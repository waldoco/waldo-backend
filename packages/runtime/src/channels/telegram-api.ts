import type { TelegramOwnerApi } from './telegram-listener';

// Every Bot API call is bounded: a hung response (the API applied the change but the
// connection never completed) must reject, or a single wedged egress stalls the whole turn.
export const TELEGRAM_API_TIMEOUT_MS = 15_000;

export class TelegramRejection extends Error {
  constructor(readonly errorCode: number, description: string, readonly retryAfter?: number, method?: string) {
    super(method ? `telegram ${method} failed: ${errorCode} ${description}` : `telegram rejected: ${errorCode} ${description}`);
  }
  get retryable(): boolean { return this.errorCode === 429; }
}

export const createTelegramCaller = (token: string, fetcher: typeof fetch = fetch, timeoutMs = TELEGRAM_API_TIMEOUT_MS) =>
  async (method: string, body: object): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
      });
      const json = await response.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } };
      // Only a structured Telegram rejection is definite. HTTP 5xx/parse/network are unknown.
      if (!response.ok && response.status >= 500) throw new Error('telegram transport unknown');
      if (json.ok === false && Number.isInteger(json.error_code)) throw new TelegramRejection(json.error_code!, json.description ?? '', typeof json.parameters?.retry_after === 'number' && Number.isFinite(json.parameters.retry_after) && json.parameters.retry_after >= 0 ? Math.ceil(json.parameters.retry_after) : undefined, method);
      if (!response.ok || json.ok !== true) throw new Error('telegram invalid acknowledgement');
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  };

// Once the owner unlinks Telegram, nothing more goes out to that chat, including queued reminders and cards.
export const gatedCaller = (call: ReturnType<typeof createTelegramCaller>, blocked: () => boolean | Promise<boolean>): ReturnType<typeof createTelegramCaller> =>
  async (method, body) => {
    if (!(await blocked())) return call(method, body);
    console.log(JSON.stringify({ hop: 'telegram_send', ok: false, skipped: 'blocked', method }));
    return undefined;
  };

// Send-time ownership: the local flag blocks immediately, and when a DB directory is wired the
// presence check makes the database authoritative for every outbound - a rebound channel blocks
// the old owner's sends no matter what its DO remembers. The check fails closed: an error
// blocks the send rather than risking a cross-owner leak.
export const egressGate = (localBlocked: () => boolean, recheck?: () => Promise<boolean>) =>
  async (): Promise<boolean> => {
    if (localBlocked()) return true;
    if (!recheck) return false;
    try {
      return !(await recheck());
    } catch {
      return true;
    }
  };

export const createTelegramOwnerApi = (call: ReturnType<typeof createTelegramCaller>): TelegramOwnerApi => ({
  setMessageReaction: (request) => call('setMessageReaction', request),
  sendChatAction: (request) => call('sendChatAction', request),
  sendMessage: (request) => call('sendMessage', request),
});
