import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { APP_FINDING_UNCONFIRMED_DAYS_V1, appChannelLinkCodeV1Schema, appConsentChangeV1Schema, appConsentListV1Schema, appFindingListV1Schema, appOnboardingChannelsV1Schema, appOnboardingResultV1Schema, appOnboardingV1Schema, appProactiveSurfaceV1Schema } from '../../contracts/src/app/onboarding';
import { PROACTIVE_SURFACES } from '../src/channels/proactive-surface';
import type { ChatChannels } from '../src/channels/chat-channel-links';
import { appOnboardingRequest, ownerOnboardingHost, type OwnerOnboardingDeps } from '../src/channels/app-onboarding';
import { claimStore } from '../src/memory/claims';
import { consentLedger } from '../src/onboarding/consent-ledger';
import { findingStore } from '../src/onboarding/findings';
import { recordSignupName } from '../src/onboarding/first-run';
import { episodeIndex } from '../src/channels/episodes';

let sequence = 0;
type Calls = { acts: unknown[]; admitted: string[]; rpc: number; hidden: (readonly string[])[] };
type Fakes = Partial<Pick<OwnerOnboardingDeps, 'rpc' | 'act' | 'admit' | 'chat' | 'assertCurrent' | 'hideText' | 'lookupOffered' | 'agreementsOffered' | 'now'>>;
const NO_CHAT: ChatChannels = { offered: async () => false, linked: async () => 'unknown', issue: async () => null };
const owner = <T>(fn: (o: { storage: DurableObjectStorage; calls: Calls; send(path: string, body?: unknown, method?: string): Promise<Response>; act(body: Record<string, unknown>): Promise<Response> }) => Promise<T>, fakes: Fakes = {}) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`app-onboarding-${sequence++}`)), async (_instance, state) => {
    const calls: Calls = { acts: [], admitted: [], rpc: 0, hidden: [] };
    let clock = 1_000;
    const deps: OwnerOnboardingDeps = {
      storage: state.storage, doName: 'owner-name', now: fakes.now ?? (() => clock++), assertCurrent: fakes.assertCurrent ?? (async () => {}), chat: fakes.chat ?? NO_CHAT,
      lookupOffered: fakes.lookupOffered ?? true, agreementsOffered: fakes.agreementsOffered ?? true, hideText: fakes.hideText ?? (async texts => { calls.hidden.push(texts); }),
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
  it('reads the name step as done when sign-up recorded the name, keeps the first answer, and lets name.set correct it', () => owner(async ({ storage, act, send }) => {
    const claims = claimStore(storage.sql, work => storage.transactionSync(work));
    expect(recordSignupName(claims, 'Asha Menon', 1)).toBe(true);
    expect(recordSignupName(claims, 'Someone Else', 2)).toBe(false);
    expect(claims.claims().filter(claim => claim.text.startsWith('Wants to be called')).map(claim => [claim.text, claim.origin, claim.source, claim.pinned]))
      .toEqual([['Wants to be called Asha Menon', 'owner', 'stated', 'profile']]);
    await act({ action: 'start' }); await act(agree);
    expect(appOnboardingV1Schema.parse(await (await send('/app/v1/onboarding')).json()).steps.name).toBe('done');
    await act({ action: 'name.set', name: 'Asha' });
    expect(claims.claims().filter(claim => claim.text.startsWith('Wants to be called')).map(claim => claim.text)).toEqual(['Wants to be called Asha']);
    expect((await run(await act({ action: 'complete' }))).steps.name).toBe('done');
  }));
  it('asks the name when sign-up recorded none, and a finished run without it reads skipped', () => owner(async ({ act }) => {
    await act({ action: 'start' }); await act(agree);
    expect((await run(await act({ action: 'brief_time.set', time: '07:30', timezone: 'Asia/Kolkata' }))).steps.name).toBe('pending');
    expect((await run(await act({ action: 'complete' }))).steps.name).toBe('skipped');
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
  it('seeds the console proactive-surface setting from the channel step, and leaves the app default when skipped', () => owner(async ({ storage, act }) => {
    await act({ action: 'start' }); await act(agree);
    expect((await run(await act({ action: 'start' }))).channel).toEqual({ surface: 'app' });
    const chosen = await run(await act({ action: 'channel.set', surface: 'both' }));
    expect(chosen).toMatchObject({ steps: { channel: 'done' }, channel: { surface: 'both' } });
    // The same key the console writes, so the console shows it and delivery follows it.
    expect(storage.kv.get('proactive_surface_v1')).toBe('both');
    expect((await act({ action: 'channel.set', surface: 'telegram' })).status).toBe(400);
    expect(storage.kv.get('proactive_surface_v1')).toBe('both');
  }));
  it('keeps the app as the proactive surface when the channel step is skipped', () => owner(async ({ storage, act }) => {
    await act({ action: 'start' }); await act(agree);
    expect(await run(await act({ action: 'skip', step: 'channel' }))).toMatchObject({ steps: { channel: 'skipped' }, channel: { surface: 'app' } });
    expect(storage.kv.get('proactive_surface_v1')).toBeUndefined();
  }));
  it('refuses the channel step before the agreements', () => owner(async ({ storage, act }) => {
    await act({ action: 'start' });
    expect(await (await act({ action: 'channel.set', surface: 'whatsapp' })).json()).toEqual({ error: 'agreements_required' });
    expect(storage.kv.get('proactive_surface_v1')).toBeUndefined();
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
    expect(done).toMatchObject({ state: 'completed', steps: { agreements: 'done', name: 'done', google: 'skipped', health: 'skipped', brief_time: 'skipped', priority: 'skipped', channel: 'skipped', first_look: 'pending' }, channel: { surface: 'app' } });
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

describe('chat channels in the first run', () => {
  const CODE = 'ABCDEFGHJK';
  const chat = (state: Record<string, 'linked' | 'not_linked' | 'unknown'>, offered: string[] = ['imessage', 'whatsapp', 'telegram']) => {
    const issued: string[] = [];
    const channels: ChatChannels = {
      offered: async provider => offered.includes(provider), linked: async provider => state[provider] ?? 'not_linked',
      issue: async provider => { issued.push(provider); return { provider, code: CODE, text: provider === 'telegram' ? `/link ${CODE}` : `waldo ${CODE}`, address: null, send_url: null, expires_in_seconds: 600 }; },
    };
    return { issued, channels };
  };
  it('lists the three chat channels with the live state of each, and says which the server does not offer', () => {
    const { channels } = chat({ imessage: 'linked', whatsapp: 'unknown' }, ['imessage', 'whatsapp']);
    return owner(async ({ send }) => {
      const view = appOnboardingChannelsV1Schema.parse(await (await send('/app/v1/onboarding/channels')).json());
      expect(view).toEqual({ surface: 'app', channels: [{ provider: 'imessage', state: 'linked' }, { provider: 'whatsapp', state: 'unknown' }, { provider: 'telegram', state: 'not_offered' }] });
    }, { chat: channels });
  });
  it('gives the same link flow to every provider, and never stores the code', () => {
    const { issued, channels } = chat({});
    return owner(async ({ storage, send, act }) => {
      await act({ action: 'start' }); await act(agree);
      for (const provider of ['imessage', 'whatsapp', 'telegram']) {
        const response = await send('/app/v1/onboarding/channel-link', { provider });
        expect([provider, response.status, response.headers.get('cache-control')]).toEqual([provider, 200, 'private, no-store']);
        expect(appChannelLinkCodeV1Schema.parse(await response.json())).toMatchObject({ provider, code: CODE });
      }
      await send('/app/v1/onboarding/channel-link', { provider: 'whatsapp' });
      expect(issued).toEqual(['imessage', 'whatsapp', 'telegram', 'whatsapp']);
      // A secret must not sit in the replay book or the run: only its absence is the guarantee.
      const everything = JSON.stringify([storage.sql.exec('SELECT * FROM app_write_requests').toArray(), storage.sql.exec('SELECT * FROM onboarding_runs').toArray()]);
      expect(everything).not.toContain(CODE);
    }, { chat: channels });
  });
  it('issues no code before the agreements, for a provider not offered, or for an unknown provider', () => {
    const { issued, channels } = chat({}, ['whatsapp']);
    return owner(async ({ send, act }) => {
      await act({ action: 'start' });
      expect(await (await send('/app/v1/onboarding/channel-link', { provider: 'whatsapp' })).json()).toEqual({ error: 'agreements_required' });
      await act(agree);
      expect(await (await send('/app/v1/onboarding/channel-link', { provider: 'imessage' })).json()).toEqual({ error: 'not_offered' });
      expect((await send('/app/v1/onboarding/channel-link', { provider: 'discord' })).status).toBe(400);
      expect((await send('/app/v1/onboarding/channel-link', { provider: 'whatsapp', request_id: 'link-0001' })).status).toBe(400);
      expect((await send('/app/v1/onboarding/channel-link', {})).status).toBe(400);
      expect(issued).toEqual([]);
    }, { chat: channels });
  });
  it('reads a provider whose offer the directory cannot confirm as unknown, and answers unavailable rather than not offered', () => {
    const unreadable: ChatChannels = { offered: async provider => { if (provider === 'imessage') throw new Error('the owner directory cannot be read'); return true; }, linked: async () => 'not_linked', issue: async () => null };
    return owner(async ({ send, act }) => {
      expect(appOnboardingChannelsV1Schema.parse(await (await send('/app/v1/onboarding/channels')).json()).channels).toEqual([
        { provider: 'imessage', state: 'unknown' }, { provider: 'whatsapp', state: 'not_linked' }, { provider: 'telegram', state: 'not_linked' }]);
      await act({ action: 'start' }); await act(agree);
      const link = await send('/app/v1/onboarding/channel-link', { provider: 'imessage' });
      expect([link.status, await link.json()]).toEqual([503, { error: 'unavailable' }]);
      const linked = await act({ action: 'channel.linked', provider: 'imessage' });
      expect([linked.status, await linked.json()]).toEqual([503, { error: 'unavailable' }]);
    }, { chat: unreadable });
  });
  it('answers unavailable when the directory gives no code', () => owner(async ({ send, act }) => {
    await act({ action: 'start' }); await act(agree);
    const response = await send('/app/v1/onboarding/channel-link', { provider: 'telegram' });
    expect([response.status, await response.json()]).toEqual([503, { error: 'unavailable' }]);
  }, { chat: { offered: async () => true, linked: async () => 'not_linked', issue: async () => null } }));
  it('issues nothing when the app session is no longer current', () => {
    const { issued, channels } = chat({});
    let ended = false;
    return owner(async ({ send, act }) => {
      await act({ action: 'start' }); await act(agree);
      ended = true;
      await expect(send('/app/v1/onboarding/channel-link', { provider: 'whatsapp' })).rejects.toThrow('session ended');
      expect(issued).toEqual([]);
    }, { chat: channels, assertCurrent: async () => { if (ended) throw new Error('session ended'); } });
  });
  it('marks the channel step done only when the directory shows the provider linked', () => {
    const { channels } = chat({ whatsapp: 'linked', imessage: 'unknown' });
    return owner(async ({ act }) => {
      await act({ action: 'start' }); await act(agree);
      const notLinked = await act({ action: 'channel.linked', provider: 'telegram' });
      expect([notLinked.status, await notLinked.json()]).toEqual([409, { error: 'not_connected' }]);
      const unknown = await act({ action: 'channel.linked', provider: 'imessage' });
      expect([unknown.status, await unknown.json()]).toEqual([503, { error: 'unavailable' }]);
      expect((await run(await act({ action: 'start' }))).steps.channel).toBe('pending');
      expect((await run(await act({ action: 'channel.linked', provider: 'whatsapp' }))).steps.channel).toBe('done');
    }, { chat: channels });
  });
  it('does not mark a provider the server does not offer, even if the directory says linked', () => {
    const { channels } = chat({ telegram: 'linked' }, ['whatsapp']);
    return owner(async ({ act }) => {
      await act({ action: 'start' }); await act(agree);
      expect(await (await act({ action: 'channel.linked', provider: 'telegram' })).json()).toEqual({ error: 'not_offered' });
      expect((await run(await act({ action: 'start' }))).steps.channel).toBe('pending');
    }, { chat: channels });
  });
  it('refuses to mark a channel before the agreements', () => owner(async ({ act }) => {
    await act({ action: 'start' });
    expect(await (await act({ action: 'channel.linked', provider: 'whatsapp' })).json()).toEqual({ error: 'agreements_required' });
  }, { chat: chat({ whatsapp: 'linked' }).channels }));
});

describe('one consent representation per purpose', () => {
  const row = (source: string, purpose: string, status = 'granted') => ({ consent_class: 'health_processing', source, purpose, version: 2, status, epoch: 1, granted_at: '2026-10-21T00:00:00Z', withdrawn_at: null, deletion_state: 'not_required' });
  const everything = { consents: [row('apple', 'storage_compute'), row('apple', 'model_processing'), row('whoop', 'storage_compute'), row('whoop', 'model_processing')] };
  const ledgerPurposes = (storage: DurableObjectStorage) => storage.sql.exec<{ purpose: string }>('SELECT DISTINCT purpose FROM consent_ledger ORDER BY purpose').toArray().map(entry => entry.purpose);
  it('keeps every health grant out of the ledger through a whole first run', () => owner(async ({ storage, act }) => {
    await act({ action: 'start' }); await act(agree);
    expect((await run(await act({ action: 'health.connected' }))).steps.health).toBe('done');
    await act({ action: 'complete' });
    expect(ledgerPurposes(storage)).toEqual(['age_18_plus', 'owner_lookup', 'privacy_notice', 'terms']);
  }, { rpc: async () => everything }));
  it('refuses a health purpose on the consent route and leaves the ledger empty', () => owner(async ({ storage, send }) => {
    for (const purpose of ['storage_compute', 'model_processing', 'whoop', 'whoop_storage_ai']) {
      const response = await send('/app/v1/consents', { request_id: `consent-${purpose}`.slice(0, 40), purpose, version: 1, age_attested_18_plus: true });
      expect([purpose, response.status]).toEqual([purpose, 400]);
    }
    expect(storage.sql.exec('SELECT 1 FROM consent_ledger').toArray()).toEqual([]);
  }));
  it('cannot store a health purpose even by a direct write', () => owner(async ({ storage }) => {
    const ledger = consentLedger(storage.sql, { lookupOffered: true, agreementsOffered: true });
    expect(ledger.grant('storage_compute' as never, 1, 1)).toBe('stale_version');
    for (const purpose of ['storage_compute', 'model_processing', 'whoop']) {
      expect(() => storage.sql.exec("INSERT INTO consent_ledger (purpose, action, version, at) VALUES (?, 'granted', 1, 1)", purpose)).toThrow();
    }
    expect(storage.sql.exec('SELECT 1 FROM consent_ledger').toArray()).toEqual([]);
  }));
  it('lists only the three non-health purposes', () => owner(async ({ send }) => {
    const list = await (await send('/app/v1/consents')).json() as { consents: { purpose: string }[] };
    expect(list.consents.map(consent => consent.purpose)).toEqual(['terms', 'privacy_notice', 'owner_lookup']);
  }));
});

describe('health step reads both grants a cloud wearable needs', () => {
  const grant = (source: string, purpose: string, status = 'granted') => ({ consent_class: 'health_processing', source, purpose, version: 2, status, epoch: 1, granted_at: '2026-10-21T00:00:00Z', withdrawn_at: null, deletion_state: 'not_required' });
  const connected = (consents: unknown[]) => owner(async ({ act }) => {
    await act({ action: 'start' }); await act(agree);
    const response = await act({ action: 'health.connected' });
    return [response.status, response.status === 200 ? (await run(response)).steps.health : (await response.json() as { error: string }).error];
  }, { rpc: async () => ({ consents }) });
  it('counts a device source on its storage grant alone', async () => {
    expect(await connected([grant('apple', 'storage_compute')])).toEqual([200, 'done']);
    expect(await connected([grant('health_connect', 'storage_compute'), grant('health_connect', 'model_processing', 'withdrawn')])).toEqual([200, 'done']);
  });
  it('needs both grants for WHOOP: storage alone, or storage with model use withdrawn, is not a connection', async () => {
    expect(await connected([grant('whoop', 'storage_compute')])).toEqual([409, 'not_connected']);
    expect(await connected([grant('whoop', 'storage_compute'), grant('whoop', 'model_processing', 'withdrawn')])).toEqual([409, 'not_connected']);
    expect(await connected([grant('whoop', 'model_processing')])).toEqual([409, 'not_connected']);
    expect(await connected([grant('whoop', 'storage_compute'), grant('whoop', 'model_processing')])).toEqual([200, 'done']);
  });
  it('does not let one source borrow another source\'s grant', async () => {
    expect(await connected([grant('whoop', 'storage_compute'), grant('apple', 'model_processing')])).toEqual([409, 'not_connected']);
  });
  it('treats a provider it has not met as needing both grants, and does not fail on it', async () => {
    expect(await connected([grant('oura', 'storage_compute')])).toEqual([409, 'not_connected']);
    expect(await connected([grant('oura', 'storage_compute'), grant('oura', 'model_processing')])).toEqual([200, 'done']);
    expect(await connected([grant('apple', 'storage_compute'), grant('oura', 'storage_compute')])).toEqual([200, 'done']);
  });
  it('answers unavailable for an answer it cannot read, never connected', async () => {
    expect(await connected([{ source: 'apple' }])).toEqual([503, 'unavailable']);
  });
});

describe('consent and findings routes', () => {
  const ledger = (storage: DurableObjectStorage) => consentLedger(storage.sql, { lookupOffered: true, agreementsOffered: true });
  const stores = (storage: DurableObjectStorage) => {
    const claims = claimStore(storage.sql, work => storage.transactionSync(work)), consent = ledger(storage);
    return { claims, consent, findings: findingStore(storage.sql, claims, consent, () => 1_000) };
  };
  const ACME = { category: 'work', text: 'Product manager at Acme', source_url: 'https://samrivera.dev/about', evidence_quote: 'product manager at Acme' } as const;
  const PUNE = { category: 'based_in', text: 'Based in Pune since 2019', source_url: 'https://samrivera.dev/about', evidence_quote: 'Sam Rivera lives in Pune' } as const;
  const seed = (storage: DurableObjectStorage) => {
    const { consent, findings } = stores(storage);
    consent.grant('terms', 1, 1); consent.grant('privacy_notice', 1, 1); consent.grant('owner_lookup', 1, 1);
    return findings.record(ACME, 'About', 2) as { id: string };
  };
  const count = (storage: DurableObjectStorage) => storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM owner_findings').one().n;
  it('withdrawing the look-up erases every finding in the same step', () => owner(async ({ storage, send }) => {
    seed(storage);
    expect(appFindingListV1Schema.parse(await (await send('/app/v1/findings')).json())).toMatchObject({ lookup: 'granted', total: 1 });
    const change = appConsentChangeV1Schema.parse(await (await send('/app/v1/consents/withdraw', { request_id: 'withdraw-0001', purpose: 'owner_lookup' })).json());
    expect(change).toMatchObject({ consent: { status: 'withdrawn' }, findings_erased: 1, replayed: false });
    expect(appFindingListV1Schema.parse(await (await send('/app/v1/findings')).json())).toEqual({ lookup: 'withdrawn', items: [], total: 0, next_cursor: null });
    expect((await send('/app/v1/consents/withdraw', { request_id: 'withdraw-0002', purpose: 'terms' })).status).toBe(400);
    expect(await (await send('/app/v1/consents', { request_id: 'grant-0001', purpose: 'owner_lookup', version: 9, age_attested_18_plus: true })).json()).toEqual({ error: 'stale_version' });
  }));
  it('withdrawing hides every copy of what was found before the findings go, and bars them from coming back', () => owner(async ({ storage, calls, send }) => {
    const { findings } = stores(storage);
    const { id } = seed(storage);
    findings.record(PUNE, 'About', 3);
    findings.decide(id, { action: 'keep' }, 4);
    const change = appConsentChangeV1Schema.parse(await (await send('/app/v1/consents/withdraw', { request_id: 'withdraw-hide-1', purpose: 'owner_lookup' })).json());
    expect(change.findings_erased).toBe(2);
    expect(calls.hidden.flat().sort()).toEqual([ACME.text, ACME.evidence_quote, PUNE.text, PUNE.evidence_quote].sort());
    expect(claimStore(storage.sql).allClaims()).toHaveLength(0);
    // A later yes, and the same pages found again, bring nothing back.
    expect((await send('/app/v1/consents', { request_id: 'grant-again-1', purpose: 'owner_lookup', version: 1, age_attested_18_plus: true })).status).toBe(200);
    expect(findings.record(ACME, 'About', 9)).toBe('forgotten');
    expect(findings.record(PUNE, 'About', 9)).toBe('forgotten');
  }));
  it('withdraws nothing when the copies cannot be hidden: the yes and the findings stay, and a retry finishes', () => {
    let failing = true;
    return owner(async ({ storage, send }) => {
      seed(storage);
      await expect(send('/app/v1/consents/withdraw', { request_id: 'withdraw-fail-1', purpose: 'owner_lookup' })).rejects.toThrow('history cleanup');
      expect(ledger(storage).state('owner_lookup').status).toBe('granted');
      expect(count(storage)).toBe(1);
      failing = false;
      expect(appConsentChangeV1Schema.parse(await (await send('/app/v1/consents/withdraw', { request_id: 'withdraw-fail-1', purpose: 'owner_lookup' })).json())).toMatchObject({ findings_erased: 1, replayed: false });
      expect(count(storage)).toBe(0);
    }, { hideText: async () => { if (failing) throw new Error('history cleanup is incomplete'); } });
  });
  it('also hides and bars a finding a turn recorded while the copies were being hidden', () => {
    const LATE = { category: 'achievement', text: 'Spoke at the Pune product summit', source_url: 'https://samrivera.dev/talks', evidence_quote: 'Sam spoke at the Pune product summit' } as const;
    const hidden: (readonly string[])[] = [];
    let storageRef: DurableObjectStorage | null = null;
    return owner(async ({ storage, send }) => {
      storageRef = storage;
      seed(storage);
      expect(appConsentChangeV1Schema.parse(await (await send('/app/v1/consents/withdraw', { request_id: 'withdraw-late-1', purpose: 'owner_lookup' })).json()).findings_erased).toBe(2);
      expect(hidden).toEqual([[ACME.text, ACME.evidence_quote], [LATE.text, LATE.evidence_quote]]);
      expect(count(storage)).toBe(0);
      ledger(storage).grant('owner_lookup', 1, 10);
      expect(stores(storage).findings.record(LATE, 'Talks', 11)).toBe('forgotten');
    }, { hideText: async texts => {
      // The first hide yields to a turn that records one more finding before the withdrawal commits.
      if (!hidden.length) stores(storageRef!).findings.record(LATE, 'Talks', 5);
      hidden.push(texts);
    } });
  });
  it('unticking the look-up in the agreements withdraws it, hides the copies and bars the findings', () => owner(async ({ storage, calls, act }) => {
    seed(storage);
    await act({ action: 'start' }); await act({ ...agree, owner_lookup: false });
    expect(count(storage)).toBe(0);
    expect(ledger(storage).state('owner_lookup').status).toBe('withdrawn');
    expect(calls.hidden.flat().sort()).toEqual([ACME.text, ACME.evidence_quote].sort());
    ledger(storage).grant('owner_lookup', 1, 10);
    expect(stores(storage).findings.record(ACME, 'About', 11)).toBe('forgotten');
  }));
  it('refuses the look-up before the privacy notice that discloses it, and leaves it not granted', () => owner(async ({ send }) => {
    const early = await send('/app/v1/consents', { request_id: 'grant-early-1', purpose: 'owner_lookup', version: 1, age_attested_18_plus: true });
    expect([early.status, await early.json()]).toEqual([409, { error: 'agreements_required' }]);
    expect(appConsentListV1Schema.parse(await (await send('/app/v1/consents')).json()).consents.find(row => row.purpose === 'owner_lookup')).toMatchObject({ status: 'not_granted' });
    expect((await send('/app/v1/consents', { request_id: 'grant-notice-1', purpose: 'privacy_notice', version: 1, age_attested_18_plus: true })).status).toBe(200);
    expect(await (await send('/app/v1/consents', { request_id: 'grant-late-1', purpose: 'owner_lookup', version: 1, age_attested_18_plus: true })).json()).toMatchObject({ consent: { purpose: 'owner_lookup', status: 'granted' } });
  }));
  it('offers no look-up while the server has it off: the app is told, and a yes is refused without half-recording the agreements', () => owner(async ({ storage, send, act }) => {
    expect(appConsentListV1Schema.parse(await (await send('/app/v1/consents')).json()).owner_lookup_offered).toBe(false);
    await send('/app/v1/consents', { request_id: 'grant-notice-2', purpose: 'privacy_notice', version: 1, age_attested_18_plus: true });
    const refused = await send('/app/v1/consents', { request_id: 'grant-off-1', purpose: 'owner_lookup', version: 1, age_attested_18_plus: true });
    expect([refused.status, await refused.json()]).toEqual([409, { error: 'not_offered' }]);
    await act({ action: 'start' });
    const yes = await act(agree);
    expect([yes.status, await yes.json()]).toEqual([409, { error: 'not_offered' }]);
    expect(storage.sql.exec<{ purpose: string }>("SELECT purpose FROM consent_ledger WHERE purpose IN ('terms', 'owner_lookup')").toArray()).toEqual([]);
    expect((await run(await act({ ...agree, owner_lookup: false }))).steps.agreements).toBe('done');
  }, { lookupOffered: false }));
  it('holds the agreements back while the server has their copy off: the app is told, nothing is recorded, and the steps after them run', () => owner(async ({ storage, calls, send, act }) => {
    expect(appConsentListV1Schema.parse(await (await send('/app/v1/consents')).json())).toMatchObject({ agreements_offered: false, owner_lookup_offered: false });
    const terms = await send('/app/v1/consents', { request_id: 'grant-held-1', purpose: 'terms', version: 1, age_attested_18_plus: true });
    expect([terms.status, await terms.json()]).toEqual([409, { error: 'not_offered' }]);
    await act({ action: 'start' });
    for (const owner_lookup of [true, false]) {
      const yes = await act({ ...agree, owner_lookup });
      expect([yes.status, await yes.json()]).toEqual([409, { error: 'not_offered' }]);
    }
    expect((await run(await act({ action: 'name.set', name: 'Sam' }))).steps).toMatchObject({ agreements: 'pending', name: 'done' });
    expect(storage.sql.exec('SELECT 1 FROM consent_ledger').toArray()).toEqual([]);
    expect(calls.hidden).toEqual([]);
    expect(appOnboardingV1Schema.parse(await (await send('/app/v1/onboarding')).json()).steps.agreements).toBe('pending');
  }, { agreementsOffered: false }));
  it('keeps what was found listed and forgettable while the server has the look-up off', () => owner(async ({ storage, calls, send }) => {
    const { id } = seed(storage);
    expect(appFindingListV1Schema.parse(await (await send('/app/v1/findings')).json())).toMatchObject({ lookup: 'not_granted', total: 1, items: [{ finding_id: id, text: ACME.text }] });
    expect((await send('/app/v1/findings/actions', { request_id: 'finding-forget-off', finding_id: id, action: 'forget' })).status).toBe(200);
    expect(calls.hidden).toEqual([[ACME.text, ACME.evidence_quote]]);
    expect(count(storage)).toBe(0);
  }, { lookupOffered: false }));
  it('stops listing an unconfirmed finding 30 days after it was found, by the server clock', () => {
    const DAY = 86_400_000;
    let clock = 1_000;
    return owner(async ({ storage, send }) => {
      seed(storage);
      clock = 2 + APP_FINDING_UNCONFIRMED_DAYS_V1 * DAY - 1;
      expect(appFindingListV1Schema.parse(await (await send('/app/v1/findings')).json()).total).toBe(1);
      clock += 1;
      expect(appFindingListV1Schema.parse(await (await send('/app/v1/findings')).json())).toMatchObject({ lookup: 'granted', total: 0, items: [] });
      expect(count(storage)).toBe(0);
    }, { now: () => clock });
  });
  it('refuses a grant that names its own time: the server records when', () => owner(async ({ storage, send }) => {
    const forged = await send('/app/v1/consents', { request_id: 'grant-forged-1', purpose: 'privacy_notice', version: 1, age_attested_18_plus: true, granted_at: 1 });
    expect(forged.status).toBe(400);
    expect(storage.sql.exec('SELECT 1 FROM consent_ledger').toArray()).toEqual([]);
  }));
  it('forgetting a finding hides its copies first, and only passages long enough not to hide unrelated lines', () => owner(async ({ storage, calls, send }) => {
    const { consent, findings } = stores(storage);
    consent.grant('terms', 1, 1); consent.grant('privacy_notice', 1, 1); consent.grant('owner_lookup', 1, 1);
    const { id } = findings.record({ ...PUNE, text: 'Pune' }, 'About', 2) as { id: string };
    expect((await send('/app/v1/findings/actions', { request_id: 'finding-forget-s', finding_id: id, action: 'forget' })).status).toBe(200);
    expect(calls.hidden).toEqual([[PUNE.evidence_quote]]);
  }));
  it('forgets nothing when the copies cannot be hidden', () => owner(async ({ storage, send }) => {
    const { id } = seed(storage);
    await expect(send('/app/v1/findings/actions', { request_id: 'finding-forget-f', finding_id: id, action: 'forget' })).rejects.toThrow('history cleanup');
    expect(count(storage)).toBe(1);
  }, { hideText: async () => { throw new Error('history cleanup is incomplete'); } }));
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

describe('the first run reads every proactive surface the console can set', () => {
  it('names the same surfaces as the console setting', () => {
    expect([...appProactiveSurfaceV1Schema.options].sort()).toEqual([...PROACTIVE_SURFACES].sort());
  });
  it('reads a run whose owner chose the app with an iMessage copy in the console', () => owner(async ({ storage, send, act }) => {
    storage.kv.put('proactive_surface_v1', 'app_imessage');
    expect(appOnboardingV1Schema.parse(await (await send('/app/v1/onboarding')).json()).channel).toEqual({ surface: 'app_imessage' });
    await act({ action: 'start' }); await act(agree);
    expect((await run(await act({ action: 'channel.set', surface: 'app_imessage' }))).channel).toEqual({ surface: 'app_imessage' });
  }));
});

describe('failures an operator can see', () => {
  const failures = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
  it('logs a fixed code, and no text, when a link code cannot be issued', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return owner(async ({ send, act }) => {
      await act({ action: 'start' }); await act(agree);
      const response = await send('/app/v1/onboarding/channel-link', { provider: 'whatsapp' });
      expect([response.status, await response.json()]).toEqual([503, { error: 'unavailable' }]);
      expect(failures(logged)).toEqual([{ hop: 'app_onboarding', ok: false, code: 'channel_link_issue' }]);
    }, { chat: { offered: async () => true, linked: async () => 'not_linked', issue: async () => { throw new Error('directory down for owner-name'); } } }).finally(() => logged.mockRestore());
  });
  it('logs a fixed code, and no text, when the health plane cannot be read', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return owner(async ({ act }) => {
      await act({ action: 'start' }); await act(agree);
      expect((await act({ action: 'health.connected' })).status).toBe(503);
      expect(failures(logged)).toEqual([{ hop: 'app_onboarding', ok: false, code: 'health_consent_list' }]);
    }, { rpc: async () => { throw new Error('directory down for owner-name'); } }).finally(() => logged.mockRestore());
  });
});
