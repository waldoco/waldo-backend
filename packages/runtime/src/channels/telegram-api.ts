import type { TelegramOwnerApi } from './telegram-listener';

// Every Bot API call is bounded: a hung response (the API applied the change but the
// connection never completed) must reject, or a single wedged egress stalls the whole turn.
export const TELEGRAM_API_TIMEOUT_MS = 15_000;

export const createTelegramCaller = (token: string, fetcher: typeof fetch = fetch, timeoutMs = TELEGRAM_API_TIMEOUT_MS) =>
  async (method: string, body: object): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
      });
      const json = await response.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number };
      if (!json.ok) throw new Error(`telegram ${method} failed: ${json.error_code} ${json.description}`);
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  };

// Once the owner unlinks Telegram, nothing more goes out to that chat, including queued reminders and cards.
export const gatedCaller = (call: ReturnType<typeof createTelegramCaller>, unlinked: () => boolean): ReturnType<typeof createTelegramCaller> =>
  async (method, body) => {
    if (!unlinked()) return call(method, body);
    console.log(JSON.stringify({ hop: 'telegram_send', ok: false, skipped: 'unlinked', method }));
    return undefined;
  };

export const createTelegramOwnerApi = (call: ReturnType<typeof createTelegramCaller>): TelegramOwnerApi => ({
  setMessageReaction: (request) => call('setMessageReaction', request),
  sendChatAction: (request) => call('sendChatAction', request),
  sendMessage: (request) => call('sendMessage', request),
});
