import { describe, expect, it, vi } from 'vitest';
import { handleTelegramWebhook, type TelegramWebhookEnv } from '../src/channels/telegram-webhook';

const namespace = () => {
  const fetch = vi.fn(async () => new Response('ok'));
  const idFromName = vi.fn((name: string) => name);
  return { fetch, idFromName, ns: { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace };
};
const post = (secret: string | null, body = '{"update_id":1}') => new Request('https://w.test/telegram/webhook', {
  method: 'POST', body, headers: secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret },
});

describe('handleTelegramWebhook', () => {
  it('hands a verified update to the owner Durable Object and answers at once', async () => {
    const { fetch, idFromName, ns } = namespace();
    const pending: Promise<unknown>[] = [];
    const env: TelegramWebhookEnv = { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret', WALDO_OWNER_TELEGRAM_ID: '42' };
    const response = await handleTelegramWebhook(post('s3cret'), env, (work) => pending.push(work));
    expect(response.status).toBe(200);
    await Promise.all(pending);
    expect(idFromName).toHaveBeenCalledWith('42');
    expect(fetch).toHaveBeenCalledWith('https://telegram-owner/turn', { method: 'POST', body: '{"update_id":1}', headers: { 'x-waldo-origin': 'https://w.test' } });
  });

  it('rejects a missing or wrong secret and hides the route when unconfigured', async () => {
    const { fetch, ns } = namespace();
    const env: TelegramWebhookEnv = { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret', WALDO_OWNER_TELEGRAM_ID: '42' };
    const noop = () => undefined;
    expect((await handleTelegramWebhook(post(null), env, noop)).status).toBe(403);
    expect((await handleTelegramWebhook(post('s3cre'), env, noop)).status).toBe(403);
    expect((await handleTelegramWebhook(new Request('https://w.test/telegram/webhook'), env, noop)).status).toBe(404);
    expect((await handleTelegramWebhook(post('s3cret'), { ...env, TELEGRAM_WEBHOOK_SECRET: undefined }, noop)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
