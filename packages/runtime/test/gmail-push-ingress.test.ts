import { describe, expect, it, vi } from 'vitest';
import { handleGmailPush, type EventIngressEnv } from '../src/channels/event-ingress';
import { gmailPush } from '../src/connectors/google-push';

const config = gmailPush('waldo-dev')!;
const b64url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const body = (account = 'Sam@Example.com', historyId = '98765') => JSON.stringify({ message: { data: b64url(JSON.stringify({ emailAddress: account, historyId })), messageId: '42' }, subscription: 'projects/waldo-dev/subscriptions/s' });
const request = (raw = body(), token = 'good-token') => new Request('https://w.test/events/gmail', { method: 'POST', body: raw, headers: { authorization: `Bearer ${token}` } });

const setup = (rows: unknown = [{ do_name: 'owner-a', connection: 'conn-a' }, { do_name: 'owner-b', connection: 'conn-b' }], ownerStatus = 200) => {
  const woken: Array<{ name: string; headers: Record<string, string> }> = [];
  const rpc: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    rpc.push({ url: String(input), ...JSON.parse(String(init?.body)) });
    return Response.json(rows);
  }));
  const ns = { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async (_url: string, init: RequestInit) => { woken.push({ name, headers: init.headers as Record<string, string> }); return new Response('ok', { status: ownerStatus }); } }) } as unknown as DurableObjectNamespace;
  const env: EventIngressEnv = { OWNER_DO: ns, WALDO_ROUTER_HMAC_SECRET: 'router-secret-fixture-0000000000', SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'k' };
  const verify = vi.fn(async (token: string, expect: { audience: string; serviceAccount: string }) => token === 'good-token' && expect.audience === 'https://w.test/events/gmail' && expect.serviceAccount === config.serviceAccount);
  return { env, woken, rpc, verify };
};

describe('Gmail push ingress', () => {
  it('wakes every owner of the mailbox with only connection and history point', async () => {
    const { env, woken, rpc, verify } = setup();
    expect((await handleGmailPush(request(), env, config, verify)).status).toBe(200);
    expect(rpc[0]).toMatchObject({ url: 'https://db.test/rest/v1/rpc/gmail_push_route', p_account: 'sam@example.com' });
    expect(woken).toEqual([
      { name: 'owner-a', headers: { 'x-waldo-gmail-connection': 'conn-a', 'x-waldo-gmail-history': '98765' } },
      { name: 'owner-b', headers: { 'x-waldo-gmail-connection': 'conn-b', 'x-waldo-gmail-history': '98765' } },
    ]);
    vi.unstubAllGlobals();
  });

  it('a token that does not check out is refused before any lookup', async () => {
    const { env, woken, rpc, verify } = setup();
    expect((await handleGmailPush(request(body(), 'forged'), env, config, verify)).status).toBe(403);
    expect(rpc).toHaveLength(0); expect(woken).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('an unreadable message is acknowledged and dropped; an unknown mailbox wakes no one', async () => {
    const dropped = setup();
    expect((await handleGmailPush(request('{"message":{}}'), dropped.env, config, dropped.verify)).status).toBe(200);
    expect(dropped.rpc).toHaveLength(0);
    vi.unstubAllGlobals();
    const unknown = setup([]);
    expect((await handleGmailPush(request(), unknown.env, config, unknown.verify)).status).toBe(200);
    expect(unknown.woken).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('is off until the project is named, and asks Pub/Sub to retry when an owner cannot take the wake', async () => {
    const { env, verify } = setup();
    expect((await handleGmailPush(request(), env, null, verify)).status).toBe(404);
    vi.unstubAllGlobals();
    const busy = setup(undefined, 503);
    expect((await handleGmailPush(request(), busy.env, config, busy.verify)).status).toBe(503);
    vi.unstubAllGlobals();
  });
});
