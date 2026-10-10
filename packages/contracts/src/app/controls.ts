import { z } from 'zod';
import { googleTaskProposalSchema } from '../tools/schemas/writes';

const text = z.string();
const count = z.int().nonnegative();
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const appControlRequestIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
export const appControlViewV1Schema = z.enum(['day', 'connections', 'waiting', 'activity', 'profile', 'setup', 'usage', 'files', 'memory', 'spots', 'constellations']);
const activityCursor = z.string().regex(/^[0-9]+$/).refine(value => Number.isSafeInteger(Number(value)) && Number(value) > 0);
export const appControlQueryV1Schema = z.strictObject({ view: appControlViewV1Schema, id: text.max(256).optional(), trace_before: activityCursor.optional(), runs_before: activityCursor.optional() }).superRefine((query, ctx) => {
  if (query.view !== 'activity' && (query.trace_before !== undefined || query.runs_before !== undefined)) ctx.addIssue({ code: 'custom', message: 'Activity cursors require the activity view' });
});
export const appControlActionV1Schema = z.strictObject({
  view: appControlViewV1Schema, action: z.enum(['spot.confirm', 'spot.dismiss', 'spot.forget', 'node.forget', 'timezone.set', 'proactivity.set', 'card.today', 'card.pin', 'card.unpin', 'google.connect', 'google.disconnect', 'session.signout', 'session.signout.all', 'approval.approve', 'approval.skip', 'approval.edit', 'approval.undo', 'file.remove']),
  id: text.max(256).optional(), value: text.max(4096).optional(),
  quiet_start: text.max(5).optional(), quiet_end: text.max(5).optional(), volume: z.enum(['low', 'normal', 'high']).optional(),
  revision, request_id: appControlRequestIdV1Schema,
});

export const appControlDayDataV1Schema = z.strictObject({
  timezone: text, date: text,
  cards: z.array(z.strictObject({ id: text, name: text, defaultTime: text, time: text.nullable(), reason: text, sent: z.boolean(), pin: text.nullable() })),
  proactivity: z.strictObject({ quiet_start: text.nullable(), quiet_end: text.nullable(), volume: z.enum(['low', 'normal', 'high']) }),
  schedules: z.strictObject({ daily_brief: z.boolean(), followups: z.boolean(), event_briefs: z.boolean(), nightly: z.boolean(), heartbeat: z.boolean() }),
});
export const appControlConnectionsDataV1Schema = z.strictObject({
  google: z.strictObject({ connectAvailable: z.boolean(), accounts: z.array(z.strictObject({ id: text, email: text, calendar: z.boolean(), mail: z.boolean(), tasks: z.boolean(), health: z.enum(['needs_reconnect', 'access_granted']) })) }),
  telegram: z.strictObject({ linked: z.boolean(), unlinkAvailable: z.boolean() }),
  sessions: z.strictObject({ until: text, count, items: z.array(z.strictObject({ signed_in: text, until: text, current: z.boolean() })) }),
});
const approvalMetadata = { proposal_digest: revision.optional(), operation_ref: text.optional() };
export const appApprovalReviewV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('email_send'), account: text.optional(), to: z.array(text), cc: z.array(text), bcc: z.array(text), subject: text, body: text, ...approvalMetadata }),
  z.strictObject({ kind: z.literal('message_send'), channel: text, content: text, ...approvalMetadata }),
  z.strictObject({ kind: z.literal('calendar_change'), account: text.optional(), action: z.enum(['create', 'move', 'cancel']), title: text.nullable(), event_id: text.nullable(), start: text.nullable(), end: text.nullable(), reason: text,
    review_timezone: text.optional(), calendar_id: text.optional(), connection_ref: text.optional(), attendees: z.array(text).optional(), send_updates: z.enum(['all', 'externalOnly', 'none']).optional(), description: z.string().max(2000).optional(), location: z.string().max(1000).optional(), seen_etag: text.optional(), ...approvalMetadata }),
  z.strictObject({ kind: z.literal('browser_submit'), url: z.url(),
    action: z.strictObject({ selector: text, description: text, method: text.optional(), arguments: z.array(text).optional() }),
    binding: z.record(z.string(), text), steps: z.array(text),
    request: z.strictObject({ url: z.url(), method: z.literal('POST'), fields: z.array(text) }).optional(), expires_at: count, ...approvalMetadata }),
  z.strictObject({ kind: z.literal('mcp_call'), server: text, tool: text, args: z.record(z.string(), z.json()), expires_at: count, ...approvalMetadata }),
  z.strictObject({ kind: z.literal('google_task_change'), account: text, proposal: googleTaskProposalSchema, proposal_digest: revision }),
]);
export const appControlWaitingDataV1Schema = z.strictObject({
  timezone: text,
  proposals: z.array(z.strictObject({ id: text, kind: text, summary: text, state: z.enum(['open', 'done', 'unconfirmed', 'review_only']), review: appApprovalReviewV1Schema.nullable(), actions: z.array(z.enum(['approval.approve', 'approval.skip', 'approval.edit', 'approval.undo'])) })),
});
const hop = z.strictObject({ hop: text, ok: z.boolean(), ms: z.number(), note: text });
export const appControlActivityDataV1Schema = z.strictObject({
  steps: z.array(z.strictObject({ step: text, state: z.enum(['ok', 'failed', 'unseen']), at: text.nullable(), note: text.nullable() })),
  last_request: z.strictObject({ at: text, ok: z.boolean(), partial: z.boolean(), recorded_steps: count, hops: z.array(hop) }).nullable(),
  trace: z.array(z.strictObject({ time: text, hop: text, ok: z.boolean(), ms: z.number(), summary: text.nullable() })),
  runs: z.array(z.strictObject({ id: text, kind: text, status: text, summary: text.nullable(), started: text, ended: text.nullable() })),
  page: z.strictObject({ trace_before: count.nullable(), runs_before: count.nullable(), trace_applied: count.nullable(), runs_applied: count.nullable() }),
  ledger: text,
});
const removal = z.strictObject({ state: z.enum(['incomplete', 'none_recorded']), pending_count: count });
export const appControlProfileDataV1Schema = z.strictObject({
  sections: z.array(z.strictObject({ title: text, lines: z.array(text) })), barriers: count, removal,
  holds: z.array(z.strictObject({ kind: text, reason: text, created_at: text })),
});
export const appControlSetupDataV1Schema = z.strictObject({ telegram_linked: z.boolean(), google_access_granted: z.boolean(), quiet_hours_set: z.boolean() });
export const appControlUsageDataV1Schema = z.strictObject({ rows: z.array(z.strictObject({ model: text, calls: count, input: count, cached: count, output: count, usd: z.number().nonnegative() })) });
export const appControlFilesDataV1Schema = z.strictObject({ storage: z.literal('telegram_reference'), items: z.array(z.strictObject({ id: z.int(), kind: text, name: text, mime: text.nullable(), size: count.nullable(), caption: text, at: count })) });

const memoryActions = z.array(z.enum(['spot.confirm', 'spot.dismiss', 'spot.forget', 'node.forget']));
const memoryControlRef = z.strictObject({ view: z.literal('memory'), id: text });
export const appMemoryClaimV1Schema = z.strictObject({
  id: text, control_ref: memoryControlRef, kind: text, text, source: text, account: z.null(), source_ref: text.nullable(), evidence: text, origin: text, status: text,
  created_at: text, last_seen_at: text, seen_count: count, learned_at: text.nullable(), valid_from: text.nullable(), valid_to: text.nullable(), supersedes_id: text.nullable(), verification_status: text.nullable(),
});
export const appMemoryInterpretationV1Schema = z.strictObject({
  id: text, control_ref: memoryControlRef, domain: text, label: text, summary: text, strength: z.number(), status: text, first_seen: text, last_confirmed: text,
  supporting_spots: z.array(text).nullable(),
});
const pendingMemory = z.strictObject({ id: text, kind: z.literal('claim'), source: text, origin: text, status: z.literal('purging'), actions: memoryActions });
export const appControlSpotsDataV1Schema = z.strictObject({ items: z.array(appMemoryClaimV1Schema), pending: z.array(pendingMemory), retired_count: count, removal });
export const appControlConstellationsDataV1Schema = z.strictObject({
  nodes: z.array(appMemoryInterpretationV1Schema), edges: z.array(z.strictObject({ from_id: text, to_id: text, relation: text, strength: z.number(), evidence_count: count })), removal,
});
export const appControlMemoryDataV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('index'), spots: appControlSpotsDataV1Schema, constellations: appControlConstellationsDataV1Schema }),
  z.strictObject({ id: text, kind: z.literal('claim'), source: text, origin: text, status: text,
    review: z.strictObject({ label: text, note: text, kind: text, seen: count, last_seen: text }).optional(), actions: memoryActions }),
  z.strictObject({ id: text, kind: z.literal('interpretation'), status: text,
    review: z.strictObject({ label: text, note: text, domain: text, support: text, strength: z.number() }), actions: memoryActions }),
]);
const envelope = { version: z.literal(1), state: z.literal('available'), revision };
export const appControlProjectionV1Schema = z.discriminatedUnion('view', [
  z.strictObject({ ...envelope, view: z.literal('day'), data: appControlDayDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('connections'), data: appControlConnectionsDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('waiting'), data: appControlWaitingDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('activity'), data: appControlActivityDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('profile'), data: appControlProfileDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('setup'), data: appControlSetupDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('usage'), data: appControlUsageDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('files'), data: appControlFilesDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('memory'), data: appControlMemoryDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('spots'), data: appControlSpotsDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('constellations'), data: appControlConstellationsDataV1Schema }),
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
