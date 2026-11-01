import { z } from 'zod';
import { appProactiveSurfaceV1Schema } from './onboarding';
import { messagingSurfaceV1Schema } from './surfaces';

const text = z.string();
const count = z.int().nonnegative();
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const appControlRequestIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
export const appControlViewV1Schema = z.enum(['day', 'connections', 'activity', 'account', 'constellation', 'phone', 'days', 'agent_mail']);
const activityCursor = z.string().regex(/^[0-9]+$/).refine(value => Number.isSafeInteger(Number(value)) && Number(value) > 0);
export const APP_MEMORY_PAGE_MAX_V1 = 50;
const memoryPageSize = z.string().regex(/^[0-9]{1,9}$/).refine(value => Number(value) >= 1 && Number(value) <= APP_MEMORY_PAGE_MAX_V1);
const memoryCursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
const memoryId = text.min(1).max(256);
const memoryViews = z.enum(['summary', 'claims', 'interpretations', 'detail', 'pattern']);
// Controls revision 2 (`x-waldo-app-contract: controls=2`): a constellation claim carries `pinned`, and the constellation
// view takes the owner's claim actions (claim.pin, claim.unpin, claim.edit). Revision 1 clients never receive the field.
export const APP_CONTROLS_MEMORY_REVISION = 2;
// An edited claim's text, trimmed. A pinned line rides every turn, so it stays well inside the profile block's room.
export const APP_CLAIM_TEXT_MAX_V1 = 1000;
const claimId = /^memory:claim:[1-9][0-9]{0,15}$/;
const CLAIM_ACTIONS: readonly string[] = ['claim.pin', 'claim.unpin', 'claim.edit'];
// The owner's own word on one constellation node: confirm it, replace it with their correction, or forget it. A correction is
// stored as what the owner said, so it is kept short like a node.
export const APP_NODE_CORRECTION_MAX_V1 = 140;
const nodeId = /^memory:node:[1-9][0-9]{0,15}$/;
const APP_PHONE_E164 = /^\+[1-9]\d{6,14}$/;
// What the owner typed for a handle. The backend trims and lower-cases it and answers invalid for anything but 3 to 32 of
// a-z, 0-9, dot and hyphen, starting and ending with a letter or digit, with no two dots together.
export const APP_AGENT_MAIL_HANDLE_INPUT_MAX_V1 = 64;
const agentMailNoticeVersion = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const NODE_ACTIONS: readonly string[] = ['node.confirm', 'node.correct', 'node.forget'];
// One of the owner's local days, as the days view names it.
const historyDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// The constellation keys page the owner's memory graph: limit is required for claims and interpretations,
// id for detail and pattern, max_nodes and max_links for pattern. Ids and cursors are opaque.
export const appControlQueryV1Schema = z.strictObject({
  view: appControlViewV1Schema, trace_before: activityCursor.optional(), runs_before: activityCursor.optional(),
  memory_view: memoryViews.optional(), cursor: memoryCursor.optional(), limit: memoryPageSize.optional(), id: memoryId.optional(),
  max_nodes: memoryPageSize.optional(), max_links: memoryPageSize.optional(), date: historyDay.optional(),
}).superRefine((query, ctx) => {
  if (query.view !== 'activity' && (query.trace_before !== undefined || query.runs_before !== undefined)) ctx.addIssue({ code: 'custom', message: 'Activity cursors require the activity view' });
  if (query.view !== 'constellation' && (query.memory_view ?? query.cursor ?? query.limit ?? query.id ?? query.max_nodes ?? query.max_links) !== undefined) ctx.addIssue({ code: 'custom', message: 'Memory paging requires the constellation view' });
  if (query.view !== 'days' && query.date !== undefined) ctx.addIssue({ code: 'custom', message: 'date requires the days view' });
});
// A signed-in device, as its connections row names it for session.revoke.
const sessionRef = z.string().regex(/^sess_[a-f0-9]{64}$/);
// A catalogue app's id, as its connections tile and the app actions name it.
export const APP_CONNECTOR_ID_V1 = /^[a-z][a-z0-9-]{1,31}$/;
export const appControlActionV1Schema = z.strictObject({
  view: appControlViewV1Schema, action: z.enum(['timezone.set', 'proactivity.set', 'channel.unlink', 'google.connect', 'granola.connect', 'granola.disconnect', 'account.delete', 'claim.pin', 'claim.unpin', 'claim.edit', 'node.confirm', 'node.correct', 'node.forget', 'session.revoke', 'phone.sms_send', 'phone.sms_check', 'phone.set', 'app.connect', 'app.disconnect', 'imessage.enroll', 'card.retry', 'google.disconnect', 'agent_mail.claim', 'agent_mail.release', 'proactive_surface.set']),
  id: text.max(256).optional(), value: text.max(4096).optional(),
  quiet_start: text.max(5).optional(), quiet_end: text.max(5).optional(), volume: z.enum(['low', 'normal', 'high']).optional(),
  confirmation: z.literal('DELETE').optional(),
  // The six digits Twilio texted, for phone.sms_check only. The send and the check name no number: the backend texts the
  // number on file, which only phone.set changes.
  code: z.string().regex(/^\d{6}$/).optional(),
  // The version of the agent mail notice the owner was shown, for agent_mail.claim only.
  notice: agentMailNoticeVersion.optional(),
  // google.connect only, and only while the connections view offers google.signin: connect the Google account the owner
  // signs in with. The backend resolves it from the owner's own sign-in identity; the app never names an address.
  account: z.literal('signin').optional(),
  revision, request_id: appControlRequestIdV1Schema,
}).superRefine((action, ctx) => {
  // Try again on one of today's cards: revision 3, the day view, the card's id and nothing else.
  if (action.action === 'card.retry' && (action.view !== 'day' || !DAY_CARD_IDS.includes(action.id ?? '')
    || (action.value ?? action.quiet_start ?? action.quiet_end ?? action.volume ?? action.confirmation) !== undefined)) ctx.addIssue({ code: 'custom', path: ['id'], message: 'card.retry starts from the day view and names one of today\'s cards in id, nothing else' });
  if (action.action === 'channel.unlink' && !messagingSurfaceV1Schema.safeParse(action.id).success) ctx.addIssue({ code: 'custom', path: ['id'], message: 'channel.unlink names a messaging channel in id' });
  // The receipt's navigation is the first-party /c/<ticket>?handoff=<code> path, opened exactly as given, once, in one
  // browser session: its one-time code binds the first browser that loads the link. The backend decides which features exist.
  if (action.action === 'google.connect' && (action.view !== 'connections' || !action.value || action.value.length > 64)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'google.connect starts from the connections view and names a Google feature in value' });
  if (action.account !== undefined && action.action !== 'google.connect') ctx.addIssue({ code: 'custom', path: ['account'], message: 'account belongs to google.connect alone' });
  // Disconnecting Google names the account's connections id and nothing else; the receipt is recorded once Waldo has dropped it.
  if (action.action === 'google.disconnect' && (action.view !== 'connections' || !action.id
    || (action.value ?? action.quiet_start ?? action.quiet_end ?? action.volume ?? action.confirmation ?? action.code) !== undefined)) ctx.addIssue({ code: 'custom', path: ['id'], message: 'google.disconnect starts from the connections view and names one Google account in id, nothing else' });
  // Granola is one fixed, reviewed server, so its actions name nothing. A connect receipt's navigation is the first-party
  // /c/<ticket>?handoff=<code> path; disconnect revokes at Granola where it can and says when it could not.
  const granola = action.action === 'granola.connect' || action.action === 'granola.disconnect';
  if (granola && (action.view !== 'connections' || (action.id ?? action.value ?? action.quiet_start ?? action.quiet_end ?? action.volume ?? action.confirmation) !== undefined)) ctx.addIssue({ code: 'custom', path: ['view'], message: 'granola actions start from the connections view and carry nothing else' });
  // A catalogue app names its tile by id and nothing else: the backend owns the server address and its sign-in service.
  // A connect receipt's navigation is the first-party /c/<ticket>?handoff=<code> path; the sign-in it opens returns to
  // waldo://oauth/complete. A disconnect receipt says in revocation whether the app revoked Waldo's access.
  const app = action.action === 'app.connect' || action.action === 'app.disconnect';
  if (app && (action.view !== 'connections' || !APP_CONNECTOR_ID_V1.test(action.id ?? '') || (action.value ?? action.quiet_start ?? action.quiet_end ?? action.volume ?? action.confirmation) !== undefined)) ctx.addIssue({ code: 'custom', path: ['id'], message: 'app actions start from the connections view and name one catalogue id in id, nothing else' });
  // Signs another device out. The current session signs out through /auth/signout, which revokes push first.
  if (action.action === 'session.revoke' && (action.view !== 'connections' || !sessionRef.safeParse(action.value).success
    || (action.id ?? action.quiet_start ?? action.quiet_end ?? action.volume ?? action.confirmation) !== undefined)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'session.revoke starts from the connections view and names one session_ref in value' });
  // Deletion signs out every session, so its recorded receipt cannot be read back: a replay is refused
  // as signed out. An unconfirmed receipt can be read back, and resending the same request_id never
  // runs a second deletion.
  const deletion = action.action === 'account.delete';
  if (deletion !== (action.view === 'account') || deletion !== (action.confirmation === 'DELETE')) ctx.addIssue({ code: 'custom', path: ['confirmation'], message: 'account.delete alone uses the account view, with confirmation DELETE' });
  if (deletion && (action.id ?? action.value ?? action.quiet_start ?? action.quiet_end ?? action.volume) !== undefined) ctx.addIssue({ code: 'custom', message: 'account.delete carries only its confirmation' });
  if ((CLAIM_ACTIONS.includes(action.action) || NODE_ACTIONS.includes(action.action)) !== (action.view === 'constellation')) ctx.addIssue({ code: 'custom', path: ['view'], message: 'The constellation view takes only the claim and node actions, and they only it' });
  // The owner's claim actions name one claim from the constellation view: pin it to the profile or facts block, unpin it,
  // or replace its text with what the owner typed. Each counts as the owner's own word for that claim.
  const claim = CLAIM_ACTIONS.includes(action.action);
  if (claim && !claimId.test(action.id ?? '')) ctx.addIssue({ code: 'custom', path: ['id'], message: 'A claim action names one claim, memory:claim:<n>' });
  if (claim && (action.quiet_start ?? action.quiet_end ?? action.volume ?? action.confirmation) !== undefined) ctx.addIssue({ code: 'custom', message: 'A claim action carries only its id and value' });
  if (action.action === 'claim.pin' && action.value !== 'profile' && action.value !== 'facts') ctx.addIssue({ code: 'custom', path: ['value'], message: 'claim.pin names the block, profile or facts' });
  if (action.action === 'claim.unpin' && action.value !== undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: 'claim.unpin carries no value' });
  const edited = action.value?.trim() ?? '';
  if (action.action === 'claim.edit' && (edited.length === 0 || edited.length > APP_CLAIM_TEXT_MAX_V1)) ctx.addIssue({ code: 'custom', path: ['value'], message: `claim.edit carries the new text, 1 to ${APP_CLAIM_TEXT_MAX_V1} characters` });
  // The owner's word on one constellation node: confirm it, correct it in their own words, or forget it.
  const node = NODE_ACTIONS.includes(action.action);
  if (node && !nodeId.test(action.id ?? '')) ctx.addIssue({ code: 'custom', path: ['id'], message: 'A node action names one node, memory:node:<n>' });
  if (node && (action.quiet_start ?? action.quiet_end ?? action.volume ?? action.confirmation) !== undefined) ctx.addIssue({ code: 'custom', message: 'A node action carries only its id and, for a correction, value' });
  const corrected = action.value?.trim() ?? '';
  if (action.action === 'node.correct' && (corrected.length === 0 || corrected.length > APP_NODE_CORRECTION_MAX_V1)) ctx.addIssue({ code: 'custom', path: ['value'], message: `node.correct carries the owner's words, 1 to ${APP_NODE_CORRECTION_MAX_V1} characters` });
  if ((action.action === 'node.confirm' || action.action === 'node.forget') && action.value !== undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: `${action.action} carries no value` });
  const phone = action.action === 'phone.sms_send' || action.action === 'phone.sms_check' || action.action === 'phone.set' || action.action === 'imessage.enroll';
  if (phone !== (action.view === 'phone')) ctx.addIssue({ code: 'custom', path: ['view'], message: 'The phone actions alone use the phone view' });
  if ((action.code !== undefined) !== (action.action === 'phone.sms_check')) ctx.addIssue({ code: 'custom', path: ['code'], message: 'phone.sms_check alone carries the code, and always does' });
  // phone.set stores the number unverified; the owner proves it with phone.sms_send and phone.sms_check.
  if (action.action === 'phone.set' && !APP_PHONE_E164.test(action.value ?? '')) ctx.addIssue({ code: 'custom', path: ['value'], message: 'phone.set carries the number in value, E.164 (+ and 7 to 15 digits)' });
  if (phone && (action.id ?? (action.action === 'phone.set' ? undefined : action.value) ?? action.quiet_start ?? action.quiet_end ?? action.volume ?? action.confirmation) !== undefined) ctx.addIssue({ code: 'custom', message: 'The phone actions carry only the code, or for phone.set the number' });
  // imessage.enroll sets up the number on file for iMessage; it carries nothing, so no number travels with it.
  // The owner's Waldo address: claim names the handle in value; release carries nothing.
  const agentMail = action.action === 'agent_mail.claim' || action.action === 'agent_mail.release';
  if (agentMail !== (action.view === 'agent_mail')) ctx.addIssue({ code: 'custom', path: ['view'], message: 'The agent_mail actions alone use the agent_mail view' });
  if (action.action === 'agent_mail.claim' && !(action.value && action.value.trim().length >= 1 && action.value.length <= APP_AGENT_MAIL_HANDLE_INPUT_MAX_V1)) ctx.addIssue({ code: 'custom', path: ['value'], message: `agent_mail.claim names the handle in value, up to ${APP_AGENT_MAIL_HANDLE_INPUT_MAX_V1} characters` });
  // Claiming is the owner's opt-in: it names the version of the notice the owner was shown and accepted.
  if ((action.notice !== undefined) !== (action.action === 'agent_mail.claim')) ctx.addIssue({ code: 'custom', path: ['notice'], message: 'agent_mail.claim alone carries notice, the version of the notice it showed, and always does' });
  // Where Waldo writes first, from the day view: one of the surfaces in value and nothing else (revision 11).
  if (action.action === 'proactive_surface.set' && (action.view !== 'day' || !appProactiveSurfaceV1Schema.safeParse(action.value).success
    || (action.id ?? action.quiet_start ?? action.quiet_end ?? action.volume ?? action.confirmation ?? action.code ?? action.notice) !== undefined)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'proactive_surface.set starts from the day view and names one surface in value, nothing else' });
  if (agentMail && ((action.action === 'agent_mail.claim' ? undefined : action.value) ?? action.id ?? action.quiet_start ?? action.quiet_end ?? action.volume ?? action.confirmation ?? action.code) !== undefined) ctx.addIssue({ code: 'custom', message: 'agent_mail.claim carries only the handle and the notice version; agent_mail.release carries nothing' });
});

// The app-visible message recorded for this card today, or null when none is recorded. Independent of `sent`:
// a card delivered on another surface, or held for quiet hours, can be sent or unsent with latest null.
// message_id is the main-chat history row; delivered_at is epoch ms. The excerpt is a prefix, up to 280
// UTF-16 code units, of the text the chat shows for that row, cut at read time and never stored. A row
// that is gone or has no text gives latest null.
export const APP_CARD_EXCERPT_MAX_V1 = 280;
// Where today's card stands. sent keeps its meaning, finished for today; state says how: sent (handed to the owner's
// channel), skipped (it came due and nothing went out), held (kept back in quiet hours) or pending (not fired yet).
// Absent when the Worker cannot tell, as for a card finished before it kept the outcome.
// Controls revision 3 (`controls=3`) adds three unfinished states: generating (a run or a Try again is under way), failed
// (no card was made and none is coming on its own; Try again is offered) and paused (the scheduler paused the card after
// repeated failures). Revisions 1 and 2 read each of them as pending. Revision 3 may also carry state_reason, a short fixed
// line saying why, and retries_left, today's remaining Try agains.
export const APP_CONTROLS_CARD_STATE_REVISION = 3;
// Controls revision 7 (`controls=7`): the day view and the account view name the owner (`name`, as they told Waldo at setup),
// the account view carries the sign-in `email` and, once verified, the `phone`, and `google.disconnect` is an app action.
// Each field is absent when Waldo does not hold it, and revisions below 7 never receive any of them.
export const APP_CONTROLS_IDENTITY_REVISION = 7;
// Controls revision 8 (`controls=8`): the day view carries memory_revision, a per-owner count that moves whenever the owner's
// memory changes, from chat or not (the nightly pass, the welcome build, the console). Re-reading a claim does not move it.
// It carries no content and is not part of the day view's revision, so it never makes a day action stale; an open screen
// re-reads memory when it differs. Revisions below 8 never receive it.
export const APP_CONTROLS_MEMORY_SIGNAL_REVISION = 8;
// Controls revision 9 (`controls=9`): a day card Waldo revised after delivering it, because the owner's day changed, carries
// revision (how many revisions reached the owner today) and revised_at (epoch ms, the latest one), together or not at all,
// and its latest names the newest revision's Main chat row, or is null when that revision reached the owner outside the app.
// The original row stays in the chat and in day history. Below 9 neither field is sent and latest stays the original delivery.
export const APP_CONTROLS_DAY_CARD_REVISION = 9;
const ownerName = text.min(1).max(80);
export const APP_CARD_STATE_REASON_MAX_V1 = 120;
export const APP_CARD_RETRIES_PER_DAY_V1 = 3;
export const appDayCardStateV1Schema = z.enum(['pending', 'held', 'sent', 'skipped', 'generating', 'failed', 'paused']);
const DAY_CARD_IDS: readonly string[] = ['card:brief', 'card:midday', 'card:close'];
const latestDelivery = z.strictObject({ message_id: text.min(1), delivered_at: z.int().positive(), excerpt: text.min(1).max(APP_CARD_EXCERPT_MAX_V1) });
// The first page of open work the Home shows; total counts every open item, so the app can say how many more there are.
export const APP_OVERVIEW_PAGE_MAX_V1 = 20;
const firstPage = <Item extends z.ZodType>(item: Item) => z.strictObject({ items: z.array(item).max(APP_OVERVIEW_PAGE_MAX_V1), total: count })
  .refine(page => page.total >= page.items.length, { error: 'total counts every open item', path: ['total'] });
// The owner's local day, or day and minute, as the loop and responsibility tools take it.
const localWhen = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/);
const workTitle = text.min(1).max(200);
// What Waldo took on and has not closed, soonest check first. next is the first unfinished step whose prerequisites are
// done, with who holds it; null when no step is open. check_at is when Waldo looks at it again.
const carried = z.strictObject({
  id: text.min(1).max(100), title: workTitle, state: z.enum(['open', 'waiting', 'uncertain']),
  next: z.strictObject({ title: workTitle, holder: z.enum(['waldo', 'owner']) }).nullable(), check_at: localWhen.nullable(),
});
// Open follow-ups, soonest due first and undated last. source says where one came from, never which thread.
const openLoop = z.strictObject({ id: text.min(1).max(100), title: workTitle, due: localWhen.nullable(), source: z.enum(['gmail', 'chat']) });
// Today's update cards in Main chat, newest first, each named like a card's latest delivery. checked_at (epoch ms) is
// when Waldo last read the calendar and inbox for changes, null before its first real read. A check can hold what it
// found for the next main card, so an empty page does not mean nothing changed.
const updates = z.strictObject({ items: z.array(latestDelivery).max(APP_OVERVIEW_PAGE_MAX_V1), total: count, checked_at: z.int().positive().nullable() })
  .refine(page => page.total >= page.items.length, { error: 'total counts every update card today', path: ['total'] });
// timezone_confirmed is true once the owner set the zone themselves (timezone.set); absent from a Worker that does not say.
export const appControlDayDataV1Schema = z.strictObject({
  timezone: text, timezone_confirmed: z.boolean().optional(), date: text, name: ownerName.optional(), memory_revision: count.optional(),
  cards: z.array(z.strictObject({ id: text, name: text, defaultTime: text, time: text.nullable(), reason: text, sent: z.boolean(), pin: text.nullable(), latest: latestDelivery.nullable().optional(),
    state: appDayCardStateV1Schema.optional(), state_reason: text.min(1).max(APP_CARD_STATE_REASON_MAX_V1).optional(),
    retries_left: z.int().min(0).max(APP_CARD_RETRIES_PER_DAY_V1).optional(), revision: z.int().min(1).optional(), revised_at: z.int().positive().optional() })
    .refine(card => card.state === undefined || card.sent === (card.state === 'sent' || card.state === 'skipped'), { error: 'state and sent disagree', path: ['state'] })
    .refine(card => (card.revision === undefined) === (card.revised_at === undefined), { error: 'revision and revised_at come together', path: ['revision'] })),
  proactivity: z.strictObject({ quiet_start: text.nullable(), quiet_end: text.nullable(), volume: z.enum(['low', 'normal', 'high']) }),
  schedules: z.strictObject({ daily_brief: z.boolean(), followups: z.boolean(), event_briefs: z.boolean(), nightly: z.boolean(), heartbeat: z.boolean() }),
  carrying: firstPage(carried).optional(),
  open_loops: firstPage(openLoop).optional(),
  updates: updates.optional(),
  // Controls revision 11: where Waldo writes first (value) and what the owner can choose now (choices). A choice is offered
  // only while every chat it names is linked. value can name a chat that has since been unlinked; Waldo then writes in the
  // app until it is linked again.
  proactive_surface: z.strictObject({ value: appProactiveSurfaceV1Schema, choices: z.array(appProactiveSurfaceV1Schema).min(1).max(appProactiveSurfaceV1Schema.options.length)
    .refine(choices => new Set(choices).size === choices.length, 'A choice is listed once') }).optional(),
});
// Controls revision 6 (`controls=6`) adds the days view: the owner's last 14 local days as the app Home showed them, and one of
// them in detail with its update cards and the night before it. It is read-only. An older revision asking for it gets
// invalid_query. History starts the day Waldo began keeping it (history_since) and is never backfilled: a day that began
// before it, or a night whose runs were partly trimmed, reads complete false.
// A card's state: sent or skipped once finished, pending while today's card may still come, not_sent for an earlier day's
// card that never went out, unknown for a card that finished before the outcome was kept. latest is as on the day view.
// text is reserved for the card's full words and is not sent until the health-number question on card text is settled.
export const APP_CONTROLS_DAY_HISTORY_REVISION = 6;
export const APP_DAY_HISTORY_DAYS_V1 = 14;
export const APP_NIGHT_RUNS_MAX_V1 = 50;
export const appDayHistoryCardStateV1Schema = z.enum(['sent', 'skipped', 'pending', 'not_sent', 'unknown']);
const historyCard = { id: text, name: text, state: appDayHistoryCardStateV1Schema, latest: latestDelivery.nullable().optional() };
export const appControlDaysDataV1Schema = z.strictObject({
  timezone: text, today: historyDay, history_since: historyDay.nullable(),
  days: z.array(z.strictObject({ date: historyDay, complete: z.boolean(), cards: z.array(z.strictObject(historyCard)), updates_total: count })).max(APP_DAY_HISTORY_DAYS_V1),
});
// The night before the day: from the previous day's Close to this day's Brief (now, while the Brief is still to come), the
// background runs started in it, oldest first. Times are epoch ms. A summary is the runner's fixed outcome line, plain text.
const nightRun = z.strictObject({
  id: text, kind: text, status: z.enum(['running', 'completed', 'failed', 'stopped']), summary: text.nullable(),
  started_at: z.int().positive(), ended_at: z.int().positive().nullable(),
});
export const appControlDayHistoryDataV1Schema = z.strictObject({
  timezone: text, date: historyDay, complete: z.boolean(),
  cards: z.array(z.strictObject({ ...historyCard, text: text.min(1).optional() })),
  updates: z.strictObject({ items: z.array(latestDelivery).max(APP_OVERVIEW_PAGE_MAX_V1), total: count })
    .refine(page => page.total >= page.items.length, { error: 'total counts every update card delivered that day', path: ['total'] }),
  night: z.strictObject({ from: z.int().positive(), to: z.int().positive(), complete: z.boolean(), runs: z.array(nightRun).max(APP_NIGHT_RUNS_MAX_V1), total: count })
    .refine(night => night.total >= night.runs.length, { error: 'total counts every run in the night', path: ['total'] }),
});
// Lists only the channels this Waldo can link. Addressing is masked and exists exactly while the
// binding keeps it: an unlinked or pending channel holds no peer identifier.
export const appChannelStatusV1Schema = z.strictObject({
  channel: messagingSurfaceV1Schema, state: z.enum(['linked', 'blocked', 'pending', 'unlinked']), masked_label: text.min(1).max(64).nullable(),
}).refine(status => (status.masked_label !== null) === (status.state === 'linked' || status.state === 'blocked'), { error: 'masked_label is present exactly while linked or blocked', path: ['masked_label'] });
// A catalogue app as its connections tile shows it. about is the app's own line; consent is what connecting allows, shown
// beside Connect, and null when connecting grants nothing. The app bundles each logo by id.
export const appConnectorTileV1Schema = z.strictObject({
  id: z.string().regex(APP_CONNECTOR_ID_V1), label: text.min(1).max(60), about: text.min(1).max(500), consent: text.min(1).max(1000).nullable(),
  connectAvailable: z.boolean(), connection: z.strictObject({ status: z.enum(['active', 'reauth_needed']), connected_at: z.int().positive() }).nullable(),
});
export const appControlConnectionsDataV1Schema = z.strictObject({
  // signin: the owner signs in with Google and that account is not connected yet, so the app can offer to connect that same
  // account with google.connect account 'signin'. Its presence is the capability: a backend without it never offers it, and
  // an older app reads the view tolerantly and drops it. email is the owner's own confirmed address.
  google: z.strictObject({ connectAvailable: z.boolean(), accounts: z.array(z.strictObject({ id: text, email: text, calendar: z.boolean(), mail: z.boolean(), tasks: z.boolean(), health: z.enum(['needs_reconnect', 'access_granted']) })), signin: z.strictObject({ email: z.email().max(254) }).optional() }),
  // Present from a Worker that reads Granola. connection is null until the owner connects it; reauth_needed means Waldo
  // can no longer read it and connecting again fixes that. connected_at is epoch ms.
  granola: z.strictObject({ connectAvailable: z.boolean(), connection: z.strictObject({ status: z.enum(['active', 'reauth_needed']), connected_at: z.int().positive() }).nullable() }).optional(),
  apps: z.array(appConnectorTileV1Schema).max(64).optional(),
  telegram: z.strictObject({ linked: z.boolean(), unlinkAvailable: z.boolean() }),
  sessions: z.strictObject({ until: text, count, items: z.array(z.strictObject({ signed_in: text, until: text, current: z.boolean(), session_ref: sessionRef.optional() })) }),
  channels: z.array(appChannelStatusV1Schema).max(messagingSurfaceV1Schema.options.length)
    .refine(channels => new Set(channels.map(status => status.channel)).size === channels.length, 'A channel is listed once').optional(),
});
export const appControlAccountDataV1Schema = z.strictObject({ deletion_available: z.boolean(), name: ownerName.optional(), email: z.email().max(254).optional(), phone: z.string().regex(APP_PHONE_E164).optional() });
const hop = z.strictObject({ hop: text, ok: z.boolean(), ms: z.number(), note: text });
export const appControlActivityDataV1Schema = z.strictObject({
  steps: z.array(z.strictObject({ step: text, state: z.enum(['ok', 'failed', 'unseen']), at: text.nullable(), note: text.nullable() })),
  last_request: z.strictObject({ at: text, ok: z.boolean(), partial: z.boolean(), recorded_steps: count, hops: z.array(hop) }).nullable(),
  trace: z.array(z.strictObject({ time: text, hop: text, ok: z.boolean(), ms: z.number(), summary: text.nullable() })),
  runs: z.array(z.strictObject({ id: text, kind: text, status: text, summary: text.nullable(), started: text, ended: text.nullable() })),
  page: z.strictObject({ trace_before: count.nullable(), runs_before: count.nullable(), trace_applied: count.nullable(), runs_applied: count.nullable() }),
  ledger: text,
});
// The console's memory graph, without its table-local ids. Claim text and writer notes are the owner's own memory:
// the app shows them and never logs or persists them. Every string here (text, evidence.text, label, summary,
// domain, relation) renders as plain text, never markdown or links: a claim can come from an untrusted source.
// A pending forget empties claims and interpretations and marks the graph partial; estimates are uncalibrated
// model output, not measurements.
const memoryGraph = { version: z.literal(1), state: z.enum(['available', 'partial', 'unavailable']), complete: z.boolean(), unavailable_claim_count: count };
const estimate = z.number().min(0).max(1).nullable();
const memoryClaim = z.strictObject({
  id: memoryId, kind: text, text, source: text, origin: z.enum(['owner', 'agent', 'shared', 'untrusted', 'legacy']), status: z.enum(['active', 'promoted']),
  evidence: z.strictObject({ kind: z.literal('writer_note'), text }),
  source_reference: z.strictObject({ state: z.enum(['unverified', 'unavailable']), link: z.null(), visibility: z.literal('withheld_unverified_pointer'), retrievable: z.literal(false) }),
  recorded_at: text, writer_seen_count: z.int().positive().nullable(),
  // Controls revision 2: the block this claim is pinned to, shown on every turn, or null. Revision 2 also reads source
  // waldo_confirmed for a claim the nightly model confirmed, which stays Waldo's read; revision 1 reads it as confirmed.
  pinned: z.enum(['profile', 'facts']).nullable().optional(),
});
// Where a node's support came from, when Waldo read it from a connected source; empty for a node resting on what the owner
// said. confirmation is confirmed once the owner confirmed the node's own wording, and waldos_read until then, whoever wrote
// or confirmed the notes under it.
export const appNodeSourceV1Schema = z.enum(['apple_health', 'health_connect', 'calendar', 'tasks', 'gmail']);
// Controls revision 14 (`controls=14`) names two more node sources: web, a node Waldo drew from what the owner look-up found,
// and setup, one drawn from the owner's own setup answers. Revisions below it never receive either.
export const APP_CONTROLS_WELCOME_WEB_REVISION = 14;
export const appNodeSourceV14Schema = z.enum([...appNodeSourceV1Schema.options, 'web', 'setup']);
const memoryNode = z.strictObject({
  id: memoryId, type: z.literal('interpretation'), label: text, summary: text, domain: text, stored_status: text, recorded_active_at: text,
  estimate, estimate_kind: z.literal('uncalibrated_model_estimate'),
  support: z.strictObject({ state: z.enum(['stored_links', 'incomplete', 'invalid']), claim_ids: z.array(memoryId), unavailable_count: count, distinct_source_refs: count, independent_observations: z.literal('unverified') }),
  sources: z.array(appNodeSourceV14Schema).max(appNodeSourceV14Schema.options.length).optional(),
  confirmation: z.enum(['waldos_read', 'confirmed']).optional(),
});
// The one-time welcome build that starts when setup ends. Each source's stage settles: done with nodes, empty when the
// source had nothing, skipped when it is not connected or not offered, revoked when its consent or grant was withdrawn, and
// unavailable when the read failed. nodes counts the nodes the build wrote. A build that has not started has no times.
export const APP_WELCOME_STAGES_V1 = ['health', 'calendar', 'mail', 'web'] as const;
// Controls revision 5 (`controls=5`) adds the setup stage: the first nodes Waldo draws from the owner's own setup answers, so an
// owner who connected nothing still gets a constellation. Revisions 1 to 4 never receive the key. At every revision a stage that
// settled skipped may go back to pending once, when its source is connected later, and the build reads building again until it
// settles; a build reads building while the setup stage runs, even where the stage itself is not shown.
export const APP_CONTROLS_WELCOME_SETUP_REVISION = 5;
export const APP_WELCOME_STAGES_V5 = [...APP_WELCOME_STAGES_V1, 'setup'] as const;
export const appWelcomeStageStateV1Schema = z.enum(['pending', 'reading', 'done', 'empty', 'skipped', 'revoked', 'unavailable']);
export const appWelcomeBuildV1Schema = z.strictObject({
  state: z.enum(['not_started', 'building', 'done']),
  started_at: z.int().positive().nullable(), finished_at: z.int().positive().nullable(),
  stages: z.strictObject({
    ...Object.fromEntries(APP_WELCOME_STAGES_V1.map(stage => [stage, appWelcomeStageStateV1Schema])) as Record<(typeof APP_WELCOME_STAGES_V1)[number], typeof appWelcomeStageStateV1Schema>,
    setup: appWelcomeStageStateV1Schema.optional(),
  }),
  nodes: count,
}).superRefine((build, ctx) => {
  if ((build.state === 'not_started') !== (build.started_at === null)) ctx.addIssue({ code: 'custom', path: ['started_at'], message: 'only a build that has not started has no start time' });
  if ((build.state === 'done') !== (build.finished_at !== null)) ctx.addIssue({ code: 'custom', path: ['finished_at'], message: 'finished_at exists exactly when the build is done' });
  if (build.finished_at !== null && build.started_at !== null && build.finished_at < build.started_at) ctx.addIssue({ code: 'custom', path: ['finished_at'], message: 'a build cannot finish before it starts' });
});
const memoryLink = z.strictObject({ from: memoryId, to: memoryId, relation: text, state: z.literal('unverified_association'), estimate, writer_evidence_count: z.int().positive().nullable(), evidence_links: z.array(text) });
const memoryPage = z.strictObject({ limit: z.int().positive(), returned: count, total: count, next_cursor: memoryCursor.nullable() });
export const appControlConstellationDataV1Schema = z.union([
  z.strictObject({ ...memoryGraph, memory_view: z.literal('summary'), counts: z.strictObject({ claims: count, interpretations: count, associations: count }), welcome: appWelcomeBuildV1Schema.optional() }),
  z.strictObject({ ...memoryGraph, memory_view: z.literal('claims'), items: z.array(memoryClaim), page: memoryPage }),
  z.strictObject({ ...memoryGraph, memory_view: z.literal('interpretations'), items: z.array(memoryNode), page: memoryPage }),
  z.strictObject({ ...memoryGraph, memory_view: z.literal('detail'), kind: z.literal('claim'), item: memoryClaim, linked_interpretation_ids: z.array(memoryId) }),
  z.strictObject({ ...memoryGraph, memory_view: z.literal('detail'), kind: z.literal('interpretation'), item: memoryNode, support_claim_ids: z.array(memoryId), support_unavailable_count: count }),
  z.strictObject({
    ...memoryGraph, memory_view: z.literal('pattern'), center: memoryNode, nodes: z.array(memoryNode), associations: z.array(memoryLink),
    showing: z.strictObject({ nodes: count, of_nodes: count, links: count, of_links: count }), truncated: z.boolean(), omitted_links: count,
    expand: z.strictObject({ next_cursor: memoryCursor.nullable(), links_capped: z.boolean(), capped_links_recoverable: z.literal(false), capped_links: count }),
  }),
]);
// The owner's number on file and how to prove it: texting a code is listed only while it is offered and would be
// accepted now, checking only while a code waits with checks left, and setting the number while it can be proven, by a
// texted code, by the owner sending their iMessage link code from it, or (controls revision 12) by sending their WhatsApp link code from it. proof names those ways. imessage.enroll is listed
// where Waldo's iMessage needs the number set up first (Photon) and it is not yet. imessage_from says how
// the owner's linked iMessage relates to the number on file, never the handle: none (not linked), number (its last
// digits match), email (an Apple ID email, which proves no number) or other_number. Both are absent from older servers.
// Times are epoch seconds; retry_at null means now.
export const appControlPhoneDataV1Schema = z.strictObject({
  phone: z.string().regex(APP_PHONE_E164).nullable(), verified: z.boolean(), sms: z.boolean(),
  challenge: z.strictObject({
    state: z.enum(['sending', 'pending', 'checking', 'approved', 'expired', 'unknown']), expires_at: z.int().positive(),
    retry_at: z.int().positive().nullable(), checks_left: z.int().min(0).max(5),
  }).nullable(),
  actions: z.array(z.enum(['phone.sms_send', 'phone.sms_check', 'phone.set', 'imessage.enroll'])),
  proof: z.array(z.enum(['sms', 'imessage', 'whatsapp'])).optional(),
  imessage_from: z.enum(['none', 'number', 'email', 'other_number']).optional(),
  whatsapp_from: z.enum(['none', 'number', 'other_number']).optional(),
});
// Controls revision 12 (`controls=12`): whatsapp in proof, and whatsapp_from. Sending Waldo the link code from WhatsApp proves
// the number it is sent from, and takes it as the number on file while none is proven, so no number is set first. whatsapp_from
// says how the owner's linked WhatsApp relates to the number on file, never the number: none (not linked), number (its last
// digits match) or other_number. A build below revision 12 never receives either, so its strict proof list never meets whatsapp.
export const APP_CONTROLS_WHATSAPP_PROOF_REVISION = 12;
// The receipt for each phone.set outcome. The app tells taken and the other refusals apart by these exact messages, so
// they are contract, and none of them repeats the number. unavailable covers a server that does not offer texting.
export const APP_PHONE_SET_RECEIPTS_V1 = {
  set: { state: 'recorded', message: 'Number saved. It is not verified yet: ask for a code to prove it is yours.' },
  // A set that also unlinked the WhatsApp or iMessage chat linked from the old number.
  set_unlinked: { state: 'recorded', message: 'Number saved, not verified yet. Messages from your old number no longer reach Waldo; link your chat again from the new one.' },
  unchanged: { state: 'recorded', message: 'That is already the number on file.' },
  taken: { state: 'rejected', message: 'That number is already verified on another account, so it cannot be used here.' },
  invalid: { state: 'rejected', message: 'That is not a full number. Start with + and the country code.' },
  unsupported: { state: 'rejected', message: 'Waldo cannot text numbers in this country yet.' },
  throttled: { state: 'rejected', message: 'That is the limit on number changes for today. Try again tomorrow.' },
  unavailable: { state: 'rejected', message: 'The number could not be saved right now. Try again later.' },
  unknown: { state: 'unconfirmed', message: 'Saving the number was not confirmed. Refresh to see the number on file.' },
} as const satisfies Readonly<Record<string, Readonly<{ state: 'recorded' | 'rejected' | 'unconfirmed'; message: string }>>>;
// The receipt for each imessage.enroll outcome. Where Waldo's iMessage runs on Photon, an owner texts their own assigned
// number, so the number on file is set up with Photon first, at the owner's tap; the link code then goes to that number.
// None repeats a number.
export const APP_IMESSAGE_ENROLL_RECEIPTS_V1 = {
  enrolled: { state: 'recorded', message: 'iMessage is set up for your number. Send the message from it to prove it.' },
  phone_taken: { state: 'rejected', message: 'That number is already set up for iMessage on another account.' },
  invalid: { state: 'rejected', message: 'There is no full number on file to set up.' },
  throttled: { state: 'rejected', message: 'That is the limit on iMessage set-ups for now. Try again in an hour.' },
  unavailable: { state: 'rejected', message: 'iMessage could not be set up right now. Try again later.' },
  unknown: { state: 'unconfirmed', message: 'Setting up iMessage was not confirmed. Refresh to see where it stands.' },
} as const satisfies Readonly<Record<string, Readonly<{ state: 'recorded' | 'rejected' | 'unconfirmed'; message: string }>>>;
// Controls revision 10 (`controls=10`): the agent_mail view and its two actions. A build below it never names them and is
// refused them.
export const APP_CONTROLS_AGENT_MAIL_REVISION = 10;
// The owner's Waldo address. Agent mail is opt-in: claiming a handle is the switch, after the owner reads notice (shown
// exactly as given; the claim names its version). enabled is false while agent mail is off, and then only display_name
// and an empty actions list are sent. handle, address and rule are absent until a handle is held. rule says where the
// address's routing stands: pending (being set up; mail may not arrive yet), live, failed (it could not be set up; claiming
// the same handle again retries) or unknown (setting it up was not confirmed; claiming it again retries). rule_reason
// not_configured: routing is not set up on this server yet, so a pending rule stays pending. display_name is the name
// mail from Waldo carries. Claim is listed while enabled, release while a handle is held; a claim of a different handle
// releases the one held.
export const appControlAgentMailDataV1Schema = z.strictObject({
  enabled: z.boolean(), domain: text.optional(), handle: text.optional(), address: text.optional(),
  rule: z.enum(['pending', 'live', 'failed', 'unknown']).optional(), rule_reason: z.literal('not_configured').optional(),
  notice: z.strictObject({ version: agentMailNoticeVersion, text: text.min(1).max(4000) }).optional(),
  display_name: text.min(1).max(80), actions: z.array(z.enum(['agent_mail.claim', 'agent_mail.release'])),
}).superRefine((data, ctx) => {
  const held = data.handle !== undefined;
  if (data.enabled ? data.domain === undefined || data.notice === undefined : data.domain !== undefined || data.notice !== undefined || held) ctx.addIssue({ code: 'custom', path: ['enabled'], message: 'domain and notice come exactly when agent mail is enabled, and a handle only then' });
  if (held !== (data.address !== undefined) || held !== (data.rule !== undefined)) ctx.addIssue({ code: 'custom', path: ['handle'], message: 'handle, address and rule come together' });
  if (data.rule_reason !== undefined && data.rule !== 'pending') ctx.addIssue({ code: 'custom', path: ['rule_reason'], message: 'rule_reason explains a pending rule only' });
});
// The receipt for each agent_mail outcome. The app tells them apart by these exact messages, so they are contract.
export const APP_AGENT_MAIL_RECEIPTS_V1 = {
  claimed: { state: 'recorded', message: 'Address saved. Waldo is setting it up; mail reaches it once that is done.' },
  changed: { state: 'recorded', message: 'Address changed. Your old address no longer receives mail, and no one can claim it for 180 days.' },
  unchanged: { state: 'recorded', message: 'That is already your Waldo address.' },
  released: { state: 'recorded', message: 'Address released. It no longer receives mail, and no one, you included, can claim it for 180 days.' },
  none: { state: 'recorded', message: 'You have no Waldo address to release.' },
  taken: { state: 'rejected', message: 'That address is taken. Try another.' },
  reserved: { state: 'rejected', message: 'That address is reserved. Try another.' },
  invalid: { state: 'rejected', message: 'Use 3 to 32 lowercase letters, digits, dots or hyphens, starting and ending with a letter or digit.' },
  unavailable: { state: 'rejected', message: 'That address cannot be claimed right now. Try another, or try again later.' },
  full: { state: 'rejected', message: 'Waldo cannot set up new addresses right now. Try again later.' },
  too_many_changes: { state: 'rejected', message: 'That is the limit on address changes for today. Try again tomorrow.' },
  notice_stale: { state: 'rejected', message: 'The notice changed since you read it. Read the new one, then claim again.' },
  unknown: { state: 'unconfirmed', message: 'The change was not confirmed. Refresh to see your address.' },
} as const satisfies Readonly<Record<string, Readonly<{ state: 'recorded' | 'rejected' | 'unconfirmed'; message: string }>>>;
// Controls revision 11 (`controls=11`): the day view says where Waldo writes first and takes proactive_surface.set, which
// the owner's first run sets too. A build below it never receives the field and is refused the action.
export const APP_CONTROLS_PROACTIVE_SURFACE_REVISION = 11;
// The receipt for each proactive_surface.set outcome. The app tells them apart by these exact messages, so they are contract.
export const APP_PROACTIVE_SURFACE_RECEIPTS_V1 = {
  saved: { state: 'recorded', message: 'Saved. Waldo sends its next messages there.' },
  unchanged: { state: 'recorded', message: 'Waldo already sends its messages there.' },
  whatsapp_not_linked: { state: 'rejected', message: 'Link WhatsApp first, then choose it here.' },
  imessage_not_linked: { state: 'rejected', message: 'Link iMessage first, then choose it here.' },
  unchecked: { state: 'rejected', message: 'Waldo could not check your linked chats just now. Try again in a moment.' },
} as const satisfies Readonly<Record<string, Readonly<{ state: 'recorded' | 'rejected'; message: string }>>>;
const envelope = { version: z.literal(1), state: z.literal('available'), revision };
export const appControlProjectionV1Schema = z.discriminatedUnion('view', [
  z.strictObject({ ...envelope, view: z.literal('day'), data: appControlDayDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('connections'), data: appControlConnectionsDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('activity'), data: appControlActivityDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('account'), data: appControlAccountDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('constellation'), data: appControlConstellationDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('phone'), data: appControlPhoneDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('days'), data: z.union([appControlDaysDataV1Schema, appControlDayHistoryDataV1Schema]) }),
  z.strictObject({ ...envelope, view: z.literal('agent_mail'), data: appControlAgentMailDataV1Schema }),
]);
// revocation is sent only on a recorded app.disconnect receipt for an app Waldo had signed in to.
export const appControlReceiptV1Schema = z.strictObject({
  state: z.enum(['recorded', 'incomplete', 'rejected', 'unconfirmed']), message: text, navigation: text.optional(), signed_out: z.boolean().optional(),
  revocation: z.enum(['revoked', 'unsupported', 'failed']).optional(),
}).refine((receipt) => receipt.revocation === undefined || receipt.state === 'recorded', { path: ['revocation'], message: 'Only a recorded disconnect says how revocation went' });
export const appControlResultV1Schema = z.strictObject({ request_id: appControlRequestIdV1Schema, receipt: appControlReceiptV1Schema, duplicate: z.boolean() });
export const appControlRoutesV1 = [
  { method: 'GET', path: '/app/v1/controls', query: appControlQueryV1Schema, response: appControlProjectionV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/actions', request: appControlActionV1Schema, response: appControlResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'GET', path: '/app/v1/actions/{request_id}', response: appControlResultV1Schema, authenticated: true, success_status: 200 },
] as const;

export type AppControlProjectionV1 = z.infer<typeof appControlProjectionV1Schema>;
export type AppControlViewV1 = z.infer<typeof appControlViewV1Schema>;
export type AppControlResultV1 = z.infer<typeof appControlResultV1Schema>;
export type AppChannelStatusV1 = z.infer<typeof appChannelStatusV1Schema>;
export type AppWelcomeBuildV1 = z.infer<typeof appWelcomeBuildV1Schema>;
export type AppNodeSourceV1 = z.infer<typeof appNodeSourceV1Schema>;
export type AppNodeSourceV14 = z.infer<typeof appNodeSourceV14Schema>;
