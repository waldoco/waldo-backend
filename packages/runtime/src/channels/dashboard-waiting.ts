// Narrow read projection for the dashboard "waiting on you" page. Pure function over approval
// desk items; never ConsoleView. The queue omits review bodies (email text, recipients); only the
// per-item detail carries the typed review, and only when it matches the item kind. Approve and
// skip stay on the existing CSRF console actions; this contract mirrors, never widens, what the
// console allows (consoleMayApprove: open calendar changes only; email/message approve stays in chat).
import type { ApprovalItem } from './approvals';
import { consoleMayApprove } from './console';

export const DASHBOARD_WAITING_PATH = '/console/dashboard/api/v1/waiting';

const LABELS: Readonly<Record<string, string>> = {
  calendar_change: 'Calendar adjustment', email_send: 'Email send', message_send: 'Message send',
  browser_submit: 'Browser action', mcp_call: 'MCP tool call',
};
const label = (kind: string) => LABELS[kind] ?? 'Proposed action';
const safeReview = (item: ApprovalItem) => (item.review?.kind === item.kind ? item.review : null);
const mayApprove = (item: ApprovalItem) => consoleMayApprove(item) && safeReview(item) !== null;
const mayDismiss = (item: ApprovalItem) =>
  (item.state === 'open' || item.state === 'review_only') && !mayApprove(item) && (item.kind === 'email_send' || item.kind === 'message_send');

export const dashboardWaiting = (input: Readonly<{ now: number; approvals: readonly ApprovalItem[] }>) => ({
  version: 1 as const,
  as_of: new Date(input.now).toISOString(),
  waiting: input.approvals.filter((item) => ['open', 'review_only', 'unconfirmed'].includes(item.state)).map((item) => ({
    id: item.id, kind: item.kind, label: label(item.kind), summary: item.summary, state: item.state,
    may_approve_here: mayApprove(item), may_dismiss_here: mayDismiss(item),
  })),
  receipts: input.approvals.filter((item) => item.state === 'done').map((item) => ({
    id: item.id, kind: item.kind, label: label(item.kind), summary: item.summary, undoable: item.undoable,
  })),
});

export const dashboardWaitingDetail = (item: ApprovalItem | undefined) => item === undefined ? null : ({
  version: 1 as const,
  id: item.id, kind: item.kind, label: label(item.kind), summary: item.summary, state: item.state, undoable: item.undoable,
  review: safeReview(item), may_approve_here: mayApprove(item), may_dismiss_here: mayDismiss(item),
});
