# DevPilot

Автономный AI-разработчик на Claude Agent SDK. **Оркестратор — обычная детерминированная
программа, Claude — заменяемый исполнитель.** Агент никогда не решает сам, что задача
выполнена: статусы проверок выставляет только Verification Engine по реальным exit-кодам,
привязанным к конкретному коммиту.

## Что реализовано (этапы 1, 3 и основа 2 из архитектуры)

| Компонент | Пакет | Что делает |
|---|---|---|
| State machine | `packages/task-engine` | Белый список переходов + guards. `DELIVERY`/`DONE` невозможны, пока все обязательные gates не `passed` **на текущем HEAD** (устаревший pass не считается). |
| Durable state | `packages/database` | PostgreSQL (JSONB-документ задачи, optimistic locking, lease, append-only event log с триггером) или JSON-файл для CLI. |
| Policy engine | `packages/policy-engine` | YAML-политики: gates (`required`/`conditional`/`off`), лимиты, approvals, права ролей, deny-лист команд, защищённые пути. |
| Git isolation | `packages/git-manager` | Отдельный worktree + ветка `devpilot/<task>` на задачу, снапшот-коммиты после каждого агента, push + `gh pr create` (merge — никогда). |
| Sandbox | `packages/sandbox-manager` | Gate-команды локально с очищенным env или в одноразовом контейнере (`--network none`, `--cap-drop ALL`, без docker socket). |
| Verification | `packages/verification-engine` | Built-in gates: `diff_present`, `test_integrity` (удаление тестов, `.only/.skip`, правка защищённых файлов), `secrets_scan`, `requirements_coverage`; command gates: typecheck/lint/unit/integration/e2e/security; отпечатки ошибок для правила «та же ошибка». |
| Project Intelligence | `packages/project-intelligence` | Индекс репозитория на коммит: файлы, пакеты, граф импортов, обратные зависимости, file → tests. Impact analysis дополняется детерминированно, а не моделью. |
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

Порты переопределяются `DEVPILOT_PG_PORT` / `DEVPILOT_REDIS_PORT`. API:
`POST /projects`, `POST /tasks`, `GET /tasks/:id`, `GET /tasks/:id/events`,
`POST /tasks/:id/approve`, `POST /tasks/:id/resume`, `POST /tasks/:id/cancel`
(`DEVPILOT_API_TOKEN` включает Bearer-авторизацию).

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
владелец файлов, сбор доказательств). Кроме того `npm test` — 24 теста: state machine, policy, полный цикл со скриптовым агентом
(happy path, repair, зацикливание → BLOCKED, review → repair, not_verified, подмена тестов,
approvals, восстановление после «падения», бюджет, пауза по лимиту подписки) и раннер `claude -p` на фейковом бинарнике (ключ API не утекает, хук запрещает, отказ при работе на API-ключе, лимит). `tests/pg-store.test.ts` — тот же цикл
на PostgreSQL (нужен `DATABASE_URL`).

## Что дальше (этапы 2, 4–5)

Параллельные подзадачи в разных worktrees и их интеграция, семантический поиск в Project Intelligence, dashboard, нотификации,
метрики (first-pass success, escaped defects, cost per accepted task), набор контрольных задач.
