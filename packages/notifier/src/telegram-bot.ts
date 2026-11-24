import type { Orchestrator } from '@devpilot/orchestrator';
import { computeMetrics } from '@devpilot/metrics';
import { sendTelegram, type NotifierConfig } from './index';

export interface TelegramBotOptions {
  telegram: NonNullable<NotifierConfig['telegram']>;
  orchestrator: Orchestrator;
  /** Schedule a task after a command changed it (queue job or in-process run). */
  schedule: (taskId: string) => Promise<void>;
  log?: (l: string) => void;
}

const HELP = `Команды DevPilot:
/tasks — последние задачи
/status <TASK> — состояние задачи
/run <project> <задача> — поставить задачу
/approve <TASK> <ответ> — ответить на запрос решения
/resume <TASK> [что изменили] — продолжить остановленную
/cancel <TASK> — отменить
/metrics [project] — метрики качества и стоимости`;

/**
 * Minimal Telegram control surface (long polling). Only the configured chat is
 * served; messages from anyone else are ignored.
 */
export class TelegramBot {
  private offset = 0;
  private stopped = false;
  private readonly base: string;
  constructor(private readonly o: TelegramBotOptions) {
    this.base = `${(o.telegram.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '')}/bot${o.telegram.token}`;
  }

  start() {
    void this.loop();
    return this;
  }
  stop() {
    this.stopped = true;
  }

  private async loop() {
    while (!this.stopped) {
      try {
        const r = await fetch(`${this.base}/getUpdates?timeout=25&offset=${this.offset}`);
        const body = (await r.json()) as { result?: { update_id: number; message?: { chat: { id: number }; text?: string } }[] };
        for (const u of body.result ?? []) {
          this.offset = u.update_id + 1;
          if (!u.message?.text || String(u.message.chat.id) !== String(this.o.telegram.chatId)) continue;
          const reply = await this.handle(u.message.text).catch((e: Error) => `Ошибка: ${e.message}`);
          await sendTelegram(this.o.telegram, reply);
        }
      } catch (e) {
        this.o.log?.(`telegram poll failed: ${e}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  /** Never throws: errors become a reply, so a typo can't kill the bot loop. */
  async handle(text: string): Promise<string> {
    try {
      return await this.dispatch(text);
    } catch (e) {
      return `Ошибка: ${(e as Error).message}`;
    }
  }

  private async dispatch(text: string): Promise<string> {
    const [cmdRaw, ...rest] = text.trim().split(/\s+/);
    const cmd = cmdRaw!.replace(/@\w+$/, '').toLowerCase();
    const orch = this.o.orchestrator;
    const store = orch.store;
    switch (cmd) {
      case '/tasks': {
        const ts = (await store.listTasks()).filter((t) => !t.parentId).slice(-10).reverse();
        return ts.map((t) => `${t.id} · ${t.state} · $${t.costUsd.toFixed(2)}\n  ${t.title}`).join('\n') || 'Задач нет';
      }
      case '/status': {
        const t = await store.getTask(rest[0] ?? '');
        if (!t) return 'Не найдено';
        const g = Object.values(t.gates).filter((x) => x.required);
        return [
          `${t.id} · ${t.state}`,
          t.title,
          g.length ? `Проверки: ${g.map((x) => `${x.status === 'passed' ? '✓' : x.status === 'failed' ? '✗' : '·'}${x.name}`).join(' ')}` : '',
          t.subtasks?.length ? `Подзадачи: ${t.subtasks.map((s) => `${s.key}${s.integratedCommit ? '✓' : ''}`).join(' ')}` : '',
          t.approval && t.state === 'AWAITING_APPROVAL' ? `Вопрос: ${t.approval.questions.join(' / ')}` : '',
          t.stopReason && t.state === 'BLOCKED' ? `Причина: ${t.stopReason}` : '',
          t.prUrl ? `PR: ${t.prUrl}` : '',
          `Стоимость: $${t.costUsd.toFixed(2)}`,
        ].filter(Boolean).join('\n');
      }
      case '/run': {
        const [projectId, ...words] = rest;
        if (!projectId || words.length < 2) return 'Формат: /run <project> <описание задачи>';
        const t = await orch.createTask({ projectId, prompt: words.join(' ') });
        await this.o.schedule(t.id);
        return `Поставлена ${t.id}`;
      }
      case '/approve': {
        const [id, ...words] = rest;
        const t = await orch.approve(id!, words.join(' ') || 'approved');
        await this.o.schedule(t.id);
        return `Принято, ${t.id} продолжает (${t.state})`;
      }
      case '/resume': {
        const [id, ...words] = rest;
        const t = await orch.resume(id!, { note: words.join(' ') || undefined });
        await this.o.schedule(t.id);
        return `${t.id} продолжает (${t.state})`;
      }
      case '/cancel': {
        const t = await orch.cancel(rest[0]!);
        return `${t.id} отменена`;
      }
      case '/metrics': {
        const m = await computeMetrics(store, { projectId: rest[0] });
        const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
        return [
          `Задач: ${m.tasks.total} (готово ${m.tasks.done}, остановлено ${m.tasks.blocked}, ждут решения ${m.tasks.awaitingHuman})`,
          `С первого раза: ${pct(m.firstPassSuccessRate)} · без участия человека: ${pct(m.autonomousCompletionRate)}`,
          `Покрытие требований: ${pct(m.requirementCoverage)} · восстановление: ${pct(m.recovery.rate)}`,
          `Стоимость принятой задачи: ${m.costPerAcceptedTaskUsd === null ? '—' : '$' + m.costPerAcceptedTaskUsd.toFixed(2)} · всего $${m.totalCostUsd.toFixed(2)}`,
        ].join('\n');
      }
      default:
        return HELP;
    }
  }
}
