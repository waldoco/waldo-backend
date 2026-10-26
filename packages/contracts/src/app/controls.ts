import { z } from 'zod';
import { messagingSurfaceV1Schema } from './surfaces';

const text = z.string();
const count = z.int().nonnegative();
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const appControlRequestIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
export const appControlViewV1Schema = z.enum(['day', 'connections', 'activity', 'account', 'constellation', 'phone']);
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
const NODE_ACTIONS: readonly string[] = ['node.confirm', 'node.correct', 'node.forget'];
// The constellation keys page the owner's memory graph: limit is required for claims and interpretations,
// id for detail and pattern, max_nodes and max_links for pattern. Ids and cursors are opaque.
export const appControlQueryV1Schema = z.strictObject({
  view: appControlViewV1Schema, trace_before: activityCursor.optional(), runs_before: activityCursor.optional(),
  memory_view: memoryViews.optional(), cursor: memoryCursor.optional(), limit: memoryPageSize.optional(), id: memoryId.optional(),
  max_nodes: memoryPageSize.optional(), max_links: memoryPageSize.optional(),
}).superRefine((query, ctx) => {
  if (query.view !== 'activity' && (query.trace_before !== undefined || query.runs_before !== undefined)) ctx.addIssue({ code: 'custom', message: 'Activity cursors require the activity view' });
  if (query.view !== 'constellation' && (query.memory_view ?? query.cursor ?? query.limit ?? query.id ?? query.max_nodes ?? query.max_links) !== undefined) ctx.addIssue({ code: 'custom', message: 'Memory paging requires the constellation view' });
});
// A signed-in device, as its connections row names it for session.revoke.
const sessionRef = z.string().regex(/^sess_[a-f0-9]{64}$/);
export const appControlActionV1Schema = z.strictObject({
  view: appControlViewV1Schema, action: z.enum(['timezone.set', 'proactivity.set', 'channel.unlink', 'google.connect', 'granola.connect', 'granola.disconnect', 'account.delete', 'claim.pin', 'claim.unpin', 'claim.edit', 'node.confirm', 'node.correct', 'node.forget', 'session.revoke', 'phone.sms_send', 'phone.sms_check', 'phone.set']),
  id: text.max(256).optional(), value: text.max(4096).optional(),
  quiet_start: text.max(5).optional(), quiet_end: text.max(5).optional(), volume: z.enum(['low', 'normal', 'high']).optional(),
  confirmation: z.literal('DELETE').optional(),
  // The six digits Twilio texted, for phone.sms_check only. The send and the check name no number: the backend texts the
  // number on file, which only phone.set changes.
  code: z.string().regex(/^\d{6}$/).optional(),
  revision, request_id: appControlRequestIdV1Schema,
}).superRefine((action, ctx) => {
  if (action.action === 'channel.unlink' && !messagingSurfaceV1Schema.safeParse(action.id).success) ctx.addIssue({ code: 'custom', path: ['id'], message: 'channel.unlink names a messaging channel in id' });
  // The receipt's navigation is the first-party /c/<ticket>?handoff=<code> path, opened exactly as given, once, in one
  // browser session: its one-time code binds the first browser that loads the link. The backend decides which features exist.
  if (action.action === 'google.connect' && (action.view !== 'connections' || !action.value || action.value.length > 64)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'google.connect starts from the connections view and names a Google feature in value' });
  // Granola is one fixed, reviewed server, so its actions name nothing. A connect receipt's navigation is the first-party
  // /c/<ticket>?handoff=<code> path; disconnect revokes at Granola where it can and says when it could not.
  const granola = action.action === 'granola.connect' || action.action === 'granola.disconnect';
  if (granola && (action.view !== 'connections' || (action.id ?? action.value ?? action.quiet_start ?? action.quiet_end ?? action.volume ?? action.confirmation) !== undefined)) ctx.addIssue({ code: 'custom', path: ['view'], message: 'granola actions start from the connections view and carry nothing else' });
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
  const phone = action.action === 'phone.sms_send' || action.action === 'phone.sms_check' || action.action === 'phone.set';
  if (phone !== (action.view === 'phone')) ctx.addIssue({ code: 'custom', path: ['view'], message: 'The phone actions alone use the phone view' });
  if ((action.code !== undefined) !== (action.action === 'phone.sms_check')) ctx.addIssue({ code: 'custom', path: ['code'], message: 'phone.sms_check alone carries the code, and always does' });
  // phone.set stores the number unverified; the owner proves it with phone.sms_send and phone.sms_check.
  if (action.action === 'phone.set' && !APP_PHONE_E164.test(action.value ?? '')) ctx.addIssue({ code: 'custom', path: ['value'], message: 'phone.set carries the number in value, E.164 (+ and 7 to 15 digits)' });
  if (phone && (action.id ?? (action.action === 'phone.set' ? undefined : action.value) ?? action.quiet_start ?? action.quiet_end ?? action.volume ?? action.confirmation) !== undefined) ctx.addIssue({ code: 'custom', message: 'The phone actions carry only the code, or for phone.set the number' });
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
export const appDayCardStateV1Schema = z.enum(['pending', 'held', 'sent', 'skipped']);
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
  timezone: text, timezone_confirmed: z.boolean().optional(), date: text,
  cards: z.array(z.strictObject({ id: text, name: text, defaultTime: text, time: text.nullable(), reason: text, sent: z.boolean(), pin: text.nullable(), latest: latestDelivery.nullable().optional(),
    state: appDayCardStateV1Schema.optional() }).refine(card => card.state === undefined || card.sent === (card.state === 'sent' || card.state === 'skipped'), { error: 'state and sent disagree', path: ['state'] })),
  proactivity: z.strictObject({ quiet_start: text.nullable(), quiet_end: text.nullable(), volume: z.enum(['low', 'normal', 'high']) }),
  schedules: z.strictObject({ daily_brief: z.boolean(), followups: z.boolean(), event_briefs: z.boolean(), nightly: z.boolean(), heartbeat: z.boolean() }),
  carrying: firstPage(carried).optional(),
  open_loops: firstPage(openLoop).optional(),
  updates: updates.optional(),
});
// Lists only the channels this Waldo can link. Addressing is masked and exists exactly while the
// binding keeps it: an unlinked or pending channel holds no peer identifier.
export const appChannelStatusV1Schema = z.strictObject({
  channel: messagingSurfaceV1Schema, state: z.enum(['linked', 'blocked', 'pending', 'unlinked']), masked_label: text.min(1).max(64).nullable(),
}).refine(status => (status.masked_label !== null) === (status.state === 'linked' || status.state === 'blocked'), { error: 'masked_label is present exactly while linked or blocked', path: ['masked_label'] });
export const appControlConnectionsDataV1Schema = z.strictObject({
  google: z.strictObject({ connectAvailable: z.boolean(), accounts: z.array(z.strictObject({ id: text, email: text, calendar: z.boolean(), mail: z.boolean(), tasks: z.boolean(), health: z.enum(['needs_reconnect', 'access_granted']) })) }),
  // Present from a Worker that reads Granola. connection is null until the owner connects it; reauth_needed means Waldo
  // can no longer read it and connecting again fixes that. connected_at is epoch ms.
  granola: z.strictObject({ connectAvailable: z.boolean(), connection: z.strictObject({ status: z.enum(['active', 'reauth_needed']), connected_at: z.int().positive() }).nullable() }).optional(),
  telegram: z.strictObject({ linked: z.boolean(), unlinkAvailable: z.boolean() }),
  sessions: z.strictObject({ until: text, count, items: z.array(z.strictObject({ signed_in: text, until: text, current: z.boolean(), session_ref: sessionRef.optional() })) }),
  channels: z.array(appChannelStatusV1Schema).max(messagingSurfaceV1Schema.options.length)
    .refine(channels => new Set(channels.map(status => status.channel)).size === channels.length, 'A channel is listed once').optional(),
});
export const appControlAccountDataV1Schema = z.strictObject({ deletion_available: z.boolean() });
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
// said. confirmation is confirmed once every supporting claim is the owner's own word, and waldos_read until then.
export const appNodeSourceV1Schema = z.enum(['apple_health', 'health_connect', 'calendar', 'tasks', 'gmail']);
const memoryNode = z.strictObject({
  id: memoryId, type: z.literal('interpretation'), label: text, summary: text, domain: text, stored_status: text, recorded_active_at: text,
  estimate, estimate_kind: z.literal('uncalibrated_model_estimate'),
  support: z.strictObject({ state: z.enum(['stored_links', 'incomplete', 'invalid']), claim_ids: z.array(memoryId), unavailable_count: count, distinct_source_refs: count, independent_observations: z.literal('unverified') }),
  sources: z.array(appNodeSourceV1Schema).max(appNodeSourceV1Schema.options.length).optional(),
  confirmation: z.enum(['waldos_read', 'confirmed']).optional(),
});
// The one-time welcome build that starts when setup ends. Each source's stage settles once: done with nodes, empty when the
// source had nothing, skipped when it is not connected or not offered, revoked when its consent or grant was withdrawn, and
// unavailable when the read failed. nodes counts the nodes the build wrote. A build that has not started has no times.
export const APP_WELCOME_STAGES_V1 = ['health', 'calendar', 'mail', 'web'] as const;
export const appWelcomeStageStateV1Schema = z.enum(['pending', 'reading', 'done', 'empty', 'skipped', 'revoked', 'unavailable']);
export const appWelcomeBuildV1Schema = z.strictObject({
  state: z.enum(['not_started', 'building', 'done']),
  started_at: z.int().positive().nullable(), finished_at: z.int().positive().nullable(),
  stages: z.strictObject(Object.fromEntries(APP_WELCOME_STAGES_V1.map(stage => [stage, appWelcomeStageStateV1Schema])) as Record<(typeof APP_WELCOME_STAGES_V1)[number], typeof appWelcomeStageStateV1Schema>),
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
// accepted now, checking only while a code waits with checks left, and setting the number while texting is offered.
// Times are epoch seconds; retry_at null means now.
export const appControlPhoneDataV1Schema = z.strictObject({
  phone: z.string().regex(APP_PHONE_E164).nullable(), verified: z.boolean(), sms: z.boolean(),
  challenge: z.strictObject({
    state: z.enum(['sending', 'pending', 'checking', 'approved', 'expired', 'unknown']), expires_at: z.int().positive(),
    retry_at: z.int().positive().nullable(), checks_left: z.int().min(0).max(5),
  }).nullable(),
  actions: z.array(z.enum(['phone.sms_send', 'phone.sms_check', 'phone.set'])),
});
// The receipt for each phone.set outcome. The app tells taken and the other refusals apart by these exact messages, so
// they are contract, and none of them repeats the number. unavailable covers a server that does not offer texting.
export const APP_PHONE_SET_RECEIPTS_V1 = {
  set: { state: 'recorded', message: 'Number saved. It is not verified yet: ask for a code to prove it is yours.' },
  unchanged: { state: 'recorded', message: 'That is already the number on file.' },
  taken: { state: 'rejected', message: 'That number is already verified on another account, so it cannot be used here.' },
  invalid: { state: 'rejected', message: 'That is not a full number. Start with + and the country code.' },
  unsupported: { state: 'rejected', message: 'Waldo cannot text numbers in this country yet.' },
  throttled: { state: 'rejected', message: 'That is the limit on number changes for today. Try again tomorrow.' },
  unavailable: { state: 'rejected', message: 'The number could not be saved right now. Try again later.' },
  unknown: { state: 'unconfirmed', message: 'Saving the number was not confirmed. Refresh to see the number on file.' },
} as const satisfies Readonly<Record<string, Readonly<{ state: 'recorded' | 'rejected' | 'unconfirmed'; message: string }>>>;
const envelope = { version: z.literal(1), state: z.literal('available'), revision };
export const appControlProjectionV1Schema = z.discriminatedUnion('view', [
  z.strictObject({ ...envelope, view: z.literal('day'), data: appControlDayDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('connections'), data: appControlConnectionsDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('activity'), data: appControlActivityDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('account'), data: appControlAccountDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('constellation'), data: appControlConstellationDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('phone'), data: appControlPhoneDataV1Schema }),
]);
export const appControlReceiptV1Schema = z.strictObject({ state: z.enum(['recorded', 'incomplete', 'rejected', 'unconfirmed']), message: text, navigation: text.optional(), signed_out: z.boolean().optional() });
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
