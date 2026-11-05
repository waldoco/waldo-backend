import type { StandingGrantRecord } from '@waldo/contracts';
import { appAutonomyChangeResultV1Schema, appAutonomyChangeV1Schema, appAutonomyV1Schema, autonomyClassV1Schema, type AppAutonomyV1, type AutonomyClassV1 } from '../../../contracts/src/app/autonomy';
import { APP_CONTRACT_HEADER, appContractHeaderV1Schema } from '../../../contracts/src/app/core';
import { sha256Hex } from '../connectors/google';
import { stableJson } from '../context-composer/canonical';
import { signedInRecently } from '../identity/console-auth';
import { APP_AUTONOMY_CHANGES_PATH, APP_AUTONOMY_PATH } from './app-api';
import { appStepUpRefusal } from './console-step-up';
import { controlRevision, loadReceiptBook, receiptCapacityReached, type ControlReceipt } from './dashboard-control-actions';
import { AVAILABLE_CLASSES as AVAILABLE, GrantLimitError, type StandingGrants } from './standing-grants';

// The owner's changes keep their own receipt book, so a request id here never answers for one on another route.
const AUTONOMY_RECEIPT_BOOK_KEY = 'app:autonomy-receipts';
// Turning these on lets Waldo reach other people or act on a site, so it needs a recent sign-in.
const STEP_UP: readonly AutonomyClassV1[] = ['message.send_to_named', 'errand.run_on_site'];

export type AppAutonomyHost = Readonly<{
  csrf: string; expires: number; storage: DurableObjectStorage; signedInAt?: string;
  assertCurrent(): Promise<void>; sessions(): Promise<readonly { csrf: string; expires: number }[]>;
  grants: Pick<StandingGrants, 'list' | 'active' | 'paused' | 'enabled' | 'grant' | 'revoke' | 'pause' | 'resume'>;
  // The day's uses of a grant, as the effect ledger counts them.
  usesToday(grant: StandingGrantRecord): Promise<number>;
  now(): number;
}>;
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });
// Only a build that names the autonomy contract sees these routes; one that does not gets 404, as for an unknown path.
export const declaresAutonomy = (request: Request): boolean => {
  const parsed = appContractHeaderV1Schema.safeParse(request.headers.get(APP_CONTRACT_HEADER));
  return parsed.success && (parsed.data.autonomy ?? 0) >= 1;
};

// The authority the owner reviewed: every stored grant with its revision and end, and the pause. Uses and expiry by the clock
// change nothing an owner agreed to, so they are left out of it.
const authorityState = (grants: AppAutonomyHost['grants']) => stableJson({ grants: grants.list(), paused: grants.paused() });
const revisionOf = async (state: string) => sha256Hex(state);

// A class runs only where this server has it and the switch is on; with the switch off every class reads not_yet, and its
// stored grants, which authorize nothing then, are not shown until it is back on.
const view = async (host: AppAutonomyHost): Promise<AppAutonomyV1> => {
  const now = host.now(), active = host.grants.active(now), runs = (cls: AutonomyClassV1) => host.grants.enabled() && AVAILABLE.includes(cls);
  const classes = await Promise.all(autonomyClassV1Schema.options.map(async cls => ({
    class: cls, availability: runs(cls) ? 'available' as const : 'not_yet' as const, step_up: STEP_UP.includes(cls),
    grants: !runs(cls) ? [] : await Promise.all(active.filter(grant => grant.terms.scope.class === cls).map(async ({ grant_id, revision, terms, created_at, created_via }) =>
      ({ grant_id, revision, terms, created_at, created_via, uses_today: await host.usesToday({ grant_id, revision, terms, created_at, created_via, ended: null }) }))),
  })));
  return appAutonomyV1Schema.parse({ version: 1, revision: await revisionOf(authorityState(host.grants)), paused: host.grants.paused(), classes });
};

// Caller serializes this inside the authenticated owner DO and has checked the session row.
export async function appAutonomyRequest(request: Request, host: AppAutonomyHost): Promise<Response> {
  const url = new URL(request.url);
  if (!declaresAutonomy(request) || (url.pathname !== APP_AUTONOMY_PATH && url.pathname !== APP_AUTONOMY_CHANGES_PATH)) return reply({ error: 'not_found' }, 404);
  await host.assertCurrent();
  if (url.pathname === APP_AUTONOMY_PATH) {
    if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
    if ([...url.searchParams.keys()].length) return reply({ error: 'invalid_query' }, 400);
    let shown: AppAutonomyV1;
    try { shown = await view(host); } catch { console.error('app autonomy projection unavailable'); return reply({ error: 'projection_unavailable' }, 503); }
    await host.assertCurrent(); return reply(shown);
  }
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  let raw: unknown; try { raw = await request.json(); } catch { return reply({ error: 'invalid_action' }, 400); }
  const parsed = appAutonomyChangeV1Schema.safeParse(raw); if (!parsed.success) return reply({ error: 'invalid_action' }, 400);
  const { request_id, expected_revision, change } = parsed.data;
  // Widening authority asks for a recent sign-in where the class reaches other people or a site, and always to resume.
  if ((change.op === 'grant' && STEP_UP.includes(change.terms.scope.class) || change.op === 'resume') && !signedInRecently(host.signedInAt, host.now())) return appStepUpRefusal();
  const session = await controlRevision(host.csrf), key = `${session}:${request_id}`, fingerprint = await controlRevision(parsed.data);
  const book = await loadReceiptBook(host.storage, host.sessions, AUTONOMY_RECEIPT_BOOK_KEY), prior = book[key];
  const result = async (receipt: ControlReceipt, duplicate = false) =>
    appAutonomyChangeResultV1Schema.parse({ request_id, receipt, duplicate, revision: await revisionOf(authorityState(host.grants)) });
  if (prior) return prior.fingerprint === fingerprint ? reply(await result(prior.receipt, true), prior.status) : reply({ error: 'request_reused', code: 'request_reused' }, 409);
  if (receiptCapacityReached(book, session)) return reply({ error: 'receipt_capacity', code: 'receipt_capacity', message: 'This session has reached its change limit. Sign in again after this session expires.' }, 429);
  const seen = authorityState(host.grants);
  const rejected = (message: string): ControlReceipt => ({ state: 'rejected', message });
  let receipt: ControlReceipt;
  if (expected_revision !== undefined && expected_revision !== await revisionOf(seen)) receipt = rejected('Your autonomy settings changed since you reviewed them. Review the current ones before changing them.');
  else if (change.op === 'pause') { host.grants.pause('app'); receipt = { state: 'recorded', message: 'Paused. Waldo does nothing on its own until you resume; your grants are kept.' }; }
  else if (change.op === 'revoke') receipt = host.grants.revoke(change.grant_id) ? { state: 'recorded', message: 'Revoked. Waldo asks you first again.' } : rejected('That grant has already ended.');
  else {
    // The reviewed state is compared again in the same commit as the write, so a change made elsewhere since is never extended.
    const widened = host.storage.transactionSync((): ControlReceipt => {
      if (authorityState(host.grants) !== seen) return rejected('Your autonomy settings changed since you reviewed them. Review the current ones before changing them.');
      if (change.op === 'resume') { host.grants.resume(); return { state: 'recorded', message: 'Resumed. Your grants apply again.' }; }
      if (!host.grants.enabled()) return rejected('Waldo cannot act on its own here yet, so no grant was made.');
      if (!AVAILABLE.includes(change.terms.scope.class)) return rejected('Waldo cannot do that on its own yet, so no grant was made.');
      if (!(host.now() < change.terms.expires_at)) return rejected('Those terms have already ended, so no grant was made.');
      try { host.grants.grant(change.terms, 'app'); } catch (error) { if (error instanceof GrantLimitError) return rejected(`${error.message}. Revoke one first.`); throw error; }
      return { state: 'recorded', message: 'Allowed. Waldo reports each thing it does under this grant.' };
    });
    receipt = widened;
  }
  const status = receipt.state === 'recorded' ? 200 : 409;
  book[key] = { fingerprint, status, receipt, expires: host.expires }; await host.storage.put(AUTONOMY_RECEIPT_BOOK_KEY, book);
  await host.assertCurrent(); return reply(await result(receipt), status);
}
