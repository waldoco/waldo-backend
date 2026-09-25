import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleWhatsAppWebhook, type WhatsAppWebhookEnv } from '../src/channels/whatsapp-webhook';
import type { OwnerDirectory } from '../src/identity/owner-directory';

const namespace = () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'));
  const idFromName = vi.fn((name: string) => name);
  return { fetch, idFromName, ns: { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace };
};

const sign = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hex = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
};

const payload = (messages: { from: string; text?: string }[], statuses = false) => JSON.stringify({
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: 'pn1' },
    messages: messages.map((m, i) => ({ from: m.from, id: `wamid.${i}`, type: 'text', text: { body: m.text ?? 'hi' } })),
    ...(statuses ? { statuses: [{ id: 'wamid.0', status: 'delivered' }] } : {}),
  } }] }],
});

const post = async (secret: string | null, body: string, appSecret = 'appsecret') => new Request('https://w.test/whatsapp/webhook', {
  method: 'POST', body,
  headers: secret === null ? {} : { 'x-hub-signature-256': await sign(appSecret, body) },
});

const run = async (request: Request, env: WhatsAppWebhookEnv, directory?: OwnerDirectory) => {
  const pending: Promise<unknown>[] = [];
  const response = await handleWhatsAppWebhook(request, env, (work) => pending.push(work), directory);
  await Promise.all(pending);
  return response;
};

afterEach(() => vi.unstubAllGlobals());

describe('handleWhatsAppWebhook', () => {
  it('GET verify: echoes the challenge for the right token, 403 otherwise', async () => {
    const { ns } = namespace();
    const env: WhatsAppWebhookEnv = { TELEGRAM_OWNER_DO: ns, WHATSAPP_VERIFY_TOKEN: 'vt' };
    const ok = await run(new Request('https://w.test/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=ch123'), env);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('ch123');
    expect((await run(new Request('https://w.test/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=ch123'), env)).status).toBe(403);
  });

  it('bad or missing signature is a 403 and never routes', async () => {
    const { fetch, ns } = namespace();
    const env: WhatsAppWebhookEnv = { TELEGRAM_OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret' };
    const body = payload([{ from: '15550001111' }]);
    expect((await run(await post(null, body), env)).status).toBe(403);
    expect((await run(new Request('https://w.test/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=deadbeef' } }), env)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('routes a verified message to the right owner DO with the whatsapp subject header', async () => {
    const { fetch, idFromName, ns } = namespace();
    const directory: OwnerDirectory = {
      byPresence: async (provider, subject) => {
        expect(provider).toBe('whatsapp');
        return subject === '15550001111' ? { doName: 'do-a', subject, timezone: 'Asia/Kolkata' } : null;
      },
      redeem: async () => null,
    };
    const env: WhatsAppWebhookEnv = { TELEGRAM_OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret' };
    const body = payload([{ from: '15550001111' }], true);
    expect((await run(await post('x', body), env, directory)).status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('do-a');
    expect(fetch).toHaveBeenCalledWith('https://telegram-owner/whatsapp-turn', {
      method: 'POST', body: expect.any(String),
      headers: { 'x-waldo-origin': 'https://w.test', 'x-waldo-whatsapp-subject': '15550001111', 'x-waldo-timezone': 'Asia/Kolkata' },
    });
    // the forwarded body carries only that sender's messages, never the status callbacks
    const forwarded = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as { messages: unknown[]; statuses?: unknown[] };
    expect(forwarded.messages).toHaveLength(1);
    expect(forwarded.statuses).toBeUndefined();
  });

  it('a multi-sender payload routes each owner only their own messages', async () => {
    const { fetch, ns } = namespace();
    const directory: OwnerDirectory = {
      byPresence: async (_p, subject) => ({ '15550001111': { doName: 'do-a', subject, timezone: null }, '15550002222': { doName: 'do-b', subject, timezone: null } })[subject] ?? null,
      redeem: async () => null,
    };
    const env: WhatsAppWebhookEnv = { TELEGRAM_OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret' };
    await run(await post('x', payload([{ from: '15550001111', text: 'one' }, { from: '15550002222', text: 'two' }])), env, directory);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) {
      const value = JSON.parse(String(call[1]!.body)) as { messages: { from: string; text: { body: string } }[] };
      expect(value.messages).toHaveLength(1);
      const only = value.messages[0]!;
      expect(['one', 'two']).toContain(only.text.body);
    }
  });

  it('an unknown sender wakes no DO; a valid link code redeems and replies, a bad one declines', async () => {
    const { fetch, ns } = namespace();
    const graph = vi.fn(async () => Response.json({ messages: [{ id: 'wamid.out' }] }));
    vi.stubGlobal('fetch', graph);
    const redeem = vi.fn(async (_p: string, _s: string, code: string) => code === 'GOOD12' ? { doName: 'do-a', subject: '15550003333', timezone: null } : null);
    const directory: OwnerDirectory = { byPresence: async () => null, redeem };
    const env: WhatsAppWebhookEnv = {
      TELEGRAM_OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret', WHATSAPP_ACCESS_TOKEN: 'wabearer-t0ken', WHATSAPP_PHONE_NUMBER_ID: 'pn1',
    };
    // unknown sender, no code: nothing happens
    await run(await post('x', payload([{ from: '15550003333', text: 'hello' }])), env, directory);
    expect(fetch).not.toHaveBeenCalled();
    expect(redeem).not.toHaveBeenCalled();
    // valid code
    await run(await post('x', payload([{ from: '15550003333', text: 'waldo GOOD12' }])), env, directory);
    expect(redeem).toHaveBeenCalledWith('whatsapp', '15550003333', 'GOOD12');
    expect(JSON.parse(String((graph.mock.calls[0] as unknown as [string, RequestInit])[1].body)).text.body).toContain('Linked');
    // bad code
    await run(await post('x', payload([{ from: '15550003333', text: 'waldo WRONG1' }])), env, directory);
    expect(JSON.parse(String((graph.mock.calls[1] as unknown as [string, RequestInit])[1].body)).text.body).toContain('did not work');
    // the bearer token stays in the authorization header, never in the body
    expect(String((graph.mock.calls[0] as unknown as [string, RequestInit])[1].body)).not.toContain('wabearer-t0ken');
    expect((graph.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ authorization: 'Bearer wabearer-t0ken' });
  });
});
