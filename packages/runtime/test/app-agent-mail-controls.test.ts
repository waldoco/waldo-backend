// The app's agent_mail view on the one controls path: GET /app/v1/controls?view=agent_mail reads the owner's Waldo address,
// and POST /app/v1/actions claims or releases it through the control-action receipt book. No Cloudflare call is made from a
// request: the owner alarm makes the rule.
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { APP_AGENT_MAIL_RECEIPTS_V1, APP_CONTROLS_AGENT_MAIL_REVISION, appControlProjectionV1Schema, appControlResultV1Schema } from '../../contracts/src/app/controls';
import { APP_CONTRACT_HEADER } from '../../contracts/src/app/core';
import { appControlsRequest, type AppControlsHost } from '../src/channels/app-controls';
import { AGENT_MAIL_RULE_DUE_KEY, agentMailRuleHandles, type RuleState } from '../src/channels/agent-mail/rules';
import { AGENT_MAIL_NOTICE } from '../src/channels/agent-mail/notice';
const NOTICE = AGENT_MAIL_NOTICE.version;

const DOMAIN = 'mail.test.invalid', TOKEN = 'cf-app-token-canary-90ae';
const mailEnv = (flag: string, zone = '0123456789abcdef0123456789abcdef') => ({
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret',
  AGENT_MAIL_INBOUND: flag, AGENT_MAIL_DOMAIN: DOMAIN, AGENT_MAIL_ZONE_ID: zone, CLOUDFLARE_EMAIL_ROUTING_TOKEN: TOKEN, WALDO_ENVIRONMENT: 'staging',
});
const unused = () => { throw Error('The agent_mail view reads the directory only'); };
afterEach(() => { vi.unstubAllGlobals(); });

// The directory's handle table, for this owner and one other who holds `taken`.
function world() {
  const holders = new Map<string, { owner: string; state: RuleState }>([['taken', { owner: 'someone-else', state: 'live' }]]);
  const rpc: string[] = [], notices: string[] = [];
  let cloudflare = 0, down = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.cloudflare.com/')) { cloudflare++; return new Response('never', { status: 500 }); }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1] ?? 'other', args = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
    rpc.push(fn);
    if (down && fn === 'claim_agent_mail_handle') return new Response('down', { status: 503 });
    const mine = () => [...holders].find(([, entry]) => entry.owner === args.p_do_name);
    if (fn === 'agent_mail_handle') { const held = mine(); return Response.json(held ? [{ handle: held[0], rule_state: held[1].state }] : []); }
    if (fn === 'claim_agent_mail_handle') {
      notices.push(args.p_notice_version!);
      const held = mine();
      if (held?.[0] === args.p_handle) return Response.json('unchanged');
      if (holders.has(args.p_handle!)) return Response.json('taken');
      if (held) holders.delete(held[0]);
      holders.set(args.p_handle!, { owner: args.p_do_name!, state: 'pending' });
      return Response.json('claimed');
    }
    if (fn === 'release_agent_mail_handle') { const held = mine(); if (held) holders.delete(held[0]); return Response.json(held ? 'released' : 'none'); }
    return new Response('unexpected', { status: 500 });
  });
  return { holders, rpc, notices, cloudflare: () => cloudflare, claimsFail: () => { down = true; } };
}
type Call = Promise<{ status: number; body: Record<string, unknown> }>;
const app = (flag: string | ReturnType<typeof mailEnv>, run: (o: { read(): Call; act(body: Record<string, unknown>): Call; storage: DurableObjectState['storage']; wakes(): number }) => Promise<void>,
  options: { revision?: number; signedInAt?: string; owner?: string } = {}) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`app-mail-${crypto.randomUUID()}`)), async (_i, state) => {
    let wakes = 0;
    const host: AppControlsHost = { csrf: 'c'.repeat(64), expires: Date.now() + 60_000, signedInAt: options.signedInAt ?? new Date().toISOString(), storage: state.storage, assertCurrent: async () => {},
      sessions: async () => [{ csrf: 'c'.repeat(64), expires: Date.now() + 60_000 }], view: unused, act: unused,
      account: { owner: 'owner-app-mail', auth: null, requestUrl: 'https://app.fixture.invalid/app/v1/controls', purgeOwnerFiles: unused, eraseOwnerStorage: unused },
      phone: mailEnv('1'), whatsappUnlinked: unused,
      agentMail: { env: typeof flag === 'string' ? mailEnv(flag) : flag, kv: state.storage.kv, owner: options.owner ?? 'owner-app-mail', ownerName: () => 'Priya Sharma', wake: async () => { wakes++; } } };
    const headers = { [APP_CONTRACT_HEADER]: `controls=${options.revision ?? APP_CONTROLS_AGENT_MAIL_REVISION}` };
    const call = async (request: Request) => { const response = await appControlsRequest(request, host); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
    await run({
      read: () => call(new Request('https://app.fixture.invalid/app/v1/controls?view=agent_mail', { headers })),
      act: (body) => call(new Request('https://app.fixture.invalid/app/v1/actions', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })),
      storage: state.storage, wakes: () => wakes,
    });
  });
const receipt = (body: Record<string, unknown>) => appControlResultV1Schema.parse(body).receipt;

it('claims an address, records it for the alarm, renames it and releases it, with receipts the app can read back', async () => {
  const w = world();
  await app('1', async ({ read, act, storage, wakes }) => {
    const first = appControlProjectionV1Schema.parse((await read()).body);
    expect(first.data).toEqual({ enabled: true, domain: DOMAIN, notice: AGENT_MAIL_NOTICE, display_name: "Waldo, Priya's assistant", actions: ['agent_mail.claim'] });
    const stale = await act({ view: 'agent_mail', action: 'agent_mail.claim', value: 'priya', notice: '2026-01-01', revision: first.revision, request_id: 'mail-request-0' });
    expect(receipt(stale.body)).toEqual(APP_AGENT_MAIL_RECEIPTS_V1.notice_stale);
    expect(w.rpc.filter(fn => fn === 'claim_agent_mail_handle')).toEqual([]);
    const claimed = await act({ view: 'agent_mail', action: 'agent_mail.claim', value: ' Priya ', notice: NOTICE, revision: first.revision, request_id: 'mail-request-1' });
    expect(claimed.status).toBe(200);
    expect(receipt(claimed.body)).toEqual(APP_AGENT_MAIL_RECEIPTS_V1.claimed);
    expect(agentMailRuleHandles(storage.kv)).toEqual(['priya']);
    expect(storage.kv.get(AGENT_MAIL_RULE_DUE_KEY)).toBeTypeOf('number');
    expect(wakes()).toBe(1);
    expect(w.notices).toEqual([NOTICE]);
    const held = appControlProjectionV1Schema.parse((await read()).body);
    expect(held.data).toMatchObject({ handle: 'priya', address: `priya@${DOMAIN}`, rule: 'pending', actions: ['agent_mail.claim', 'agent_mail.release'] });
    const renamed = await act({ view: 'agent_mail', action: 'agent_mail.claim', value: 'priya.k', notice: NOTICE, revision: held.revision, request_id: 'mail-request-2' });
    expect(receipt(renamed.body)).toEqual(APP_AGENT_MAIL_RECEIPTS_V1.changed);
    // The old handle stays recorded until the alarm sees its rule gone.
    expect(agentMailRuleHandles(storage.kv)).toEqual(['priya', 'priya.k']);
    const after = appControlProjectionV1Schema.parse((await read()).body);
    const released = await act({ view: 'agent_mail', action: 'agent_mail.release', revision: after.revision, request_id: 'mail-request-3' });
    expect(receipt(released.body)).toEqual(APP_AGENT_MAIL_RECEIPTS_V1.released);
    expect(w.holders.has('priya.k')).toBe(false);
    const back = await act({ view: 'agent_mail', action: 'agent_mail.release', revision: after.revision, request_id: 'mail-request-3' });
    expect(back.body).toMatchObject({ duplicate: true, receipt: APP_AGENT_MAIL_RECEIPTS_V1.released });
    expect(w.cloudflare()).toBe(0);
    expect(JSON.stringify([...(await storage.list()).entries()])).not.toContain(TOKEN);
  });
});

it('answers taken, reserved and invalid, asking the directory only for a handle that could be claimed', async () => {
  const w = world();
  await app('1', async ({ read, act }) => {
    const { revision } = appControlProjectionV1Schema.parse((await read()).body);
    const ask = async (value: string, request: string) => receipt((await act({ view: 'agent_mail', action: 'agent_mail.claim', value, notice: NOTICE, revision, request_id: request })).body);
    expect(await ask('taken', 'mail-request-4')).toEqual(APP_AGENT_MAIL_RECEIPTS_V1.taken);
    expect(await ask('postmaster', 'mail-request-5')).toEqual(APP_AGENT_MAIL_RECEIPTS_V1.reserved);
    expect(await ask('a..b', 'mail-request-6')).toEqual(APP_AGENT_MAIL_RECEIPTS_V1.invalid);
    expect(w.rpc.filter(fn => fn === 'claim_agent_mail_handle')).toHaveLength(1);
  });
});

it('a claim the directory does not answer is unconfirmed, and the handle stays recorded for the alarm to check', async () => {
  const w = world();
  await app('1', async ({ read, act, storage }) => {
    const { revision } = appControlProjectionV1Schema.parse((await read()).body);
    w.claimsFail();
    const claimed = await act({ view: 'agent_mail', action: 'agent_mail.claim', value: 'priya', notice: NOTICE, revision, request_id: 'mail-request-7' });
    expect(receipt(claimed.body)).toEqual(APP_AGENT_MAIL_RECEIPTS_V1.unknown);
    expect(agentMailRuleHandles(storage.kv)).toEqual(['priya']);
  });
});

it('with agent mail off the view offers nothing and a claim is refused', async () => {
  const w = world();
  await app('0', async ({ read, act }) => {
    const projection = appControlProjectionV1Schema.parse((await read()).body);
    expect(projection.data).toEqual({ enabled: false, display_name: "Waldo, Priya's assistant", actions: [] });
    expect((await act({ view: 'agent_mail', action: 'agent_mail.claim', value: 'priya', notice: NOTICE, revision: projection.revision, request_id: 'mail-request-8' })).body).toMatchObject({ error: 'no_longer_eligible' });
    expect(w.rpc).toEqual([]);
  });
});

it('a build below the agent_mail revision is refused the view and its actions', async () => {
  const w = world();
  await app('1', async ({ read, act }) => {
    expect((await read()).status).toBe(400);
    expect((await act({ view: 'agent_mail', action: 'agent_mail.claim', value: 'priya', notice: NOTICE, revision: 'f'.repeat(64), request_id: 'mail-request-9' })).status).toBe(400);
    expect(w.rpc).toEqual([]);
  }, { revision: APP_CONTROLS_AGENT_MAIL_REVISION - 1 });
});

it('a claim needs a recent sign-in', async () => {
  const w = world();
  await app('1', async ({ read, act }) => {
    const { revision } = appControlProjectionV1Schema.parse((await read()).body);
    expect((await act({ view: 'agent_mail', action: 'agent_mail.claim', value: 'priya', notice: NOTICE, revision, request_id: 'mail-request-10' })).body).toMatchObject({ error: 'step_up_required' });
    expect(w.rpc.filter(fn => fn === 'claim_agent_mail_handle')).toEqual([]);
  }, { signedInAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString() });
});

it('with routing not configured a claim is recorded and stays pending, saying why, and never shows live', async () => {
  const w = world();
  await app(mailEnv('1', ''), async ({ read, act }) => {
    const { revision } = appControlProjectionV1Schema.parse((await read()).body);
    expect(receipt((await act({ view: 'agent_mail', action: 'agent_mail.claim', value: 'priya', notice: NOTICE, revision, request_id: 'mail-request-11' })).body)).toEqual(APP_AGENT_MAIL_RECEIPTS_V1.claimed);
    expect(appControlProjectionV1Schema.parse((await read()).body).data).toMatchObject({ handle: 'priya', rule: 'pending', rule_reason: 'not_configured' });
    expect(w.cloudflare()).toBe(0);
  });
});

it('an owner object with no directory name offers no address and claims nothing', async () => {
  const w = world();
  await app('1', async ({ read, act, storage }) => {
    const projection = appControlProjectionV1Schema.parse((await read()).body);
    expect(projection.data).toEqual({ enabled: false, display_name: "Waldo, Priya's assistant", actions: [] });
    expect((await act({ view: 'agent_mail', action: 'agent_mail.claim', value: 'priya', notice: NOTICE, revision: projection.revision, request_id: 'mail-request-12' })).body).toMatchObject({ error: 'no_longer_eligible' });
    expect((await act({ view: 'agent_mail', action: 'agent_mail.release', revision: projection.revision, request_id: 'mail-request-13' })).body).toMatchObject({ error: 'no_longer_eligible' });
    expect(w.rpc).toEqual([]);
    expect(agentMailRuleHandles(storage.kv)).toEqual([]);
  }, { owner: '' });
});
