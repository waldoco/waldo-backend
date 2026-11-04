// The look-up's erasure through the owner object's own app route: withdrawing the look-up, or forgetting one finding, hides
// every retained copy the memory forget reaches (chat history, episodes, thread titles), and the route rechecks the app
// session before it answers.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { episodeIndex } from '../src/channels/episodes';
import { claimStore, FORGOTTEN } from '../src/memory/claims';
import { consentLedger } from '../src/onboarding/consent-ledger';
import { findingStore } from '../src/onboarding/findings';
import { jobBook } from '../src/tasks/jobs';

const OWNER_ID = '5b3c4d5e-6f70-4a8b-9cad-1e2f3a4b5c6e';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { authorityReads: 0, authorityLimit: Infinity };
beforeEach(() => {
  wire.authorityReads = 0; wire.authorityLimit = Infinity;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority' && ++wire.authorityReads > wire.authorityLimit) throw new Error('directory unavailable');
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const FOUND = { category: 'work', text: 'Product manager at Northwind', source_url: 'https://ashamenon.example/about', evidence_quote: 'Asha Menon is a product manager at Northwind' } as const;
const PUNE = { category: 'based_in', text: 'Based in Pune since 2019', source_url: 'https://ashamenon.example/about', evidence_quote: 'Asha has lived in Pune since 2019' } as const;
const conversation = (id: string, text: string) => ({ id, ownerId: 'prn_owner', chatId: 'main', parentId: null, threadAnchorId: null, surface: 'app', modelPayload: text, appPayload: text, modelProjection: { mode: 'include' }, role: 'assistant' });
const thread = (title: string) => ({ thread_id: 'th_1', title, revision: 1, title_revision: 2, state: 'active', created_at: 1, last_activity_at: 1 });

const owner = (name: string, work: (o: { state: DurableObjectState; call(path: string, body?: unknown): Promise<Response> }) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    state.storage.kv.put('do_name', name);
    const object = new OwnerDO(state, { ...env, ...directory, OWNER_LOOKUP: '1', APP_AGREEMENTS: '1', TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: undefined });
    const call = (path: string, body?: unknown) => object.fetch(new Request(`https://telegram-owner${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    await work({ state, call });
  });
// Two findings and their copies: the assistant said them in chat, the day's episode holds them, and a thread is named after one.
const seed = (state: DurableObjectState) => {
  const sql = state.storage.sql, claims = claimStore(sql, w => state.storage.transactionSync(w)), consent = consentLedger(sql, { lookupOffered: true, agreementsOffered: true });
  // The owner object reads findings by its own clock, so they are found now: an older one would have expired.
  const at = Date.now();
  consent.grant('terms', 1, at); consent.grant('privacy_notice', 1, at); consent.grant('owner_lookup', 1, at);
  const findings = findingStore(sql, claims, consent, Date.now);
  const first = findings.record(FOUND, 'About', at) as { id: string };
  findings.record(PUNE, 'About', at + 1);
  state.storage.kv.put('conv:0000000001', conversation('reply-1', `I found this: ${FOUND.evidence_quote}.`));
  episodeIndex(sql).add('e1', 'waldo', `Noted that Asha is ${PUNE.text.toLowerCase()}, and ${FOUND.text}.`, 4);
  state.storage.kv.put('app:thread:th_1', thread(FOUND.text));
  return { findings, first };
};
const leftovers = (state: DurableObjectState) => JSON.stringify([
  state.storage.kv.get('conv:0000000001'), state.storage.sql.exec('SELECT text FROM episodes').toArray(), state.storage.kv.get('app:thread:th_1'),
]);

describe('look-up erasure through the owner object', () => {
  it('withdrawing the look-up hides every copy the memory forget reaches, and nothing found comes back', () => owner('onboarding-erase-withdraw', async ({ state, call }) => {
    const { findings } = seed(state);
    const response = await call('/app/v1/consents/withdraw', { request_id: 'withdraw-do-0001', purpose: 'owner_lookup' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ consent: { status: 'withdrawn' }, findings_erased: 2 });
    const left = leftovers(state);
    for (const text of [FOUND.text, FOUND.evidence_quote, PUNE.evidence_quote]) expect(left).not.toContain(text);
    expect(left).toContain(FORGOTTEN);
    expect((state.storage.kv.get('app:thread:th_1') as { title: string }).title).toBe(FORGOTTEN);
    expect((await call('/app/v1/consents', { request_id: 'grant-do-0002', purpose: 'owner_lookup', version: 1, age_attested_18_plus: true })).status).toBe(200);
    expect(findings.record(FOUND, 'About', Date.now())).toBe('forgotten');
  }));
  it('unticking the look-up in the agreements does the same', () => owner('onboarding-erase-agreements', async ({ state, call }) => {
    seed(state);
    expect((await call('/app/v1/onboarding/actions', { request_id: 'start-do-0001', action: 'start' })).status).toBe(200);
    const response = await call('/app/v1/onboarding/actions', { request_id: 'agree-do-0001', action: 'agreements.accept', terms_version: 1, notice_version: 1, age_attested_18_plus: true, owner_lookup: false });
    expect(response.status).toBe(200);
    expect(leftovers(state)).not.toContain(FOUND.evidence_quote);
    expect((state.storage.kv.get('app:thread:th_1') as { title: string }).title).toBe(FORGOTTEN);
  }));
  it('forgetting one finding reaches the thread title too', () => owner('onboarding-erase-one', async ({ state, call }) => {
    const { first } = seed(state);
    expect((await call('/app/v1/findings/actions', { request_id: 'forget-do-0001', finding_id: first.id, action: 'forget' })).status).toBe(200);
    expect((state.storage.kv.get('app:thread:th_1') as { title: string }).title).toBe(FORGOTTEN);
    expect(JSON.stringify(state.storage.kv.get('conv:0000000001'))).not.toContain(FOUND.evidence_quote);
  }));
  // A background task started from what the look-up found holds its own copy: the open one is cancelled, and no row of the job
  // book keeps the text in its brief, progress or result once the route answers.
  const tasked = (state: DurableObjectState) => {
    const sql = state.storage.sql, book = jobBook(sql, { now: Date.now, newId: () => 'f1d1f1d10001', newToken: () => 'token' });
    const brief = { title: 'Asha\'s role', goal: `Check that ${FOUND.text}.`, context: `The look-up read: ${FOUND.evidence_quote}.`, done_when: 'Confirmed.', effort: 'standard' as const, timezone: 'UTC', started_at: Date.now() };
    const { job } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: 'lookup-task', origin: 'turn', surface: 'app', brief, dueAt: Date.now() + 3_600_000, deadlineAt: Date.now() + 7_200_000 });
    const ticket = book.startAttempt(job.id)!;
    book.checkpoint(ticket, 1, { turns: [{ call: { call_id: 'c1', name: 'web_search', arguments: '{}' }, output: `Found: ${PUNE.evidence_quote}` }] }, { rounds: 1, costUsd: 0 });
    return { id: job.id, columns: () => JSON.stringify(sql.exec('SELECT brief_json, checkpoint_json, result_json FROM task_jobs').toArray()), book };
  };
  it('withdrawing the look-up cancels a task that carries what it found and leaves no copy in the job book', () => owner('onboarding-erase-withdraw-task', async ({ state, call }) => {
    seed(state);
    const task = tasked(state);
    expect((await call('/app/v1/consents/withdraw', { request_id: 'withdraw-task-0001', purpose: 'owner_lookup' })).status).toBe(200);
    expect(task.book.get(task.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten', lease_token: null });
    for (const text of [FOUND.text, FOUND.evidence_quote, PUNE.evidence_quote]) expect(task.columns()).not.toContain(text);
  }));
  it('forgetting one finding cancels a task that carries it and leaves no copy in the job book', () => owner('onboarding-erase-one-task', async ({ state, call }) => {
    const { first } = seed(state);
    const task = tasked(state);
    expect((await call('/app/v1/findings/actions', { request_id: 'forget-task-0001', finding_id: first.id, action: 'forget' })).status).toBe(200);
    expect(task.book.get(task.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten', lease_token: null });
    for (const text of [FOUND.text, FOUND.evidence_quote]) expect(task.columns()).not.toContain(text);
  }));
  it('answers nothing when the app session ends while the answer is being built', () => owner('onboarding-session-answer', async ({ call }) => {
    // Admitted by the route and by the onboarding host's first check; the recheck right before the answer finds the session gone.
    wire.authorityLimit = 2;
    const response = await call('/app/v1/onboarding');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
    expect(wire.authorityReads).toBe(3);
  }));
  it('answers nothing once the app session stops being current during the route', () => owner('onboarding-session-recheck', async ({ call }) => {
    // The route is admitted on the first read; the recheck before the answer finds the session gone.
    wire.authorityLimit = 1;
    const response = await call('/app/v1/onboarding');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  }));
});
