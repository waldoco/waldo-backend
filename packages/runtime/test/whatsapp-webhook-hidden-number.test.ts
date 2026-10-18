// Meta's business-scoped user ids (BSUIDs): a sender with a WhatsApp username whose number Meta does not share arrives
// with messages[].from_user_id and no messages[].from; contacts[] carries user_id and profile.username
// (https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids).
import { afterEach, expect, it, vi } from 'vitest';
import { handleWhatsAppWebhook, type WhatsAppWebhookEnv } from '../src/channels/whatsapp-webhook';
import type { OwnerDirectory } from '../src/identity/owner-directory';

const BSUID = 'US.13491208655302741918';
const USERNAME = 'fictional.handle';

const sign = async (body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('appsecret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('')}`;
};

type Sender = { from?: string; userId: string; text?: string };
const payload = (senders: Sender[]) => JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp',
  metadata: { phone_number_id: 'pn1' },
  contacts: senders.map(s => ({ profile: { name: 'Fictional', username: USERNAME }, ...(s.from ? { wa_id: s.from } : {}), user_id: s.userId })),
  messages: senders.map((s, i) => ({ ...(s.from ? { from: s.from } : {}), from_user_id: s.userId, id: `wamid.${i}`, timestamp: '1700000000', type: 'text', text: { body: s.text ?? 'hi' } })),
} }] }] });

const harness = (throttleAllows = true, graphStatus = 200, routeEverySubject = false) => {
  const doCalls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const doNames: string[] = [];
  const doGets: string[] = [];
  const graph: Record<string, unknown>[] = [];
  const throttleKeys: string[] = [];
  const sharedThrottle: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/rest/v1/rpc/console_auth_throttle')) { sharedThrottle.push(String(init?.body)); return Response.json(true); }
    if (url.endsWith('/rest/v1/rpc/whatsapp_onboarding_allowed')) {
      throttleKeys.push((JSON.parse(String(init?.body)) as { p_subject_hash: string }).p_subject_hash);
      return Response.json(throttleAllows);
    }
    if (url.startsWith('https://graph.facebook.com/')) { graph.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return graphStatus === 200 ? Response.json({ messages: [{ id: 'wamid.out' }] }) : Response.json({ error: { code: 131030, message: `fictional rejection for ${BSUID}` } }, { status: graphStatus });
    }
    return new Response('unexpected', { status: 500 });
  }));
  const byPresence = vi.fn<OwnerDirectory['byPresence']>(async (_provider, subject) => routeEverySubject ? { doName: `do-${subject}`, subject, timezone: null } : subject === '15550001111' ? { doName: 'do-a', subject, timezone: null } : null);
  const redeem = vi.fn<OwnerDirectory['redeem']>(async () => null);
  const env: WhatsAppWebhookEnv = {
    WHATSAPP_APP_SECRET: 'appsecret', WHATSAPP_ACCESS_TOKEN: 'fictional-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
    SUPABASE_PROJECT_URL: 'https://fictional.supabase.test', SUPABASE_PUBLISHABLE_KEY: 'fictional-key', WALDO_ROUTER_HMAC_SECRET: 'fictional-secret',
    OWNER_DO: {
      idFromName: (name: string) => { doNames.push(name); return name; },
      get: (name: string) => {
        doGets.push(name);
        return { fetch: async (url: string, init?: RequestInit) => { doCalls.push({ url: `${name}|${url}`, body: String(init?.body), headers: { ...(init?.headers as Record<string, string>) } }); return new Response('ok'); } };
      },
    } as unknown as DurableObjectNamespace,
  };
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
  const handle = async (body: string, e: WhatsAppWebhookEnv = env) => {
    const deferred: Promise<unknown>[] = [];
    const response = await handleWhatsAppWebhook(new Request('https://w.test/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': await sign(body) } }), e, work => deferred.push(work), { byPresence, redeem });
    await Promise.all(deferred);
    return response;
  };
  return { env, handle, doCalls, doNames, doGets, graph, throttleKeys, sharedThrottle, byPresence, redeem, logs };
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('a sender with no phone number is answered by BSUID, never routed, and never logged by id or username', async () => {
  const h = harness();
  expect((await h.handle(payload([{ userId: BSUID }]))).status).toBe(200);
  expect(h.byPresence).not.toHaveBeenCalled();
  expect(h.doCalls).toEqual([]);
  expect(h.graph).toHaveLength(1);
  expect(h.graph[0]).toMatchObject({ messaging_product: 'whatsapp', recipient: BSUID, type: 'text' });
  expect(h.graph[0]).not.toHaveProperty('to');
  expect((h.graph[0]!.text as { body: string }).body).toMatch(/phone number/);
  expect(h.throttleKeys).toHaveLength(1);
  expect(h.throttleKeys[0]).not.toContain(BSUID);
  // The 30-day store keyed by the hash, never the shared sign-in throttle, whose cleanup would wipe a 30-day count.
  expect(h.throttleKeys[0]).toMatch(/^[0-9a-f]{64}$/);
  expect(h.sharedThrottle).toEqual([]);
  expect(h.logs.some(line => line.includes('whatsapp_hidden_number'))).toBe(true);
  for (const line of h.logs) { expect(line).not.toContain(BSUID); expect(line).not.toContain(USERNAME); }
});

it('a "waldo CODE" from a sender with no phone number is never redeemed', async () => {
  const h = harness();
  expect((await h.handle(payload([{ userId: BSUID, text: 'waldo ABCDEFGH23' }]))).status).toBe(200);
  expect(h.redeem).not.toHaveBeenCalled();
  expect(h.graph).toHaveLength(1);
});

it('several messages from one hidden-number sender in a payload get one reply', async () => {
  const h = harness();
  await h.handle(payload([{ userId: BSUID }, { userId: BSUID, text: 'again' }]));
  expect(h.throttleKeys).toHaveLength(1);
  expect(h.graph).toHaveLength(1);
});

it('a linked phone sender in the same payload is still routed, and the payload is acked', async () => {
  const h = harness();
  expect((await h.handle(payload([{ from: '15550001111', userId: 'US.99999999999999999999' }, { userId: BSUID }]))).status).toBe(200);
  expect(h.doCalls.map(c => c.url)).toEqual(['do-a|https://telegram-owner/whatsapp-admit']);
  // The phone sender's BSUID reaches its owner's DO with the message.
  expect(JSON.parse(h.doCalls[0]!.body)).toMatchObject({ messages: [{ from: '15550001111', from_user_id: 'US.99999999999999999999' }] });
  expect(h.graph).toEqual([expect.objectContaining({ recipient: BSUID })]);
});

it('a throttled sender gets no further reply', async () => {
  const h = harness(false);
  expect((await h.handle(payload([{ userId: BSUID }]))).status).toBe(200);
  expect(h.throttleKeys).toHaveLength(1);
  expect(h.graph).toEqual([]);
});

it('with no owner directory to throttle against, the sender is logged but not answered', async () => {
  const h = harness();
  const { SUPABASE_PROJECT_URL: _url, ...noDirectory } = h.env;
  expect((await h.handle(payload([{ userId: BSUID }]), noDirectory)).status).toBe(200);
  expect(h.graph).toEqual([]);
  expect(h.logs.some(line => line.includes('whatsapp_hidden_number'))).toBe(true);
});

it('a from that is not a phone number is never used as one', async () => {
  const h = harness();
  expect((await h.handle(payload([{ from: BSUID, userId: BSUID, text: 'waldo ABCDEFGH23' }]))).status).toBe(200);
  expect(h.byPresence).not.toHaveBeenCalled();
  expect(h.redeem).not.toHaveBeenCalled();
  expect(h.graph).toEqual([expect.objectContaining({ recipient: BSUID })]);
});

it('a refused reply logs the Graph status, never the response body', async () => {
  const h = harness(true, 400);
  expect((await h.handle(payload([{ userId: BSUID }]))).status).toBe(200);
  expect(h.graph).toHaveLength(1);
  const failure = h.logs.map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry.hop === 'whatsapp_hidden_number' && entry.ok === false);
  // A failed send is a hashed log line and still a 200: Meta is not asked to redeliver, and nothing retries.
  const senderKey = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`whatsapp.bsuid.${BSUID}`)))].map(b => b.toString(16).padStart(2, '0')).join('');
  expect(failure).toMatchObject({ status: 400, code: 131030, sender: senderKey.slice(0, 16) });
  expect(h.graph).toHaveLength(1);
  for (const line of h.logs) { expect(line).not.toContain('fictional rejection'); expect(line).not.toContain(BSUID); }
});

// The directory here resolves any subject to an owner, the worst case of a presence bound to a BSUID.
it('a hidden-number sender never reaches an owner DO, so no owner binds a do_name from it', async () => {
  const alone = harness(true, 200, true);
  await alone.handle(payload([{ userId: BSUID, text: 'waldo ABCDEFGH23' }]));
  expect(alone.doNames).toEqual([]);
  expect(alone.doGets).toEqual([]);
  expect(alone.doCalls).toEqual([]);

  // Mixed: only the phone sender is admitted, under its own do_name, with only its own message.
  const mixed = harness(true, 200, true);
  await mixed.handle(payload([{ from: '15550001111', userId: 'US.99999999999999999999' }, { userId: BSUID }]));
  expect(mixed.doNames).toEqual(['do-15550001111']);
  expect(mixed.doCalls).toHaveLength(1);
  expect(mixed.doCalls[0]).toMatchObject({ url: 'do-15550001111|https://telegram-owner/whatsapp-admit', headers: { 'x-waldo-do-name': 'do-15550001111', 'x-waldo-whatsapp-subject': '15550001111' } });
  const admitted = JSON.parse(mixed.doCalls[0]!.body) as { messages: { from?: string; from_user_id?: string }[] };
  expect(admitted.messages.map(m => m.from_user_id)).toEqual(['US.99999999999999999999']);
  expect(mixed.doCalls[0]!.body).not.toContain(BSUID);
});
