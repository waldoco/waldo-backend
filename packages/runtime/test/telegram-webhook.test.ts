import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleTelegramWebhook, type TelegramWebhookEnv } from '../src/channels/telegram-webhook';
import type { OwnerDirectory } from '../src/identity/owner-directory';

const namespace = () => {
  const fetch = vi.fn(async () => new Response('ok'));
  const idFromName = vi.fn((name: string) => name);
  return { fetch, idFromName, ns: { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace };
};
const message = (from: number, text = 'hi') => JSON.stringify({ update_id: 1, message: { from: { id: from }, chat: { id: from, type: 'private' }, text } });
const post = (secret: string | null, body = message(42)) => new Request('https://w.test/telegram/webhook', {
  method: 'POST', body, headers: secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret },
});
const run = async (request: Request, env: TelegramWebhookEnv, directory?: OwnerDirectory) => {
  const pending: Promise<unknown>[] = [];
  const response = await handleTelegramWebhook(request, env, (work) => pending.push(work), directory);
  await Promise.all(pending);
  return response;
};

afterEach(() => vi.unstubAllGlobals());

describe('handleTelegramWebhook', () => {
  it('hands a verified update from the configured owner to their Durable Object and answers at once', async () => {
    const { fetch, idFromName, ns } = namespace();
    const env: TelegramWebhookEnv = { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret', WALDO_OWNER_TELEGRAM_ID: '42', WALDO_OWNER_TIMEZONE: 'Asia/Kolkata' };
    expect((await run(post('s3cret'), env)).status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('42');
    expect(fetch).toHaveBeenCalledWith('https://telegram-owner/telegram-ingress', {
      method: 'POST', body: message(42),
      headers: { 'x-waldo-origin': 'https://w.test', 'x-waldo-telegram-subject': '42', 'x-waldo-timezone': 'Asia/Kolkata' },
    });
  });

  it('routes each sender to their own owner Durable Object', async () => {
    const { fetch, idFromName, ns } = namespace();
    const directory: OwnerDirectory = {
      byPresence: async (_provider, subject) => ({ '1': { doName: 'do-a', subject: '1', timezone: null }, '2': { doName: 'do-b', subject: '2', timezone: null } })[subject] ?? null,
      redeem: async () => null,
    };
    const env: TelegramWebhookEnv = { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret' };
    await run(post('s3cret', message(1)), env, directory);
    await run(post('s3cret', message(2)), env, directory);
    expect(idFromName.mock.calls.map(([name]) => name)).toEqual(['do-a', 'do-b']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the directory lookup throws, so Telegram redelivers', async () => {
    const { fetch, ns } = namespace();
    const directory: OwnerDirectory = { byPresence: async () => { throw new Error('db down'); }, redeem: async () => null };
    const env: TelegramWebhookEnv = { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret' };
    expect((await run(post('s3cret'), env, directory)).status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when the ingress write fails, so Telegram redelivers', async () => {
    const { fetch, ns } = namespace();
    fetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const directory: OwnerDirectory = { byPresence: async (_p, subject) => ({ doName: 'do-a', subject, timezone: null }), redeem: async () => null };
    const env: TelegramWebhookEnv = { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret' };
    expect((await run(post('s3cret'), env, directory)).status).toBe(500);
  });

  it('fails closed when the ingress fetch throws, so Telegram redelivers', async () => {
    const { fetch, ns } = namespace();
    fetch.mockRejectedValueOnce(new Error('do unreachable'));
    const directory: OwnerDirectory = { byPresence: async (_p, subject) => ({ doName: 'do-a', subject, timezone: null }), redeem: async () => null };
    const env: TelegramWebhookEnv = { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret' };
    expect((await run(post('s3cret'), env, directory)).status).toBe(500);
  });

  it('never wakes an owner for a stranger, a sender-less update, or a stranger trying a link code', async () => {
    const { fetch, ns } = namespace();
    const telegram = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })));
    vi.stubGlobal('fetch', telegram);
    const redeem = vi.fn(async () => null);
    const directory: OwnerDirectory = { byPresence: async () => null, redeem };
    const env: TelegramWebhookEnv = { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret', TELEGRAM_BOT_TOKEN: 'bot' };
    await run(post('s3cret', message(7)), env, directory);
    await run(post('s3cret', '{"update_id":2}'), env, directory);
    await run(post('s3cret', message(7, '/start WRONG1')), env, directory);
    expect(fetch).not.toHaveBeenCalled();
    expect(redeem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((telegram.mock.calls[0] as unknown as [string, RequestInit])[1].body)).text).toContain('did not work');
  });

  it('binds a stranger who sends a valid link code and tells them', async () => {
    const { fetch, ns } = namespace();
    const telegram = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })));
    vi.stubGlobal('fetch', telegram);
    const redeem = vi.fn(async () => ({ doName: 'do-a', subject: '7', timezone: null }));
    const env: TelegramWebhookEnv = { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret', TELEGRAM_BOT_TOKEN: 'bot' };
    await run(post('s3cret', message(7, '/link GOOD12')), env, { byPresence: async () => null, redeem });
    expect(redeem).toHaveBeenCalledWith('telegram', '7', 'GOOD12');
    expect(JSON.parse(String((telegram.mock.calls[0] as unknown as [string, RequestInit])[1].body)).text).toContain('Linked');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores link codes sent from a group chat', async () => {
    const { ns } = namespace();
    const redeem = vi.fn(async () => null);
    const group = JSON.stringify({ update_id: 3, message: { from: { id: 7 }, chat: { id: -5, type: 'group' }, text: '/link GOOD12' } });
    await run(post('s3cret', group), { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret', TELEGRAM_BOT_TOKEN: 'bot' }, { byPresence: async () => null, redeem });
    expect(redeem).not.toHaveBeenCalled();
  });

  it('rejects a missing or wrong secret and hides the route when unconfigured', async () => {
    const { fetch, ns } = namespace();
    const env: TelegramWebhookEnv = { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret', WALDO_OWNER_TELEGRAM_ID: '42' };
    expect((await run(post(null), env)).status).toBe(403);
    expect((await run(post('s3cre'), env)).status).toBe(403);
    expect((await run(new Request('https://w.test/telegram/webhook'), env)).status).toBe(404);
    expect((await run(post('s3cret'), { ...env, TELEGRAM_WEBHOOK_SECRET: undefined })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
