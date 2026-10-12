// The webhook used to answer 200 and do the work in waitUntil, so a Worker kill or a failed Durable Object call before the
// message was recorded lost it silently (Meta does not retry a 200). Now it acks only after the owner's DO admits the payload.
import { afterEach, expect, it, vi } from 'vitest';
import { handleWhatsAppWebhook, type WhatsAppWebhookEnv } from '../src/channels/whatsapp-webhook';
import type { OwnerDirectory } from '../src/identity/owner-directory';

const sign = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('')}`;
};
const body = (senders: string[]) => JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn1' },
  messages: senders.map((from, i) => ({ from, id: `wamid.${from}.${i}`, type: 'text', text: { body: 'hi' } })) } }] }] });
const request = async (payload: string) => new Request('https://w.test/whatsapp/webhook', { method: 'POST', body: payload, headers: { 'x-hub-signature-256': await sign('appsecret', payload) } });
const directory: OwnerDirectory = { byPresence: async (_p, subject) => ({ doName: `do-${subject}`, subject, timezone: null }), redeem: async () => null };
const env = (fetch: (url: string, init?: RequestInit) => Promise<Response>): WhatsAppWebhookEnv => ({
  WHATSAPP_APP_SECRET: 'appsecret',
  TELEGRAM_OWNER_DO: { idFromName: (name: string) => name, get: (name: string) => ({ fetch: (url: string, init?: RequestInit) => fetch(`${name}|${url}`, init) }) } as unknown as DurableObjectNamespace,
});
const handle = async (payload: string, e: WhatsAppWebhookEnv) => {
  const deferred: Promise<unknown>[] = [];
  const response = await handleWhatsAppWebhook(await request(payload), e, work => deferred.push(work), directory);
  return { response, settled: Promise.all(deferred) };
};
afterEach(() => vi.restoreAllMocks());

it('acks 200 only after the owner DO admitted the payload', async () => {
  const calls: string[] = [];
  const { response } = await handle(body(['15550001111']), env(async url => { calls.push(url); return new Response('ok'); }));
  expect(response.status).toBe(200);
  expect(calls).toEqual(['do-15550001111|https://telegram-owner/whatsapp-admit']);
});

it('answers 503 so Meta redelivers when the DO admission throws or refuses', async () => {
  expect((await handle(body(['15550001111']), env(async () => { throw new Error('do unavailable'); }))).response.status).toBe(503);
  expect((await handle(body(['15550001111']), env(async () => new Response('capacity', { status: 503 })))).response.status).toBe(503);
});

it('a multi-owner payload is acked only if every owner admitted; the one that did is not rolled back', async () => {
  const calls: string[] = [];
  const result = await handle(body(['15550001111', '15550002222']), env(async url => {
    calls.push(url);
    if (url.startsWith('do-15550002222')) throw new Error('second owner unavailable');
    return new Response('ok');
  }));
  expect(result.response.status).toBe(503);
  expect(calls).toHaveLength(2);
});
