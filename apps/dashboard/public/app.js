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
  const flow = t.subtasks?.length ? FLOW_DAG : FLOW;
  const reached = new Set(events.filter((e) => e.type === 'state_changed').map((e) => e.data.to));
  const gates = Object.values(t.gates);
  const kids = new Map(children.map((c) => [c.id, c]));
  const actions = [];
  if (t.state === 'AWAITING_APPROVAL') actions.push('approve');
  if (t.state === 'BLOCKED') actions.push('resume');
  if (!['DONE', 'FAILED', 'CANCELLED'].includes(t.state)) actions.push('cancel');
  $view.innerHTML = `
    <p><a href="#/">← задачи</a>${t.parentId ? ` · подзадача ${esc(t.subtaskKey)} задачи <a href="#/tasks/${esc(t.parentId)}">${esc(t.parentId)}</a>` : ''}</p>
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
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', h === a.getAttribute('href') || (a.dataset.nav === 'tasks' && h.startsWith('#/tasks'))));
  try {
    let m;
    if ((m = h.match(/^#\/tasks\/([\w-]+)/))) await viewTask(m[1]);
    else if ((m = h.match(/^#\/report\/([\w-]+)/))) await viewReport(m[1]);
    else if (h.startsWith('#/approvals')) await viewApprovals();
    else if (h.startsWith('#/metrics')) await viewMetrics();
    else await viewTasks();
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
    const h = location.hash;
    const relevant = !h.startsWith('#/tasks/') || h.includes(e.taskId) || e.type === 'state_changed';
    if (!relevant || document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
    clearTimeout(pending);
    pending = setTimeout(render, 400);
  };
}

window.addEventListener('hashchange', render);
await render();
connectLive();
