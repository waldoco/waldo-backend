import type { TelegramOwnerApi } from './telegram-listener';

export const createTelegramCaller = (token: string, fetcher: typeof fetch = fetch) =>
  async (method: string, body: object): Promise<unknown> => {
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await response.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number };
    if (!json.ok) throw new Error(`telegram ${method} failed: ${json.error_code} ${json.description}`);
    return json.result;
  };

export const createTelegramOwnerApi = (call: ReturnType<typeof createTelegramCaller>): TelegramOwnerApi => ({
  setMessageReaction: (request) => call('setMessageReaction', request),
  sendChatAction: (request) => call('sendChatAction', request),
  sendMessage: (request) => call('sendMessage', request),
});
