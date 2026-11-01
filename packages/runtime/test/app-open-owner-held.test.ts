import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { consentLedger, CURRENT_CONSENT_VERSION } from '../src/onboarding/consent-ledger';
import { ensureSchema } from '../src/tracer/schema';
import { MONTHLY_SPEND_CEILING_USD } from '../src/llm/cost-ledger';
import { sendOpenOwnerMark } from '../src/identity/open-owner-hold';

const model = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    model.asked.push(String(request.messages.at(-1)?.content ?? ''));
    const text = request.response_format ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_topics":[]}' : 'Done.';
    return { ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5c4b3a29-1f0e-4d7c-8b6a-5d4e3f2a1b0c';
const HASH = 'b'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const owners = vi.hoisted(() => ({ releaseOk: true, released: 0, asked: [] as string[] }));
beforeEach(() => {
  model.asked = []; owners.releaseOk = true; owners.released = 0; owners.asked = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn) owners.asked.push(fn);
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'release_open_owner') { if (!owners.releaseOk) return new Response('down', { status: 503 }); owners.released += 1; return Response.json(true); }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, 'content-type': 'application/json' });
const withOwner = <T,>(name: string, work: (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState) => Promise<T>, extra: Record<string, string> = {}) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql); ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new OwnerDO(state, { ...env, ...directory, APP_AGREEMENTS: '1', TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, ...extra });
  try { return await work(owner, state); } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
});
const send = (owner: InstanceType<typeof OwnerDO>, name: string, client: string) =>
  owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: client, text: 'hello Waldo' }) }));
// The Worker's mark, sent the way a sign-in sends it, to this very object.
const mark = (owner: InstanceType<typeof OwnerDO>, name: string, secret = directory.WALDO_ROUTER_HMAC_SECRET) =>
  sendOpenOwnerMark({ idFromName: (value: string) => value as unknown as DurableObjectId, get: () => ({ fetch: (request: Request) => owner.fetch(request) }) }, secret, name);
const accept = (state: DurableObjectState) => {
  const consent = consentLedger(state.storage.sql, { agreementsOffered: true, lookupOffered: false }), at = Date.now();
  consent.attestAge(at);
  consent.grant('terms', CURRENT_CONSENT_VERSION.terms, at);
  consent.grant('privacy_notice', CURRENT_CONSENT_VERSION.privacy_notice, at);
};

it('an owner who joined openly sends nothing to the model, and opens no console, until they accept the agreements', async () => {
  const name = 'app-open-owner-held';
  await withOwner(name, async (owner, state) => {
    expect(await mark(owner, name, 'not-the-router-secret')).toBe(false);
    expect(await mark(owner, name)).toBe(true);
    const refused = await send(owner, name, 'held-client-0001');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'agreements_required' });
    const page = await owner.fetch(new Request('https://telegram-owner/console', { headers: { 'x-waldo-do-name': name } }));
    expect(page.status).toBe(403);
    expect(owners.released).toBe(0);

    // Accepting the terms alone, without the 18+ attestation, is not enough.
    const consent = consentLedger(state.storage.sql, { agreementsOffered: true, lookupOffered: false });
    consent.grant('terms', CURRENT_CONSENT_VERSION.terms, Date.now());
    consent.grant('privacy_notice', CURRENT_CONSENT_VERSION.privacy_notice, Date.now());
    expect((await send(owner, name, 'held-client-0002')).status).toBe(409);
    expect(model.asked).toEqual([]);

    accept(state);
    const sent = await send(owner, name, 'held-client-0003');
    expect(sent.status).toBe(202);
    expect(owners.released).toBe(1);
    await vi.waitFor(() => expect(model.asked.some(text => text.includes('hello Waldo'))).toBe(true), { timeout: 10_000, interval: 20 });
    await vi.waitFor(() => expect((owner as unknown as { activeApp: unknown }).activeApp).toBeNull(), { timeout: 10_000, interval: 20 });
  });
});

it('stays held after accepting while the directory cannot record the release', async () => {
  const name = 'app-open-owner-release-down';
  owners.releaseOk = false;
  await withOwner(name, async (owner, state) => {
    await mark(owner, name);
    accept(state);
    expect((await send(owner, name, 'release-down-001')).status).toBe(409);
    expect(model.asked).toEqual([]);
  });
});

it('an owner object with no mark sends as before and never asks the directory about joining', async () => {
  const name = 'app-open-owner-member';
  await withOwner(name, async owner => {
    expect((await send(owner, name, 'member-client-001')).status).toBe(202);
    await vi.waitFor(() => expect(model.asked.some(text => text.includes('hello Waldo'))).toBe(true), { timeout: 10_000, interval: 20 });
    await vi.waitFor(() => expect((owner as unknown as { activeApp: unknown }).activeApp).toBeNull(), { timeout: 10_000, interval: 20 });
    expect(owners.asked.filter(fn => fn.includes('open'))).toEqual([]);
  });
});

it('an owner who joined openly runs under the open sign-up ceiling; every other owner under the usual one', async () => {
  type Spend = { setup(channel: string): { monthSpend(): { spentUsd: number; ceilingUsd: number } | undefined } };
  const ledger = { WALDO_COST_LEDGER_SYNC: 'on', OPEN_SIGNUP_SPEND_CEILING_USD: '7' };
  await withOwner('app-open-owner-ceiling', async owner => {
    await mark(owner, 'app-open-owner-ceiling');
    expect((owner as unknown as Spend).setup('app').monthSpend()?.ceilingUsd).toBe(7);
  }, ledger);
  await withOwner('app-member-ceiling', async owner => {
    expect((owner as unknown as Spend).setup('app').monthSpend()?.ceilingUsd).toBe(MONTHLY_SPEND_CEILING_USD);
  }, ledger);
});
