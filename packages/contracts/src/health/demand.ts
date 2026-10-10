import { z } from 'zod';
import { healthSourceSchema } from '../adapters/health';
import { iso8601Schema } from '../core/error';
import { healthDaySchema, healthRequestIdSchema, healthTimezoneSchema } from './ingest';

// Internal signed producer DTOs. No app route accepts provider-derived demand.
// Source/query evidence is assembled by the authenticated owner host after its
// actual provider or responsibility reads and source-current checks.
const reference = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const healthDemandMetricSchema = z.enum(['calendar_minutes', 'task_minutes', 'message_count']);
const common = {
  source_ref: reference, context_ref: reference,
  day: healthDaySchema, timezone: healthTimezoneSchema,
  observed_at: iso8601Schema, queried_at: iso8601Schema,
  revision: z.int().nonnegative(),
  query_complete: z.boolean(), evidence_ref: reference,
  missing_reason: z.enum(['source_unavailable', 'incomplete_query', 'missing_owner_estimates', 'unknown_responsibility_state']).nullable(),
  connection_refs: z.array(z.uuid()).max(32),
};
export const healthDemandObservationSchema = z.discriminatedUnion('metric', [
  z.strictObject({ ...common, metric: z.literal('calendar_minutes'), unit: z.literal('minutes'), method: z.literal('union_busy_minutes'), supplier: z.literal('google_calendar'), value: z.number().finite().min(0).max(2880).nullable() }),
  z.strictObject({ ...common, metric: z.literal('task_minutes'), unit: z.literal('minutes'), method: z.literal('owner_estimated_due_minutes'), supplier: z.enum(['google_tasks', 'owner_work']), estimate_refs: z.array(reference).max(128), value: z.number().finite().min(0).max(10080).nullable() }),
  z.strictObject({ ...common, metric: z.literal('message_count'), unit: z.literal('count'), method: z.literal('requires_owner_response_count'), supplier: z.literal('responsibilities'), value: z.int().min(0).max(100000).nullable() }),
]).superRefine((observation, context) => {
  if (Date.parse(observation.observed_at) > Date.parse(observation.queried_at)) context.addIssue({ code: 'custom', message: 'invalid observation time' });
  if (observation.value === null ? observation.missing_reason === null : !observation.query_complete || observation.missing_reason !== null) context.addIssue({ code: 'custom', message: 'missing complete evidence' });
  if ((observation.supplier === 'google_calendar' || observation.supplier === 'google_tasks') && observation.connection_refs.length === 0) context.addIssue({ code: 'custom', message: 'missing account scope' });
  if (observation.metric === 'task_minutes' && observation.value !== null && observation.value > 0 && observation.estimate_refs.length === 0) context.addIssue({ code: 'custom', message: 'missing owner estimate evidence' });
});
export type HealthDemandObservation = z.infer<typeof healthDemandObservationSchema>;
export const healthDemandRecordSchema = z.strictObject({
  request_id: healthRequestIdSchema, source: healthSourceSchema,
  consent_epoch: z.int().positive(), observations: z.array(healthDemandObservationSchema).min(1).max(90),
});
export type HealthDemandRecord = z.infer<typeof healthDemandRecordSchema>;
export const healthDemandQuerySchema = z.strictObject({
  source: healthSourceSchema, consent_epoch: z.int().positive(), metric: healthDemandMetricSchema,
  source_ref: reference, context_ref: reference,
  from: healthDaySchema, to: healthDaySchema,
}).refine(query => query.from <= query.to && Date.parse(query.to) - Date.parse(query.from) <= 89 * 86400000, 'invalid demand range');
export type HealthDemandQuery = z.infer<typeof healthDemandQuerySchema>;
export const healthDemandReceiptSchema = z.strictObject({
  request_id: healthRequestIdSchema, source: healthSourceSchema, consent_epoch: z.int().positive(),
  accepted: z.int().nonnegative(), ignored: z.int().nonnegative(), replayed: z.boolean(),
});
export const healthDemandReadSchema = z.strictObject({
  source: healthSourceSchema, consent_epoch: z.int().positive(), observations: z.array(healthDemandObservationSchema).max(90),
});
export const healthDemandRetentionSchema = z.strictObject({ deleted: z.int().nonnegative() });
