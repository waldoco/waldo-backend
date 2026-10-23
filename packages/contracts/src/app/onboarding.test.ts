import { describe, expect, it } from 'vitest';
import {
  APP_PRIVACY_NOTICE_VERSION_V1, APP_TERMS_VERSION_V1, appConsentChangeV1Schema, appConsentGrantV1Schema, appConsentListV1Schema,
  appConsentStateV1Schema, appConsentWithdrawV1Schema, appFindingActionV1Schema, appFindingListV1Schema, appFindingResultV1Schema,
  appFindingV1Schema, appOnboardingActionV1Schema, appOnboardingErrorV1Schema, appOnboardingResultV1Schema, appOnboardingRoutesV1,
  appOnboardingV1Schema, appConsentPurposeV1Schema, appChannelLinkCodeV1Schema, appChannelLinkRequestV1Schema, appOnboardingChannelsV1Schema,
} from './onboarding';
import { healthPurposeV1Schema, healthSourceV1Schema } from './health-ingest';

const rejected = (schema: { safeParse(input: unknown): { success: boolean } }, inputs: unknown[]) => inputs.forEach(input => expect(schema.safeParse(input).success, JSON.stringify(input)).toBe(false));
const accepted = (schema: { safeParse(input: unknown): { success: boolean } }, inputs: unknown[]) => inputs.forEach(input => expect(schema.safeParse(input).success, JSON.stringify(input)).toBe(true));
const REVISION = 'a'.repeat(64);

describe('consent ledger', () => {
  const granted = { purpose: 'owner_lookup', version: APP_PRIVACY_NOTICE_VERSION_V1, status: 'granted', granted_at: 1_000, withdrawn_at: null, active: true };
  it('reads a state for every purpose, never granted, granted or withdrawn', () => {
    accepted(appConsentStateV1Schema, [granted, { ...granted, active: false }, { ...granted, status: 'withdrawn', withdrawn_at: 2_000, active: false }, { purpose: 'terms', version: null, status: 'not_granted', granted_at: null, withdrawn_at: null, active: false }]);
    rejected(appConsentStateV1Schema, [
      // active says whether the yes counts now; only a granted yes can.
      { ...granted, status: 'withdrawn', withdrawn_at: 2_000 }, { purpose: 'terms', version: null, status: 'not_granted', granted_at: null, withdrawn_at: null, active: true },
      { ...granted, active: undefined }, { ...granted, active: 'yes' },
      { ...granted, status: 'withdrawn' }, { ...granted, withdrawn_at: 2_000 }, { ...granted, status: 'withdrawn', withdrawn_at: 500 },
      { ...granted, status: 'not_granted' }, { ...granted, version: null }, { ...granted, purpose: 'health_processing' },
      { ...granted, purpose: 'terms', status: 'withdrawn', withdrawn_at: 2_000 }, { ...granted, owner_id: 'other' },
    ]);
  });
  it('lists each purpose exactly once with the 18+ attestation', () => {
    const consents = ['terms', 'privacy_notice', 'owner_lookup'].map(purpose => ({ purpose, version: null, status: 'not_granted', granted_at: null, withdrawn_at: null, active: false }));
    const offered = { agreements_offered: true, owner_lookup_offered: false };
    accepted(appConsentListV1Schema, [{ age_attested_18_plus: false, ...offered, consents }, { age_attested_18_plus: true, agreements_offered: false, owner_lookup_offered: true, consents }]);
    rejected(appConsentListV1Schema, [{ consents, ...offered }, { age_attested_18_plus: false, consents }, { age_attested_18_plus: false, owner_lookup_offered: false, consents }, { age_attested_18_plus: false, ...offered, agreements_offered: 'yes', consents }, { age_attested_18_plus: false, ...offered, owner_lookup_offered: 'yes', consents }, { age_attested_18_plus: false, ...offered, consents: consents.slice(1) }, { age_attested_18_plus: false, ...offered, consents: [consents[0], consents[0], consents[1]] }]);
  });
  it('grants name a copy version and always carry the 18+ attestation; only the look-up can be withdrawn', () => {
    const grant = { request_id: 'consent-001', purpose: 'owner_lookup', version: 1, age_attested_18_plus: true };
    accepted(appConsentGrantV1Schema, [grant, { ...grant, purpose: 'terms', version: APP_TERMS_VERSION_V1 }]);
    rejected(appConsentGrantV1Schema, [{ ...grant, age_attested_18_plus: false }, { ...grant, version: 0 }, { ...grant, version: '1' }, { ...grant, purpose: '*' }, { ...grant, request_id: 'short' }, { ...grant, user_id: 'forged' }, { ...grant, granted_at: 1 }, { ...grant, at: 1 }]);
    accepted(appConsentWithdrawV1Schema, [{ request_id: 'withdraw-01', purpose: 'owner_lookup' }]);
    rejected(appConsentWithdrawV1Schema, [{ request_id: 'withdraw-01', purpose: 'terms' }, { request_id: 'withdraw-01', purpose: 'privacy_notice' }, { request_id: 'withdraw-01' }]);
    accepted(appConsentChangeV1Schema, [{ consent: granted, replayed: false, findings_erased: 0 }]);
    rejected(appConsentChangeV1Schema, [{ consent: granted, replayed: false }, { consent: granted, replayed: false, findings_erased: -1 }]);
  });
});

describe('one consent representation per purpose', () => {
  it('names no purpose the health plane already names, and no health source', () => {
    const health = new Set<string>([...healthPurposeV1Schema.options, ...healthSourceV1Schema.options, 'whoop', 'oura', 'whoop_storage_ai']);
    expect(appConsentPurposeV1Schema.options.filter(purpose => health.has(purpose))).toEqual([]);
    rejected(appConsentGrantV1Schema, [...health].map(purpose => ({ request_id: 'consent-001', purpose, version: 1, age_attested_18_plus: true })));
    rejected(appConsentStateV1Schema, [...health].map(purpose => ({ purpose, version: null, status: 'not_granted', granted_at: null, withdrawn_at: null, active: false })));
  });
});

describe('first run', () => {
  const steps = { agreements: 'pending', name: 'pending', google: 'pending', health: 'pending', first_look: 'pending', brief_time: 'pending', priority: 'pending', channel: 'pending' };
  const fresh = { version: 1, state: 'not_started', run_id: null, started_at: null, completed_at: null, steps, first_look: { message_id: null }, brief: { time: null, timezone_confirmed: false }, channel: { surface: 'app' }, revision: REVISION };
  const run = { ...fresh, state: 'in_progress', run_id: `onb_${'b'.repeat(32)}`, started_at: 1_000 };
  const done = { ...run, state: 'completed', completed_at: 9_000, steps: { ...steps, agreements: 'done', name: 'skipped', google: 'skipped', health: 'skipped', first_look: 'done', brief_time: 'done', priority: 'skipped', channel: 'done' }, first_look: { message_id: 'onboarding-first-look-1' }, brief: { time: '07:30', timezone_confirmed: true }, channel: { surface: 'both' } };
  it('reads a run before start, in progress and completed', () => {
    accepted(appOnboardingV1Schema, [fresh, run, done]);
    rejected(appOnboardingV1Schema, [
      { ...fresh, run_id: run.run_id }, { ...run, run_id: null }, { ...run, started_at: null }, { ...done, completed_at: null }, { ...run, completed_at: 5 },
      { ...done, steps: { ...done.steps, agreements: 'pending' } }, { ...run, steps: { ...steps, agreements: 'skipped' } }, { ...run, steps: { ...steps, first_look: 'skipped' } },
      { ...run, steps: { ...steps, first_look: 'done' } }, { ...run, first_look: { message_id: 'onboarding-first-look-1' } },
      { ...run, steps: { ...steps, mood_quiz: 'pending' } }, { ...run, brief: { time: '7:30', timezone_confirmed: false } }, { ...run, brief: { time: '24:00', timezone_confirmed: false } },
      { ...run, channel: { surface: 'telegram' } }, { ...run, channel: undefined }, { ...run, steps: { ...steps, channel: undefined } }, { ...run, run_id: 'onb_short' }, { ...run, revision: 'nope' }, { ...run, version: 2 },
    ]);
  });
  it('takes exactly three question answers, the agreements, connection outcomes and a surface choice, and nothing else', () => {
    const r = { request_id: 'onboarding-0001' };
    accepted(appOnboardingActionV1Schema, [
      { ...r, action: 'start' },
      { ...r, action: 'agreements.accept', terms_version: 1, notice_version: 1, age_attested_18_plus: true, owner_lookup: false },
      { ...r, action: 'name.set', name: 'Sam' }, { ...r, action: 'brief_time.set', time: '07:30', timezone: 'Asia/Kolkata' },
      ...['imessage', 'whatsapp', 'telegram'].map(provider => ({ ...r, action: 'channel.linked', provider })),
      { ...r, action: 'priority.set', text: 'Ship the board deck' }, ...['app', 'whatsapp', 'both', 'app_imessage'].map(surface => ({ ...r, action: 'channel.set', surface })), { ...r, action: 'health.connected' }, { ...r, action: 'first_look.request' },
      ...['name', 'google', 'health', 'brief_time', 'priority', 'channel'].map(step => ({ ...r, action: 'skip', step })), { ...r, action: 'complete' },
    ]);
    rejected(appOnboardingActionV1Schema, [
      { ...r, action: 'agreements.accept', terms_version: 1, notice_version: 1, age_attested_18_plus: false, owner_lookup: true },
      { ...r, action: 'agreements.accept', terms_version: 1, notice_version: 1, owner_lookup: true },
      { ...r, action: 'name.set', name: '   ' }, { ...r, action: 'name.set', name: 'x'.repeat(81) },
      { ...r, action: 'brief_time.set', time: '7:30', timezone: 'Asia/Kolkata' }, { ...r, action: 'brief_time.set', time: '07:30' }, { ...r, action: 'brief_time.set', time: '07:30', timezone: '../etc' },
      { ...r, action: 'priority.set', text: '' }, { ...r, action: 'skip', step: 'agreements' }, { ...r, action: 'skip', step: 'first_look' },
      { ...r, action: 'channel.linked' }, { ...r, action: 'channel.linked', provider: 'app' }, { ...r, action: 'channel.linked', provider: 'discord' }, { ...r, action: 'channel.linked', provider: 'telegram', code: 'ABCDEFGHJK' },
      { ...r, action: 'channel.set', surface: 'telegram' }, { ...r, action: 'channel.set' }, { ...r, action: 'channel.set', surface: 'app', extra: true }, { ...r, action: 'mood.set', value: 'tired' }, { ...r, action: 'start', owner_id: 'forged' }, { action: 'start' }, { ...r, action: 'name.set', name: 'Sam', extra: true },
    ]);
  });
  it('answers with the run and whether the request was replayed', () => {
    accepted(appOnboardingResultV1Schema, [{ request_id: 'onboarding-0001', onboarding: run, replayed: false }]);
    rejected(appOnboardingResultV1Schema, [{ request_id: 'onboarding-0001', onboarding: run }, { request_id: 'onboarding-0001', onboarding: { ...run, state: 'paused' }, replayed: false }]);
    accepted(appOnboardingErrorV1Schema, [{ error: 'agreements_required' }, { error: 'stale_version', message: 'Notice copy 2 is current.' }]);
    rejected(appOnboardingErrorV1Schema, [{ error: 'boom' }, { error: 'unavailable', stack: 'x' }]);
  });
});

describe('look-up findings', () => {
  const finding = { finding_id: `fnd_${'c'.repeat(32)}`, category: 'work', text: 'Product manager at Acme', source: { url: 'https://acme.example/team', title: 'Team' }, state: 'unconfirmed', found_at: 1_000, decided_at: null };
  it('carries an http(s) source, a closed category and the owner decision', () => {
    accepted(appFindingV1Schema, [finding, { ...finding, state: 'kept', decided_at: 2_000 }, { ...finding, state: 'corrected', decided_at: 2_000 }]);
    for (const category of ['work', 'education', 'public_work', 'based_in', 'public_profile', 'interest', 'achievement']) expect(appFindingV1Schema.safeParse({ ...finding, category }).success, category).toBe(true);
    rejected(appFindingV1Schema, [
      ...['health', 'religion', 'caste', 'politics', 'sexuality', 'other', 'family'].map(category => ({ ...finding, category })),
      { ...finding, source: { url: 'javascript:alert(1)', title: '' } }, { ...finding, source: { url: 'file:///etc/passwd', title: '' } }, { ...finding, source: { title: 'Team' } },
      { ...finding, subject: 'Priya' }, { ...finding, state: 'kept' }, { ...finding, decided_at: 5 }, { ...finding, text: '' }, { ...finding, text: 'x'.repeat(301) },
    ]);
  });
  it('pages newest first with the look-up consent status', () => {
    accepted(appFindingListV1Schema, [{ lookup: 'granted', items: [finding], total: 3, next_cursor: 'c2' }, { lookup: 'withdrawn', items: [], total: 0, next_cursor: null }]);
    rejected(appFindingListV1Schema, [{ lookup: 'granted', items: [finding], total: 0, next_cursor: null }, { lookup: 'maybe', items: [], total: 0, next_cursor: null }, { items: [], total: 0, next_cursor: null }]);
  });
  it('lets the owner keep, correct or forget one finding', () => {
    const r = { request_id: 'finding-0001', finding_id: finding.finding_id };
    accepted(appFindingActionV1Schema, [{ ...r, action: 'keep' }, { ...r, action: 'correct', text: 'Product lead at Acme' }, { ...r, action: 'forget' }]);
    rejected(appFindingActionV1Schema, [{ ...r, action: 'correct' }, { ...r, action: 'correct', text: ' ' }, { ...r, action: 'keep', text: 'x' }, { ...r, action: 'share' }, { ...r, finding_id: 'fnd_x', action: 'forget' }]);
    accepted(appFindingResultV1Schema, [{ ...r, outcome: 'forgotten', replayed: false }]);
    rejected(appFindingResultV1Schema, [{ ...r, outcome: 'deleted', replayed: false }]);
  });
});

describe('chat channels', () => {
  const channels = [{ provider: 'imessage', state: 'linked' }, { provider: 'whatsapp', state: 'not_linked' }, { provider: 'telegram', state: 'not_offered' }];
  it('lists iMessage, WhatsApp and Telegram once each with what the owner can do with them', () => {
    accepted(appOnboardingChannelsV1Schema, [{ surface: 'app', channels }, { surface: 'both', channels: channels.map(channel => ({ ...channel, state: 'unknown' })) }]);
    rejected(appOnboardingChannelsV1Schema, [
      { surface: 'app', channels: channels.slice(1) }, { surface: 'app', channels: [channels[0], channels[0], channels[1]] }, { channels },
      { surface: 'app', channels: channels.map(channel => ({ ...channel, state: 'connected' })) }, { surface: 'app', channels: [...channels.slice(0, 2), { provider: 'app', state: 'linked' }] },
      { surface: 'telegram', channels }, { surface: 'app', channels, extra: true },
    ]);
  });
  const code = 'ABCDEFGHJK';
  it('hands out a one-time code that names the text to send, for any provider', () => {
    accepted(appChannelLinkRequestV1Schema, ['imessage', 'whatsapp', 'telegram'].map(provider => ({ provider })));
    rejected(appChannelLinkRequestV1Schema, [{}, { provider: 'app' }, { provider: 'whatsapp', request_id: 'link-0001' }, { provider: 'whatsapp', owner: 'other' }]);
    accepted(appChannelLinkCodeV1Schema, [
      { provider: 'imessage', code, text: `waldo ${code}`, address: '+15550100', send_url: `sms:+15550100&body=waldo%20${code}`, expires_in_seconds: 600 },
      { provider: 'whatsapp', code, text: `waldo ${code}`, address: null, send_url: null, expires_in_seconds: 600 },
      { provider: 'telegram', code, text: `/link ${code}`, address: null, send_url: null, expires_in_seconds: 600 },
    ]);
    rejected(appChannelLinkCodeV1Schema, [
      { provider: 'telegram', code, text: '/link', address: null, send_url: null, expires_in_seconds: 600 },
      { provider: 'whatsapp', code: 'abc', text: 'waldo abc', address: null, send_url: null, expires_in_seconds: 600 },
      { provider: 'whatsapp', code, text: `waldo ${code}`, address: null, send_url: 'https://example.com', expires_in_seconds: 600 },
      { provider: 'whatsapp', code, text: `waldo ${code}`, address: null, send_url: null, expires_in_seconds: 60 },
      { provider: 'whatsapp', code, text: `waldo ${code}`, address: null, send_url: null },
    ]);
  });
});

describe('routes', () => {
  // The link-code route answers with a one-time secret, so it has no request_id: a replay is recorded nowhere and a repeat
  // simply issues another code.
  const ONE_TIME_SECRET = '/app/v1/onboarding/channel-link';
  it('are authenticated, and every write is idempotent by request_id except the one that returns a one-time code', () => {
    for (const route of appOnboardingRoutesV1) {
      expect(route.authenticated).toBe(true);
      expect(route.path.startsWith('/app/v1/')).toBe(true);
      if (route.method === 'POST' && route.path !== ONE_TIME_SECRET) expect('idempotency_field' in route && route.idempotency_field).toBe('request_id');
    }
    const link = appOnboardingRoutesV1.find(route => route.path === ONE_TIME_SECRET);
    expect(link).toMatchObject({ method: 'POST', request: appChannelLinkRequestV1Schema, response: appChannelLinkCodeV1Schema });
    expect(link && 'idempotency_field' in link).toBe(false);
  });
});
