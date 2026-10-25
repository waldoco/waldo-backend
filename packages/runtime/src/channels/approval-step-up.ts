import type { AppApprovalV1 } from '../../../contracts/src/app/approvals';
import type { ApprovalActionV1, ApprovalKindV1 } from '../../../contracts/src/app/parts';

// Which approvals need the recent email check, read by the app, the console and the chat desk alike. It imports nothing at
// runtime, because the console imports the approval desk, which reads this.
// Approving is the only decision that can act for the owner: skipping, deferring and asking for a new draft act on nothing, and
// undoing within its window reaches only those the approved change reached. Approving one change to the owner's own things
// stays one tap; approving anything that reaches other people, or acts on a site, a tool or external content, is gated like
// approval.send. A calendar change reaches other people when it has guests or is on a calendar other than the primary one.
export const STEP_UP_APPROVALS: Readonly<Record<ApprovalKindV1 | 'calendar_shared', Readonly<{ gated: boolean; why: string }>>> = {
  email_send: { gated: true, why: 'Sends one email as the owner to other people; it cannot be called back.' },
  message_send: { gated: true, why: 'Sends one message as the owner to another person; it cannot be called back.' },
  calendar_change: { gated: false, why: 'Changes one event on the owner\'s own primary calendar, with no guests.' },
  calendar_shared: { gated: true, why: 'Changes an event with guests, or on a calendar other people may share.' },
  google_task_change: { gated: false, why: 'Changes one task on the owner\'s own list; reaches no one else.' },
  browser_submit: { gated: true, why: 'Submits a form on a website as the owner.' },
  mcp_call: { gated: true, why: 'Runs a tool on a connected server, which can act beyond the owner\'s own things.' },
  tainted_action: { gated: true, why: 'Runs an action that content from outside asked for.' },
};
export const appApprovalStepUp = (item: Pick<AppApprovalV1, 'kind' | 'exact'>, action: ApprovalActionV1): boolean => {
  if (action !== 'approve') return false;
  const changes = item.exact.changes;
  const shared = item.kind === 'calendar_change' && (changes?.guests !== undefined || changes?.emails_guests !== undefined || changes?.calendar !== undefined);
  return STEP_UP_APPROVALS[shared ? 'calendar_shared' : item.kind]?.gated !== false;
};
