import { createBrain } from './brain.js';

// DevPilot dashboard — plain ES module, no build step. Every status shown here
// comes from the API (i.e. from the orchestrator's durable state), never computed in the browser.

const $view = document.getElementById('view');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return new Date(iso).toLocaleDateString();
};
const state = (s) => `<span class="state ${esc(s)}">${esc(s)}</span>`;
const FLOW = ['QUEUED', 'DISCOVERY', 'SPECIFICATION', 'IMPACT_ANALYSIS', 'IMPLEMENTATION', 'VALIDATION', 'REVIEW', 'DELIVERY', 'DONE'];
const FLOW_SOLO = ['QUEUED', 'IMPLEMENTATION', 'VALIDATION', 'REVIEW', 'DELIVERY', 'DONE'];
const flowOf = (t) => (t.mode === 'solo' && !t.parentId ? FLOW_SOLO : t.subtasks?.length ? FLOW_DAG : FLOW);
const FLOW_DAG = ['QUEUED', 'DISCOVERY', 'SPECIFICATION', 'IMPACT_ANALYSIS', 'DECOMPOSITION', 'EXECUTING_SUBTASKS', 'VALIDATION', 'REVIEW', 'DELIVERY', 'DONE'];

// ------------------------------------------------------------------- API ----
let token = (() => {
  try {
    return localStorage.getItem('devpilot.token') || '';
  } catch {
    return '';
  }
})();
async function askToken() {
  const d = document.getElementById('token-dialog');
  d.showModal();
  await new Promise((r) => d.addEventListener('close', r, { once: true }));
  token = document.getElementById('token-input').value.trim();
  try {
    localStorage.setItem('devpilot.token', token);
  } catch {
    /* private mode */
  }
}
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) } });
  if (r.status === 401) {
    await askToken();
    return api(path, opts);
  }
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(body?.message || body?.error || r.statusText);
  return body;
}
const post = (path, data) => api(path, { method: 'POST', body: JSON.stringify(data ?? {}) });

// ---------------------------------------------------------------- views ----
async function viewTasks() {
  const [tasks, projects, m] = await Promise.all([api('/tasks'), api('/projects'), api('/metrics')]);
  const stats = [
    ['Задач', m.tasks.total, `${m.tasks.active} в работе`],
    ['Готово', m.tasks.done, `${m.tasks.blocked} остановлено`],
    ['С первого раза', pct(m.firstPassSuccessRate), 'без исправлений'],
    ['Автономно', pct(m.autonomousCompletionRate), 'без участия человека'],
    ['Покрытие требований', pct(m.requirementCoverage), 'тестами'],
    ['Цена принятой задачи', money(m.costPerAcceptedTaskUsd), `всего ${money(m.totalCostUsd)}`],
  ];
  $view.innerHTML = `
    <div class="grid">${stats.map(([l, v, h]) => `<div class="card stat"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="hint">${esc(h)}</div></div>`).join('')}</div>
    <h2>Новая задача</h2>
    <form class="inline card" id="new-task">
      <select name="projectId" required>${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.id)}</option>`).join('')}</select>
      <textarea name="prompt" placeholder="Что сделать? Например: клиент может отменить запись не позднее чем за 12 часов" required minlength="5"></textarea>
      <button class="primary" ${projects.length ? '' : 'disabled'}>Запустить</button>
    </form>
    ${projects.length ? '' : '<p class="muted">Сначала зарегистрируйте проект: <code>npm run cli -- project add &lt;id&gt; &lt;repo&gt;</code> или POST /projects.</p>'}
    <h2>Задачи</h2>
    <table><thead><tr><th>Задача</th><th>Состояние</th><th>Проект</th><th>Проверки</th><th>Исправлений</th><th>Стоимость</th><th>Обновлено</th></tr></thead>
    <tbody>${tasks
      .map((t) => {
        const req = Object.values(t.gates).filter((g) => g.required);
        const ok = req.filter((g) => g.status === 'passed').length;
        return `<tr class="click" data-href="#/tasks/${esc(t.id)}"><td><b>${esc(t.title)}</b><div class="muted">${esc(t.id)}${t.subtasks?.length ? ` · ${t.subtasks.length} подзадач` : ''}</div></td><td>${state(t.state)}</td><td>${esc(t.projectId)}</td><td>${req.length ? `${ok}/${req.length}` : '—'}</td><td>${t.repairAttempts}</td><td>${money(t.costUsd)}</td><td class="muted">${ago(t.updatedAt)}</td></tr>`;
      })
      .join('') || '<tr><td colspan="7" class="muted">Пока нет задач</td></tr>'}</tbody></table>`;
  $view.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => (location.hash = tr.dataset.href)));
  document.getElementById('new-task').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const t = await post('/tasks', { projectId: f.get('projectId'), prompt: f.get('prompt') });
    location.hash = `#/tasks/${t.id}`;
  });
}

async function viewTask(id) {
  const [{ task: t, agentRuns, children }, events] = await Promise.all([api(`/tasks/${id}`), api(`/tasks/${id}/events`)]);
  const flow = flowOf(t);
  const reached = new Set(events.filter((e) => e.type === 'state_changed').map((e) => e.data.to));
  const gates = Object.values(t.gates);
  const kids = new Map(children.map((c) => [c.id, c]));
  const actions = [];
  if (t.state === 'AWAITING_APPROVAL') actions.push('approve');
  if (t.state === 'BLOCKED') actions.push('resume');
  if (!['DONE', 'FAILED', 'CANCELLED'].includes(t.state)) actions.push('cancel');
  $view.innerHTML = `
    <p><a href="#/tasks">← задачи</a>${t.parentId ? ` · подзадача ${esc(t.subtaskKey)} задачи <a href="#/tasks/${esc(t.parentId)}">${esc(t.parentId)}</a>` : ''}</p>
    <div class="row"><h1>${esc(t.title)}</h1>${state(t.state)}</div>
    <div class="muted">${esc(t.id)} · ${esc(t.projectId)} · ветка <code>${esc(t.branch || '—')}</code> · HEAD <code>${esc((t.headCommit || '').slice(0, 8))}</code> · ${money(t.costUsd)}${t.complexity ? ` · сложность ${t.complexity.score}` : ''}${t.prUrl ? ` · <a href="${esc(t.prUrl)}" target="_blank" rel="noopener">PR</a>` : ''}${t.reportPath ? ` · <a href="#/report/${esc(t.id)}">отчёт</a>` : ''}</div>
    <div class="flow">${flow.map((s) => `<span class="${s === t.state ? 'now' : reached.has(s) ? 'done' : ''}">${s}</span>`).join('')}</div>
    ${t.state === 'AWAITING_APPROVAL' && t.approval ? `<div class="card approval"><b>${esc(t.approval.reason)}</b><ul>${t.approval.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul><form id="approve" class="row"><input name="answer" placeholder="Ваш ответ / решение" required><button class="primary">Ответить</button></form></div>` : ''}
    ${t.state === 'BLOCKED' ? `<div class="card approval"><b>Остановлено:</b> ${esc(t.stopReason)}<form id="resume" class="row" style="margin-top:8px"><input name="note" placeholder="Что вы изменили (необязательно)"><button class="primary">Продолжить</button></form></div>` : ''}
    ${t.pausedUntil && Date.parse(t.pausedUntil) > Date.now() ? `<div class="card">⏸ Пауза (${esc(t.waitReason)}) до ${esc(new Date(t.pausedUntil).toLocaleString())}</div>` : ''}
    <div class="cols">
      <div>
        <h2>Запрос</h2><div class="card">${esc(t.prompt)}</div>
        <h2>Требования</h2>
        <table><thead><tr><th>ID</th><th>Требование</th><th>Статус</th><th>Тесты</th></tr></thead><tbody>${t.requirements.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.description)}<div class="muted">${r.acceptanceCriteria.map(esc).join(' · ')}</div></td><td>${state(r.status)}</td><td class="muted">${r.tests.map(esc).join('<br>') || '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Ещё не сформулированы</td></tr>'}</tbody></table>
        ${t.subtasks?.length ? `<h2>Подзадачи</h2><table><thead><tr><th>Ключ</th><th>Подзадача</th><th>Состояние</th><th>После</th><th>Интеграция</th></tr></thead><tbody>${t.subtasks.map((s) => { const c = kids.get(s.taskId); return `<tr class="${c ? 'click' : ''}" ${c ? `data-href="#/tasks/${esc(c.id)}"` : ''}><td>${esc(s.key)}</td><td>${esc(s.title)}<div class="muted">${esc(s.requirementIds.join(', '))}</div></td><td>${c ? state(c.state) : '<span class="muted">не начата</span>'}</td><td>${esc(s.dependsOn.join(', ') || '—')}</td><td>${s.integratedCommit ? `<code>${esc(s.integratedCommit.slice(0, 8))}</code>${s.conflicts ? ` <span class="muted">конфликты: ${esc(s.conflicts.join(', '))}</span>` : ''}` : '—'}</td></tr>`; }).join('')}</tbody></table>` : ''}
        <h2>Проверки (выставлены системой, не агентом)</h2>
        <table><thead><tr><th>Проверка</th><th>Статус</th><th>Коммит</th><th>Время</th><th>Причина</th></tr></thead><tbody>${gates.map((g) => `<tr><td>${esc(g.name)}${g.required ? '' : ' <span class="muted">(необяз.)</span>'}</td><td>${state(g.status)}</td><td><code>${esc(g.commit.slice(0, 8))}</code></td><td>${g.durationMs != null ? `${(g.durationMs / 1000).toFixed(1)} с` : '—'}</td><td class="muted">${esc(g.reason)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Ещё не запускались</td></tr>'}</tbody></table>
        ${t.defects.length ? `<h2>Дефекты</h2><table><thead><tr><th>Источник</th><th>Описание</th><th>Попытка</th><th></th></tr></thead><tbody>${t.defects.map((d) => `<tr><td>${esc(d.source)} / ${esc(d.gate || '')}</td><td>${esc(d.summary)}</td><td>${d.foundInAttempt}</td><td>${d.resolved ? '✔︎ исправлен' : '<span class="error">открыт</span>'}</td></tr>`).join('')}</tbody></table>` : ''}
        <h2>Агенты</h2>
        <table><thead><tr><th>Роль</th><th>Этап</th><th>Модель</th><th>Результат</th><th>Ходов</th><th>Инструменты</th><th>Запрещено</th><th>Стоимость</th></tr></thead><tbody>${agentRuns.map((r) => `<tr><td>${esc(r.role)}</td><td>${esc(r.state)}</td><td class="muted">${esc(r.model)}</td><td>${state(r.subtype || r.status)}</td><td>${r.numTurns}</td><td>${r.toolCalls}</td><td>${r.deniedToolCalls.length}</td><td>${money(r.costUsd)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">—</td></tr>'}</tbody></table>
      </div>
      <div>
        <div class="row"><h2 style="flex:1">События</h2>${actions.includes('cancel') ? '<button class="danger" id="cancel">Отменить</button>' : ''}</div>
        <ul class="timeline card">${events.slice().reverse().map((e) => `<li><time>${esc(new Date(e.ts).toLocaleTimeString())}</time><b>${esc(e.type)}</b> ${esc(summarize(e))}</li>`).join('')}</ul>
      </div>
    </div>`;
  $view.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => (location.hash = tr.dataset.href)));
  document.getElementById('approve')?.addEventListener('submit', async (e) => (e.preventDefault(), await post(`/tasks/${id}/approve`, { answer: new FormData(e.target).get('answer') }), render()));
  document.getElementById('resume')?.addEventListener('submit', async (e) => (e.preventDefault(), await post(`/tasks/${id}/resume`, { note: new FormData(e.target).get('note') || undefined }), render()));
  document.getElementById('cancel')?.addEventListener('click', async () => confirm('Отменить задачу?') && (await post(`/tasks/${id}/cancel`, {}), render()));
}

function summarize(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'state_changed': return `${d.from} → ${d.to}${d.reason ? ` (${d.reason})` : ''}`;
    case 'agent_started': return `${d.role}${d.resumeOf ? ' (возобновление сессии)' : ''}`;
    case 'agent_finished': return `${d.role}: ${d.subtype}, ${money(d.costUsd)}${d.error ? ` — ${d.error}` : ''}`;
    case 'gates_evaluated': return Object.entries(d.gates || {}).filter(([, g]) => g.required).map(([n, g]) => `${g.status === 'passed' ? '✓' : g.status === 'failed' ? '✗' : '·'}${n}`).join(' ');
    case 'tool_denied': return `${d.role}: ${d.tool} — ${d.reason}`;
    case 'subtask_integrated': return `${d.key}${d.conflicts ? ` (конфликтов: ${d.conflicts})` : ''}`;
    case 'ci_polled': return `CI: ${d.state}`;
    default: return Object.keys(d).length ? JSON.stringify(d).slice(0, 160) : '';
  }
}

// ------------------------------------------------------------- live view ----
const ROLE_RU = { researcher: 'исследователь', architect: 'архитектор', developer: 'разработчик', qa: 'тестировщик', reviewer: 'ревьюер', fixer: 'исправляющий', integrator: 'интегратор' };
const STAGE_RU = { QUEUED: 'очередь', DISCOVERY: 'исследование', SPECIFICATION: 'спецификация', IMPACT_ANALYSIS: 'анализ влияния', DECOMPOSITION: 'разбиение', EXECUTING_SUBTASKS: 'подзадачи', IMPLEMENTATION: 'код', VALIDATION: 'проверки', REVIEW: 'ревью', REPAIR: 'исправление', DELIVERY: 'сдача', DONE: 'готово', AWAITING_APPROVAL: 'ждёт решения', BLOCKED: 'остановлено', FAILED: 'ошибка', CANCELLED: 'отменено' };
const TOOL_RU = { Read: 'читает', Edit: 'правит', Write: 'пишет', MultiEdit: 'правит', Bash: 'запускает', Grep: 'ищет', Glob: 'ищет файлы', LS: 'смотрит', WebFetch: 'читает страницу', TodoWrite: 'планирует' };
const TERMINAL = ['DONE', 'FAILED', 'CANCELLED'];
const tone = (st) => (st === 'DONE' ? 'ok' : ['BLOCKED', 'FAILED'].includes(st) ? 'bad' : st === 'AWAITING_APPROVAL' ? 'warn' : st === 'CANCELLED' ? 'idle' : 'run');
const short = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
const mins = (ms) => (ms == null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)} с` : `${Math.round(ms / 60_000)} мин`);
const act = (a) => (a ? `${esc(TOOL_RU[a.tool] || a.tool)} <code>${esc(short(a.target || '', 90))}</code>` : '');

/** Subtask DAG as SVG: columns = dependency depth, last column = integration of the whole. */
function dagSvg(t, kids, running, lastActivity) {
  const subs = t.subtasks || [];
  const by = new Map(subs.map((s) => [s.key, s]));
  const depth = new Map();
  const lvl = (k, seen = new Set()) => {
    if (depth.has(k)) return depth.get(k);
    if (seen.has(k)) return 0;
    seen.add(k);
    const d = Math.max(-1, ...(by.get(k)?.dependsOn || []).map((x) => lvl(x, seen))) + 1;
    depth.set(k, d);
    return d;
  };
  subs.forEach((s) => lvl(s.key));
  const cols = [];
  subs.forEach((s) => (cols[depth.get(s.key)] ||= []).push(s));
  const W = 210, H = 70, GX = 56, GY = 18, PAD = 8;
  const rows = Math.max(1, ...cols.map((c) => c.length));
  const width = PAD * 2 + (cols.length + 1) * W + cols.length * GX;
  const height = PAD * 2 + rows * H + (rows - 1) * GY;
  const pos = new Map();
  cols.forEach((c, i) => c.forEach((s, j) => pos.set(s.key, { x: PAD + i * (W + GX), y: PAD + j * (H + GY) + ((rows - c.length) * (H + GY)) / 2 })));
  const fin = { x: PAD + cols.length * (W + GX), y: PAD + ((rows - 1) * (H + GY)) / 2 };
  const leaves = subs.filter((s) => !subs.some((o) => o.dependsOn.includes(s.key)));
  const edge = (a, b, done) => {
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
    return `<path class="edge ${done ? 'done' : ''}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}" marker-end="url(#arr)"/>`;
  };
  const node = (x, y, title, sub, st, extra, href) => `
    <g class="node ${tone(st)}" ${href ? `data-href="${esc(href)}"` : ''} transform="translate(${x},${y})">
      <rect width="${W}" height="${H}" rx="10"/>
      ${tone(st) === 'run' && st !== 'QUEUED' ? `<circle class="pulse" cx="${W - 14}" cy="14" r="4"/>` : ''}
      <text x="12" y="22" class="t1">${esc(short(title, 26))}</text>
      <text x="12" y="41" class="t2">${esc(short(sub, 32))}</text>
      <text x="12" y="58" class="t3">${esc(short(extra, 34))}</text>
    </g>`;
  let out = '';
  for (const s of subs) for (const d of s.dependsOn) out += edge(pos.get(d), pos.get(s.key), !!by.get(d)?.integratedCommit);
  for (const s of leaves) out += edge(pos.get(s.key), fin, !!s.integratedCommit);
  for (const s of subs) {
    const c = kids.get(s.taskId);
    const st = c ? c.state : 'QUEUED';
    const r = running.find((x) => x.taskId === s.taskId);
    const a = lastActivity[s.taskId];
    const extra = s.integratedCommit ? `влито ${s.integratedCommit.slice(0, 7)}` : r ? `${ROLE_RU[r.role] || r.role}${a ? ': ' + (TOOL_RU[a.tool] || a.tool) + ' ' + (a.target || '').split('/').pop() : ''}` : c ? STAGE_RU[st] || st : s.dependsOn.length ? `ждёт ${s.dependsOn.join(', ')}` : 'в очереди';
    const p = pos.get(s.key);
    out += node(p.x, p.y, `${s.key} · ${s.title}`, c ? `${STAGE_RU[st] || st} · ${money(c.costUsd)}` : 'не начата', st, extra, c ? `#/tasks/${c.id}` : '');
  }
  const integrated = subs.length && subs.every((s) => s.integratedCommit);
  const finState = TERMINAL.includes(t.state) || t.state === 'BLOCKED' ? t.state : integrated ? t.state : 'QUEUED';
  out += node(fin.x, fin.y, 'Сборка целиком', integrated ? STAGE_RU[t.state] || t.state : `влито ${subs.filter((s) => s.integratedCommit).length}/${subs.length}`, finState, 'проверки + ревью всего', '');
  return `<div class="dag"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Граф подзадач">
    <defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead"/></marker></defs>${out}</svg></div>`;
}

function stageTrack(t, reached) {
  const flow = flowOf(t);
  const detour = ['REPAIR', 'AWAITING_APPROVAL', 'BLOCKED'].includes(t.state) ? t.state : null;
  // furthest stage reached on the main path (the feed is only the recent tail)
  const at = Math.max(flow.indexOf(t.state), ...[...reached].map((x) => flow.indexOf(x)));
  return `<div class="track">${flow
    .map((s, i) => `<span class="${s === t.state ? 'now' : i < at || reached.has(s) ? 'done' : ''}">${esc(STAGE_RU[s] || s)}</span>`)
    .join('<i></i>')}${detour ? `<span class="now ${tone(detour)}">${esc(STAGE_RU[detour])}</span>` : ''}</div>`;
}

function feedLine(e, keys) {
  const d = e.data || {};
  const who = keys.get(e.taskId) || 'задача';
  const time = `<time>${esc(new Date(e.ts).toLocaleTimeString())}</time>`;
  if (e.type === 'agent_activity') return `<li class="act">${time}<b>${esc(who)}</b> ${esc(ROLE_RU[d.role] || d.role)} ${act(d)}</li>`;
  if (e.type === 'state_changed') return `<li class="st">${time}<b>${esc(who)}</b> ${esc(STAGE_RU[d.from] || d.from)} → <b>${esc(STAGE_RU[d.to] || d.to)}</b>${d.reason ? ` <span class="muted">${esc(short(d.reason, 90))}</span>` : ''}</li>`;
  if (e.type === 'subtask_integrated') return `<li class="st">${time}<b>${esc(who)}</b> подзадача ${esc(d.key)} влита${d.conflicts ? `, конфликтов: ${esc(d.conflicts)}` : ''}</li>`;
  if (e.type === 'gates_evaluated') return `<li class="st">${time}<b>${esc(who)}</b> проверки: ${esc(summarize(e))}</li>`;
  if (e.type === 'review_recorded') return `<li class="st">${time}<b>${esc(who)}</b> ревью: ${esc(d.status)}${d.blocking ? `, блокирующих ${d.blocking}` : ''}</li>`;
  return `<li>${time}<b>${esc(who)}</b> ${esc(e.type)}</li>`;
}

let brain = null;
async function viewLive() {
  const live = await api('/live');
  const { tasks } = live;
  // The brain canvas persists across refreshes (its animation is the point); only the cards re-render.
  if (!brain?.alive || !document.getElementById('brain')) {
    $view.innerHTML = `<div class="row"><h1 style="flex:1">Сейчас</h1><span class="muted legend"><i class="lg run"></i>работает <i class="lg ok"></i>готово <i class="lg warn"></i>ждёт решения <i class="lg bad"></i>остановлено</span></div>
      <div class="card brainwrap"><canvas id="brain" aria-label="Живая схема: оркестратор, задачи, подзадачи и агенты"></canvas></div><div id="live-cards"></div>`;
    brain = createBrain(document.getElementById('brain'), { onOpen: (href) => (location.hash = href) });
  }
  brain.update(live);
  const $cards = document.getElementById('live-cards');
  if (!tasks.length) {
    $cards.innerHTML = `<div class="card empty" style="margin-top:16px">Сейчас ничего не выполняется. Запустите задачу из <a href="#/tasks">списка задач</a> или командой <code>npm run cli -- run &lt;project&gt; "…"</code>. Здесь появится её живой ход.</div>`;
    return;
  }
  $cards.innerHTML = `${tasks
    .map(({ task: t, children, running, agentRuns, lastActivity, feed }) => {
      const kids = new Map(children.map((c) => [c.id, c]));
      const keys = new Map([[t.id, 'задача'], ...children.map((c) => [c.id, c.subtaskKey || c.id])]);
      const live = running.filter((r) => { const owner = r.taskId === t.id ? t : kids.get(r.taskId); return owner && !TERMINAL.includes(owner.state) && !['AWAITING_APPROVAL', 'BLOCKED'].includes(owner.state); });
      const reached = new Set(feed.filter((e) => e.type === 'state_changed' && e.taskId === t.id).map((e) => e.data.to));
      const cost = t.costUsd + children.reduce((a, c) => a + c.costUsd, 0);
      const active = (t.activeMs || 0) + children.reduce((a, c) => a + (c.activeMs || 0), 0);
      return `<section class="card livecard ${tone(t.state)}">
        <div class="row"><a href="#/tasks/${esc(t.id)}"><h2 style="margin:0">${esc(t.title)}</h2></a>${state(t.state)}</div>
        <div class="muted">${esc(t.projectId)} · ${esc(t.id)} · работа ${mins(active)} · ${money(cost)} · запусков агентов ${agentRuns}${t.subtasks?.length ? ` · подзадач ${t.subtasks.length}` : ''}</div>
        ${stageTrack(t, reached)}
        ${t.state === 'AWAITING_APPROVAL' && t.approval ? `<div class="card approval"><b>${esc(t.approval.reason)}</b> — <a href="#/tasks/${esc(t.id)}">ответить</a></div>` : ''}
        ${t.state === 'BLOCKED' ? `<div class="card approval"><b>Остановлено:</b> ${esc(t.stopReason)}</div>` : ''}
        ${t.subtasks?.length ? dagSvg(t, kids, live, lastActivity) : ''}
        <div class="cols">
          <div><h3>Агенты сейчас</h3>${
            live.length
              ? `<ul class="agents">${live.map((r) => { const a = lastActivity[r.taskId]; return `<li><span class="dot"></span><b>${esc(ROLE_RU[r.role] || r.role)}</b> · ${esc(keys.get(r.taskId))} <span class="muted">${esc(r.model || '')} · ${ago(r.startedAt)}</span>${a ? `<div class="muted">${act(a)} · ${ago(a.ts)}</div>` : ''}</li>`; }).join('')}</ul>`
              : `<p class="muted">${TERMINAL.includes(t.state) ? 'Задача завершена.' : 'Нет работающих агентов (система проверяет, ждёт или между шагами).'}</p>`
          }</div>
          <div><h3>Ход работы</h3><ul class="timeline feed">${feed.slice(0, 40).map((e) => feedLine(e, keys)).join('')}</ul></div>
        </div>
      </section>`;
    })
    .join('')}`;
  $cards.querySelectorAll('g[data-href]').forEach((g) => g.addEventListener('click', () => (location.hash = g.dataset.href)));
}

async function viewApprovals() {
  const list = await api('/approvals');
  $view.innerHTML = `<h1>Ждут вашего решения</h1><p class="muted">Агенты останавливаются только там, где решение должен принять владелец проекта.</p>
    ${list.map((a) => `<div class="card approval" style="margin-top:12px"><a href="#/tasks/${esc(a.id)}"><b>${esc(a.title)}</b></a> <span class="muted">${esc(a.id)} · ${esc(a.approval?.kind)}</span><p>${esc(a.approval?.reason)}</p><ul>${(a.approval?.questions || []).map((q) => `<li>${esc(q)}</li>`).join('')}</ul><form class="row" data-id="${esc(a.id)}"><input name="answer" placeholder="Ответ / решение" required><button class="primary">Ответить</button></form></div>`).join('') || '<p class="muted">Ничего не ждёт решения 🎉</p>'}`;
  $view.querySelectorAll('form[data-id]').forEach((f) => f.addEventListener('submit', async (e) => (e.preventDefault(), await post(`/tasks/${f.dataset.id}/approve`, { answer: new FormData(f).get('answer') }), render())));
}

async function viewMetrics() {
  const m = await api('/metrics');
  const maxDay = Math.max(1, ...m.daily.map((d) => d.costUsd));
  const card = (l, v, h) => `<div class="card stat"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="hint">${esc(h)}</div></div>`;
  $view.innerHTML = `<h1>Метрики качества и стоимости</h1><p class="muted">Считаются по фактам: состояния задач, реально выполненные проверки, запуски агентов.</p>
    <div class="grid">
      ${card('First-pass success', pct(m.firstPassSuccessRate), 'прошли проверки без исправлений')}
      ${card('Autonomous completion', pct(m.autonomousCompletionRate), 'без участия человека')}
      ${card('Escaped defects', m.escapedDefects.reportedAfterDelivery, `${m.escapedDefects.ciFailuresAfterPr} падений CI после PR`)}
      ${card('Requirement coverage', pct(m.requirementCoverage), 'требования с тестами')}
      ${card('Recovery success', pct(m.recovery.rate), `${m.recovery.recovered}/${m.recovery.incidents} инцидентов`)}
      ${card('Cost per accepted task', money(m.costPerAcceptedTaskUsd), `всего ${money(m.totalCostUsd)}`)}
      ${card('Среднее время', m.avgDurationMinutes == null ? '—' : `${m.avgDurationMinutes.toFixed(1)} мин`, `исправлений в среднем ${m.avgRepairAttempts ?? '—'}`)}
      ${card('Запрещённых действий', m.deniedToolCalls, 'заблокировано политикой')}
    </div>
    <div class="cols"><div>
      <h2>Расход по дням</h2>
      <table><thead><tr><th>День</th><th>Задач</th><th>Готово</th><th style="width:45%">Стоимость</th></tr></thead><tbody>${m.daily.map((d) => `<tr><td>${esc(d.date)}</td><td>${d.created}</td><td>${d.done}</td><td><div class="row"><div class="bar" style="flex:1"><span style="width:${(100 * d.costUsd) / maxDay}%"></span></div>${money(d.costUsd)}</div></td></tr>`).join('') || '<tr><td colspan="4" class="muted">—</td></tr>'}</tbody></table>
      <h2>Повторяющиеся ошибки</h2>
      <table><thead><tr><th>Проверка</th><th>Ошибка</th><th>Раз</th><th>Задач</th></tr></thead><tbody>${m.recurringFailures.map((f) => `<tr><td>${esc(f.gate)}</td><td>${esc(f.summary)}</td><td>${f.occurrences}</td><td>${f.tasks}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Нет</td></tr>'}</tbody></table>
    </div><div>
      <h2>Чаще всего падают</h2>
      <table><tbody>${m.gateFailures.map((g) => `<tr><td>${esc(g.gate)}</td><td>${g.failures}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</tbody></table>
      <h2>Стоимость по ролям</h2>
      <table><tbody>${Object.entries(m.costByRole).sort((a, b) => b[1] - a[1]).map(([r, c]) => `<tr><td>${esc(r)}</td><td>${money(c)}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</tbody></table>
      <h2>Модели</h2>
      <table><tbody>${Object.entries(m.costByModel).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.runs} запусков</td><td>${money(v.costUsd)}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</tbody></table>
    </div></div>`;
}

async function viewReport(id) {
  const md = await api(`/tasks/${id}/report`);
  $view.innerHTML = `<p><a href="#/tasks/${esc(id)}">← задача</a></p><h1>Отчёт ${esc(id)}</h1><pre>${esc(md)}</pre>`;
}

// --------------------------------------------------------------- router ----
async function render() {
  const h = location.hash || '#/';
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', h === a.getAttribute('href') || (a.dataset.nav === 'tasks' && h.startsWith('#/tasks')) || (a.dataset.nav === 'live' && h === '#/')));
  try {
    let m;
    if ((m = h.match(/^#\/tasks\/([\w-]+)/))) await viewTask(m[1]);
    else if (h === '#/' || h.startsWith('#/live')) await viewLive();
    else if ((m = h.match(/^#\/report\/([\w-]+)/))) await viewReport(m[1]);
    else if (h.startsWith('#/approvals')) await viewApprovals();
    else if (h.startsWith('#/metrics')) await viewMetrics();
    else await viewTasks(); // #/tasks
  } catch (e) {
    $view.innerHTML = `<p class="error">Ошибка: ${esc(e.message)}</p>`;
  }
  refreshApprovals();
}
async function refreshApprovals() {
  try {
    const n = (await api('/approvals')).length;
    const el = document.getElementById('approvals-count');
    el.textContent = String(n);
    el.classList.toggle('hidden', n === 0);
  } catch {
    /* ignore */
  }
}

// Live updates: re-render when an event for what we're looking at arrives (debounced).
let pending;
function connectLive() {
  const es = new EventSource(`/events/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  const live = document.getElementById('live');
  es.onopen = () => live.classList.add('on');
  es.onerror = () => live.classList.remove('on');
  es.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    if (brain?.alive) brain.pulse(e); // signals travel along the branches as events arrive
    const h = location.hash;
    const onLive = h === '#/' || h.startsWith('#/live');
    const relevant = onLive || !h.startsWith('#/tasks/') || h.includes(e.taskId) || e.type === 'state_changed';
    if (!relevant || document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
    clearTimeout(pending);
    pending = setTimeout(render, 400);
  };
}

window.addEventListener('hashchange', render);
// keep "N с назад" honest on the live page even when nothing new happens
setInterval(() => {
  const h = location.hash || '#/';
  if ((h === '#/' || h.startsWith('#/live')) && !document.activeElement?.matches?.('input,textarea')) render();
}, 5000);
await render();
connectLive();
