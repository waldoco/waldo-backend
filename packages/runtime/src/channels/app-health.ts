import { fromRowZone } from '@waldo/contracts';
import { APP_CONTRACT_HEADER, appContractRevision } from '../../../contracts/src/app/core';
import {
  checkHealthChangeV1, HEALTH_BASELINE_REVISION_V1, HEALTH_INGEST_MAX_REQUEST_BYTES_V1, HEALTH_PER_SAMPLE_REVISION_V1, healthConsentListAtRevisionV1, isHealthProviderSourceV1,
  healthApiErrorV1Schema, healthConsentChangeV1Schema, healthConsentGrantV1Schema, healthConsentListV1Schema, healthConsentWithdrawV1Schema,
  healthIngestEnvelopeV1Schema, healthIngestReceiptV1Schema, healthIngestV1Schema, healthScoresQueryV1Schema, healthScoresResponseV1Schema,
  healthBaselineV1Schema, healthScoresUnavailableV1Schema, healthScoresV1Schema, healthSleepDebtV1Schema, HEALTH_SLEEP_DEBT_REVISION_V1, HEALTH_SCORES_HISTORY_REVISION_V1,
} from '../../../contracts/src/app/health-ingest';
import { healthHistoryView, historyWindowOf } from './app-health-history';
import { rowFreshness } from './health-context';
import { md5Hex } from './md5';
import { produceHealthScores, type ProducerDeps } from '../health/producer';

// The app's health routes. The Worker validates request shape against the app contract and signs a call that binds the
// operation, the owner and the digest of the exact payload it sends; the database owns consent, epochs, idempotency,
// revisions and retention. The owner always comes from the authenticated session, never from the request.
// The runtime does not depend on zod directly; a contract schema is used only through safeParse.
type ZodType<T = unknown> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
type Rpc = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
type ErrorCode = (typeof healthApiErrorV1Schema.shape.error.options)[number];
export type AppHealthInput = Readonly<{
  request: Request; url: URL; doName: string; rpc: Rpc | null;
  readBody: (request: Request, max: number) => Promise<Uint8Array | null>;
  // After a committed ingest the owner's derived rows are recomputed off the request path. The owner's Durable Object does
  // it, once for a run of uploads, in the owner's own zone; without a way to tell it, or when it cannot take the notice, the
  // Worker recomputes here, in the zone the batch was read in, since only the owner's object holds the owner's zone.
  defer?: (work: Promise<unknown>) => void;
  notifySamples?: () => Promise<void>;
  compute?: ProducerDeps['compute'];
  // The owner's calendar busy minutes for Weight, read from the owner's Durable Object. Without it Weight is unavailable.
  readDemand?: ProducerDeps['readDemand'];
  // Tells the owner's Durable Object that today's derived row moved zone, so the health trigger can look at it.
  notifyZoneChange?: ProducerDeps['onZoneChange'];
}>;

export const APP_HEALTH_PATH = '/app/v1/health';
const STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400, not_linked: 403, consent_required: 403, consent_withdrawn: 403,
  epoch_conflict: 409, idempotency_conflict: 409, anchor_conflict: 409, sample_conflict: 409, unavailable: 503,
};
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const refuse = (error: ErrorCode, status: number = STATUS[error]) => reply({ error }, status);

// Zone names are validated by the contract, but the platform's zone database is the authority on what exists.
const knownZone = (zone: string): boolean => { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; } };

export const invokeHealth = async (rpc: Rpc | null, doName: string, operation: string, payload: string): Promise<unknown> => {
  if (!rpc) return null;
  try { return await rpc(`health_${operation}`, `health.${operation}.${doName}.${md5Hex(payload)}`, { p_do_name: doName, p_payload: payload }); } catch { return null; }
};

const asObject = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);

// A database answer is either a closed error code or the success shape the contract declares; anything else is a
// fault on our side and never reaches the client as detail.
const failureCode = (result: unknown): ErrorCode | null => {
  const answer = asObject(result);
  if (!answer) return 'unavailable';
  if (!('error' in answer)) return null;
  const code = healthApiErrorV1Schema.shape.error.safeParse(answer.error);
  return code.success ? code.data : 'unavailable';
};
type View = { body: object } | { error: ErrorCode };
const answer = (view: View): Response => ('body' in view ? reply(view.body) : refuse(view.error));
const parse = <T>(result: unknown, schema: ZodType<T>): View => {
  const failed = failureCode(result);
  if (failed) return { error: failed };
  const parsed = schema.safeParse(result);
  if (parsed.success) return { body: parsed.data as object };
  console.error('app health response shape');
  return { error: 'unavailable' };
};
const settle = <T>(result: unknown, schema: ZodType<T>): Response => answer(parse(result, schema));

const readJson = async <T>(request: Request, schema: ZodType<T>, readBody: AppHealthInput['readBody']): Promise<{ data: T } | { response: Response }> => {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return { response: refuse('invalid_request') };
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > HEALTH_INGEST_MAX_REQUEST_BYTES_V1)) return { response: refuse('invalid_request', 413) };
  const bytes = await readBody(request, HEALTH_INGEST_MAX_REQUEST_BYTES_V1);
  if (!bytes) return { response: refuse('invalid_request', 413) };
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { return { response: refuse('invalid_request') }; }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { response: refuse('invalid_request') };
  // The request id is the idempotency key. A client may also send it as a header; the two must agree.
  const requestId = (parsed.data as { request_id?: string }).request_id;
  const key = request.headers.get('idempotency-key');
  if (key !== null && key !== requestId) return { response: refuse('invalid_request') };
  return { data: parsed.data };
};

type Pillar = 'recovery' | 'form' | 'weight';
// The stored read model holds one zone vocabulary; the contract uses words that carry their own direction. A stored
// 'unknown' is a score whose algorithm version has no ratified zone bands yet: it is shown without a zone word.
// A build that does not name the baseline revision has nowhere to show the label, so a provisional score is withheld from it as
// not yet learned, judged on the stored state alone so a damaged label cannot let the number through. At every revision a label
// that is present and does not read fails the same way, since a score is never shown without the label it was stored with;
// a pillar stored with no label at all is shown as it always was.
const pillarView = (pillar: Pillar, stored: unknown, revision: number): object | null => {
  const row = asObject(stored);
  if (!row) return null;
  if (typeof row.reason === 'string') return { state: 'unavailable', reason: row.reason };
  const labelled = revision >= HEALTH_BASELINE_REVISION_V1;
  if (!labelled && asObject(row.baseline)?.state === 'provisional') return { state: 'unavailable', reason: 'baseline_immature' };
  const zone = row.zone === 'unknown' ? null : fromRowZone(pillar, row.zone);
  if (zone === null && row.zone !== 'unknown') return null;
  const baseline = 'baseline' in row ? healthBaselineV1Schema.safeParse(row.baseline) : null;
  if (baseline && !baseline.success) {
    console.error('app health scores baseline shape');
    return { state: 'unavailable', reason: 'baseline_immature' };
  }
  return {
    state: 'available', score: row.score, zone, algorithm_version: row.algorithm_version, activation: row.activation,
    confidence: row.confidence ?? null, hrv_method: row.hrv_method ?? null,
    ...(labelled && baseline?.success ? { baseline: baseline.data } : {}),
  };
};

// A stored extra of the scores row that does not read as the contract's is left out, with a tag that holds no value, so it
// cannot cost the owner their scores.
const readExtra = <K extends 'drivers' | 'windows'>(stored: Record<string, unknown> | null, key: K): Record<string, unknown> => {
  if (!stored || !(key in stored)) return {};
  const parsed = healthScoresV1Schema.shape[key].safeParse(stored[key]);
  if (parsed.success) return { [key]: parsed.data };
  console.error(`app health scores ${key} shape`);
  return {};
};

// The one reading of a scores_read answer, for the app and for the owner's console: the contract body, or the closed error.
// revision is the client's health revision: builds pinned before the app took sleep_debt parse the scores strictly without it.
export const healthScoresView = (result: unknown, day: string | null, now: number, revision: number): View => {
  // No row to show is an answer, not an error: a 200 that says why, never a zero score.
  const nothing = (reason: unknown): View => {
    const body = healthScoresUnavailableV1Schema.safeParse({ state: 'unavailable', day, reason });
    if (body.success) return { body: body.data };
    console.error('app health scores reason');
    return { error: 'unavailable' };
  };
  const answered = asObject(result);
  if (answered?.error === 'not_linked') return nothing('not_linked');
  const failed = failureCode(answered);
  if (failed) return { error: failed };
  if (typeof answered?.unavailable === 'string') return nothing(answered.unavailable);
  const stored = asObject(answered?.scores);
  // The stored freshness is the row's at write time; the row is aged when read instead, by its compile time and its own day in its own zone.
  const aged = typeof stored?.day === 'string' && typeof stored.timezone === 'string' && knownZone(stored.timezone) ? rowFreshness(stored.compiled_at, stored.day, stored.timezone, now) : null;
  // A stored sleep debt that does not read as the contract's is left out, never passed on, so it cannot cost the owner
  // their scores.
  const shown = revision >= HEALTH_SLEEP_DEBT_REVISION_V1;
  // A need that leans on the prior is a word a build pinned before the baseline revision cannot parse, so it never reaches one.
  const priorLed = revision < HEALTH_BASELINE_REVISION_V1 && asObject(stored?.sleep_debt)?.need_basis === 'blended_average';
  // The row's trend word is for the model and the backend. The app's sleep debt is strict, so it never carries one.
  const { trend: _trend, ...storedDebt } = asObject(stored?.sleep_debt) ?? {};
  const debt = shown && !priorLed && stored && 'sleep_debt' in stored ? healthSleepDebtV1Schema.safeParse(asObject(stored.sleep_debt) ? storedDebt : stored.sleep_debt) : null;
  if (debt && !debt.success) console.error('app health scores sleep debt shape');
  const body = stored && {
    day: stored.day, timezone: stored.timezone, compiled_at: stored.compiled_at, freshness: aged,
    recovery: pillarView('recovery', stored.recovery, revision), form: pillarView('form', stored.form, revision), weight: pillarView('weight', stored.weight, revision),
    ...(debt?.success ? { sleep_debt: debt.data } : {}),
    ...(revision >= HEALTH_BASELINE_REVISION_V1 ? { ...readExtra(stored, 'drivers'), ...readExtra(stored, 'windows') } : {}),
  };
  const parsed = healthScoresResponseV1Schema.safeParse(body);
  if (parsed.success) return { body: parsed.data };
  console.error('app health scores shape');
  return { error: 'unavailable' };
};

// The owner's consents as a client at this health revision may be shown them: a build that does not name revision 2 parses
// the list strictly and cannot read a provider's rows, so it is shown none.
export const healthConsentView = (listed: unknown, revision: number): View => {
  const rows = asObject(listed)?.consents;
  return parse(Array.isArray(rows) ? { consents: healthConsentListAtRevisionV1(rows.filter((row): row is { source: string } => typeof asObject(row)?.source === 'string'), revision) } : listed, healthConsentListV1Schema);
};

const scores = async (input: AppHealthInput): Promise<Response> => {
  const { url, doName, rpc } = input;
  const unknown = [...url.searchParams.keys()].some(key => key !== 'day');
  const query = healthScoresQueryV1Schema.safeParse({ ...(url.searchParams.has('day') ? { day: url.searchParams.get('day') } : {}) });
  if (unknown || !query.success) return refuse('invalid_request');
  const revision = appContractRevision(input.request.headers.get(APP_CONTRACT_HEADER), 'health');
  return answer(healthScoresView(await invokeHealth(rpc, doName, 'scores_read', JSON.stringify(query.data)), query.data.day ?? null, Date.now(), revision));
};

// Score history exists only for a build that names health revision 4; below it the route is not there, as with the provider routes.
// It spends the same per-owner health budget as every route under /app/v1/health.
const scoresHistory = async ({ request, url, doName, rpc }: AppHealthInput): Promise<Response> => {
  if (appContractRevision(request.headers.get(APP_CONTRACT_HEADER), 'health') < HEALTH_SCORES_HISTORY_REVISION_V1) return refuse('invalid_request', 404);
  if (request.method !== 'GET') return refuse('unavailable', 405);
  const days = historyWindowOf(url);
  if (!days) return refuse('invalid_request');
  const readers = { pillar: (pillar: Pillar, stored: unknown) => pillarView(pillar, stored, HEALTH_SCORES_HISTORY_REVISION_V1), failure: failureCode };
  return answer(healthHistoryView(await invokeHealth(rpc, doName, 'scores_history', JSON.stringify({ days })), days, readers));
};

// A batch that changed nothing (a replay, or only ignored readings) leaves every derived row as it was. The recompute cannot
// fail the ingest: it starts after the database has answered and its outcome is not part of the response.
const recompute = ({ rpc, doName, defer, notifySamples, compute, readDemand, notifyZoneChange }: AppHealthInput, result: unknown, timezone: string): void => {
  const receipt = healthIngestReceiptV1Schema.safeParse(result);
  if (!defer || (!notifySamples && !compute) || !receipt.success || receipt.data.replayed || receipt.data.accepted + receipt.data.deleted === 0) return;
  const here = async () => compute && produceHealthScores({
    readSeries: range => invokeHealth(rpc, doName, 'series_read', JSON.stringify(range)),
    writeContext: payload => invokeHealth(rpc, doName, 'context_write', payload),
    readScores: day => invokeHealth(rpc, doName, 'scores_read', JSON.stringify({ day })),
    compute,
    ...(readDemand ? { readDemand } : {}),
    ...(notifyZoneChange ? { onZoneChange: notifyZoneChange } : {}),
  }, { now: Date.now(), timezone });
  defer(notifySamples ? notifySamples().catch(() => { console.error('health samples notice failed'); return here(); }) : here());
};

// Health revision 3: each change is checked on its own. A rejected change stays in its position as its reason and kind of
// reading only, so the database numbers every rejection and stores one complete receipt, and its value never leaves the
// Worker. The signed digest covers this payload, so two bodies under one request id that differ only inside a rejected
// change are the same request: both store the same readings and get the same receipt.
type Verdict = ReturnType<typeof checkHealthChangeV1>;
const forwarded = (verdict: Verdict) => (verdict.ok ? verdict.change : { rejected: verdict.rejection.reason, signal: verdict.rejection.signal });
const perSamplePayload = (batch: { samples: readonly unknown[]; deletions: readonly unknown[] }) => ({
  ...batch,
  samples: batch.samples.map((value, index) => forwarded(checkHealthChangeV1('sample', index, value))),
  deletions: batch.deletions.map((value, index) => forwarded(checkHealthChangeV1('deletion', index, value))),
  rejection: 'per_sample',
});

// A refused upload leaves no receipt, so its closed code and status are the only trace a stuck sync leaves on the server.
// They are logged, and counted for the console's freshness view after the answer, through the deferred lane, so the count
// never changes or delays what the app is told. A call refused before this route (credential, rate limit) is not counted.
const logRefusal = async (input: AppHealthInput, response: Response): Promise<Response> => {
  if (response.status !== 200) {
    const body = await response.clone().json().catch(() => null) as { error?: unknown } | null;
    console.warn('app health ingest refused', { status: response.status, error: body?.error ?? null });
    const code = healthApiErrorV1Schema.shape.error.safeParse(body?.error);
    input.defer?.(invokeHealth(input.rpc, input.doName, 'refusal_note', JSON.stringify({ code: code.success ? code.data : 'unavailable', status: response.status })));
  }
  return response;
};

export const handleAppHealth = async (input: AppHealthInput): Promise<Response> => {
  const { request, url, doName, rpc, readBody } = input;
  const route = url.pathname.slice(APP_HEALTH_PATH.length);
  const writes: Readonly<Record<string, readonly [string, ZodType, ZodType]>> = {
    '/consents': ['consent_grant', healthConsentGrantV1Schema, healthConsentChangeV1Schema],
    '/consents/withdraw': ['consent_withdraw', healthConsentWithdrawV1Schema, healthConsentChangeV1Schema],
    '/ingest': ['ingest', healthIngestV1Schema, healthIngestReceiptV1Schema],
  };
  if (route === '/consents' && request.method === 'GET') {
    return answer(healthConsentView(await invokeHealth(rpc, doName, 'consent_list', '{}'), appContractRevision(request.headers.get(APP_CONTRACT_HEADER), 'health')));
  }
  if (route === '/scores/history') return scoresHistory(input);
  if (route === '/scores') return request.method === 'GET' ? scores(input) : refuse('unavailable', 405);
  const write = writes[route];
  if (!write) return refuse('unavailable', 404);
  if (request.method !== 'POST') return refuse('unavailable', 405);
  const [operation, requestSchema, responseSchema] = write;
  if (operation !== 'ingest') {
    const body = await readJson(request, requestSchema, readBody);
    return 'response' in body ? body.response : settle(await invokeHealth(rpc, doName, operation, JSON.stringify(body.data)), responseSchema);
  }
  // A build that does not name health revision 3 keeps the all-or-nothing batch exactly.
  const perSample = appContractRevision(request.headers.get(APP_CONTRACT_HEADER), 'health') >= HEALTH_PER_SAMPLE_REVISION_V1;
  const body = await readJson(request, perSample ? healthIngestEnvelopeV1Schema : healthIngestV1Schema, readBody);
  if ('response' in body) return logRefusal(input, body.response);
  if (!knownZone(body.data.timezone)) return logRefusal(input, refuse('invalid_request'));
  // A provider's readings come from Waldo's own sync of that provider, never from an app upload that claims its name.
  if (isHealthProviderSourceV1(body.data.source)) return logRefusal(input, refuse('invalid_request'));
  const payload = JSON.stringify(perSample ? perSamplePayload(body.data) : body.data);
  // The per-sample mode marker and the rejection stand-ins can take a body at the cap just past it, which the database
  // would refuse whole as invalid; this answers as the oversize body it is.
  if (new TextEncoder().encode(payload).byteLength > HEALTH_INGEST_MAX_REQUEST_BYTES_V1) return logRefusal(input, refuse('invalid_request', 413));
  const result = await invokeHealth(rpc, doName, operation, payload);
  recompute(input, result, body.data.timezone);
  return logRefusal(input, settle(result, responseSchema));
};
