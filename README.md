# DevPilot

Автономный AI-разработчик на Claude Agent SDK. **Оркестратор — обычная детерминированная
программа, Claude — заменяемый исполнитель.** Агент никогда не решает сам, что задача
выполнена: статусы проверок выставляет только Verification Engine по реальным exit-кодам,
привязанным к конкретному коммиту.

Реализованы все пять этапов исходного плана: надёжный исполнитель, Project Intelligence,
Verification Engine, мультиагентная оркестрация, автономность и наблюдаемость
(dashboard, уведомления, метрики, бюджеты, выбор моделей, контрольные задачи).

## Ядро (этапы 1 и 3)

| Компонент | Пакет | Что делает |
|---|---|---|
| State machine | `packages/task-engine` | Белый список переходов + guards. `DELIVERY`/`DONE` невозможны, пока все обязательные gates не `passed` **на текущем HEAD** (устаревший pass не считается). |
| Durable state | `packages/database` | PostgreSQL (JSONB-документ задачи, optimistic locking, lease, append-only event log с триггером) или JSON-файл для CLI. |
| Policy engine | `packages/policy-engine` | YAML-политики: gates (`required`/`conditional`/`off`), лимиты, approvals, права ролей, deny-лист команд, защищённые пути. |
| Git isolation | `packages/git-manager` | Отдельный worktree + ветка `devpilot/<task>` на задачу, снапшот-коммиты после каждого агента, push + `gh pr create` (merge — никогда). |
| Sandbox | `packages/sandbox-manager` | Gate-команды локально с очищенным env или в одноразовом контейнере (`--network none`, `--cap-drop ALL`, без docker socket). |
| Verification | `packages/verification-engine` | Built-in gates: `diff_present`, `test_integrity` (удаление тестов, `.only/.skip`, правка защищённых файлов), `secrets_scan`, `requirements_coverage`; command gates: typecheck/lint/unit/integration/e2e/security; отпечатки ошибок для правила «та же ошибка». |
| Project Intelligence | `packages/project-intelligence` | AST-индекс на коммит (инкрементальный, кэш по git blob): символы, граф импортов (workspaces, tsconfig paths, barrels, Python), API, UI-маршруты, модель данных, env, интеграции, CI, file → tests. Concept search + расширение по графу и общим таблицам, blast radius изменённых символов, память о сданных задачах. |
| Agent runtime | `packages/agent-runtime` | `ClaudeAgentRunner` (Agent SDK `query()`): роль → набор tools, PreToolUse hook + `canUseTool` → policy, structured output по zod-схеме, `maxBudgetUsd`, `maxTurns`, сохранение `session_id` и `resume` после сбоя, OS-sandbox для Bash. `ScriptedAgentRunner` — для тестов. |
| Orchestrator | `packages/orchestrator` | Один `step()` = одна единица работы; результат сохраняется до перехода. Repair loop со стоп-правилами. Отчёт с доказательствами. |
| Apps | `apps/api`, `apps/worker`, `apps/cli` | Fastify API, BullMQ worker (восстановление активных задач при старте), CLI без Redis. |
| Роли | `agents/*.md` | researcher, architect, developer, qa-engineer, reviewer, fixer. |

## Жизненный цикл

```
QUEUED → DISCOVERY → SPECIFICATION → IMPACT_ANALYSIS → IMPLEMENTATION → VALIDATION
                         │                 │                                │   ▲
                         ▼                 ▼                       fail     ▼   │ после КАЖДОГО фикса
                  AWAITING_APPROVAL  AWAITING_APPROVAL              REPAIR ─────┘
                 (блокирующая неясность) (миграции/auth)              │
                                                                     ▼ стоп-правила
        VALIDATION ok → REVIEW (независимый) → DELIVERY → DONE      BLOCKED
```

Доставка (`DELIVERY`):
1. push ровно того коммита, на котором прошли все проверки (и снова — после каждого исправления);
2. PR открывается один раз (идемпотентно: после падения находится существующий), описание обновляется отчётом;
3. CI — обязательный gate `ci`, привязанный к запушенному коммиту. DevPilot опрашивает `gh pr checks`
   (`delivery.ci_poll_seconds`), задача ждёт без расхода попыток. Упавшие проверки превращаются в дефекты
   с логом из `gh run view --log-failed` → `REPAIR` → полная валидация → ревью → новый push → снова CI.
   Нет ни одной проверки за `ci_no_checks_grace_minutes` или CI не уложился в `ci_timeout_minutes` → `BLOCKED`.
4. `create_pr: true` без remote → `BLOCKED` (без тихой «локальной» доставки). Merge — никогда.

Стоп-правила REPAIR: исчерпаны попытки; одна и та же ошибка (fingerprint) N раз;
нет прогресса (число открытых дефектов не уменьшается) M попыток подряд; бюджет; время.
Required gate без команды/окружения → `not_verified` → `BLOCKED` (никогда не засчитывается).

Reviewer получает требования, diff и результаты реально выполненных проверок — **без**
рассуждений Developer. Его blocker/major находки возвращают задачу в REPAIR.

## Быстрый старт (CLI, без Postgres/Redis)

```bash
npm install
npm test
```

```bash
npm run cli -- project add myapp /path/to/repo --policy examples/devpilot.yaml
```

```bash
npm run cli -- run myapp "Сделай систему промокодов с лимитом использований и сроком действия"
```

```bash
npm run cli -- status
```

Состояние — в `./.devpilot/state.json`, worktrees — в `./.devpilot/worktrees`, отчёты —
в `./.devpilot/reports/<TASK>.md`, логи gates — в `./.devpilot/artifacts`.
Если процесс упал: `npm run cli -- continue <TASK>` продолжит с сохранённого шага.

## Работа на подписке Claude (по умолчанию)

По умолчанию (`agents.auth: subscription`) агенты запускаются через официальный
`claude -p` (headless Claude Code) под вашим входом claude.ai (Pro/Max):

```bash
claude auth status
```

Если `loggedIn: true` и `authMethod: claude.ai`, больше ничего не нужно. Для сервера
или контейнера без браузера выпустите долгоживущий токен подписки и передайте его
воркеру как `CLAUDE_CODE_OAUTH_TOKEN`:

```bash
claude setup-token
```

Что гарантирует DevPilot в этом режиме:
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` вычищаются из окружения агента: ключ
  не может перехватить приоритет у подписки.
- Если Claude Code всё-таки сообщает, что работает на API-ключе (`apiKeySource != none`),
  запуск прерывается с ошибкой `auth_mismatch`. Случайных списаний по API не будет.
- При исчерпании лимита (окно 5 часов или неделя) задача не падает и не тратит попытки.
  Она получает `pausedUntil`, сессия агента помечается `interrupted` и после сброса
  лимита продолжается через `--resume`. CLI ждёт сам, воркер ставит отложенный job.
  С `agents.wait_on_rate_limit: false` задача вместо этого уходит в `BLOCKED`.
- Воркер по умолчанию ведёт одну задачу за раз (`DEVPILOT_CONCURRENCY=1`): лимит один на подписку.
- `max_task_cost_usd` в этом режиме считается по *условной* стоимости, которую сообщает
  Claude Code. Денег это не стоит, но защищает от «бесконечного» агента.

Политика инструментов работает так же: PreToolUse хук (`packages/agent-runtime/src/policy-hook.ts`)
передаётся в `claude -p --settings`, при любой ошибке он запрещает действие.

Режим API (`agents.auth: api`): Claude Agent SDK с `ANTHROPIC_API_KEY`.
Документация Anthropic требует API-ключ для продуктов на Agent SDK, которые вы
предлагаете другим. Режим подписки предназначен для личного использования на своей машине.

Проверка подписки одним настоящим запуском агента (≈15 с, немного квоты):

```bash
npx tsx scripts/smoke-subscription.ts
```

## Серверный режим

```bash
npm run infra:up
```

```bash
DATABASE_URL=postgres://devpilot:devpilot@localhost:5432/devpilot REDIS_URL=redis://localhost:6379 npm run worker
```

```bash
DATABASE_URL=postgres://devpilot:devpilot@localhost:5432/devpilot REDIS_URL=redis://localhost:6379 npm run api
```

Порты переопределяются `DEVPILOT_PG_PORT` / `DEVPILOT_REDIS_PORT`.

Без `REDIS_URL` API работает во **встроенном режиме**: сам исполняет задачи в фоне (одна
команда на ноутбуке, без Redis и Postgres):

```bash
npm run api
```

Dashboard: `http://127.0.0.1:4317/dashboard/`. API: `POST /projects`, `POST /tasks`, `GET /tasks`,
`GET /tasks/:id` (с подзадачами и запусками агентов), `GET /tasks/:id/events`, `GET /tasks/:id/report`,
`POST /tasks/:id/approve|resume|cancel`, `POST /tasks/:id/escaped-defect`, `GET /approvals`,
`GET /metrics`, `GET /events/stream` (SSE), `GET /projects/:id/index|search|knowledge`.
`DEVPILOT_API_TOKEN` включает Bearer-авторизацию (для SSE — `?token=`; dashboard спросит токен сам).

## Project Intelligence (этап 2)

Индекс строится детерминированно, без модели, и всегда привязан к коммиту: перед использованием
сверяется с HEAD. Факты по каждому файлу кэшируются по git blob, поэтому повторная индексация
перепарсивает только изменённые файлы (75 файлов DevPilot: 0,19 с с нуля, 0,04 с из кэша).

| Слой | Что извлекается |
|---|---|
| Структура | файлы, workspace-пакеты (npm/pnpm), entry points, scripts |
| Граф зависимостей | AST-импорты TS/JS (ESM, CJS, dynamic, re-export), tsconfig `paths`, workspace-пакеты, barrel-файлы, Python; внешние пакеты |
| Символы | объявления с диапазонами строк и признаком экспорта; кто импортирует какой символ (сквозь barrels) |
| API | Express/Koa/Hono-подобные роутеры, Fastify `route()`, NestJS `@Controller/@Get`, Next.js `app/**/route.ts` и `pages/api`, FastAPI/Flask |
| UI | Next.js app/pages, React Router `<Route>` и конфиги роутов |
| Данные | Prisma (модели, связи, `@@map`), SQL-миграции (CREATE/ALTER), Drizzle, TypeORM, SQLAlchemy, Django; кто читает/пишет таблицу (`prisma.booking`, `db('bookings')`, сырой SQL) |
| Окружение | `process.env` / `import.meta.env` / `os.environ`, `.env.example`, секреты CI |
| Интеграции | известные SDK (платежи, почта, очереди, LLM, аналитика, auth…) и внешние HTTP-хосты |
| Тесты | file → tests (транзитивно), названия тестов |

Как это используется в задаче:
- **DISCOVERY**: исследователь получает карту архитектуры и предварительный поиск, а возвращает `searchTerms`
  на языке кода (запрос может быть на русском). Система расширяет найденное: потребители (обратные импорты),
  зависимости, тесты, **все файлы, работающие с теми же таблицами** (уведомления, аналитика, расписания…).
- **SPECIFICATION / IMPACT**: этот контекст плюс память о ранее сданных связанных задачах (их требования
  считаются действующими бизнес-правилами).
- **REVIEW**: blast radius по символам: какие экспортируемые символы изменил diff и кто их использует,
  с пометкой потребителей, которых diff **не** затронул.
- **DONE**: задача записывается в Project Knowledge (требования, решения владельца, код, тесты, endpoints, таблицы).

```bash
npm run cli -- index myapp
```

```bash
npm run cli -- search myapp "cancel booking"
```

```bash
npm run cli -- impact myapp src/services/booking.ts cancelBooking
```

```bash
npm run cli -- knowledge myapp
```

API: `GET /projects/:id/index`, `GET /projects/:id/search?q=…`, `GET /projects/:id/knowledge`.

Чего нет: семантического (embedding) поиска — намеренно. Перевод терминов делает исследователь, а
полноту гарантируют точные символы, граф и общие таблицы. Языки кроме TS/JS/Python не парсятся.

## Мультиагентная оркестрация (этап 4)

Если архитектор на IMPACT_ANALYSIS решает, что изменение большое и делится на независимо
проверяемые части, он описывает `subtasks` (ключ, описание, требования, файлы, `dependsOn`).
Дальше всё детерминированно:

```
IMPACT_ANALYSIS → DECOMPOSITION → EXECUTING_SUBTASKS ──(все интегрированы)──→ VALIDATION → REVIEW → DELIVERY
                                        │  ▲
              S1 ─┐  (свои worktree,    │  │ merge --no-ff в интеграционную ветку родителя,
              S2 ─┼─ полный цикл:       ▼  │ конфликт → integrator-агент → повторная проверка всего
              S3 ─┘  impact→код→тесты→gates→review)
```

- **Проверка плана**: ключи уникальны, зависимости существуют, нет циклов, каждое требование
  покрыто подзадачей. Невалидный план отклоняется, архитектор планирует заново, после 3 попыток
  задача уходит в `BLOCKED`. Подзадачи, которые объявили одни и те же файлы, но не зависят друг
  от друга, автоматически выстраиваются последовательно (событие `plan_validated.serialized`).
- **Параллельность**: одновременно работает не больше `execution.max_parallel_agents` подзадач.
  Каждая работает в своём worktree, ответвлённом от интеграционной ветки родителя, где уже есть
  её зависимости. Подзадача наследует исследование, требования (свою часть), решения владельца
  и одобрения.
- **Каждая подзадача проверяется сама**: все gates и независимое ревью. «Сдаётся» она в ветку
  родителя, а не в PR.
- **Интеграция** идёт в порядке зависимостей. При конфликте агент `integrator` разрешает его,
  удерживая намерения обеих сторон (до `decomposition.max_conflict_attempts` попыток). Если маркеры
  остались, merge откатывается, worktree остаётся чистым, родитель уходит в `BLOCKED`.
- **Собранный результат проверяется целиком**: полные gates, покрытие всех требований (тесты
  берутся из подзадач), ревью общего diff, затем PR и CI.
- Упавшая подзадача блокирует родителя с указанием причины. `resume` подзадачи возобновляет и
  родителя, `cancel` родителя отменяет подзадачи.
- **Режимы**: в CLI подзадачи гоняются параллельно внутри процесса. В воркере каждая подзадача —
  отдельные job-ы в очереди: новые подзадачи и родитель, у которого завершилась подзадача,
  ставятся в очередь сразу.

```yaml
execution:
  max_parallel_agents: 3   # на подписке все агенты делят один лимит
decomposition:
  enabled: true
  max_subtasks: 8
  max_conflict_attempts: 2
```

## Воркер и восстановление

`startWorker()` (`packages/orchestrator/src/worker.ts`): один BullMQ job = один шаг. Пока шаг идёт,
lease задачи в PostgreSQL продлевается heartbeat-ом (TTL 2 мин). Если процесс упал, lease истекает,
любой воркер при старте переставляет в очередь все активные задачи и продолжает с сохранённого шага
(исследование и спецификация не повторяются, прерванная сессия агента возобновляется).

## Docker

- Gates в контейнере: `execution.containerized: true` — каждая команда в одноразовом контейнере
  с `--network none`, `--cap-drop ALL`, `no-new-privileges`, лимитами CPU/памяти/pids, от имени
  пользователя хоста, без переменных окружения хоста. Доказательства (`collect: [playwright-report, test-results]`)
  копируются в artifacts и попадают в отчёт.
- Весь воркер в контейнере (`docker/Dockerfile`, профиль `app` в compose): внутри `claude` CLI и `gh`,
  непривилегированный пользователь, без docker socket — контейнер сам является песочницей агентов,
  gates выполняются внутри него. Подписка в контейнере — через `CLAUDE_CODE_OAUTH_TOKEN`:

```bash
claude setup-token
```

```bash
CLAUDE_CODE_OAUTH_TOKEN=<token> GH_TOKEN=<token> DEVPILOT_REPOS=/path/to/repos docker compose -f docker/docker-compose.yml --profile app up -d --build
```

## Модель безопасности

1. Policy (PreToolUse hook + canUseTool): роль → tools; read-only роли не пишут и
   выполняют только команды просмотра; QA пишет только тесты; все пути внутри worktree;
   deny-лист (`git push`, `gh`, `sudo`, `ssh`, `docker`, `curl | sh`, `~/.ssh`, …); нет Task/WebFetch/MCP.
2. Claude Code OS-sandbox для Bash (запись только в worktree).
3. Вне модели: worktree, очищенное окружение, контейнеры для gates, отсутствие боевых
   ключей и docker socket. `test_integrity` ловит обход через Bash постфактум.

## Тесты

Полный прогон (с PostgreSQL, Redis и Docker; без них соответствующие тесты пропускаются):

```bash
DEVPILOT_PG_PORT=54329 DEVPILOT_REDIS_PORT=56379 npm run infra:up
```

```bash
DATABASE_URL=postgres://devpilot:devpilot@localhost:54329/devpilot REDIS_URL=redis://localhost:56379 npm test
```

Сюда входят: доставка через bare-remote и фейковый `gh` (PR, ожидание CI, красный CI → repair → повторный push,
нет CI → BLOCKED), падение воркера посреди шага на реальных Redis+PostgreSQL, gates в Docker (нет сети, нет секретов,
владелец файлов, сбор доказательств), этап 5 (метрики, маршрутизация моделей, дневной бюджет, Telegram/webhook с
фейковыми серверами, команды бота, API во встроенном режиме с SSE и dashboard, стенд контрольных задач). Всего 55 тестов
(`npm test`); из них 48 (включая Project Intelligence на фикстуре booking-монорепо и подзадачи: параллельность, зависимости, конфликты, сериализация, отказы, режим воркера); из них 24: state machine, policy, полный цикл со скриптовым агентом
(happy path, repair, зацикливание → BLOCKED, review → repair, not_verified, подмена тестов,
approvals, восстановление после «падения», бюджет, пауза по лимиту подписки) и раннер `claude -p` на фейковом бинарнике (ключ API не утекает, хук запрещает, отказ при работе на API-ключе, лимит). `tests/pg-store.test.ts` — тот же цикл
на PostgreSQL (нужен `DATABASE_URL`).

## Автономность и наблюдаемость (этап 5)

**Dashboard** (`apps/dashboard`, отдаётся API по `/dashboard/`, без сборки): список задач с метриками,
постановка задачи, карточка задачи (этапы, требования и их тесты, проверки с коммитом, подзадачи,
дефекты, запуски агентов с моделью и стоимостью, живая лента событий), ответ на вопросы /
возобновление / отмена, отчёт, отдельные страницы «Решения» и «Метрики». Обновляется вживую через SSE.

**Метрики** (`packages/metrics`, `GET /metrics`, `devpilot metrics`), из раздела 11 архитектуры, только по фактам:

| Метрика | Как считается |
|---|---|
| First-pass success | DONE без единой попытки исправления (с подзадачами) / DONE |
| Autonomous completion | DONE без участия человека (ответы, решения, resume) / завершённые |
| Escaped defects | падения CI после PR + дефекты, отмеченные после сдачи (`POST /tasks/:id/escaped-defect`) |
| Requirement coverage | требования сданных задач, подтверждённые тестами |
| Recovery success | задачи с инцидентом (сбой шага, лимит подписки, смена воркера, прерванная сессия), дошедшие до DONE |
| Cost per accepted task | вся стоимость (включая неудачные задачи и подзадачи) / DONE |

Плюс: какие проверки падают чаще всего, повторяющиеся ошибки (по отпечатку) между задачами,
стоимость по ролям и моделям, запрещённые действия, расход по дням.

**Уведомления** (`packages/notifier`): Telegram и webhook (с HMAC-подписью `x-devpilot-signature`)
о том, что требует внимания: нужно решение, задача остановлена, готово, PR открыт, пауза по лимиту
подписки или дневному бюджету. **Telegram-бот** (только для указанного чата): `/tasks`, `/status`,
`/run <project> <задача>`, `/approve <TASK> <ответ>`, `/resume`, `/cancel`, `/metrics`.

```bash
DEVPILOT_TELEGRAM_BOT_TOKEN=<token> DEVPILOT_TELEGRAM_CHAT_ID=<chat> DEVPILOT_DASHBOARD_URL=http://127.0.0.1:4317/dashboard npm run api
```

Также: `DEVPILOT_WEBHOOK_URL`, `DEVPILOT_WEBHOOK_SECRET`, `DEVPILOT_NOTIFY_ON` (список событий).

**Стоимость и модели**:
- `limits.max_daily_cost_usd`: дневной бюджет проекта; при исчерпании задачи встают на паузу до полуночи.
- `agents.routing`: модель и effort по сложности задачи. Сложность считается детерминированно после
  impact analysis (файлы, зависимые модули, требования, риск, публичный API, подзадачи). Архитектор
  и ревьюер всегда на верхнем уровне, fixer повышается после неудачных попыток. **По умолчанию
  выключено**: более дешёвая модель выбирается только если вы это настроили.

```yaml
agents:
  routing:
    enabled: true
    tiers:
      - { name: small,  max_score: 4,  model: claude-sonnet-5-5, effort: medium }
      - { name: medium, max_score: 10, model: claude-opus-5-5,   effort: high }
      - { name: large,                 model: claude-opus-5-5,   effort: xhigh }
limits:
  max_daily_cost_usd: 30
```

**Контрольные задачи** (`benchmarks/`, `devpilot bench`): одна и та же задача решается DevPilot и
обычным Claude Code (одна сессия `claude -p`, без оркестрации и проверок). Оба результата
оцениваются **одними и теми же скрытыми приёмочными тестами**, которые ни один агент не видел:
они копируются в репозиторий только после работы. Отчёт: accepted, скрытые тесты, стоимость, время.

```bash
npm run cli -- bench cancel-window promo-codes
```

Свою контрольную задачу легко добавить: `benchmarks/<name>/{benchmark.yaml, repo/, acceptance/}`.
