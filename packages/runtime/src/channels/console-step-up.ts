import { CONSOLE_STEP_UP_MS } from '../identity/console-auth';
import { WHATSAPP_LINK_PATH, whatsappLinkToken } from '../identity/whatsapp-link';
import { MCP_START_PATH } from '../connectors/mcp-connections';
import { CONSOLE_DEVICES_PATH } from '../devices/contract';
import { BROWSER_TRIAL_PATH } from './browser-trial-consent';
import { CONSOLE_ACTION_PATH, CONSOLE_GOOGLE_START_PATH, type ConsoleSession } from './console';
import { CONTROL_ACTION_PATH } from './dashboard-control-actions';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';
import { OWNER_CONTROLS_ACTION_PATH } from './dashboard-owner-controls';
import { CONSOLE_PHOTON_START_PATH } from './imessage/console';
import { APP_PROVIDERS_PATH } from '../health/providers/app-providers';
import type { AppApprovalV1 } from '../../../contracts/src/app/approvals';
import type { AppChatProviderV1 } from '../../../contracts/src/app/onboarding';
import type { ApprovalActionV1, ApprovalKindV1 } from '../../../contracts/src/app/parts';

type StepUpRule = Readonly<{ gated: boolean; why: string }>;

// Every action a console registry accepts. An action whose effect outlives this browser's session (a bound chat, a paired
// Mac, a connected account or tool, a standing grant, an invite, the account's removal), or that sends to other people as the
// owner, needs an email code from the last two hours, so a copied 30-day cookie cannot do it. Reading, arranging, deciding
// one change to the owner's own things once, and removing access do not.
// A test fails when a registry gains an action this table does not name.
export const STEP_UP_ACTIONS: Readonly<Record<string, StepUpRule>> = {
  'spot.confirm': { gated: false, why: 'Confirms one thing Waldo remembers; grants no access.' },
  'spot.dismiss': { gated: false, why: 'Dismisses one thing Waldo remembers; grants no access.' },
  'spot.forget': { gated: false, why: 'Forgets one thing Waldo remembers; removes, grants nothing.' },
  'spot.pin': { gated: true, why: 'Makes a claim the owner\'s own word on every turn: a copied cookie could plant anything Waldo then treats as said by the owner.' },
  'spot.unpin': { gated: false, why: 'Takes one line out of what Waldo keeps in mind every turn; removes, grants nothing.' },
  'spot.edit': { gated: true, why: 'Writes new text as the owner\'s own word: a copied cookie could plant anything Waldo then treats as said by the owner.' },
  'node.forget': { gated: false, why: 'Forgets one remembered item; removes, grants nothing.' },
  'forget.retry': { gated: false, why: 'Runs a pending forget cleanup again; removes, grants nothing.' },
  'proactivity.set': { gated: false, why: 'Sets how often Waldo reaches out; grants no access.' },
  'proactive_surface.set': { gated: false, why: 'Picks which already-linked chat Waldo reaches out on; links nothing new.' },
  'health_memory.set': { gated: false, why: 'Sets whether Waldo keeps health patterns in memory; grants no access.' },
  'schedule.set': { gated: false, why: 'Sets when the daily cards arrive; grants no access.' },
  'schedule.reset': { gated: false, why: 'Restores the default card times; grants no access.' },
  'timezone.set': { gated: false, why: 'Sets the owner\'s time zone; grants no access.' },
  'card.today': { gated: false, why: 'Arranges today\'s cards; grants no access.' },
  'card.pin': { gated: false, why: 'Pins a card to a time; grants no access.' },
  'card.unpin': { gated: false, why: 'Unpins a card; grants no access.' },
  'approval.approve': { gated: false, why: 'Decides one held calendar change once; leaves no standing grant.' },
  'approval.skip': { gated: false, why: 'Declines one held change.' },
  'approval.undo': { gated: false, why: 'Reverses one decision.' },
  'approval.send': { gated: true, why: 'Sends one held email or message as the owner, and an email reaches other people; it cannot be called back.' },
  'approval.edit': { gated: false, why: 'Asks Waldo for a new draft of one held send; sends nothing.' },
  'file.remove': { gated: false, why: 'Removes one file the owner sent; grants nothing.' },
  'session.signout': { gated: false, why: 'Ends this browser\'s session; removes access.' },
  'session.signout.all': { gated: false, why: 'Ends every console session; removes access.' },
  'google.connect': { gated: true, why: 'Connects a Google account Waldo keeps using after this session.' },
  'google.disconnect': { gated: false, why: 'Disconnects a Google account; removes access.' },
  'mcp.connect': { gated: true, why: 'Connects a tool server Waldo keeps calling after this session.' },
  'mcp.disconnect': { gated: false, why: 'Disconnects a tool server; removes access.' },
  'mcp.runs': { gated: true, why: 'Lets a connected tool run without asking: a standing grant.' },
  'telegram.link': { gated: true, why: 'Issues a code that binds a Telegram chat, which can then send console sign-in links.' },
  'telegram.unlink': { gated: false, why: 'Unlinks Telegram; removes access.' },
  'whatsapp.link': { gated: true, why: 'Issues a code that binds a WhatsApp number to this account.' },
  'whatsapp.confirm': { gated: true, why: 'Binds a WhatsApp number to this account, replacing the linked one.' },
  'whatsapp.unlink': { gated: false, why: 'Unlinks WhatsApp; removes access.' },
  'imessage.enroll': { gated: true, why: 'Sets up the owner\'s iMessage number and issues a code that binds a handle.' },
  'imessage.link': { gated: true, why: 'Issues a code that binds an iMessage handle, which can then send console sign-in links.' },
  'imessage.unlink': { gated: false, why: 'Unlinks iMessage; removes access.' },
  'imessage.pair': { gated: true, why: 'Issues a code that pairs a Mac host to this account.' },
  'imessage.pair_shared': { gated: true, why: 'Issues a code that pairs the shared number\'s host to this account.' },
  'imessage.verify': { gated: true, why: 'Sets which Apple ID a pairing Mac host treats as the owner.' },
  'imessage.activate': { gated: true, why: 'Puts a paired Mac host live for this account.' },
  'imessage.activate_shared': { gated: true, why: 'Puts the shared number\'s host live for this account.' },
  'imessage.revoke': { gated: false, why: 'Revokes a Mac host; removes access.' },
  'device.pair': { gated: true, why: 'Issues a code that pairs a Mac to this account.' },
  'device.revoke': { gated: false, why: 'Unpairs a Mac; removes access.' },
  'device.query': { gated: false, why: 'Asks a Mac already paired one question; creates no new access.' },
  'device.notify': { gated: false, why: 'Shows one notice on a Mac already paired; creates no new access.' },
  'invite.create': { gated: true, why: 'Creates an invite that brings a new owner in.' },
  'invite.member': { gated: true, why: 'Invites someone to this Waldo.' },
  'invite.revoke': { gated: false, why: 'Withdraws an unused invite; removes access.' },
  'account.delete': { gated: true, why: 'Deletes the account, which cannot be undone.' },
};

// Console routes that start access or record consent outside an action. A gated route is refused whatever its method.
// startsFlow: a GET there begins a flow rather than reads, so the cross-site guard refuses it when another site sends
// it. A path ending in "/" is a prefix that needs a token after it. This is the only list of flow-starting GETs: a new
// one belongs here, or behind a POST.
export const STEP_UP_ROUTES: Readonly<Record<string, StepUpRule & Readonly<{ startsFlow: boolean }>>> = {
  [CONSOLE_PHOTON_START_PATH]: { gated: true, startsFlow: true, why: 'Starts connecting Photon, which binds an iMessage line to this account.' },
  [BROWSER_TRIAL_PATH]: { gated: false, startsFlow: true, why: 'Consents to one 60-second public fixture session with no sign-ins; it cannot be renewed.' },
  '/console/browser-handoff': { gated: false, startsFlow: false, why: 'Shows or ends a browser run already in progress; it ends with that run.' },
  [MCP_START_PATH]: { gated: false, startsFlow: true, why: 'Follows a single-use start link that only a gated mcp.connect mints.' },
  [CONSOLE_GOOGLE_START_PATH]: { gated: false, startsFlow: true, why: 'Follows a single-use start link that only a gated google.connect mints.' },
  '/console/workspace': { gated: false, startsFlow: false, why: 'Uploads, reads or removes the owner\'s own files; grants no access.' },
};
const FLOW_STARTS = Object.entries(STEP_UP_ROUTES).filter(([, rule]) => rule.startsFlow).map(([path]) => path);
export const startsConsoleFlow = (path: string): boolean =>
  FLOW_STARTS.some(start => start.endsWith('/') ? path.startsWith(start) && path.length > start.length : path === start);

const gated = (table: Readonly<Record<string, StepUpRule>>) => new Set(Object.entries(table).filter(([, rule]) => rule.gated).map(([name]) => name));
const GATED_ACTIONS = gated(STEP_UP_ACTIONS), GATED_ROUTES = gated(STEP_UP_ROUTES);
const ACTION_PATHS = new Set([CONSOLE_ACTION_PATH, CONTROL_ACTION_PATH, OWNER_CONTROLS_ACTION_PATH]);
export const CONSOLE_CONFIRM_HREF = '/console/signin?confirm=1';

// The sign-in page returns only to targets on its own allowlist, so this names the two classic pages it accepts.
const returnTarget = (action: string, form: FormData | null): string | null => {
  if (action === 'device.pair') return CONSOLE_DEVICES_PATH;
  const token = form?.get('token');
  const path = typeof token === 'string' ? `${WHATSAPP_LINK_PATH}/${token}` : '';
  return action === 'whatsapp.confirm' && whatsappLinkToken(path) ? path : null;
};
const confirmPage = (target: string | null) => {
  const href = target ? `${CONSOLE_CONFIRM_HREF}&amp;return_to=${encodeURIComponent(target)}` : CONSOLE_CONFIRM_HREF;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Confirm it's you</title></head><body><h1>Confirm it's you</h1><p>This needs an email code from the last ${CONSOLE_STEP_UP_MS / 3_600_000} hours. You stay signed in.</p><p><a href="${href}">Get an email code</a></p></body></html>`,
    { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin' } });
};

// Refuses a lasting-access action or route unless this browser proved an email code recently. It runs before any handler
// and reads only the action name or path, so every console path that can grant such access passes through it.
export const consoleStepUpRefusal = async (request: Request, session: ConsoleSession, now: number): Promise<Response | null> => {
  const path = new URL(request.url).pathname;
  const route = GATED_ROUTES.has(path);
  if (!route && (request.method !== 'POST' || !ACTION_PATHS.has(path))) return null;
  if (session.verified_at !== undefined && now - session.verified_at < CONSOLE_STEP_UP_MS) return null;
  if (route) return confirmPage(null);
  const form = await request.clone().formData().catch(() => null);
  const action = form?.get('action');
  if (typeof action !== 'string' || !GATED_ACTIONS.has(action)) return null;
  if (path !== CONSOLE_ACTION_PATH || (request.headers.get('accept') ?? '').includes('application/json')) {
    return Response.json({ error: 'step_up_required' }, { status: 403, headers: DASHBOARD_OVERVIEW_HEADERS });
  }
  return confirmPage(returnTarget(action, form));
};

// error is what a client acts on; code names it for the core app problem shape.
export const appStepUpRefusal = () => Response.json({ error: 'step_up_required', code: 'step_up_required' }, { status: 403, headers: { 'cache-control': 'private, no-store' } });
// An action the table does not name is gated, so a new app action fails closed until it is classified.
export const stepUpGated = (action: string): boolean => STEP_UP_ACTIONS[action]?.gated !== false;
// Each app control is the console action of the same name, except that unlinking names its channel in id.
export const appControlStepUpAction = (action: Readonly<{ action: string; id?: string | undefined }>): string => action.action === 'channel.unlink' ? `${action.id}.unlink` : action.action;
export const appLinkStepUpAction = (provider: AppChatProviderV1): string => `${provider}.link`;

// App routes with no console action of their own.
export const APP_STEP_UP_ROUTES: Readonly<Record<string, StepUpRule>> = {
  [`${APP_PROVIDERS_PATH}/connect`]: { gated: true, why: 'Connects a health provider Waldo keeps syncing after this session.' },
};

// Approving is the only decision that can act for the owner: skipping, deferring and asking for a new draft act on nothing, and
// undoing within its window reaches only those the approved change reached. Approving one change to the owner's own things
// stays one tap; approving anything that reaches other people, or acts on a site, a tool or external content, is gated like
// approval.send. A calendar change reaches other people when it has guests or is on a calendar other than the primary one.
export const STEP_UP_APPROVALS: Readonly<Record<ApprovalKindV1 | 'calendar_shared', StepUpRule>> = {
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
