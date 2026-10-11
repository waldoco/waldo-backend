import { appApprovalDecisionResultV1Schema, appApprovalDecisionV1Schema, appApprovalListQueryV1Schema, appApprovalListV1Schema, appApprovalV1Schema, type AppApprovalStateV1, type AppApprovalV1 } from '../../../contracts/src/app/approvals';
import { approvalControlReceipt, controlRevision, loadReceiptBook, receiptCapacityReached, RECEIPT_BOOK_KEY, type ControlReceipt } from './dashboard-control-actions';
import { APP_APPROVAL_DECISIONS_PATH, APP_APPROVALS_PATH } from './app-api';
import type { ApprovalDesk } from './approvals';

export type AppApprovalsHost = Readonly<{
  csrf: string; expires: number; storage: DurableObjectStorage;
  assertCurrent(): Promise<void>; sessions(): Promise<readonly { csrf: string; expires: number }[]>;
  desk: Pick<ApprovalDesk, 'approvals' | 'decide'>;
}>;
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });
const LETTER = { approve: 'a', skip: 's', edit: 'e', undo: 'u' } as const;
// A decision is recorded only when the row moved to the state that decision produces.
const TARGET = { approve: 'done', skip: 'skipped', edit: 'edit_requested', undo: 'undone' } as const satisfies Readonly<Record<keyof typeof LETTER, AppApprovalStateV1>>;

// Caller serializes this inside the authenticated owner DO and has checked the session row.
export async function appApprovalsRequest(request: Request, host: AppApprovalsHost): Promise<Response> {
  const url = new URL(request.url); await host.assertCurrent();
  const listed = async (filter: Parameters<ApprovalDesk['approvals']>[1]) => (await host.desk.approvals(Date.now(), filter)).filter((item): item is AppApprovalV1 => {
    if (appApprovalV1Schema.safeParse(item).success) return true;
    console.error('app approval projection dropped an item');
    return false;
  });
  if (url.pathname === APP_APPROVALS_PATH) {
    if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
    if ([...url.searchParams.keys()].some(key => key !== 'state' || url.searchParams.getAll(key).length !== 1)) return reply({ error: 'invalid_query' }, 400);
    const query = appApprovalListQueryV1Schema.safeParse(Object.fromEntries(url.searchParams)); if (!query.success) return reply({ error: 'invalid_query' }, 400);
    const parsed = appApprovalListV1Schema.safeParse({ approvals: await listed(query.data) });
    await host.assertCurrent(); return parsed.success ? reply(parsed.data) : reply({ error: 'projection_unavailable' }, 503);
  }
  if (url.pathname !== APP_APPROVAL_DECISIONS_PATH) return reply({ error: 'not_found' }, 404);
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  let raw: unknown; try { raw = await request.json(); } catch { return reply({ error: 'invalid_action' }, 400); }
  const decision = appApprovalDecisionV1Schema.safeParse(raw); if (!decision.success) return reply({ error: 'invalid_action' }, 400);
  const { approval_id: id, action, expected_digest, request_id } = decision.data;
  const [item] = await listed({ id });
  if (!item) return reply({ error: 'not_found' }, 404);
  const result = (receipt: ControlReceipt, state: AppApprovalStateV1, duplicate = false) => appApprovalDecisionResultV1Schema.parse({ request_id, receipt, duplicate, approval_state: state });
  // A stale digest records nothing, so retrying it repeats the same answer and the request id stays free.
  if (item.payload_digest !== expected_digest) return reply(result({ state: 'rejected', message: 'That proposal changed since you reviewed it. Review the current version before deciding.' }, 'superseded'), 409);
  const session = await controlRevision(host.csrf), key = `${session}:${request_id}`, fingerprint = await controlRevision({ approval_id: id, action, expected_digest });
  const book = await loadReceiptBook(host.storage, host.sessions), prior = book[key];
  if (prior) return prior.fingerprint === fingerprint ? reply(result(prior.receipt, (prior.approval_state ?? item.state) as AppApprovalStateV1, true), prior.status) : reply({ error: 'request_reused', code: 'request_reused' }, 409);
  if (receiptCapacityReached(book, session)) return reply({ error: 'receipt_capacity', code: 'receipt_capacity', message: 'This session has reached its change limit. Sign in again after this session expires; existing receipts remain available.' }, 429);
  if (!item.actions.includes(action)) return reply({ error: 'no_longer_eligible', code: 'no_longer_eligible', message: 'This decision is no longer available. Refresh the approvals.' }, 409);
  const pending: ControlReceipt = { state: 'unconfirmed', message: 'The outcome is not confirmed. Refresh the approvals before deciding again.' };
  book[key] = { fingerprint, status: 503, receipt: pending, expires: host.expires, approval_state: 'outcome_unknown' }; await host.storage.put(RECEIPT_BOOK_KEY, book);
  let receipt = pending, status = 503, state: AppApprovalStateV1 = 'outcome_unknown';
  try {
    const out = await host.desk.decide(id, LETTER[action], 'app:approval', { surface: 'app' });
    state = (await listed({ id }))[0]?.state ?? 'outcome_unknown';
    receipt = approvalControlReceipt(out, state === TARGET[action] && item.state !== state ? 'recorded' : state === 'outcome_unknown' ? 'unconfirmed' : 'rejected');
    status = receipt.state === 'recorded' ? 200 : receipt.state === 'unconfirmed' ? 503 : 409;
  } catch { console.error('app approval decision outcome unconfirmed'); }
  book[key] = { fingerprint, status, receipt, expires: host.expires, approval_state: state }; await host.storage.put(RECEIPT_BOOK_KEY, book);
  await host.assertCurrent(); return reply(result(receipt, state), status);
}
