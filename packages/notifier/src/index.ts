import { createHmac } from 'node:crypto';
import type { Orchestrator, OrchestratorEvent } from '@devpilot/orchestrator';
import type { Task } from '@devpilot/shared';

/** What is worth interrupting a human for. */
export const DEFAULT_NOTIFY_ON = ['AWAITING_APPROVAL', 'BLOCKED', 'DONE', 'FAILED', 'pr_created', 'paused_usage_limit', 'paused_daily_budget'];

export interface NotifierConfig {
  telegram?: { token: string; chatId: string; apiBase?: string };
  webhook?: { url: string; secret?: string };
  on: string[];
  dashboardUrl?: string;
}

export function notifierConfigFromEnv(env = process.env): NotifierConfig | undefined {
  const telegram = env.DEVPILOT_TELEGRAM_BOT_TOKEN && env.DEVPILOT_TELEGRAM_CHAT_ID ? { token: env.DEVPILOT_TELEGRAM_BOT_TOKEN, chatId: env.DEVPILOT_TELEGRAM_CHAT_ID, apiBase: env.DEVPILOT_TELEGRAM_API } : undefined;
  const webhook = env.DEVPILOT_WEBHOOK_URL ? { url: env.DEVPILOT_WEBHOOK_URL, secret: env.DEVPILOT_WEBHOOK_SECRET } : undefined;
  if (!telegram && !webhook) return undefined;
  return { telegram, webhook, on: env.DEVPILOT_NOTIFY_ON ? env.DEVPILOT_NOTIFY_ON.split(',').map((s) => s.trim()) : DEFAULT_NOTIFY_ON, dashboardUrl: env.DEVPILOT_DASHBOARD_URL };
}

/** Event -> notification key: state changes use the target state, other events their type. */
export const keyOf = (e: OrchestratorEvent) => (e.type === 'state_changed' ? String(e.data.to) : e.type);

export function formatNotification(task: Task, e: OrchestratorEvent, dashboardUrl?: string): string {
  const head = `${task.id}: ${task.title}`;
  const link = dashboardUrl ? `\n${dashboardUrl.replace(/\/$/, '')}/#/tasks/${task.id}` : '';
  const gates = Object.values(task.gates).filter((g) => g.required);
  const passed = gates.filter((g) => g.status === 'passed').length;
  switch (keyOf(e)) {
    case 'AWAITING_APPROVAL':
      return `❓ Нужно решение · ${head}\n${task.approval?.reason ?? ''}\n${(task.approval?.questions ?? []).map((q) => `• ${q}`).join('\n')}\n\nОтветить: /approve ${task.id} <ответ>${link}`;
    case 'BLOCKED':
      return `⛔ Остановлено · ${head}\n${task.stopReason ?? ''}\n\nПосле исправления: /resume ${task.id} <что изменили>${link}`;
    case 'DONE':
      return `✅ Готово · ${head}\n${task.prUrl ? `PR: ${task.prUrl}` : `Ветка: ${task.branch}`}\nПроверки: ${passed}/${gates.length} · исправлений: ${task.repairAttempts} · $${task.costUsd.toFixed(2)}${link}`;
    case 'FAILED':
      return `❌ Ошибка · ${head}\n${task.stopReason ?? ''}${link}`;
    case 'pr_created':
      return `🔀 PR открыт · ${head}\n${String(e.data.prUrl)}\nЖдём CI…${link}`;
    case 'paused_usage_limit':
      return `⏸ Лимит подписки · ${head}\nПродолжу автоматически после ${String(e.data.until)}${link}`;
    case 'paused_daily_budget':
      return `⏸ Дневной бюджет исчерпан ($${String(e.data.spent)} из $${String(e.data.cap)}) · ${head}\nПродолжу после ${String(e.data.until)}${link}`;
    default:
      return `${keyOf(e)} · ${head}${link}`;
  }
}

export async function sendTelegram(cfg: NonNullable<NotifierConfig['telegram']>, text: string, chatId = cfg.chatId) {
  const base = (cfg.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '');
  const r = await fetch(`${base}/bot${cfg.token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}: ${await r.text()}`);
}

export async function sendWebhook(cfg: NonNullable<NotifierConfig['webhook']>, payload: unknown) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.secret) headers['x-devpilot-signature'] = 'sha256=' + createHmac('sha256', cfg.secret).update(body).digest('hex');
  const r = await fetch(cfg.url, { method: 'POST', headers, body });
  if (!r.ok) throw new Error(`webhook ${r.status}`);
}

/**
 * Subscribes to the orchestrator and notifies on important transitions of
 * top-level tasks. Delivery failures are logged, never propagated.
 */
export function attachNotifier(orch: Orchestrator, cfg: NotifierConfig, log: (l: string) => void = () => {}) {
  return orch.on((e) => {
    const key = keyOf(e);
    if (!cfg.on.includes(key)) return;
    void (async () => {
      const task = await orch.store.getTask(e.taskId);
      if (!task || task.parentId) return; // subtasks roll up into their parent
      const text = formatNotification(task, e, cfg.dashboardUrl);
      const jobs: Promise<unknown>[] = [];
      if (cfg.telegram) jobs.push(sendTelegram(cfg.telegram, text));
      if (cfg.webhook)
        jobs.push(sendWebhook(cfg.webhook, { event: key, ts: e.ts, text, task: { id: task.id, projectId: task.projectId, title: task.title, state: task.state, prUrl: task.prUrl, branch: task.branch, costUsd: task.costUsd, stopReason: task.stopReason, approval: task.approval } }));
      for (const r of await Promise.allSettled(jobs)) if (r.status === 'rejected') log(`notify failed: ${r.reason}`);
    })().catch((err) => log(`notify failed: ${err}`));
  });
}

export { TelegramBot, type TelegramBotOptions } from './telegram-bot';
