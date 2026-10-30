import { describe, expect, it } from 'vitest';
import {
  APP_PRIVACY_NOTICE_URL_V1, APP_PRIVACY_NOTICE_VERSION_V1, APP_TERMS_URL_V1, APP_TERMS_VERSION_V1, appConsentChangeV1Schema, appConsentGrantV1Schema, appConsentListV1Schema,
  appConsentStateV1Schema, appConsentWithdrawV1Schema, appFindingActionV1Schema, appFindingListV1Schema, appFindingResultV1Schema,
  appFindingV1Schema, appOnboardingActionV1Schema, appOnboardingErrorV1Schema, appOnboardingResultV1Schema, appOnboardingRoutesV1,
  appOnboardingV1Schema, appConsentPurposeV1Schema, appChannelLinkCodeV1Schema, appChannelLinkRequestV1Schema, appOnboardingChannelsV1Schema,
  appSetupAnswersRequestV1Schema, appSetupAnswersResultV1Schema, appSetupAnswersFitRevision, appSetupAnswersResultAtRevision, appSetupSpotV1Schema,
  APP_ONBOARDING_SETUP_ANSWERS_REVISION_V1, APP_SETUP_ANSWERS_MAX_REQUEST_BYTES_V1,
} from './onboarding';
import { appJsonWireBytes } from './core';
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
    // A run completed while the server holds the agreements back finishes with them pending; they are never skipped.
    accepted(appOnboardingV1Schema, [fresh, run, done, { ...done, steps: { ...done.steps, agreements: 'pending' } }]);
    rejected(appOnboardingV1Schema, [
      { ...fresh, run_id: run.run_id }, { ...run, run_id: null }, { ...run, started_at: null }, { ...done, completed_at: null }, { ...run, completed_at: 5 },
      { ...done, steps: { ...done.steps, agreements: 'skipped' } }, { ...run, steps: { ...steps, agreements: 'skipped' } }, { ...run, steps: { ...steps, first_look: 'skipped' } },
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
    accepted(appOnboardingErrorV1Schema, [{ error: 'agreements_required' }, { error: 'step_up_required' }, { error: 'stale_version', message: 'Notice copy 2 is current.' }]);
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
  it('opens WhatsApp to Waldo with the code filled in, and each link only for its own provider and code', () => {
    const whatsapp = { provider: 'whatsapp', code, text: `waldo ${code}`, address: '+919226067544', expires_in_seconds: 600 };
    const imessage = { provider: 'imessage', code, text: `waldo ${code}`, address: '+15550100', expires_in_seconds: 600 };
    accepted(appChannelLinkCodeV1Schema, [
      { ...whatsapp, send_url: `https://wa.me/919226067544?text=waldo%20${code}` },
      { ...whatsapp, address: '+15550100', send_url: `https://wa.me/15550100?text=waldo%20${code}` },
    ]);
    rejected(appChannelLinkCodeV1Schema, [
      { ...imessage, send_url: `https://wa.me/15550100?text=waldo%20${code}` },
      { ...whatsapp, send_url: `sms:+919226067544&body=waldo%20${code}` },
      { ...whatsapp, send_url: `http://wa.me/919226067544?text=waldo%20${code}` },
      { ...whatsapp, send_url: `https://wa.me.evil.example/919226067544?text=waldo%20${code}` },
      { ...whatsapp, send_url: `https://wa.me/+919226067544?text=waldo%20${code}` },
      { ...whatsapp, send_url: `https://wa.me/9192260675x4?text=waldo%20${code}` },
      { ...whatsapp, send_url: `https://wa.me/1234567?text=waldo%20${code}` },
      { ...whatsapp, send_url: `https://wa.me/0919226067544?text=waldo%20${code}` },
      { ...whatsapp, send_url: 'https://wa.me/919226067544?text=waldo%20ZZZZZZZZZZ' },
      { ...whatsapp, send_url: `https://wa.me/919226067544?text=waldo%20${code}&x=1` },
      { provider: 'telegram', code, text: `/link ${code}`, address: null, send_url: `https://wa.me/919226067544?text=waldo%20${code}`, expires_in_seconds: 600 },
    ]);
  });
});

describe('setup answers', () => {
  // The answers the app's setup conversation holds: its name, day shape, slips and watch, field for field.
  const answers = { request_id: 'setup-answers-01', name: 'Asha', day: { shape: 'meetings', own_words: 'Calls start at 8' }, slips: { picked: ['replies', 'breaks'], own_words: '' }, wearable: 'apple' };
  it('takes any of the answers, each set, cleared with null, or left out', () => {
    accepted(appSetupAnswersRequestV1Schema, [
      answers, { request_id: 'setup-answers-01', name: 'Asha' }, { request_id: 'setup-answers-01', wearable: null },
      { ...answers, day: { shape: null, own_words: 'Different every week' } }, { ...answers, day: null, slips: null, name: null },
      { ...answers, slips: { picked: [], own_words: '' } }, { ...answers, slips: { picked: ['replies', 'overlaps', 'promises', 'breaks', 'evenings'], own_words: 'x'.repeat(280) } },
      { ...answers, wearable: 'samsung' },
    ]);
    rejected(appSetupAnswersRequestV1Schema, [
      { request_id: 'setup-answers-01' }, { ...answers, request_id: 'short' }, { ...answers, name: '' }, { ...answers, name: ' '.repeat(3) }, { ...answers, name: 'x'.repeat(81) },
      { ...answers, day: { shape: 'night_shift', own_words: '' } }, { ...answers, day: { shape: 'focus' } }, { ...answers, day: 'meetings' },
      { ...answers, day: { shape: 'focus', own_words: 'x'.repeat(281) } },
      { ...answers, slips: { picked: ['replies', 'replies'], own_words: '' } }, { ...answers, slips: { picked: ['sleep'], own_words: '' } }, { ...answers, slips: ['replies'] },
      { ...answers, wearable: 'other' }, { ...answers, wearable: 'none' }, { ...answers, watch_id: 'paired-watch' }, { ...answers, owner_id: 'forged' },
    ]);
  });
  it('answers which answers Waldo now holds as owner facts', () => {
    const held = { name: true, day: true, slips: false, wearable: false };
    accepted(appSetupAnswersResultV1Schema, [{ request_id: 'setup-answers-01', held, replayed: false }]);
    rejected(appSetupAnswersResultV1Schema, [{ request_id: 'setup-answers-01', held, }, { request_id: 'setup-answers-01', held: { name: true }, replayed: false },
      { request_id: 'setup-answers-01', held: { ...held, day: 'yes' }, replayed: false }, { request_id: 'setup-answers-01', held, replayed: false, answers: [] }]);
  });
});

describe('setup answers, onboarding revision 2', () => {
  // The rest of the setup conversation: what the owner wants a hand with, where it is hardest, what is never to be moved, how
  // Waldo should bring things up, the season they are in, and what goes first when they run low.
  const more = {
    request_id: 'setup-answers-02',
    matters: { picked: ['sleep', 'promises'], own_words: 'Mostly the evenings' },
    spots: ['sleep-waking', 'promises-favours', 'promises-lookinto'],
    protect: { picked: ['workouts', 'family'], own_words: '' },
    rope: 'suggest',
    season: { choice: 'travel', own_words: 'Two weeks in Pune' },
    low: { picked: ['patience', 'cancel'], own_words: '' },
  };
  it('takes each new answer alone, cleared with null or an empty choice, beside the first four', () => {
    accepted(appSetupAnswersRequestV1Schema, [
      more, { request_id: 'setup-answers-02', spots: [] }, { request_id: 'setup-answers-02', rope: null }, { request_id: 'setup-answers-02', low: null },
      { ...more, name: 'Asha' }, { ...more, matters: { picked: [], own_words: 'Something else' } },
      { ...more, season: { choice: null, own_words: '' } }, { ...more, season: { choice: 'none', own_words: '' } },
      { ...more, spots: appSetupSpotV1Schema.options }, { ...more, protect: { picked: ['workouts', 'family', 'meals', 'mornings', 'focus'], own_words: 'x'.repeat(280) } },
      ...['tell', 'suggest', 'draft'].map(rope => ({ ...more, rope })),
    ]);
    rejected(appSetupAnswersRequestV1Schema, [
      { ...more, spots: ['none'] }, { ...more, spots: ['promises-work', 'promises-work'] }, { ...more, spots: 'sleep-waking' }, { ...more, spots: { picked: ['sleep-waking'] } },
      { ...more, matters: { picked: ['health'], own_words: '' } }, { ...more, matters: { picked: ['sleep', 'sleep'], own_words: '' } }, { ...more, matters: ['sleep'] },
      { ...more, protect: { picked: ['sleep'], own_words: '' } }, { ...more, protect: { picked: ['meals'] } }, { ...more, protect: { picked: [], own_words: 'x'.repeat(281) } },
      { ...more, rope: 'act' }, { ...more, rope: '' }, { ...more, season: 'busy' }, { ...more, season: { choice: 'holiday', own_words: '' } }, { ...more, season: { own_words: '' } },
      { ...more, low: { picked: ['focus', 'focus'], own_words: '' } }, { ...more, low: { picked: ['tired'], own_words: '' } }, { ...more, low: { picked: ['focus'], own_words: 'x'.repeat(281) } },
      { ...more, low: { picked: ['focus'], own_words: '', readings: [] } },
    ]);
  });
  it('lets only a build that declares revision 2 send the later answers', () => {
    const first = { request_id: 'setup-answers-02', name: 'Asha', day: { shape: 'focus' as const, own_words: '' } };
    for (const revision of [1, 2, 3]) expect(appSetupAnswersFitRevision(first, revision)).toBe(true);
    for (const answer of ['matters', 'spots', 'protect', 'rope', 'season', 'low'] as const) {
      const later = appSetupAnswersRequestV1Schema.parse({ ...first, [answer]: more[answer] });
      expect([answer, appSetupAnswersFitRevision(later, 1), appSetupAnswersFitRevision(later, 2)]).toEqual([answer, false, true]);
    }
  });
  it('fits the longest answers in any script under the answers route cap', () => {
    // Six answers in the owner's own words at their limit, every choice picked, in characters JSON spells out as \uXXXX: six
    // bytes each, more than any script takes.
    const words = '\u0001'.repeat(280), longest = {
      request_id: 'x'.repeat(80), name: `a${'\u0001'.repeat(79)}`, day: { shape: 'varies', own_words: words }, slips: { picked: ['replies', 'overlaps', 'promises', 'breaks', 'evenings'], own_words: words },
      wearable: 'garmin', matters: { picked: ['sleep', 'energy', 'stress', 'schedule', 'mail', 'promises'], own_words: words }, spots: appSetupSpotV1Schema.options,
      protect: { picked: ['workouts', 'family', 'meals', 'mornings', 'focus'], own_words: words }, rope: 'suggest', season: { choice: 'none', own_words: words },
      low: { picked: ['focus', 'patience', 'sleep', 'push', 'cancel'], own_words: words },
    };
    accepted(appSetupAnswersRequestV1Schema, [longest]);
    expect(appJsonWireBytes(longest)).toBeLessThanOrEqual(APP_SETUP_ANSWERS_MAX_REQUEST_BYTES_V1);
    expect(appOnboardingRoutesV1.find(route => route.path === '/app/v1/onboarding/answers')?.max_request_bytes).toBe(APP_SETUP_ANSWERS_MAX_REQUEST_BYTES_V1);
  });
  it('holds each new answer only for a build that reads revision 2, and the first four for every build', () => {
    const all = { name: true, day: false, slips: false, wearable: true, matters: true, spots: true, protect: false, rope: true, season: true, low: false };
    const result = { request_id: 'setup-answers-02', held: all, replayed: false };
    accepted(appSetupAnswersResultV1Schema, [result]);
    rejected(appSetupAnswersResultV1Schema, [{ ...result, held: { ...all, rope: 'yes' } }, { ...result, held: { ...all, mood: true } }]);
    const first = { request_id: 'setup-answers-02', held: { name: true, day: false, slips: false, wearable: true }, replayed: false };
    expect(APP_ONBOARDING_SETUP_ANSWERS_REVISION_V1).toBe(2);
    for (const revision of [1]) expect(appSetupAnswersResultAtRevision(result, revision)).toEqual(first);
    for (const revision of [2, 3]) expect(appSetupAnswersResultAtRevision(result, revision)).toBe(result);
    // An answer recorded before the revision replays as it was, whichever revision reads it.
    expect(appSetupAnswersResultAtRevision(first, 2)).toBe(first);
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

describe('published copy', () => {
  it('names the address where each version is published, on the website the notice itself names', () => {
    expect([APP_TERMS_VERSION_V1, APP_PRIVACY_NOTICE_VERSION_V1]).toEqual([1, 1]);
    expect(APP_TERMS_URL_V1).toBe('https://www.heywaldo.in/terms');
    expect(APP_PRIVACY_NOTICE_URL_V1).toBe('https://www.heywaldo.in/privacy');
  });
});
