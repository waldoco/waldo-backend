import { z } from 'zod';
import { messagingSurfaceV1Schema } from './surfaces';

const text = z.string();
const count = z.int().nonnegative();
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const appControlRequestIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
export const appControlViewV1Schema = z.enum(['day', 'connections', 'activity', 'account', 'constellation']);
const activityCursor = z.string().regex(/^[0-9]+$/).refine(value => Number.isSafeInteger(Number(value)) && Number(value) > 0);
export const APP_MEMORY_PAGE_MAX_V1 = 50;
const memoryPageSize = z.string().regex(/^[0-9]{1,9}$/).refine(value => Number(value) >= 1 && Number(value) <= APP_MEMORY_PAGE_MAX_V1);
const memoryCursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
const memoryId = text.min(1).max(256);
const memoryViews = z.enum(['summary', 'claims', 'interpretations', 'detail', 'pattern']);
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
  view: appControlViewV1Schema, action: z.enum(['timezone.set', 'proactivity.set', 'channel.unlink', 'google.connect', 'account.delete', 'session.revoke']),
  id: text.max(256).optional(), value: text.max(4096).optional(),
  quiet_start: text.max(5).optional(), quiet_end: text.max(5).optional(), volume: z.enum(['low', 'normal', 'high']).optional(),
  confirmation: z.literal('DELETE').optional(),
  revision, request_id: appControlRequestIdV1Schema,
}).superRefine((action, ctx) => {
  if (action.action === 'channel.unlink' && !messagingSurfaceV1Schema.safeParse(action.id).success) ctx.addIssue({ code: 'custom', path: ['id'], message: 'channel.unlink names a messaging channel in id' });
  // The receipt's navigation is the first-party /c/<ticket> path; the backend decides which features exist.
  if (action.action === 'google.connect' && (action.view !== 'connections' || !action.value || action.value.length > 64)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'google.connect starts from the connections view and names a Google feature in value' });
  // Signs another device out. The current session signs out through /auth/signout, which revokes push first.
  if (action.action === 'session.revoke' && (action.view !== 'connections' || !sessionRef.safeParse(action.value).success
    || (action.id ?? action.quiet_start ?? action.quiet_end ?? action.volume ?? action.confirmation) !== undefined)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'session.revoke starts from the connections view and names one session_ref in value' });
  // Deletion signs out every session, so its recorded receipt cannot be read back: a replay is refused
  // as signed out. An unconfirmed receipt can be read back, and resending the same request_id never
  // runs a second deletion.
  const deletion = action.action === 'account.delete';
  if (deletion !== (action.view === 'account') || deletion !== (action.confirmation === 'DELETE')) ctx.addIssue({ code: 'custom', path: ['confirmation'], message: 'account.delete alone uses the account view, with confirmation DELETE' });
  if (deletion && (action.id ?? action.value ?? action.quiet_start ?? action.quiet_end ?? action.volume) !== undefined) ctx.addIssue({ code: 'custom', message: 'account.delete carries only its confirmation' });
  if (action.view === 'constellation') ctx.addIssue({ code: 'custom', path: ['view'], message: 'The constellation view is read-only' });
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
// timezone_confirmed is true once the owner set the zone themselves (timezone.set); absent from a Worker that does not say.
export const appControlDayDataV1Schema = z.strictObject({
  timezone: text, timezone_confirmed: z.boolean().optional(), date: text,
  cards: z.array(z.strictObject({ id: text, name: text, defaultTime: text, time: text.nullable(), reason: text, sent: z.boolean(), pin: text.nullable(), latest: latestDelivery.nullable().optional(),
    state: appDayCardStateV1Schema.optional() }).refine(card => card.state === undefined || card.sent === (card.state === 'sent' || card.state === 'skipped'), { error: 'state and sent disagree', path: ['state'] })),
  proactivity: z.strictObject({ quiet_start: text.nullable(), quiet_end: text.nullable(), volume: z.enum(['low', 'normal', 'high']) }),
  schedules: z.strictObject({ daily_brief: z.boolean(), followups: z.boolean(), event_briefs: z.boolean(), nightly: z.boolean(), heartbeat: z.boolean() }),
  carrying: firstPage(carried).optional(),
  open_loops: firstPage(openLoop).optional(),
});
// Lists only the channels this Waldo can link. Addressing is masked and exists exactly while the
// binding keeps it: an unlinked or pending channel holds no peer identifier.
export const appChannelStatusV1Schema = z.strictObject({
  channel: messagingSurfaceV1Schema, state: z.enum(['linked', 'blocked', 'pending', 'unlinked']), masked_label: text.min(1).max(64).nullable(),
}).refine(status => (status.masked_label !== null) === (status.state === 'linked' || status.state === 'blocked'), { error: 'masked_label is present exactly while linked or blocked', path: ['masked_label'] });
export const appControlConnectionsDataV1Schema = z.strictObject({
  google: z.strictObject({ connectAvailable: z.boolean(), accounts: z.array(z.strictObject({ id: text, email: text, calendar: z.boolean(), mail: z.boolean(), tasks: z.boolean(), health: z.enum(['needs_reconnect', 'access_granted']) })) }),
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
});
const memoryNode = z.strictObject({
  id: memoryId, type: z.literal('interpretation'), label: text, summary: text, domain: text, stored_status: text, recorded_active_at: text,
  estimate, estimate_kind: z.literal('uncalibrated_model_estimate'),
  support: z.strictObject({ state: z.enum(['stored_links', 'incomplete', 'invalid']), claim_ids: z.array(memoryId), unavailable_count: count, distinct_source_refs: count, independent_observations: z.literal('unverified') }),
});
const memoryLink = z.strictObject({ from: memoryId, to: memoryId, relation: text, state: z.literal('unverified_association'), estimate, writer_evidence_count: z.int().positive().nullable(), evidence_links: z.array(text) });
const memoryPage = z.strictObject({ limit: z.int().positive(), returned: count, total: count, next_cursor: memoryCursor.nullable() });
export const appControlConstellationDataV1Schema = z.union([
  z.strictObject({ ...memoryGraph, memory_view: z.literal('summary'), counts: z.strictObject({ claims: count, interpretations: count, associations: count }) }),
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
const envelope = { version: z.literal(1), state: z.literal('available'), revision };
export const appControlProjectionV1Schema = z.discriminatedUnion('view', [
  z.strictObject({ ...envelope, view: z.literal('day'), data: appControlDayDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('connections'), data: appControlConnectionsDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('activity'), data: appControlActivityDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('account'), data: appControlAccountDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('constellation'), data: appControlConstellationDataV1Schema }),
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
