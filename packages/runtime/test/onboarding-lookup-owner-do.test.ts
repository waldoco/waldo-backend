import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { consentLedger, CURRENT_CONSENT_VERSION } from '../src/onboarding/consent-ledger';
import { startLookup } from '../src/onboarding/lookup';
import { jobBook, type JobBook } from '../src/tasks/jobs';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';

// The owner look-up the owner's yes starts, end to end through the owner object's own routes: the yes and the setup answers
// write one job, the first reply lets it start, the welcome build's web stage waits on it, and withdrawing the yes stops it.
const model = vi.hoisted(() => ({ welcome: [] as string[], replies: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const body = JSON.stringify(request);
    if (body.includes('welcome_nodes')) model.welcome.push(body); else model.replies += 1;
    const text = body.includes('welcome_nodes') ? '{"nodes":[]}'
      : body.includes('claim_ops') ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : 'Here is your week.';
    return { ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c1f0d0e-2b7a-4c43-9a51-0d8f5e3b2a77';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  model.welcome = []; model.replies = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_consent_list') return Response.json({ consents: [] });
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Flags = Readonly<{ ONBOARDING_LOOKUP?: string; WELCOME_V2?: string; BRAVE_SEARCH_API_KEY?: string }>;
type Owner = InstanceType<typeof OwnerDO>;
const ownerWith = async (flags: Flags, run: (h: Readonly<{ state: DurableObjectState; owner: Owner; book(): JobBook; app(path: string, body: unknown): Promise<Response>; jobs(): { id: string; status: string; brief_json: string; due_at: number | null }[]; hops(prefix: string): string[] }>) => Promise<void>) => {
  const name = `lookup-owner-${crypto.randomUUID()}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, APP_AGREEMENTS: '1', OWNER_LOOKUP: '1', ...flags, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const app = (path: string, body: unknown) => owner.fetch(new Request(`https://telegram-owner${path}`, { method: 'POST',
      headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const jobs = () => state.storage.sql.exec<{ id: string; status: string; brief_json: string; due_at: number | null }>("SELECT id, status, brief_json, due_at FROM task_jobs WHERE origin = 'machine:owner_lookup'").toArray();
    const hops = (prefix: string) => state.storage.sql.exec<{ hop: string }>('SELECT hop FROM trace_log WHERE hop LIKE ? ORDER BY rowid', `${prefix}%`).toArray().map(row => row.hop);
    let n = 0;
    const book = () => jobBook(state.storage.sql, { now: Date.now, newId: () => `test-${n += 1}`, newToken: () => `tok-${n += 1}` });
    try { await run({ state, owner, book, app, jobs: () => { try { return jobs(); } catch { return []; } }, hops }); } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
};
const consents = async (app: (path: string, body: unknown) => Promise<Response>, lookup: boolean) => {
  const purposes: readonly ('terms' | 'privacy_notice' | 'owner_lookup')[] = lookup ? ['terms', 'privacy_notice', 'owner_lookup'] : ['terms', 'privacy_notice'];
  for (const purpose of purposes) {
    const granted = await app('/app/v1/consents', { request_id: `consent-${purpose}-1`, purpose, version: CURRENT_CONSENT_VERSION[purpose], age_attested_18_plus: true });
    expect(granted.status, await granted.clone().text()).toBe(200);
  }
};
const CANARIES = ['a1b2c3d4e5f60718', '1a2b3c4d5e6f7081', 'f0e1d2c3b4a59687'];
const settle = () => new Promise(resolve => setTimeout(resolve, 150));

it('the yes and the setup answers write one look-up job carrying only the name, and the first reply lets it start', async () => {
  await ownerWith({ ONBOARDING_LOOKUP: '1', WELCOME_V2: '1' }, async ({ state, app, jobs, hops }) => {
    await consents(app, true);
    await settle();
    // No name yet: the yes alone writes nothing.
    expect(jobs()).toEqual([]);
    expect((await app('/app/v1/onboarding/answers', { request_id: 'lookup-answers-1', name: 'Asha' })).status).toBe(200);
    await vi.waitFor(() => expect(jobs()).toHaveLength(1), { timeout: 10_000, interval: 25 });
    const [job] = jobs();
    const brief = JSON.parse(job!.brief_json) as { context: string; machine: { refs: string[] } };
    // The directory gives no address here, so the brief carries the name alone: nothing from the setup answers, no memory.
    expect(brief.machine.refs).toEqual(['name']);
    expect(brief.context).toContain('Asha');
    expect(job!.due_at).toBeGreaterThan(Date.now());
    // The welcome build's web stage waits on the running look-up.
    await vi.waitFor(() => expect(model.welcome.some(body => body.includes('Source: what the owner told Waldo'))).toBe(true), { timeout: 10_000, interval: 25 });
    expect(model.welcome.some(body => body.includes('Source: what the owner look-up found'))).toBe(false);
    // The build began before the job was written, and still waits for it: the web stage is pending, not settled empty.
    const web = () => (JSON.parse(state.storage.sql.exec<{ stages_json: string }>('SELECT stages_json FROM welcome_builds').one().stages_json) as Record<string, { state: string }>).web!.state;
    expect(web()).toBe('pending');
    // The owner's first message is answered before the look-up's worker may take the serial lane.
    const sent = await app('/app/v1/chat/main/messages', { client_message_id: 'lookup-first-message', text: 'Show me today as you see it.' });
    expect(sent.status).toBe(202);
    await vi.waitFor(() => expect(hops('lookup_')).toEqual(['lookup_enqueued', 'lookup_released']), { timeout: 10_000, interval: 25 });
    // Trace order: the first reply is sent and its turn closes before the look-up is released, and no look-up worker started
    // before it.
    const trace = hops('');
    expect(trace).toContain('send');
    expect(trace).toContain('turn');
    expect(trace.indexOf('lookup_released')).toBeGreaterThan(trace.lastIndexOf('send'));
    expect(trace.indexOf('lookup_released')).toBeGreaterThan(trace.lastIndexOf('turn'));
    // The job is still queued here, not started: nothing ran it before the reply. (Its worker runs on the jobs lane's next
    // pass, which this test does not drive.)
    expect(jobs().map(job => job.status)).toEqual(['queued']);
    expect(model.replies).toBeGreaterThan(0);
    expect(jobs()[0]!.due_at).toBeLessThanOrEqual(Date.now());
    // A second answers post starts nothing new.
    await app('/app/v1/onboarding/answers', { request_id: 'lookup-answers-2', name: 'Asha K' });
    await settle();
    expect(jobs()).toHaveLength(1);
  });
});

it('withdrawing the yes cancels and fences the look-up job', async () => {
  await ownerWith({ ONBOARDING_LOOKUP: '1' }, async ({ app, jobs, hops }) => {
    await consents(app, true);
    await app('/app/v1/onboarding/answers', { request_id: 'lookup-answers-w', name: 'Asha' });
    await vi.waitFor(() => expect(jobs()).toHaveLength(1), { timeout: 10_000, interval: 25 });
    expect((await app('/app/v1/consents/withdraw', { request_id: 'lookup-withdraw-1', purpose: 'owner_lookup' })).status).toBe(200);
    await vi.waitFor(() => expect(jobs().map(job => job.status)).toEqual(['cancelled']), { timeout: 10_000, interval: 25 });
    expect(hops('lookup_')).toEqual(['lookup_enqueued', 'lookup_cancelled']);
  });
});

it('writes no look-up job without the yes, or with the switch off', async () => {
  await ownerWith({ ONBOARDING_LOOKUP: '1' }, async ({ app, jobs }) => {
    await consents(app, false);
    await app('/app/v1/onboarding/answers', { request_id: 'lookup-answers-n', name: 'Asha' });
    await settle();
    expect(jobs()).toEqual([]);
  });
  await ownerWith({ ONBOARDING_LOOKUP: '0' }, async ({ app, jobs, hops }) => {
    await consents(app, true);
    await app('/app/v1/onboarding/answers', { request_id: 'lookup-answers-o', name: 'Asha' });
    await settle();
    expect(jobs()).toEqual([]);
    expect(hops('lookup_')).toEqual([]);
  });
});

it('a look-up whose yes stops counting is fenced at its next worker call, even before the owner object reconciles', async () => {
  await ownerWith({ ONBOARDING_LOOKUP: '1' }, async ({ state, owner, book, app, jobs, hops }) => {
    await consents(app, true);
    await app('/app/v1/onboarding/answers', { request_id: 'lookup-answers-l', name: 'Asha' });
    await vi.waitFor(() => expect(jobs()).toHaveLength(1), { timeout: 10_000, interval: 25 });
    const ticket = book().startAttempt(jobs()[0]!.id)!;
    expect(await owner.taskClaim(ticket)).not.toBe('fenced');
    // The yes is withdrawn straight in the ledger, so no route and no reconcile runs: only the brain's own check can stop it.
    consentLedger(state.storage.sql, { agreementsOffered: true, lookupOffered: true }).withdraw('owner_lookup', Date.now());
    expect(await owner.taskTool(ticket, { call_id: 'lapsed-1', name: 'web_search', arguments: JSON.stringify({ query: 'Asha' }) }, CANARIES)).toBe('fenced');
    expect(jobs().map(job => job.status)).toEqual(['cancelled']);
    expect(hops('task_cancelled')).toEqual(['task_cancelled']);
    expect(state.storage.sql.exec<{ note: string | null }>("SELECT note FROM trace_log WHERE hop = 'task_cancelled'").one().note).toContain('lapsed');
    expect(hops('lookup_')).toEqual(['lookup_enqueued']);
  });
});

it('withdrawing the yes cancels a look-up written earlier even with the switch now off', async () => {
  await ownerWith({ ONBOARDING_LOOKUP: '0' }, async ({ state, book, app, jobs, hops }) => {
    await consents(app, true);
    // A job written while the switch was on: the switch has since been turned off.
    const made = startLookup({ book: book(), consent: consentLedger(state.storage.sql, { agreementsOffered: true, lookupOffered: true }), now: Date.now, surface: 'app',
      started: () => null, markStarted: () => undefined, held: [] }, { name: 'Asha', email: null });
    expect(made.code).toBe('enqueued');
    expect((await app('/app/v1/consents/withdraw', { request_id: 'lookup-withdraw-off', purpose: 'owner_lookup' })).status).toBe(200);
    await vi.waitFor(() => expect(jobs().map(job => job.status)).toEqual(['cancelled']), { timeout: 10_000, interval: 25 });
    expect(hops('lookup_')).toEqual(['lookup_cancelled']);
  });
});

it('the look-up worker\'s web search sends the search provider no location: only the query leaves', async () => {
  const asked: string[] = [];
  const directoryFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.search.brave.com/')) return directoryFetch(input, init);
    asked.push(url);
    return Response.json({ web: { results: [{ title: 'Asha Rao', url: 'https://asha.example/', description: 'Designer' }] } });
  });
  // The owner's time zone here is UTC, which the owner's own searches send as a country.
  await ownerWith({ ONBOARDING_LOOKUP: '1', BRAVE_SEARCH_API_KEY: 'synthetic-brave' }, async ({ owner, book, app, jobs }) => {
    await consents(app, true);
    await app('/app/v1/onboarding/answers', { request_id: 'lookup-answers-s', name: 'Asha' });
    await vi.waitFor(() => expect(jobs()).toHaveLength(1), { timeout: 10_000, interval: 25 });
    const ticket = book().startAttempt(jobs()[0]!.id)!;
    expect(await owner.taskClaim(ticket)).not.toBe('fenced');
    expect(await owner.taskTool(ticket, { call_id: 'search-1', name: 'web_search', arguments: JSON.stringify({ query: 'Asha Rao designer' }) }, CANARIES)).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
    expect(new URL(asked[0]!).searchParams.get('q')).toBe('Asha Rao designer');
    expect(new URL(asked[0]!).searchParams.has('country')).toBe(false);
  });
});
