import {
  APP_FINDINGS_PAGE_MAX_V1, APP_ONBOARDING_MAX_REQUEST_BYTES_V1, appChannelLinkCodeV1Schema, appChannelLinkRequestV1Schema, appChatProviderV1Schema,
  appOnboardingChannelsV1Schema, type AppOnboardingChannelsV1, type AppProactiveSurfaceV1, appConsentChangeV1Schema, appConsentGrantV1Schema, appConsentListV1Schema,
  appConsentWithdrawV1Schema, appFindingActionV1Schema, appFindingListQueryV1Schema, appFindingListV1Schema, appFindingResultV1Schema,
  appOnboardingActionV1Schema, appOnboardingResultV1Schema, appOnboardingV1Schema, appSetupAnswersRequestV1Schema, appSetupAnswersResultV1Schema,
} from '../../../contracts/src/app/onboarding';
import type { AppConsentStateV1 } from '../../../contracts/src/app/onboarding';
import type { ChatChannels } from './chat-channel-links';
import { z } from 'zod';
import { claimStore } from '../memory/claims';
import { consentLedger, type ConsentLedger } from '../onboarding/consent-ledger';
import { findingStore, type FindingStore } from '../onboarding/findings';
import { firstRun, type FirstRun, type FirstRunHost } from '../onboarding/first-run';
import { bodyDigest, requestBook, type RequestBook } from '../onboarding/request-book';
import { loopBook } from './loops';
import { md5Hex } from './md5';
import { proactiveSurface, setProactiveSurface } from './proactive-surface';

const CHANNELS_PATH = '/app/v1/onboarding/channels', CHANNEL_LINK_PATH = '/app/v1/onboarding/channel-link', ANSWERS_PATH = '/app/v1/onboarding/answers';
export const APP_ONBOARDING_PATHS: readonly string[] = ['/app/v1/onboarding', '/app/v1/onboarding/actions', ANSWERS_PATH, CHANNELS_PATH, CHANNEL_LINK_PATH, '/app/v1/consents', '/app/v1/consents/withdraw', '/app/v1/findings', '/app/v1/findings/actions'];

export type AppOnboardingHost = Readonly<{
  firstRun: FirstRun; consent: ConsentLedger; findings: FindingStore; requests: RequestBook;
  chat: ChatChannels;
  // The owner's proactive-surface setting (the console's own).
  proactiveSurface(): AppProactiveSurfaceV1;
  now(): number;
  transaction<T>(work: () => T): T;
  // Forgets one finding, or withdraws the look-up and erases every finding. Each hides the retained copies first, so a failed
  // hide changes nothing and the same request can be tried again.
  forgetFinding(id: string): Promise<'forgotten' | 'not_found'>;
  withdrawLookup(): Promise<Readonly<{ state: AppConsentStateV1; erased: number }>>;
  // Rechecks the app session before an answer leaves.
  assertCurrent(): Promise<void>;
}>;

// The two grants the first run reads from the health plane, by source and purpose. Only the fields it decides on are read, so a
// source the health plane learns later never makes the step unreadable.
const healthConsentRows = z.object({ consents: z.array(z.object({ source: z.string(), purpose: z.string(), status: z.string() })) });
// The app's own on-device collectors. Any other source is a cloud wearable, whose express authorization to store the owner's
// data and use it in AI processing is both grants for that source; an unknown source gets the stricter rule.
const DEVICE_HEALTH_SOURCES: ReadonlySet<string> = new Set(['apple', 'samsung', 'health_connect']);
const healthStepConnected = (rows: z.infer<typeof healthConsentRows>['consents']): boolean => {
  const live = (source: string, purpose: string) => rows.some(row => row.source === source && row.purpose === purpose && row.status === 'granted');
  return rows.some(row => row.purpose === 'storage_compute' && live(row.source, 'storage_compute') && (DEVICE_HEALTH_SOURCES.has(row.source) || live(row.source, 'model_processing')));
};

// An operator sees which step failed by a fixed code, never the error text, which may carry an owner's details.
const logFailure = (code: 'channel_link_issue' | 'health_consent_list' | 'health_consent_shape') => console.error(JSON.stringify({ hop: 'app_onboarding', ok: false, code }));
const STATUS = { invalid_request: 400, not_found: 404, stale_version: 409, agreements_required: 409, not_started: 409, not_connected: 409, not_offered: 409, completed: 409, request_reused: 409, unavailable: 503 } as const;
type Problem = keyof typeof STATUS;
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });
const problem = (error: Problem) => reply({ error }, STATUS[error]);

const readBody = async (request: Request): Promise<unknown> => {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > APP_ONBOARDING_MAX_REQUEST_BYTES_V1) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
};

// The first run, the consent ledger and the look-up findings for the app. Every write is exactly-once by request_id: the first
// answer comes back for a repeat, and a different body under the same id is refused.
export async function appOnboardingRequest(request: Request, host: AppOnboardingHost): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  await host.assertCurrent();
  const answer = async (body: object) => { await host.assertCurrent(); return reply(body); };
  if (request.method === 'GET') {
    if (path === '/app/v1/onboarding' && !url.search) return answer(appOnboardingV1Schema.parse(await host.firstRun.view()));
    if (path === CHANNELS_PATH && !url.search) {
      // A provider whose offer the directory cannot confirm is unknown, never not offered: the app must not hide it for a blip.
      const channels = await Promise.all(appChatProviderV1Schema.options.map(async provider =>
        ({ provider, state: await host.chat.offered(provider).then(offered => offered ? host.chat.linked(provider) : 'not_offered' as const, () => 'unknown' as const) })));
      return answer(appOnboardingChannelsV1Schema.parse({ surface: host.proactiveSurface(), channels } satisfies AppOnboardingChannelsV1));
    }
    if (path === '/app/v1/consents' && !url.search) return answer(appConsentListV1Schema.parse(host.consent.list()));
    if (path === '/app/v1/findings') {
      if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) return problem('invalid_request');
      const query = appFindingListQueryV1Schema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return problem('invalid_request');
      const page = host.findings.page(APP_FINDINGS_PAGE_MAX_V1, query.data.cursor);
      return answer(appFindingListV1Schema.parse({ lookup: host.findings.lookup(), ...page }));
    }
    return path.startsWith('/app/v1/') && APP_ONBOARDING_PATHS.includes(path) ? reply({ error: 'method_not_allowed' }, 405) : problem('not_found');
  }
  if (request.method !== 'POST' || !['/app/v1/onboarding/actions', ANSWERS_PATH, CHANNEL_LINK_PATH, '/app/v1/consents', '/app/v1/consents/withdraw', '/app/v1/findings/actions'].includes(path)) return reply({ error: 'method_not_allowed' }, 405);
  const raw = await readBody(request);
  if (path === CHANNEL_LINK_PATH) {
    // The answer is a one-time secret, so it never enters the request book: a repeat issues another code.
    const link = appChannelLinkRequestV1Schema.safeParse(raw);
    if (!link.success) return problem('invalid_request');
    if (!host.consent.stepsOpen()) return problem('agreements_required');
    const offered = await host.chat.offered(link.data.provider).catch(() => null);
    if (offered === null) return problem('unavailable');
    if (!offered) return problem('not_offered');
    const issued = await host.chat.issue(link.data.provider).catch(() => { logFailure('channel_link_issue'); return null; });
    return issued ? answer(appChannelLinkCodeV1Schema.parse(issued)) : problem('unavailable');
  }
  const parsed = path === '/app/v1/onboarding/actions' ? appOnboardingActionV1Schema.safeParse(raw)
    : path === ANSWERS_PATH ? appSetupAnswersRequestV1Schema.safeParse(raw)
    : path === '/app/v1/consents' ? appConsentGrantV1Schema.safeParse(raw)
    : path === '/app/v1/consents/withdraw' ? appConsentWithdrawV1Schema.safeParse(raw)
    : appFindingActionV1Schema.safeParse(raw);
  if (!parsed.success) return problem('invalid_request');
  const body = parsed.data, digest = await bodyDigest(body);
  const seen = host.requests.find(path, body.request_id, digest);
  if (seen.kind === 'reused') return problem('request_reused');
  if (seen.kind === 'replay') return answer({ ...(seen.result as object), replayed: true });
  const record = (result: Record<string, unknown>) => { host.requests.record(path, body.request_id, digest, result); return answer({ ...result, replayed: false }); };

  if (path === '/app/v1/onboarding/actions') {
    const action = appOnboardingActionV1Schema.parse(body);
    const error = await host.firstRun.act(action);
    if (error) return problem(error);
    return record(appOnboardingResultV1Schema.parse({ request_id: action.request_id, onboarding: await host.firstRun.view(), replayed: false }));
  }
  if (path === ANSWERS_PATH) {
    // The answers are the owner's personal details: none is kept before the agreements, while the server offers them.
    if (!host.consent.stepsOpen()) return problem('agreements_required');
    const answers = appSetupAnswersRequestV1Schema.parse(body);
    const held = host.transaction(() => host.firstRun.saveAnswers(answers));
    return record(appSetupAnswersResultV1Schema.parse({ request_id: answers.request_id, held, replayed: false }));
  }
  if (path === '/app/v1/consents') {
    const grant = appConsentGrantV1Schema.parse(body);
    const result = host.transaction(() => {
      const outcome = host.consent.grant(grant.purpose, grant.version, host.now());
      if (typeof outcome === 'object') { host.consent.attestAge(host.now()); host.firstRun.agreementsAccepted(); }
      return outcome;
    });
    if (result === 'stale_version' || result === 'not_offered') return problem(result);
    // The look-up is disclosed in the privacy notice, so it waits for the notice.
    if (result === 'notice_required') return problem('agreements_required');
    return record(appConsentChangeV1Schema.parse({ consent: result.state, replayed: false, findings_erased: 0 }));
  }
  if (path === '/app/v1/consents/withdraw') {
    // The withdrawal and the erasure commit together: no finding outlives the consent it was kept under.
    const result = await host.withdrawLookup();
    return record(appConsentChangeV1Schema.parse({ consent: result.state, replayed: false, findings_erased: result.erased }));
  }
  const action = appFindingActionV1Schema.parse(body);
  if (action.action === 'forget') {
    if (await host.forgetFinding(action.finding_id) === 'not_found') return problem('not_found');
    return record(appFindingResultV1Schema.parse({ request_id: action.request_id, finding_id: action.finding_id, outcome: 'forgotten', replayed: false }));
  }
  const outcome = host.transaction(() => host.findings.decide(action.finding_id, action.action === 'keep' ? { action: 'keep' } : { action: 'correct', text: action.text }, host.now()));
  if (outcome === 'not_found') return problem('not_found');
  return record(appFindingResultV1Schema.parse({ request_id: action.request_id, finding_id: action.finding_id, outcome, replayed: false }));
}

// What the owner object hands the first run. Built per request from storage, so the tables exist whenever a route is served.
export type OwnerOnboardingDeps = Readonly<{
  storage: DurableObjectStorage; doName: string; now(): number;
  // The health plane's signed RPC; null where no directory backs this deploy.
  rpc: ((fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>) | null;
  // The owner runtime's settings action (timezone.set, proactivity.set, card.pin).
  act(action: Readonly<{ action: 'timezone.set' | 'proactivity.set' | 'card.pin'; id: string; value: string }>): Promise<unknown>;
  admit(clientId: string, text: string): Promise<boolean>;
  assertCurrent(): Promise<void>;
  // The chat channels the owner can link.
  chat: ChatChannels;
  // The server's switches: the agreements, off until the owner approves their copy, and the look-up, off until the notice that
  // discloses it is published.
  agreementsOffered: boolean;
  lookupOffered: boolean;
  // Hides retained copies of these texts wherever the owner's memory forget reaches them (chat history, stored tool output,
  // episodes, thread titles and the rest), and throws when it cannot verify that it did.
  hideText(texts: readonly string[]): Promise<void>;
}>;
// Quiet hours run from this time until the Brief, so nothing but the Brief opens the owner's morning.
export const FIRST_RUN_QUIET_FROM = '22:00';
const HIDE_TEXT_MIN_CHARS = 12;
export const ownerOnboardingHost = (deps: OwnerOnboardingDeps): AppOnboardingHost => {
  const { storage, now } = deps, sql = storage.sql, transaction = <T>(work: () => T) => storage.transactionSync(work);
  const claims = claimStore(sql, transaction), consent = consentLedger(sql, { agreementsOffered: deps.agreementsOffered, lookupOffered: deps.lookupOffered });
  const findings = findingStore(sql, claims, consent, now);
  // A short literal would hide every chat line that happens to contain it, so only passages of the length the owner-evidence
  // rule uses are swept; the finding itself is gone either way.
  const hide = async (all: readonly string[]) => {
    const texts = all.map(text => text.trim()).filter(text => text.length >= HIDE_TEXT_MIN_CHARS);
    if (texts.length) await deps.hideText(texts);
  };
  // Copies are hidden before the commit that removes the finding, the only link to them. A finding recorded meanwhile is in
  // the commit too, and its copies are hidden after it.
  const forgetFinding = async (id: string): Promise<'forgotten' | 'not_found'> => {
    const before = findings.texts(id);
    if (!before.length) return 'not_found';
    await hide(before);
    const texts = transaction(() => findings.forget(id, now()));
    if (texts === 'not_found') return 'not_found';
    await hide(texts.filter(text => !before.includes(text)));
    return 'forgotten';
  };
  const withdrawLookup = async () => {
    if (consent.state('owner_lookup').status !== 'granted') return { state: consent.state('owner_lookup'), erased: 0 };
    const before = findings.texts();
    await hide(before);
    const result = transaction(() => {
      const change = consent.withdraw('owner_lookup', now());
      return { state: change.state, ...(change.changed ? findings.eraseAll(now()) : { erased: 0, texts: [] }) };
    });
    await hide(result.texts.filter(text => !before.includes(text)));
    return { state: result.state, erased: result.erased };
  };
  const healthConnected = async (): Promise<boolean | 'unavailable'> => {
    if (!deps.rpc) return 'unavailable';
    let answer: unknown;
    try { answer = await deps.rpc('health_consent_list', `health.consent_list.${deps.doName}.${md5Hex('{}')}`, { p_do_name: deps.doName, p_payload: '{}' }); } catch { logFailure('health_consent_list'); return 'unavailable'; }
    const list = healthConsentRows.safeParse(answer);
    if (!list.success) logFailure('health_consent_shape');
    return list.success ? healthStepConnected(list.data.consents) : 'unavailable';
  };
  const firstRunHost: FirstRunHost = {
    googleConnected: async () => (storage.kv.get<unknown[]>('google:accounts') ?? []).length > 0,
    healthConnected,
    timezoneConfirmed: () => storage.kv.get<boolean>('timezone_confirmed') === true,
    proactiveSurface: () => proactiveSurface(storage.kv),
    setProactiveSurface: surface => setProactiveSurface(storage.kv, surface),
    chatLink: async provider => {
      const offered = await deps.chat.offered(provider).catch(() => null);
      return offered === null ? 'unknown' : offered ? deps.chat.linked(provider) : 'not_offered';
    },
    async setBriefTime(time, timezone) {
      if (await deps.act({ action: 'timezone.set', id: '', value: timezone }) !== true) return false;
      if (await deps.act({ action: 'card.pin', id: 'card:brief', value: time }) !== true) return false;
      const volume = loopBook(sql, { newId: () => crypto.randomUUID(), now }).proactivity().volume;
      return await deps.act({ action: 'proactivity.set', id: '', value: `${FIRST_RUN_QUIET_FROM}|${time}|${volume}` }) === true;
    },
    admitFirstLook: deps.admit,
    withdrawLookup,
  };
  return {
    firstRun: firstRun(sql, consent, claims, firstRunHost, now), consent, findings, requests: requestBook(sql, now), chat: deps.chat, proactiveSurface: firstRunHost.proactiveSurface, now, transaction,
    assertCurrent: deps.assertCurrent, forgetFinding, withdrawLookup,
  };
};
