import { z } from 'zod';
import { errorCodeSchema } from '../core/error';
import { triggerTypeSchema } from '../core/trigger';
import {
  sanitiseDestinationSchema,
  sanitiseFailureReasonSchema,
} from '../memory/sanitise';
import { modelNameSchema } from '../model/roster';
import { toolNameSchema } from '../tools/permissions';
import {
  deliveryGateReasonSchema,
  deliveryVerdictSchema,
} from './delivery-policy';
import { runStateSchema } from './journal';
import { loopDispositionSchema, loopTypeSchema } from './loop-policy';
import { outboxStatusSchema } from './outbox';
import { pushClassSchema } from './push-class';
import {
  runtimeGovernorDenyReasonSchema,
  runtimeOperationalRefSchema,
  runtimeRunFailureReasonSchema,
  runtimeRunFallbackStepSchema,
  runtimeRunCanAdvance,
  runtimeRunStateSchema,
  runtimeToolDispatchFailureReasonSchema,
} from './run';

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

export const runtimeTraceEventNameSchema = z.enum([
  'scheduled_wake',
  'governor_admitted',
  'governor_denied',
  'session_reset',
  'context_built',
  'llm_called',
  'llm_observed',
  'tool_parse_failed',
  'tool_dispatched',
  'gated',
  'delivered',
  'done',
  'failed',
  'scribe_denied',
]);
export type RuntimeTraceEventName = z.infer<typeof runtimeTraceEventNameSchema>;

const deliveryTextSourceSchema = z.enum(['fallback', 'llm']);

const scheduledWakeDetailSchema = z.strictObject({
  schedule_ref: runtimeOperationalRefSchema,
  occurrence_at: z.int().nonnegative(),
  trigger: triggerTypeSchema,
});
const governorAdmittedDetailSchema = z.strictObject({
  loop_type: loopTypeSchema,
});
const governorDeniedDetailSchema = z.strictObject({
  reason: runtimeGovernorDenyReasonSchema,
  disposition: loopDispositionSchema.nullable(),
});
const sessionResetDetailSchema = z.strictObject({
  started_at: z.int().nonnegative(),
  tool_count: z.int().nonnegative().max(toolNameSchema.options.length),
});
const contextBuiltDetailSchema = z.strictObject({
  source: z.literal('fake-derived'),
});
const llmCalledDetailSchema = z.strictObject({
  model: modelNameSchema,
  fallback_step: runtimeRunFallbackStepSchema,
  tool_call_count: z.int().nonnegative().max(16),
});
const llmObservedDetailSchema = z.strictObject({
  model: modelNameSchema,
  fallback_step: runtimeRunFallbackStepSchema,
  delivery_text_source: deliveryTextSourceSchema,
});
const toolParseFailedDetailSchema = z.strictObject({
  code: errorCodeSchema,
});
const toolDispatchedDetailSchema = z
  .strictObject({
    tools: z.array(toolNameSchema).max(16),
    denied: z.array(toolNameSchema).max(16),
    reasons: z.array(runtimeToolDispatchFailureReasonSchema).max(16).optional(),
  })
  .refine(
    (detail) =>
      detail.denied.length === 0
        ? detail.reasons === undefined
        : detail.reasons?.length === detail.denied.length,
    {
      error: 'denied tools require one finite reason per tool',
      path: ['reasons'],
    },
  );
const gatedDetailSchema = z.union([
  z.strictObject({
    verdict: z.enum(['send', 'degrade']),
    outbox_kind: pushClassSchema,
    delivery_text_source: deliveryTextSourceSchema,
  }),
  z.strictObject({
    verdict: z.enum(['hold', 'drop']),
    reason: deliveryGateReasonSchema,
    delivery_text_source: deliveryTextSourceSchema,
  }),
]);
const deliveredDetailSchema = z.strictObject({
  sink: z.literal('fake'),
  status: z.literal('acked'),
});
const doneDetailSchema = z.strictObject({ terminal: z.literal(true) });
const failedDetailSchema = z.strictObject({
  reason: z.union([runtimeRunFailureReasonSchema, z.literal('unknown')]),
});
const scribeDeniedDetailSchema = z.strictObject({
  destination: sanitiseDestinationSchema,
  reason: sanitiseFailureReasonSchema,
});

export const runtimeTraceDetailSchema = z.union([
  scheduledWakeDetailSchema,
  governorAdmittedDetailSchema,
  governorDeniedDetailSchema,
  sessionResetDetailSchema,
  contextBuiltDetailSchema,
  llmCalledDetailSchema,
  llmObservedDetailSchema,
  toolParseFailedDetailSchema,
  toolDispatchedDetailSchema,
  gatedDetailSchema,
  deliveredDetailSchema,
  doneDetailSchema,
  failedDetailSchema,
  scribeDeniedDetailSchema,
]);
export type RuntimeTraceDetail = z.infer<typeof runtimeTraceDetailSchema>;

const detailEnvelope = <Event extends RuntimeTraceEventName, Detail extends z.ZodType>(
  event: Event,
  detail: Detail,
) => z.strictObject({ event: z.literal(event), detail });

export const runtimeTraceDetailEnvelopeSchema = z.discriminatedUnion('event', [
  detailEnvelope('scheduled_wake', scheduledWakeDetailSchema),
  detailEnvelope('governor_admitted', governorAdmittedDetailSchema),
  detailEnvelope('governor_denied', governorDeniedDetailSchema),
  detailEnvelope('session_reset', sessionResetDetailSchema),
  detailEnvelope('context_built', contextBuiltDetailSchema),
  detailEnvelope('llm_called', llmCalledDetailSchema),
  detailEnvelope('llm_observed', llmObservedDetailSchema),
  detailEnvelope('tool_parse_failed', toolParseFailedDetailSchema),
  detailEnvelope('tool_dispatched', toolDispatchedDetailSchema),
  detailEnvelope('gated', gatedDetailSchema),
  detailEnvelope('delivered', deliveredDetailSchema),
  detailEnvelope('done', doneDetailSchema),
  detailEnvelope('failed', failedDetailSchema),
  detailEnvelope('scribe_denied', scribeDeniedDetailSchema),
]);
export type RuntimeTraceDetailEnvelope = z.infer<
  typeof runtimeTraceDetailEnvelopeSchema
>;

export function parseRuntimeTraceDetail(
  event: RuntimeTraceEventName,
  detail: unknown,
): RuntimeTraceDetail {
  return runtimeTraceDetailEnvelopeSchema.parse({ event, detail }).detail;
}

const traceEventBaseShape = {
  schema_version: z.literal(RUNTIME_EVIDENCE_SCHEMA_VERSION),
  trace_id: runtimeOperationalRefSchema,
  run_id: runtimeOperationalRefSchema,
  seq: z.int().nonnegative(),
  event_key: z.string().min(1).max(512),
  occurred_at: z.int().nonnegative(),
} as const;

const traceEvent = <
  Event extends RuntimeTraceEventName,
  Family extends RuntimeTraceFamily,
  Privacy extends RuntimeTracePrivacy,
  Status extends z.ZodType,
  Detail extends z.ZodType,
>(
  event: Event,
  family: Family,
  privacy: Privacy,
  status: Status,
  detail: Detail,
) =>
  z.strictObject({
    ...traceEventBaseShape,
    event: z.literal(event),
    family: z.literal(family),
    status,
    privacy: z.literal(privacy),
    detail,
  });

export const runtimeTraceEventSchema = z
  .discriminatedUnion('event', [
    traceEvent(
      'scheduled_wake',
      'wake',
      'operational_ref',
      z.literal('scheduled'),
      scheduledWakeDetailSchema,
    ),
    traceEvent(
      'governor_admitted',
      'governor',
      'policy_metadata',
      z.literal('admitted'),
      governorAdmittedDetailSchema,
    ),
    traceEvent(
      'governor_denied',
      'governor',
      'policy_metadata',
      z.literal('denied'),
      governorDeniedDetailSchema,
    ),
    traceEvent(
      'session_reset',
      'session',
      'operational_metadata',
      z.literal('ok'),
      sessionResetDetailSchema,
    ),
    traceEvent(
      'context_built',
      'context',
      'derived_summary',
      z.literal('ok'),
      contextBuiltDetailSchema,
    ),
    traceEvent(
      'llm_called',
      'llm',
      'operational_metadata',
      z.literal('ok'),
      llmCalledDetailSchema,
    ),
    traceEvent(
      'llm_observed',
      'llm',
      'operational_metadata',
      z.literal('ok'),
      llmObservedDetailSchema,
    ),
    traceEvent(
      'tool_parse_failed',
      'tool',
      'operational_metadata',
      z.literal('failed'),
      toolParseFailedDetailSchema,
    ),
    traceEvent(
      'tool_dispatched',
      'tool',
      'operational_metadata',
      z.enum(['ok', 'denied']),
      toolDispatchedDetailSchema,
    ),
    traceEvent(
      'gated',
      'gate',
      'policy_metadata',
      z.enum(['send', 'ok']),
      gatedDetailSchema,
    ),
    traceEvent(
      'delivered',
      'delivery',
      'operational_metadata',
      z.literal('acked'),
      deliveredDetailSchema,
    ),
    traceEvent(
      'done',
      'outcome',
      'operational_metadata',
      z.literal('done'),
      doneDetailSchema,
    ),
    traceEvent(
      'failed',
      'outcome',
      'operational_metadata',
      z.literal('failed'),
      failedDetailSchema,
    ),
    traceEvent(
      'scribe_denied',
      'outcome',
      'policy_metadata',
      z.literal('denied'),
      scribeDeniedDetailSchema,
    ),
  ])
  .refine(
    (event) =>
      event.event !== 'tool_dispatched' ||
      event.status === (event.detail.denied.length > 0 ? 'denied' : 'ok'),
    { error: 'tool status must match denied results', path: ['status'] },
  )
  .refine(
    (event) =>
      event.event !== 'gated' ||
      event.status === (event.detail.verdict === 'send' ? 'send' : 'ok'),
    { error: 'gate status must match its verdict', path: ['status'] },
  )
  .refine(
    (event) => event.trace_id === event.run_id,
    { error: 'runtime trace and run ids must match', path: ['run_id'] },
  )
  .refine(
    (event) =>
      event.event_key ===
      `${event.run_id}:${event.family}:${event.event}:${event.seq}`,
    { error: 'runtime event key must use the canonical run/family/event/seq form', path: ['event_key'] },
  );
export type RuntimeTraceEvent = z.infer<typeof runtimeTraceEventSchema>;

export const runtimeTraceEvalRuleIdSchema = z.enum([
  'trace_order',
  'terminal_visible',
  'privacy_guard',
  'outbox_consistency',
  'failure_visible',
]);
export const runtimeTraceEvalEvidenceSchema = z.enum([
  'trace sequence is monotonic and starts with scheduled_wake',
  'trace sequence is missing its wake prefix or monotonic ordering',
  'terminal runtime state is visible in trace evidence',
  'terminal runtime state is not visible in trace evidence',
  'trace details match the closed event schemas',
  'trace details do not match the closed event schemas',
  'terminal delivery evidence is consistent with outbox state',
  'done run lacks acked outbox or delivery evidence',
  'failed runs carry a terminal reason or denial evidence',
  'failed run lacks terminal failure evidence',
  'rule was not observed',
]);
const evalRuleSchema = <
  Id extends z.infer<typeof runtimeTraceEvalRuleIdSchema>,
  Pass extends z.infer<typeof runtimeTraceEvalEvidenceSchema>,
  Fail extends z.infer<typeof runtimeTraceEvalEvidenceSchema>,
>(id: Id, pass: Pass, fail: Fail) =>
  z.discriminatedUnion('status', [
    z.strictObject({ id: z.literal(id), status: z.literal('pass'), evidence: z.literal(pass) }),
    z.strictObject({ id: z.literal(id), status: z.literal('fail'), evidence: z.literal(fail) }),
    z.strictObject({
      id: z.literal(id),
      status: z.literal('not_observed'),
      evidence: z.literal('rule was not observed'),
    }),
  ]);

export const runtimeTraceEvalRuleSchema = z.discriminatedUnion('id', [
  evalRuleSchema(
    'trace_order',
    'trace sequence is monotonic and starts with scheduled_wake',
    'trace sequence is missing its wake prefix or monotonic ordering',
  ),
  evalRuleSchema(
    'terminal_visible',
    'terminal runtime state is visible in trace evidence',
    'terminal runtime state is not visible in trace evidence',
  ),
  evalRuleSchema(
    'privacy_guard',
    'trace details match the closed event schemas',
    'trace details do not match the closed event schemas',
  ),
  evalRuleSchema(
    'outbox_consistency',
    'terminal delivery evidence is consistent with outbox state',
    'done run lacks acked outbox or delivery evidence',
  ),
  evalRuleSchema(
    'failure_visible',
    'failed runs carry a terminal reason or denial evidence',
    'failed run lacks terminal failure evidence',
  ),
]);
export type RuntimeTraceEvalRule = z.infer<typeof runtimeTraceEvalRuleSchema>;

export const runtimeTraceEvalSchema = z
  .strictObject({
    schema_version: z.literal(RUNTIME_EVIDENCE_SCHEMA_VERSION),
    trace_id: runtimeOperationalRefSchema,
    run_id: runtimeOperationalRefSchema,
    result: z.enum(['pass', 'fail', 'needs_review']),
    rules: z.array(runtimeTraceEvalRuleSchema).length(runtimeTraceEvalRuleIdSchema.options.length),
    wis: z.strictObject({
      available: z.literal(false),
      reason: z.literal('not_observed_fake_first'),
    }),
  })
  .refine((evaluation) => evaluation.trace_id === evaluation.run_id, {
    error: 'runtime eval trace and run ids must match',
    path: ['run_id'],
  })
  .refine(
    (evaluation) =>
      new Set(evaluation.rules.map((rule) => rule.id)).size ===
        runtimeTraceEvalRuleIdSchema.options.length &&
      runtimeTraceEvalRuleIdSchema.options.every((id) =>
        evaluation.rules.some((rule) => rule.id === id),
      ),
    { error: 'runtime eval must contain each rule exactly once', path: ['rules'] },
  )
  .refine(
    (evaluation) => {
      const expected = evaluation.rules.some((rule) => rule.status === 'fail')
        ? 'fail'
        : evaluation.rules.some((rule) => rule.status === 'not_observed')
          ? 'needs_review'
          : 'pass';
      return evaluation.result === expected;
    },
    { error: 'runtime eval result must be derived from rule statuses', path: ['result'] },
  );
export type RuntimeTraceEval = z.infer<typeof runtimeTraceEvalSchema>;

export const runtimeReplayFixtureSchema = z
  .strictObject({
    schema_version: z.literal(RUNTIME_EVIDENCE_SCHEMA_VERSION),
    fixture_id: runtimeOperationalRefSchema,
    source_trace_id: runtimeOperationalRefSchema,
    hermetic: z.literal(true),
    live_provider: z.literal(false),
    trace: z.array(runtimeTraceEventSchema).max(256),
    fsm: z.array(runtimeRunStateSchema).max(64),
    outbox: z
      .array(
        z.strictObject({
          kind: pushClassSchema,
          status: outboxStatusSchema,
          attempts: z.int().nonnegative(),
        }),
      )
      .max(16),
    delivery_journal: z.strictObject({
      state: runStateSchema,
      verdict: deliveryVerdictSchema.nullable(),
    }),
    current: z.strictObject({
      state: runtimeRunStateSchema,
      failure_reason: runtimeRunFailureReasonSchema.nullable(),
    }),
    eval: runtimeTraceEvalSchema,
  })
  .refine((fixture) => fixture.trace.every(
    (event) =>
      event.trace_id === fixture.source_trace_id && event.run_id === fixture.source_trace_id,
  ), {
    error: 'fixture trace events must share the source trace and run id',
    path: ['trace'],
  })
  .refine(
    (fixture) =>
      fixture.eval.trace_id === fixture.source_trace_id &&
      fixture.eval.run_id === fixture.source_trace_id,
    {
    error: 'fixture eval must share the source trace and run id',
    path: ['eval'],
    },
  )
  .refine(
    (fixture) =>
      (fixture.current.state === 'FAILED') === (fixture.current.failure_reason !== null),
    {
      error: 'fixture failure reason is required only for FAILED runs',
      path: ['current', 'failure_reason'],
    },
  )
  .refine(
    (fixture) =>
      fixture.fsm.length > 0 &&
      fixture.fsm.at(-1) === fixture.current.state &&
      fixture.fsm.every(
        (state, index) => index === 0 || runtimeRunCanAdvance(fixture.fsm[index - 1]!, state),
      ),
    {
      error: 'fixture FSM must contain legal transitions ending at current state',
      path: ['fsm'],
    },
  )
  .refine(
    (fixture) =>
      fixture.current.state !== 'DONE' ||
      (fixture.trace.some((event) => event.event === 'done') &&
        fixture.trace.some((event) => event.event === 'delivered') &&
        fixture.outbox.some((row) => row.status === 'acked')),
    {
      error: 'DONE fixtures require done, delivery, and acked outbox evidence',
      path: ['current'],
    },
  )
  .refine(
    (fixture) =>
      fixture.current.state !== 'FAILED' ||
      fixture.trace.some((event) => event.event === 'failed'),
    {
      error: 'FAILED fixtures require a terminal failed trace event',
      path: ['trace'],
    },
  )
  .refine(
    (fixture) => {
      const traceOrderOk = fixture.trace.every(
        (event, index) => index === 0 || event.seq > fixture.trace[index - 1]!.seq,
      );
      const expected: Record<z.infer<typeof runtimeTraceEvalRuleIdSchema>, 'pass' | 'fail'> = {
        trace_order:
          traceOrderOk && fixture.trace[0]?.event === 'scheduled_wake' ? 'pass' : 'fail',
        terminal_visible:
          fixture.current.state === 'DONE'
            ? fixture.trace.some((event) => event.event === 'done') ? 'pass' : 'fail'
            : fixture.trace.some((event) => event.event === 'failed') ? 'pass' : 'fail',
        privacy_guard: fixture.trace.every((event) =>
          runtimeTraceDetailSchema.safeParse(event.detail).success,
        ) ? 'pass' : 'fail',
        outbox_consistency:
          fixture.current.state !== 'DONE' ||
          (fixture.outbox.some((row) => row.status === 'acked') &&
            fixture.trace.some((event) => event.event === 'delivered'))
            ? 'pass'
            : 'fail',
        failure_visible:
          fixture.current.state !== 'FAILED' ||
          (fixture.current.failure_reason !== null &&
            fixture.trace.some((event) => event.event === 'failed'))
            ? 'pass'
            : 'fail',
      };
      return fixture.eval.rules.every((rule) => rule.status === expected[rule.id]);
    },
    {
      error: 'fixture eval rules must be derived from fixture facts',
      path: ['eval', 'rules'],
    },
  );
export type RuntimeReplayFixture = z.infer<typeof runtimeReplayFixtureSchema>;

export function traceDetailKeysArePublic(value: unknown): boolean {
  return runtimeTraceDetailSchema.safeParse(value).success;
}
