import type { AppApprovalV1 } from '../../../contracts/src/app/approvals';
import type { ApprovalActionV1, ApprovalKindV1 } from '../../../contracts/src/app/parts';

// Which approvals reach beyond the owner's own things, so that WhatsApp and iMessage hand them to the app rather than approve
// them in chat. A signed-in app or console approves any of them without a fresh email code, by owner ruling (beta). It imports nothing at
// runtime, because the console imports the approval desk, which reads this.
// Approving is the only decision that can act for the owner: skipping, deferring and asking for a new draft act on nothing, and
// undoing within its window reaches only those the approved change reached. Approving one change to the owner's own things
// stays one tap in chat; approving anything that reaches other people, or acts on a site, a tool or external content, is
// handed to the app. A calendar change reaches other people when it has guests or is on a calendar other than the primary one.
export const STEP_UP_APPROVALS: Readonly<Record<ApprovalKindV1 | 'calendar_shared', Readonly<{ gated: boolean; why: string }>>> = {
  email_send: { gated: true, why: 'Sends one email as the owner to other people; it cannot be called back.' },
  message_send: { gated: true, why: 'Sends one message as the owner to another person; it cannot be called back.' },
  agent_mail_send: { gated: true, why: "Sends one email as Waldo, from the owner's Waldo address, to other people; it cannot be called back." },
  calendar_change: { gated: false, why: 'Changes one event on the owner\'s own primary calendar, with no guests.' },
  calendar_plan: { gated: false, why: 'Adds new blocks of time to the owner\'s own primary calendar, with no guests.' },
  calendar_shared: { gated: true, why: 'Changes an event with guests, or on a calendar other people may share.' },
  google_task_change: { gated: false, why: 'Changes one task on the owner\'s own list; reaches no one else.' },
  browser_submit: { gated: true, why: 'Submits a form on a website as the owner.' },
  mcp_call: { gated: true, why: 'Runs a tool on a connected server, which can act beyond the owner\'s own things.' },
  tainted_action: { gated: true, why: 'Runs an action that content from outside asked for.' },
  standing_grant: { gated: false, why: "Lets Waldo change the owner's own things without asking, within the terms shown; revocable any time." },
};
// A standing grant that would let Waldo send to other people or act on a site is handed to the app, whatever its row says.
const REACHING_CLASSES: readonly string[] = ['message.send_to_named', 'errand.run_on_site'];
export const appApprovalStepUp = (item: Pick<AppApprovalV1, 'kind' | 'exact'>, action: ApprovalActionV1): boolean => {
  if (action !== 'approve') return false;
  const changes = item.exact.changes;
  const shared = item.kind === 'calendar_change' && (changes?.guests !== undefined || changes?.emails_guests !== undefined || changes?.calendar !== undefined);
  if (item.kind === 'standing_grant' && (item.exact.grant === undefined || REACHING_CLASSES.includes(item.exact.grant.scope.class))) return true;
  return STEP_UP_APPROVALS[shared ? 'calendar_shared' : item.kind]?.gated !== false;
};
