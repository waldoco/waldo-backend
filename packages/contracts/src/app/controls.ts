import { z } from 'zod';

const text = z.string();
const count = z.int().nonnegative();
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const appControlRequestIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
export const appControlViewV1Schema = z.enum(['day', 'connections', 'activity']);
const activityCursor = z.string().regex(/^[0-9]+$/).refine(value => Number.isSafeInteger(Number(value)) && Number(value) > 0);
export const appControlQueryV1Schema = z.strictObject({ view: appControlViewV1Schema, trace_before: activityCursor.optional(), runs_before: activityCursor.optional() }).superRefine((query, ctx) => {
  if (query.view !== 'activity' && (query.trace_before !== undefined || query.runs_before !== undefined)) ctx.addIssue({ code: 'custom', message: 'Activity cursors require the activity view' });
});
export const appControlActionV1Schema = z.strictObject({
  view: appControlViewV1Schema, action: z.enum(['timezone.set', 'proactivity.set']),
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
const hop = z.strictObject({ hop: text, ok: z.boolean(), ms: z.number(), note: text });
export const appControlActivityDataV1Schema = z.strictObject({
  steps: z.array(z.strictObject({ step: text, state: z.enum(['ok', 'failed', 'unseen']), at: text.nullable(), note: text.nullable() })),
  last_request: z.strictObject({ at: text, ok: z.boolean(), partial: z.boolean(), recorded_steps: count, hops: z.array(hop) }).nullable(),
  trace: z.array(z.strictObject({ time: text, hop: text, ok: z.boolean(), ms: z.number(), summary: text.nullable() })),
  runs: z.array(z.strictObject({ id: text, kind: text, status: text, summary: text.nullable(), started: text, ended: text.nullable() })),
  page: z.strictObject({ trace_before: count.nullable(), runs_before: count.nullable(), trace_applied: count.nullable(), runs_applied: count.nullable() }),
  ledger: text,
});
const envelope = { version: z.literal(1), state: z.literal('available'), revision };
export const appControlProjectionV1Schema = z.discriminatedUnion('view', [
  z.strictObject({ ...envelope, view: z.literal('day'), data: appControlDayDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('connections'), data: appControlConnectionsDataV1Schema }),
  z.strictObject({ ...envelope, view: z.literal('activity'), data: appControlActivityDataV1Schema }),
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
