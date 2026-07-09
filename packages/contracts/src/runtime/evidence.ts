import { z } from 'zod';
import { runtimeRunStateSchema } from './run';
import { outboxStatusSchema } from './outbox';
import { pushClassSchema } from './push-class';
import { runStateSchema } from './journal';

export const RUNTIME_EVIDENCE_SCHEMA_VERSION = 1 as const;

export const runtimeTraceFamilySchema = z.enum([
  'wake',
  'governor',
  'session',
  'context',
  'llm',
  'tool',
  'gate',
  'outbox',
  'delivery',
  'outcome',
]);
export type RuntimeTraceFamily = z.infer<typeof runtimeTraceFamilySchema>;

export const runtimeTracePrivacySchema = z.enum([
  'operational_ref',
  'operational_metadata',
  'policy_metadata',
  'derived_summary',
]);
export type RuntimeTracePrivacy = z.infer<typeof runtimeTracePrivacySchema>;

export const runtimeTraceStatusSchema = z.enum([
  'scheduled',
  'admitted',
  'denied',
  'ok',
  'failed',
  'send',
  'acked',
  'done',
  'not_observed',
]);
export type RuntimeTraceStatus = z.infer<typeof runtimeTraceStatusSchema>;

const forbiddenTraceDetailKeys = new Set([
  'access_token',
  'auth_header',
  'authorization',
  'cookie',
  'credentials',
  'full_body',
  'prompt',
  'provider_body',
  'raw_health',
  'refresh_token',
  'request_body',
  'response_body',
  'secret',
  'token',
]);
const forbiddenTraceDetailKeyFragments = ['token', 'cookie', 'secret', 'credential'] as const;

const traceDetailValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(traceDetailValueSchema),
    z.record(z.string(), traceDetailValueSchema),
  ]),
);

export const runtimeTraceDetailSchema = z
  .record(z.string(), traceDetailValueSchema)
  .refine((detail) => traceDetailKeysArePublic(detail), {
    error: 'trace detail must not carry private payload fields',
  });
export type RuntimeTraceDetail = z.infer<typeof runtimeTraceDetailSchema>;

export const runtimeTraceEventSchema = z.strictObject({
  schema_version: z.literal(RUNTIME_EVIDENCE_SCHEMA_VERSION),
  trace_id: z.string().min(1),
  run_id: z.string().min(1),
  seq: z.int().nonnegative(),
  event_key: z.string().min(1),
  family: runtimeTraceFamilySchema,
  event: z.string().min(1),
  status: runtimeTraceStatusSchema,
  privacy: runtimeTracePrivacySchema,
  detail: runtimeTraceDetailSchema,
  occurred_at: z.int().nonnegative(),
});
export type RuntimeTraceEvent = z.infer<typeof runtimeTraceEventSchema>;

export const runtimeTraceEvalRuleSchema = z.strictObject({
  id: z.string().min(1),
  status: z.enum(['pass', 'fail', 'not_observed']),
  evidence: z.string().min(1),
});
export type RuntimeTraceEvalRule = z.infer<typeof runtimeTraceEvalRuleSchema>;

export const runtimeTraceEvalSchema = z.strictObject({
  schema_version: z.literal(RUNTIME_EVIDENCE_SCHEMA_VERSION),
  trace_id: z.string().min(1),
  run_id: z.string().min(1),
  result: z.enum(['pass', 'fail', 'needs_review']),
  rules: z.array(runtimeTraceEvalRuleSchema),
  wis: z.strictObject({
    available: z.literal(false),
    reason: z.literal('not_observed_fake_first'),
  }),
});
export type RuntimeTraceEval = z.infer<typeof runtimeTraceEvalSchema>;

export const runtimeReplayFixtureSchema = z
  .strictObject({
    schema_version: z.literal(RUNTIME_EVIDENCE_SCHEMA_VERSION),
    fixture_id: z.string().min(1),
    source_trace_id: z.string().min(1),
    hermetic: z.literal(true),
    live_provider: z.literal(false),
    trace: z.array(runtimeTraceEventSchema),
    fsm: z.array(runtimeRunStateSchema),
    outbox: z.array(
      z.strictObject({
        kind: pushClassSchema,
        status: outboxStatusSchema,
        attempts: z.int().nonnegative(),
      }),
    ),
    delivery_journal: z.strictObject({
      state: runStateSchema,
      verdict: z.enum(['send', 'degrade', 'hold', 'drop']).nullable(),
    }),
    current: z.strictObject({
      state: runtimeRunStateSchema,
      failure_reason: z.string().min(1).nullable(),
    }),
    eval: runtimeTraceEvalSchema,
  })
  .refine((fixture) => fixture.trace.every((event) => event.trace_id === fixture.source_trace_id), {
    error: 'fixture trace events must share the source trace id',
    path: ['trace'],
  })
  .refine((fixture) => fixture.eval.trace_id === fixture.source_trace_id, {
    error: 'fixture eval must share the source trace id',
    path: ['eval'],
  });
export type RuntimeReplayFixture = z.infer<typeof runtimeReplayFixtureSchema>;

export function traceDetailKeysArePublic(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every((item) => traceDetailKeysArePublic(item));
  }
  if (value === null || typeof value !== 'object') {
    return true;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      forbiddenTraceDetailKeys.has(normalizedKey) ||
      forbiddenTraceDetailKeyFragments.some((fragment) => normalizedKey.includes(fragment))
    ) {
      return false;
    }
    if (!traceDetailKeysArePublic(child)) {
      return false;
    }
  }
  return true;
}
