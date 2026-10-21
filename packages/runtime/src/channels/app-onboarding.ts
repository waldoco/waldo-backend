import {
  APP_FINDINGS_PAGE_MAX_V1, APP_ONBOARDING_MAX_REQUEST_BYTES_V1, appConsentChangeV1Schema, appConsentGrantV1Schema, appConsentListV1Schema,
  appConsentWithdrawV1Schema, appFindingActionV1Schema, appFindingListQueryV1Schema, appFindingListV1Schema, appFindingResultV1Schema,
  appOnboardingActionV1Schema, appOnboardingResultV1Schema, appOnboardingV1Schema,
} from '../../../contracts/src/app/onboarding';
import { healthConsentListV1Schema } from '../../../contracts/src/app/health-ingest';
import { literalTextRedactor } from '@waldo/contracts';
import { redactToolOutputLedger } from '../conversation/tool-output-ledger';
import { claimStore, FORGOTTEN } from '../memory/claims';
import { consentLedger, type ConsentLedger } from '../onboarding/consent-ledger';
import { findingStore, type FindingStore } from '../onboarding/findings';
import { firstRun, type FirstRun, type FirstRunHost } from '../onboarding/first-run';
import { bodyDigest, requestBook, type RequestBook } from '../onboarding/request-book';
import { redactConversationEntries } from './conversation-store';
import { loopBook } from './loops';
import { md5Hex } from './md5';
import { proactiveSurface, setProactiveSurface } from './proactive-surface';

export const APP_ONBOARDING_PATHS: readonly string[] = ['/app/v1/onboarding', '/app/v1/onboarding/actions', '/app/v1/consents', '/app/v1/consents/withdraw', '/app/v1/findings', '/app/v1/findings/actions'];

export type AppOnboardingHost = Readonly<{
  firstRun: FirstRun; consent: ConsentLedger; findings: FindingStore; requests: RequestBook;
  now(): number;
  transaction<T>(work: () => T): T;
  // Hides retained copies of a forgotten finding in chat history and stored tool output.
  hideText(texts: readonly string[]): Promise<void>;
  // Rechecks the app session before an answer leaves.
  assertCurrent(): Promise<void>;
}>;

const STATUS = { invalid_request: 400, not_found: 404, stale_version: 409, agreements_required: 409, not_started: 409, not_connected: 409, completed: 409, request_reused: 409, unavailable: 503 } as const;
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
  if (request.method !== 'POST' || !['/app/v1/onboarding/actions', '/app/v1/consents', '/app/v1/consents/withdraw', '/app/v1/findings/actions'].includes(path)) return reply({ error: 'method_not_allowed' }, 405);
  const raw = await readBody(request);
  const parsed = path === '/app/v1/onboarding/actions' ? appOnboardingActionV1Schema.safeParse(raw)
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
  if (path === '/app/v1/consents') {
    const grant = appConsentGrantV1Schema.parse(body);
    const result = host.transaction(() => { host.consent.attestAge(host.now()); return host.consent.grant(grant.purpose, grant.version, host.now()); });
    if (result === 'stale_version') return problem('stale_version');
    return record(appConsentChangeV1Schema.parse({ consent: result.state, replayed: false, findings_erased: 0 }));
  }
  if (path === '/app/v1/consents/withdraw') {
    // The withdrawal and the erasure commit together: no finding outlives the consent it was kept under.
    const result = host.transaction(() => {
      const change = host.consent.withdraw('owner_lookup', host.now());
      return { state: change.state, erased: change.changed ? host.findings.eraseAll() : 0 };
    });
    return record(appConsentChangeV1Schema.parse({ consent: result.state, replayed: false, findings_erased: result.erased }));
  }
  const action = appFindingActionV1Schema.parse(body);
  if (action.action === 'forget') {
    const texts = host.transaction(() => host.findings.forget(action.finding_id, host.now()));
    if (texts === 'not_found') return problem('not_found');
    await host.hideText(texts);
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
}>;
// Quiet hours run from this time until the Brief, so nothing but the Brief opens the owner's morning.
export const FIRST_RUN_QUIET_FROM = '22:00';
const HIDE_TEXT_MIN_CHARS = 12;
export const ownerOnboardingHost = (deps: OwnerOnboardingDeps): AppOnboardingHost => {
  const { storage, now } = deps, sql = storage.sql, transaction = <T>(work: () => T) => storage.transactionSync(work);
  const claims = claimStore(sql, transaction), consent = consentLedger(sql), findings = findingStore(sql, claims, consent);
  const healthConnected = async (): Promise<boolean | 'unavailable'> => {
    if (!deps.rpc) return 'unavailable';
    let answer: unknown;
    try { answer = await deps.rpc('health_consent_list', `health.consent_list.${deps.doName}.${md5Hex('{}')}`, { p_do_name: deps.doName, p_payload: '{}' }); } catch { return 'unavailable'; }
    const list = healthConsentListV1Schema.safeParse(answer);
    return list.success ? list.data.consents.some(row => row.purpose === 'storage_compute' && row.status === 'granted') : 'unavailable';
  };
  const firstRunHost: FirstRunHost = {
    googleConnected: async () => (storage.kv.get<unknown[]>('google:accounts') ?? []).length > 0,
    healthConnected,
    timezoneConfirmed: () => storage.kv.get<boolean>('timezone_confirmed') === true,
    proactiveSurface: () => proactiveSurface(storage.kv),
    setProactiveSurface: surface => setProactiveSurface(storage.kv, surface),
    async setBriefTime(time, timezone) {
      if (await deps.act({ action: 'timezone.set', id: '', value: timezone }) !== true) return false;
      if (await deps.act({ action: 'card.pin', id: 'card:brief', value: time }) !== true) return false;
      const volume = loopBook(sql, { newId: () => crypto.randomUUID(), now }).proactivity().volume;
      return await deps.act({ action: 'proactivity.set', id: '', value: `${FIRST_RUN_QUIET_FROM}|${time}|${volume}` }) === true;
    },
    admitFirstLook: deps.admit,
  };
  return {
    firstRun: firstRun(sql, consent, claims, findings, firstRunHost, now), consent, findings, requests: requestBook(sql, now), now, transaction,
    assertCurrent: deps.assertCurrent,
    // A short literal would hide every chat line that happens to contain it, so only passages of the length the owner-evidence
    // rule uses are swept; the finding itself is gone either way.
    async hideText(all) {
      const texts = all.map(text => text.trim()).filter(text => text.length >= HIDE_TEXT_MIN_CHARS);
      if (!texts.length) return;
      await redactConversationEntries(storage, texts, FORGOTTEN);
      await redactToolOutputLedger(storage, texts, FORGOTTEN);
      const redact = literalTextRedactor(texts, FORGOTTEN);
      transaction(() => {
        if (!sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'episodes'").toArray().length) return;
        for (const row of sql.exec<{ ref: number; text: string }>('SELECT rowid AS ref, text FROM episodes').toArray()) {
          const text = redact(row.text);
          if (text !== row.text) sql.exec('UPDATE episodes SET text = ? WHERE rowid = ?', text, row.ref);
        }
      });
    },
  };
};
