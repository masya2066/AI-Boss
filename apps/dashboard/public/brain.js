// "Brain" view: the orchestrator in the centre, tasks branching off it, subtasks off the
// tasks and the agents at work off those. Canvas 2D, no dependencies. Every frame the
// nodes ease towards their target layout; events fire signals that travel along branches.

const ROLE_ICON = { researcher: '🔎', architect: '📐', developer: '💻', qa: '🧪', reviewer: '👁', fixer: '🔧', integrator: '🔀' };
const ROLE_RU = { researcher: 'исследователь', architect: 'архитектор', developer: 'разработчик', qa: 'тестировщик', reviewer: 'ревьюер', fixer: 'исправляющий', integrator: 'интегратор' };
const TOOL_RU = { Read: 'читает', Edit: 'правит', Write: 'пишет', MultiEdit: 'правит', Bash: 'запускает', Grep: 'ищет', Glob: 'ищет', LS: 'смотрит', TodoWrite: 'планирует' };
const STAGE_RU = { QUEUED: 'очередь', DISCOVERY: 'исследование', SPECIFICATION: 'спецификация', IMPACT_ANALYSIS: 'анализ', DECOMPOSITION: 'разбиение', EXECUTING_SUBTASKS: 'подзадачи', IMPLEMENTATION: 'код', VALIDATION: 'проверки', REVIEW: 'ревью', REPAIR: 'исправление', DELIVERY: 'сдача', DONE: 'готово', AWAITING_APPROVAL: 'ждёт решения', BLOCKED: 'остановлено', FAILED: 'ошибка', CANCELLED: 'отменено' };
const TERMINAL = ['DONE', 'FAILED', 'CANCELLED'];
const short = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
const ease = (a, b, k) => a + (b - a) * k;

export function createBrain(canvas, { onOpen } = {}) {
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const nodes = new Map(); // id -> node (persistent, so layout changes animate)
  let edges = [];
  let links = []; // dependsOn between subtasks
  const signals = [];
  let view = { x: 0, y: 0, s: 1 };
  let hover = null;
  let running = true;
  let lastAmbient = 0;
  let brainPulse = 0;

  const css = () => {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    return { bg: v('--panel'), text: v('--text'), muted: v('--muted'), line: v('--line'), ok: v('--ok'), bad: v('--bad'), warn: v('--warn'), info: v('--info'), idle: v('--idle'), accent: v('--accent') };
  };
  let C = css();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => (C = css()));
  const colorOf = (st) => (st === 'DONE' ? C.ok : ['BLOCKED', 'FAILED'].includes(st) ? C.bad : st === 'AWAITING_APPROVAL' ? C.warn : st === 'CANCELLED' || st === 'QUEUED' || !st ? C.idle : C.info);

  function upsert(id, props) {
    let n = nodes.get(id);
    if (!n) {
      const parent = props.parent && nodes.get(props.parent);
      n = { id, x: parent ? parent.x : 0, y: parent ? parent.y : 0, k: 0, born: performance.now(), alive: true };
      nodes.set(id, n);
    }
    Object.assign(n, props, { alive: true, seen: true });
    return n;
  }

  /** New data from GET /live. Positions are targets; nodes glide there. */
  function update(live) {
    for (const n of nodes.values()) n.seen = false;
    edges = [];
    links = [];
    upsert('brain', { type: 'brain', tx: 0, ty: 0, r: 44, label: 'DevPilot', state: 'RUN' });
    const tasks = live.tasks;
    const N = Math.max(1, tasks.length);
    tasks.forEach((x, i) => {
      const t = x.task;
      const a = N === 1 ? Math.PI : -Math.PI / 2 + (2 * Math.PI * i) / N;
      const sector = N === 1 ? Math.PI * 1.7 : Math.min((2 * Math.PI) / N, Math.PI) * 0.9;
      const R1 = N === 1 ? 150 : 190;
      const tid = `t:${t.id}`;
      upsert(tid, { type: 'task', parent: 'brain', tx: Math.cos(a) * R1, ty: Math.sin(a) * R1, r: 26, label: short(t.title, 34), sub: STAGE_RU[t.state] || t.state, state: t.state, href: `#/tasks/${t.id}`, angle: a, taskId: t.id });
      edges.push(['brain', tid]);
      const kids = new Map(x.children.map((c) => [c.id, c]));
      const subs = t.subtasks || [];
      const liveRuns = x.running.filter((r) => {
        const owner = r.taskId === t.id ? t : kids.get(r.taskId);
        return owner && !TERMINAL.includes(owner.state) && !['AWAITING_APPROVAL', 'BLOCKED'].includes(owner.state);
      });
      const owners = subs.map((s) => ({ key: s.key, id: `s:${t.id}:${s.key}`, taskId: s.taskId, s })); // stable id: no jump when spawned
      const R2 = R1 + 170;
      owners.forEach((o, j) => {
        const aa = a + (owners.length === 1 ? 0 : -sector / 2 + (sector * j) / (owners.length - 1));
        const c = o.taskId ? kids.get(o.taskId) : undefined;
        const st = c ? c.state : 'QUEUED';
        upsert(o.id, {
          type: 'sub', parent: tid, tx: Math.cos(aa) * R2, ty: Math.sin(aa) * R2, r: 19, angle: aa,
          label: `${o.key} · ${short(o.s.title, 22)}`, sub: o.s.integratedCommit ? 'влита' : c ? STAGE_RU[st] || st : o.s.dependsOn.length ? `ждёт ${o.s.dependsOn.join(', ')}` : 'в очереди',
          state: o.s.integratedCommit ? 'DONE' : st, key: o.key, href: c ? `#/tasks/${c.id}` : '', taskId: o.taskId,
        });
        edges.push([tid, o.id]);
      });
      for (const o of owners) for (const d of o.s.dependsOn) { const from = owners.find((p) => p.key === d); if (from) links.push([from.id, o.id]); }
      // agents hang off whoever runs them (a subtask or the task itself)
      const byOwner = new Map();
      for (const r of liveRuns) {
        const ownerId = r.taskId === t.id ? tid : owners.find((o) => o.taskId === r.taskId)?.id;
        if (!ownerId) continue;
        (byOwner.get(ownerId) || byOwner.set(ownerId, []).get(ownerId)).push(r);
      }
      for (const [ownerId, runs] of byOwner) {
        const owner = nodes.get(ownerId);
        const base = owner.angle ?? a;
        const dist = owner.type === 'task' ? R2 : R2 + 120;
        runs.forEach((r, k) => {
          const aa = base + (runs.length === 1 ? 0 : (k - (runs.length - 1) / 2) * 0.22);
          const act = x.lastActivity[r.taskId];
          upsert(`a:${r.id}`, {
            type: 'agent', parent: ownerId, tx: Math.cos(aa) * dist, ty: Math.sin(aa) * dist, r: 14, angle: aa,
            icon: ROLE_ICON[r.role] || '🤖', label: ROLE_RU[r.role] || r.role,
            sub: act ? `${TOOL_RU[act.tool] || act.tool} ${short((act.target || '').split(/[\\/ ]/).filter(Boolean).pop() || '', 22)}` : 'думает…',
            state: 'RUN', taskId: r.taskId,
          });
          edges.push([ownerId, `a:${r.id}`]);
        });
      }
    });
    for (const n of nodes.values()) if (!n.seen && n.alive) (n.alive = false), (n.dying = performance.now());
    fit();
  }

  function fit() {
    const pts = [...nodes.values()].filter((n) => n.alive);
    if (!pts.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of pts) {
      x0 = Math.min(x0, n.tx - n.r - 90); x1 = Math.max(x1, n.tx + n.r + 90);
      y0 = Math.min(y0, n.ty - n.r - 20); y1 = Math.max(y1, n.ty + n.r + 46);
    }
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return; // not laid out yet; the ResizeObserver fits again
    const s = Math.min(1.25, Math.min(w / (x1 - x0), h / (y1 - y0)));
    view.target = { s, x: w / 2 - ((x0 + x1) / 2) * s, y: h / 2 - ((y0 + y1) / 2) * s };
    if (!view.fitted) Object.assign(view, view.target, { fitted: true }); // first frame: no zoom-in from a corner
  }

  /** A signal travels brain -> task -> subtask -> agent (or reverse) along the branches. */
  function signal(path, color) {
    if (reduce) return;
    const ids = path.filter((id) => nodes.get(id)?.alive);
    if (ids.length < 2) return;
    signals.push({ ids, t: 0, color: color || C.info, speed: 0.9 + Math.random() * 0.5 });
    if (signals.length > 80) signals.shift();
  }
  const ancestry = (id) => {
    const out = [];
    for (let n = nodes.get(id); n; n = n.parent ? nodes.get(n.parent) : undefined) out.unshift(n.id);
    return out;
  };

  /** Live event from SSE. */
  function pulse(e) {
    brainPulse = 1;
    const taskNode = [...nodes.values()].find((n) => n.alive && n.type !== 'agent' && n.taskId === e.taskId);
    const agent = [...nodes.values()].find((n) => n.alive && n.type === 'agent' && n.taskId === e.taskId);
    const target = agent || taskNode;
    if (!target) return;
    const color = e.type === 'state_changed' ? colorOf(e.data?.to) : e.type === 'agent_activity' ? (['Edit', 'Write', 'MultiEdit'].includes(e.data?.tool) ? C.accent : C.info) : C.warn;
    // activity flows out to the agent; results (state changes) flow back to the brain
    const path = ancestry(target.id);
    signal(e.type === 'agent_activity' ? path : path.slice().reverse(), color);
    if (e.type === 'state_changed' && taskNode) taskNode.flash = performance.now();
  }

  // -------------------------------------------------------------- drawing --
  function resize() {
    const dpr = devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fit();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  const curve = (a, b) => {
    // bow branches slightly so the tree looks organic
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y;
    return { cx: mx - dy * 0.12, cy: my + dx * 0.12 };
  };
  const onCurve = (a, b, t) => {
    const { cx, cy } = curve(a, b);
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y };
  };

  function frame(now) {
    if (!running) return;
    if (!canvas.isConnected) return destroy();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (view.target) {
      view.s = ease(view.s, view.target.s, 0.08);
      view.x = ease(view.x, view.target.x, 0.08);
      view.y = ease(view.y, view.target.y, 0.08);
    }
    for (const n of nodes.values()) {
      n.x = ease(n.x, n.tx, reduce ? 1 : 0.07);
      n.y = ease(n.y, n.ty, reduce ? 1 : 0.07);
      n.k = n.alive ? Math.min(1, n.k + 0.05) : Math.max(0, n.k - 0.04);
      if (!n.alive && n.k === 0) nodes.delete(n.id);
    }
    brainPulse = Math.max(0, brainPulse - 0.02);
    // ambient: every running agent periodically reports back to the brain
    if (!reduce && now - lastAmbient > 900) {
      lastAmbient = now;
      for (const n of nodes.values()) if (n.type === 'agent' && n.alive && Math.random() < 0.6) signal(ancestry(n.id).reverse(), C.accent);
    }

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.s, view.s);

    // dependency links between subtasks (dashed arcs)
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1.2;
    for (const [a, b] of links) {
      const A = nodes.get(a), B = nodes.get(b);
      if (!A || !B) continue;
      ctx.globalAlpha = 0.5 * Math.min(A.k, B.k);
      ctx.strokeStyle = C.muted;
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.quadraticCurveTo((A.x + B.x) / 2 * 1.15, (A.y + B.y) / 2 * 1.15, B.x, B.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // branches
    for (const [a, b] of edges) {
      const A = nodes.get(a), B = nodes.get(b);
      if (!A || !B) continue;
      const { cx, cy } = curve(A, B);
      const active = B.state && !['DONE', 'QUEUED', 'CANCELLED'].includes(B.state);
      ctx.globalAlpha = Math.min(A.k, B.k) * (active ? 0.9 : 0.45);
      ctx.strokeStyle = B.state === 'DONE' ? C.ok : active ? C.info : C.line;
      ctx.lineWidth = B.type === 'task' ? 3.5 : B.type === 'sub' ? 2.5 : 1.6;
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.quadraticCurveTo(cx, cy, B.x, B.y);
      ctx.stroke();
    }

    // signals
    for (let i = signals.length - 1; i >= 0; i--) {
      const s = signals[i];
      s.t += 0.018 * s.speed * (60 / 60);
      const seg = Math.floor(s.t);
      if (seg >= s.ids.length - 1) {
        signals.splice(i, 1);
        continue;
      }
      const A = nodes.get(s.ids[seg]), B = nodes.get(s.ids[seg + 1]);
      if (!A || !B) {
        signals.splice(i, 1);
        continue;
      }
      for (let k = 0; k < 6; k++) {
        const tt = Math.max(0, (s.t - seg) - k * 0.035);
        const p = onCurve(A, B, tt);
        ctx.globalAlpha = (1 - k / 6) * 0.9;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.6 - k * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // nodes
    ctx.textAlign = 'center';
    for (const n of nodes.values()) {
      const k = n.k;
      if (k <= 0) continue;
      const r = n.r * (0.6 + 0.4 * k);
      const col = n.type === 'brain' ? C.accent : n.type === 'agent' ? C.accent : colorOf(n.state);
      const isRun = n.type === 'agent' || n.type === 'brain' || (!TERMINAL.includes(n.state) && n.state !== 'QUEUED' && n.state !== 'BLOCKED' && n.state !== 'AWAITING_APPROVAL');
      ctx.globalAlpha = k;
      // glow / breathing ring
      if (isRun && !reduce) {
        const ph = (Math.sin(now / 420 + (n.x + n.y) * 0.01) + 1) / 2;
        ctx.strokeStyle = col;
        ctx.globalAlpha = k * (0.15 + 0.25 * ph + (n.type === 'brain' ? brainPulse * 0.5 : 0));
        ctx.lineWidth = n.type === 'brain' ? 10 : 6;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 5 + ph * 4 + (n.type === 'brain' ? brainPulse * 10 : 0), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (n.flash && now - n.flash < 900) {
        const f = (now - n.flash) / 900;
        ctx.globalAlpha = k * (1 - f);
        ctx.strokeStyle = col;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + f * 40, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = k;
      ctx.fillStyle = C.bg;
      ctx.strokeStyle = col;
      ctx.lineWidth = n === hover ? 4 : 2.5;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (n.type === 'brain') {
        // neurons orbiting the brain
        if (!reduce) for (let i = 0; i < 6; i++) {
          const aa = now / (900 + i * 170) + (i * Math.PI) / 3;
          ctx.fillStyle = C.accent;
          ctx.globalAlpha = k * 0.7;
          ctx.beginPath();
          ctx.arc(n.x + Math.cos(aa) * (r + 14), n.y + Math.sin(aa) * (r + 14), 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = k;
        ctx.font = `${Math.round(r * 1.05)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji"`;
        ctx.textBaseline = 'middle';
        ctx.fillText('🧠', n.x, n.y + 2);
        ctx.font = '600 13px system-ui';
        ctx.fillStyle = C.text;
        ctx.textBaseline = 'top';
        ctx.fillText('DevPilot', n.x, n.y + r + 24);
        continue;
      }
      ctx.textBaseline = 'middle';
      if (n.type === 'agent') {
        ctx.font = `${Math.round(r * 1.1)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji"`;
        ctx.fillText(n.icon, n.x, n.y + 1);
      } else {
        ctx.fillStyle = col;
        ctx.font = `700 ${n.type === 'task' ? 13 : 11}px system-ui`;
        ctx.fillText(n.type === 'task' ? (n.state === 'DONE' ? '✓' : n.state === 'BLOCKED' ? '!' : '●') : n.key || '', n.x, n.y + 1);
      }
      // labels stay readable when the whole tree is zoomed out to fit
      const fs = Math.min(1.6, Math.max(1, 0.95 / view.s));
      ctx.textBaseline = 'top';
      ctx.fillStyle = C.text;
      ctx.font = `600 ${(n.type === 'task' ? 13 : 11.5) * fs}px system-ui`;
      ctx.fillText(n.label, n.x, n.y + r + 7);
      ctx.fillStyle = C.muted;
      ctx.font = `${11 * fs}px system-ui`;
      if (n.sub) ctx.fillText(n.sub, n.x, n.y + r + 9 + 14 * fs);
    }
    ctx.restore();
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ interaction --
  const at = (ev) => {
    const b = canvas.getBoundingClientRect();
    const x = (ev.clientX - b.left - view.x) / view.s, y = (ev.clientY - b.top - view.y) / view.s;
    let best = null;
    for (const n of nodes.values()) if (n.alive && Math.hypot(n.x - x, n.y - y) <= n.r + 6) best = n;
    return best;
  };
  canvas.addEventListener('mousemove', (ev) => {
    hover = at(ev);
    canvas.style.cursor = hover?.href ? 'pointer' : 'default';
    canvas.title = hover ? [hover.label, hover.sub].filter(Boolean).join(' — ') : '';
  });
  canvas.addEventListener('click', (ev) => {
    const n = at(ev);
    if (n?.href) onOpen?.(n.href);
  });

  function destroy() {
    running = false;
    ro.disconnect();
  }
  resize();
  requestAnimationFrame(frame);
  return { update, pulse, destroy, get alive() { return running && canvas.isConnected; } };
}
