import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { appConsentChangeV1Schema, appFindingListV1Schema, appOnboardingResultV1Schema, appOnboardingV1Schema } from '../../contracts/src/app/onboarding';
import { appOnboardingRequest, ownerOnboardingHost, type OwnerOnboardingDeps } from '../src/channels/app-onboarding';
import { claimStore } from '../src/memory/claims';
import { consentLedger } from '../src/onboarding/consent-ledger';
import { findingStore } from '../src/onboarding/findings';
import { episodeIndex } from '../src/channels/episodes';

let sequence = 0;
type Calls = { acts: unknown[]; admitted: string[]; rpc: number };
type Fakes = Partial<Pick<OwnerOnboardingDeps, 'rpc' | 'act' | 'admit'>>;
const owner = <T>(fn: (o: { storage: DurableObjectStorage; calls: Calls; send(path: string, body?: unknown, method?: string): Promise<Response>; act(body: Record<string, unknown>): Promise<Response> }) => Promise<T>, fakes: Fakes = {}) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`app-onboarding-${sequence++}`)), async (_instance, state) => {
    const calls: Calls = { acts: [], admitted: [], rpc: 0 };
    let clock = 1_000;
    const deps: OwnerOnboardingDeps = {
      storage: state.storage, doName: 'owner-name', now: () => clock++, assertCurrent: async () => {},
      rpc: fakes.rpc ?? (async () => { calls.rpc += 1; return { consents: [] }; }),
      act: fakes.act ?? (async action => { calls.acts.push(action); if (action.action === 'timezone.set') state.storage.kv.put('timezone_confirmed', true); return true; }),
      admit: fakes.admit ?? (async client => { calls.admitted.push(client); return true; }),
    };
    const send = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
      appOnboardingRequest(new Request(`https://telegram-owner${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), ownerOnboardingHost(deps));
    let request = 0;
    const act = (body: Record<string, unknown>) => send('/app/v1/onboarding/actions', { request_id: `onboarding-${request++}`, ...body });
    return fn({ storage: state.storage, calls, send, act });
  });
const run = async (response: Response) => appOnboardingResultV1Schema.parse(await response.json()).onboarding;
const agree = { action: 'agreements.accept', terms_version: 1, notice_version: 1, age_attested_18_plus: true, owner_lookup: true };

describe('first run', () => {
  it('starts once: a second start, from any device, returns the same run', () => owner(async ({ send, act }) => {
    expect(appOnboardingV1Schema.parse(await (await send('/app/v1/onboarding')).json())).toMatchObject({ state: 'not_started', run_id: null });
    const [a, b] = await Promise.all([act({ action: 'start' }), act({ action: 'start' })]);
    const first = await run(a!), second = await run(b!);
    expect(first.state).toBe('in_progress');
    expect(second.run_id).toBe(first.run_id);
    expect((await run(await act({ action: 'start' }))).started_at).toBe(first.started_at);
  }));
  it('asks nothing before the agreements, and refuses a copy that is no longer current', () => owner(async ({ send, act }) => {
    expect((await act({ action: 'name.set', name: 'Sam' })).status).toBe(409);
    await act({ action: 'start' });
    const early = await act({ action: 'name.set', name: 'Sam' });
    expect([early.status, await early.json()]).toEqual([409, { error: 'agreements_required' }]);
    expect(await (await act({ ...agree, notice_version: 2 })).json()).toEqual({ error: 'stale_version' });
    expect((await run(await act(agree))).steps.agreements).toBe('done');
    expect(await (await send('/app/v1/consents')).json()).toMatchObject({ age_attested_18_plus: true, consents: [
      { purpose: 'terms', status: 'granted', version: 1 }, { purpose: 'privacy_notice', status: 'granted', version: 1 }, { purpose: 'owner_lookup', status: 'granted', version: 1 }] });
  }));
  it('keeps the three answers as owner memory, never as a fourth question', () => owner(async ({ storage, act }) => {
    await act({ action: 'start' }); await act(agree);
    await act({ action: 'name.set', name: 'Sam' });
    const named = await run(await act({ action: 'name.set', name: 'Sammy' }));
    expect(named.steps.name).toBe('done');
    await act({ action: 'priority.set', text: 'Ship the board deck' });
    const claims = claimStore(storage.sql, work => storage.transactionSync(work)).claims();
    expect(claims.map(claim => [claim.text, claim.origin, claim.source, claim.verification_status])).toEqual(expect.arrayContaining([
      ['Wants to be called Sammy', 'owner', 'stated', 'owner-grounded'], [expect.stringContaining('Ship the board deck'), 'owner', 'stated', 'owner-grounded']]));
    expect(claims.filter(claim => claim.text.startsWith('Wants to be called'))).toHaveLength(1);
    expect(claims.find(claim => claim.text === 'Wants to be called Sammy')?.pinned).toBe('profile');
    expect((await act({ action: 'mood.set', value: 'tired' })).status).toBe(400);
  }));
  it('skips health honestly: nothing is recorded about the body and the health plane is not asked', () => owner(async ({ storage, calls, act }) => {
    await act({ action: 'start' }); await act(agree);
    const skipped = await run(await act({ action: 'skip', step: 'health' }));
    expect(skipped.steps.health).toBe('skipped');
    expect(calls.rpc).toBe(0);
    expect(claimStore(storage.sql).claims()).toHaveLength(0);
    // The app's word is not a connection: with no live health consent the step stays skipped.
    const claimed = await act({ action: 'health.connected' });
    expect([claimed.status, await claimed.json()]).toEqual([409, { error: 'not_connected' }]);
    expect(calls.rpc).toBe(1);
  }));
  it('marks health connected only from the health plane, and says so when it cannot read it', () => owner(async ({ act }) => {
    await act({ action: 'start' }); await act(agree);
    expect((await run(await act({ action: 'health.connected' }))).steps.health).toBe('done');
  }, { rpc: async () => ({ consents: [{ consent_class: 'health_processing', source: 'apple', purpose: 'storage_compute', version: 2, status: 'granted', epoch: 1, granted_at: '2026-10-21T00:00:00Z', withdrawn_at: null, deletion_state: 'not_required' }] }) }));
  it('answers unavailable when the health plane cannot be read', () => owner(async ({ act }) => {
    await act({ action: 'start' }); await act(agree);
    expect((await act({ action: 'health.connected' })).status).toBe(503);
  }, { rpc: async () => { throw new Error('directory down'); } }));
  it('sets the Brief time, the zone and quiet hours that end with the Brief', () => owner(async ({ calls, act }) => {
    await act({ action: 'start' }); await act(agree);
    const set = await run(await act({ action: 'brief_time.set', time: '07:30', timezone: 'Asia/Kolkata' }));
    expect(set.brief).toEqual({ time: '07:30', timezone_confirmed: true });
    expect(calls.acts).toEqual([
      { action: 'timezone.set', id: '', value: 'Asia/Kolkata' }, { action: 'card.pin', id: 'card:brief', value: '07:30' },
      { action: 'proactivity.set', id: '', value: '22:00|07:30|normal' }]);
  }));
  it('runs one first look per run, however often it is asked', () => owner(async ({ calls, act }) => {
    await act({ action: 'start' }); await act(agree);
    const first = await run(await act({ action: 'first_look.request' }));
    const again = await run(await act({ action: 'first_look.request' }));
    expect(first.steps.first_look).toBe('done');
    expect(again.first_look.message_id).toBe(first.first_look.message_id);
    expect(new Set(calls.admitted)).toEqual(new Set([first.first_look.message_id]));
  }));
  it('finishes once: what was left unanswered is skipped, and a restart finds the finished run', () => owner(async ({ send, act }) => {
    await act({ action: 'start' }); await act(agree); await act({ action: 'name.set', name: 'Sam' });
    const done = await run(await act({ action: 'complete' }));
    expect(done).toMatchObject({ state: 'completed', steps: { agreements: 'done', name: 'done', google: 'skipped', health: 'skipped', brief_time: 'skipped', priority: 'skipped', first_look: 'pending' } });
    expect(await (await act({ action: 'name.set', name: 'Other' })).json()).toEqual({ error: 'completed' });
    expect((await run(await act({ action: 'start' }))).state).toBe('completed');
    expect(appOnboardingV1Schema.parse(await (await send('/app/v1/onboarding')).json()).run_id).toBe(done.run_id);
  }));
  it('replays a repeated request and refuses a reused id with another body', () => owner(async ({ send }) => {
    const body = { request_id: 'onboarding-replay-1', action: 'start' };
    const first = await (await send('/app/v1/onboarding/actions', body)).json() as { replayed: boolean; onboarding: { run_id: string } };
    const again = await (await send('/app/v1/onboarding/actions', body)).json() as { replayed: boolean; onboarding: { run_id: string } };
    expect([first.replayed, again.replayed, again.onboarding.run_id]).toEqual([false, true, first.onboarding.run_id]);
    const reused = await send('/app/v1/onboarding/actions', { ...body, action: 'complete' });
    expect([reused.status, await reused.json()]).toEqual([409, { error: 'request_reused' }]);
  }));
});

describe('consent and findings routes', () => {
  const seed = (storage: DurableObjectStorage) => {
    const claims = claimStore(storage.sql, work => storage.transactionSync(work)), consent = consentLedger(storage.sql), findings = findingStore(storage.sql, claims, consent);
    consent.grant('owner_lookup', 1, 1);
    return findings.record({ category: 'work', text: 'Product manager at Acme', source_url: 'https://samrivera.dev/about', evidence_quote: 'product manager at Acme', anchor: 'samrivera.dev' }, 'About', 2) as { id: string };
  };
  it('withdrawing the look-up erases every finding in the same step', () => owner(async ({ storage, send }) => {
    seed(storage);
    expect(appFindingListV1Schema.parse(await (await send('/app/v1/findings')).json())).toMatchObject({ lookup: 'granted', total: 1 });
    const change = appConsentChangeV1Schema.parse(await (await send('/app/v1/consents/withdraw', { request_id: 'withdraw-0001', purpose: 'owner_lookup' })).json());
    expect(change).toMatchObject({ consent: { status: 'withdrawn' }, findings_erased: 1, replayed: false });
    expect(appFindingListV1Schema.parse(await (await send('/app/v1/findings')).json())).toEqual({ lookup: 'withdrawn', items: [], total: 0, next_cursor: null });
    expect((await send('/app/v1/consents/withdraw', { request_id: 'withdraw-0002', purpose: 'terms' })).status).toBe(400);
    expect(await (await send('/app/v1/consents', { request_id: 'grant-0001', purpose: 'owner_lookup', version: 9, age_attested_18_plus: true })).json()).toEqual({ error: 'stale_version' });
  }));
  it('unticking the look-up in the agreements withdraws it and erases the findings', () => owner(async ({ storage, act }) => {
    seed(storage);
    await act({ action: 'start' }); await act({ ...agree, owner_lookup: false });
    expect(storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM owner_findings').one().n).toBe(0);
    expect(consentLedger(storage.sql).state('owner_lookup').status).toBe('withdrawn');
  }));
  it('forgetting a finding with a short quote hides the long passage only, never every line that shares a word', () => owner(async ({ storage, send }) => {
    const claims = claimStore(storage.sql, work => storage.transactionSync(work)), consent = consentLedger(storage.sql), findings = findingStore(storage.sql, claims, consent);
    consent.grant('owner_lookup', 1, 1);
    const { id } = findings.record({ category: 'based_in', text: 'Based in Pune since 2019', source_url: 'https://samrivera.dev/about', evidence_quote: 'Pune', anchor: 'samrivera.dev' }, 'About', 2) as { id: string };
    const episodes = episodeIndex(storage.sql);
    episodes.add('e1', 'owner', 'Book me a table in Pune on Friday', 1);
    episodes.add('e2', 'waldo', 'Your site says: Based in Pune since 2019', 2);
    expect((await send('/app/v1/findings/actions', { request_id: 'finding-forget-s', finding_id: id, action: 'forget' })).status).toBe(200);
    expect(storage.sql.exec<{ text: string }>('SELECT text FROM episodes ORDER BY entry_id').toArray().map(row => row.text)).toEqual(['Book me a table in Pune on Friday', 'Your site says: [forgotten]']);
  }));
  it('forgets one finding and hides its copies in the chat', () => owner(async ({ storage, send }) => {
    const { id } = seed(storage);
    expect(await (await send('/app/v1/findings/actions', { request_id: 'finding-keep-1', finding_id: id, action: 'keep' })).json()).toMatchObject({ outcome: 'kept' });
    expect(await (await send('/app/v1/findings/actions', { request_id: 'finding-forget-1', finding_id: id, action: 'forget' })).json()).toMatchObject({ outcome: 'forgotten', replayed: false });
    expect(await (await send('/app/v1/findings/actions', { request_id: 'finding-forget-1', finding_id: id, action: 'forget' })).json()).toMatchObject({ outcome: 'forgotten', replayed: true });
    expect((await send('/app/v1/findings/actions', { request_id: 'finding-forget-2', finding_id: id, action: 'forget' })).status).toBe(404);
    expect(claimStore(storage.sql).claims()).toHaveLength(0);
    expect(appFindingListV1Schema.parse(await (await send('/app/v1/findings')).json()).total).toBe(0);
  }));
});
