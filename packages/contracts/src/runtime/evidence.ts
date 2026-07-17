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
import { journalCompletionModeSchema, runStateSchema, type JournalCompletionMode } from './journal';
import { loopDispositionSchema, loopTypeSchema } from './loop-policy';
import { outboxStatusSchema } from './outbox';
import { pushClassSchema } from './push-class';
import { routingLogEventSchema } from './routing';
import {
  runtimeGovernorDenyReasonSchema,
  runtimeOperationalRefSchema,
  runtimeRunFailureReasonSchema,
  runtimeRunFallbackStepSchema,
  runtimeRunCanAdvance,
  runtimeRunStateSchema,
  runtimeToolDispatchFailureReasonSchema,
} from './run';
import { invocationOutputDispositionKindSchema } from './invocation';

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
  'provider_effect_rejected',
  'tool_parse_failed',
  'tool_dispatched',
  'egress_checked',
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
const contextBuiltDetailSchema = z.union([
  z.strictObject({
    source: z.literal('fake-derived'),
  }),
  z.strictObject({
    source: z.literal('context-composer-v2'),
    context_ref: runtimeOperationalRefSchema,
    source_count: z.int().positive().max(32),
    source_taint: z.enum(['external']).nullable(),
  }),
]);
const routingLogsSchema = z.array(routingLogEventSchema).max(2);
const llmCalledDetailSchema = z.strictObject({
  model: modelNameSchema,
  fallback_step: runtimeRunFallbackStepSchema,
  tool_call_count: z.int().nonnegative().max(16),
  routing_logs: routingLogsSchema.optional(),
});
const llmObservedDetailSchema = z.union([
  z.strictObject({
    model: modelNameSchema,
    fallback_step: runtimeRunFallbackStepSchema,
    delivery_text_source: deliveryTextSourceSchema,
    routing_logs: routingLogsSchema.optional(),
  }),
  z.strictObject({
    model: modelNameSchema,
    fallback_step: runtimeRunFallbackStepSchema,
    output_disposition: invocationOutputDispositionKindSchema,
    routing_logs: routingLogsSchema.optional(),
  }),
]);
const providerEffectRejectedDetailSchema = z.strictObject({
  phase: z.enum(['provider_plan', 'provider_observe']),
  outcome: z.enum(['post_hook_rejected', 'invalid_response']),
  fallback_step: runtimeRunFallbackStepSchema,
  routing_logs: routingLogsSchema.optional(),
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
const egressCheckedDetailSchema = z.strictObject({
  disposition: z.literal('solicited_reply'),
  verdict: z.enum(['admit', 'deny']),
  reason: z.union([z.literal('policy_admitted'), runtimeGovernorDenyReasonSchema]),
});
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
const doneDetailSchema = z.union([
  z.strictObject({ terminal: z.literal(true) }),
  z.strictObject({
    terminal: z.literal(true),
    disposition: invocationOutputDispositionKindSchema,
  }),
]);
const failedDetailSchema = z.strictObject({
  reason: z.union([runtimeRunFailureReasonSchema, z.literal('unknown')]),
  fallback_step: runtimeRunFallbackStepSchema.optional(),
  routing_logs: routingLogsSchema.optional(),
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
  providerEffectRejectedDetailSchema,
  toolParseFailedDetailSchema,
  toolDispatchedDetailSchema,
  egressCheckedDetailSchema,
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
  detailEnvelope('provider_effect_rejected', providerEffectRejectedDetailSchema),
  detailEnvelope('tool_parse_failed', toolParseFailedDetailSchema),
  detailEnvelope('tool_dispatched', toolDispatchedDetailSchema),
  detailEnvelope('egress_checked', egressCheckedDetailSchema),
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
      'provider_effect_rejected',
      'llm',
      'operational_metadata',
      z.literal('failed'),
      providerEffectRejectedDetailSchema,
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
      'egress_checked',
      'governor',
      'policy_metadata',
      z.enum(['ok', 'denied']),
      egressCheckedDetailSchema,
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
    (event) =>
      event.event !== 'egress_checked' ||
      event.status === (event.detail.verdict === 'deny' ? 'denied' : 'ok'),
    { error: 'egress status must match its Governor verdict', path: ['status'] },
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
  'terminal completion evidence is consistent with output disposition',
  'done run has inconsistent output disposition evidence',
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

const outboxConsistencyRuleSchema = z.union([
  evalRuleSchema(
    'outbox_consistency',
    'terminal delivery evidence is consistent with outbox state',
    'done run lacks acked outbox or delivery evidence',
  ),
  evalRuleSchema(
    'outbox_consistency',
    'terminal completion evidence is consistent with output disposition',
    'done run has inconsistent output disposition evidence',
  ),
]);

export const runtimeTraceEvalRuleSchema = z.union([
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
  outboxConsistencyRuleSchema,
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

// Historical replay fixtures predate trusted invocation markers. New fixtures carry their
// immutable runtime flavor so a damaged V2 trace cannot be interpreted as a V1 reader record.
export const runtimeEvidenceFlavorSchema = z.enum(['historical_v1', 'trusted_v2']);
export type RuntimeEvidenceFlavor = z.infer<typeof runtimeEvidenceFlavorSchema>;

export const runtimeReplayFixtureSchema = z
  .strictObject({
    schema_version: z.literal(RUNTIME_EVIDENCE_SCHEMA_VERSION),
    fixture_id: runtimeOperationalRefSchema,
    source_trace_id: runtimeOperationalRefSchema,
    hermetic: z.literal(true),
    live_provider: z.literal(false),
    evidence_flavor: runtimeEvidenceFlavorSchema.default('historical_v1'),
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
      completion_mode: journalCompletionModeSchema.nullable().default(null),
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
        (state, index) =>
          index === 0 || fixtureFsmCanAdvance(fixture, fixture.fsm[index - 1]!, state),
      ),
    {
      error: 'fixture FSM must contain legal transitions ending at current state',
      path: ['fsm'],
    },
  )
  .refine(
    (fixture) =>
      !fixture.fsm.some(
        (state, index) => index > 0 && fixture.fsm[index - 1] === 'DONE' && state === 'FAILED',
      ) ||
      (fixture.current.failure_reason === 'replay:artifact_invalid' &&
        runtimeDoneEvidenceMatchesDisposition(
          fixture.trace,
          fixture.outbox,
          fixture.delivery_journal,
          fixture.evidence_flavor,
        )),
    {
      error: 'post-DONE integrity failures require intact completion evidence',
      path: ['fsm'],
    },
  )
  .refine(
    (fixture) =>
      fixture.current.state === 'DONE' || fixture.current.state === 'FAILED'
        ? runtimeTerminalEvidenceMatchesDisposition(
            fixture.trace,
            fixture.outbox,
            fixture.delivery_journal,
            fixture.current.state,
            fixture.evidence_flavor,
          )
        : true,
    {
      error: 'terminal fixtures require disposition-consistent journal and delivery evidence',
      path: ['current'],
    },
  )
  .refine(
    (fixture) =>
      !requiresV2DispositionEvidence(fixture.trace, fixture.evidence_flavor) ||
      fixture.eval.rules.some(
        (rule) =>
          rule.id === 'outbox_consistency' &&
          (rule.evidence === 'terminal completion evidence is consistent with output disposition' ||
            rule.evidence === 'done run has inconsistent output disposition evidence'),
      ),
    {
      error: 'explicit V2 fixtures require disposition-aware outbox evaluation evidence',
      path: ['eval', 'rules'],
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
          fixture.current.state === 'DONE' || fixture.current.state === 'FAILED'
            ? runtimeTerminalEvidenceMatchesDisposition(
                fixture.trace,
                fixture.outbox,
                fixture.delivery_journal,
                fixture.current.state,
                fixture.evidence_flavor,
              )
              ? 'pass'
              : 'fail'
            : 'pass',
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

// Terminal evidence carries the output contract across both normal completion and typed failure.
// V1 historical readers retain their permissive FAILED representation; explicit V2 traces must
// make gate, journal, outbox, delivery, and completion facts agree even when runtime ends FAILED.
export function runtimeTerminalEvidenceMatchesDisposition(
  trace: readonly RuntimeTraceEvent[],
  outbox: readonly { kind?: string; status: string }[],
  deliveryJournal: Readonly<{
    state: string;
    verdict: string | null;
    completion_mode: JournalCompletionMode | null;
  }>,
  terminalState: 'DONE' | 'FAILED',
  evidenceFlavor?: RuntimeEvidenceFlavor,
): boolean {
  return terminalState === 'DONE'
    ? runtimeDoneEvidenceMatchesDisposition(trace, outbox, deliveryJournal, evidenceFlavor)
    : runtimeFailedEvidenceMatchesDisposition(trace, outbox, deliveryJournal, evidenceFlavor);
}

export function runtimeDoneEvidenceMatchesDisposition(
  trace: readonly RuntimeTraceEvent[],
  outbox: readonly { kind?: string; status: string }[],
  deliveryJournal: Readonly<{
    state: string;
    verdict: string | null;
    completion_mode: JournalCompletionMode | null;
  }>,
  evidenceFlavor?: RuntimeEvidenceFlavor,
): boolean {
  const doneEvents = trace.filter(
    (event): event is Extract<RuntimeTraceEvent, { event: 'done' }> => event.event === 'done',
  );
  const v2Trace = requiresV2DispositionEvidence(trace, evidenceFlavor);
  if (doneEvents.length !== 1) return false;
  const done = doneEvents[0]!;
  const dispositionWitness = tracedV2Disposition(trace);
  if (
    v2Trace &&
    (dispositionWitness.kind !== 'consistent' ||
      dispositionWitness.disposition !== doneDisposition(done))
  ) {
    return false;
  }
  const disposition = doneDisposition(done);
  const gatedEvents = trace.filter(
    (event): event is Extract<RuntimeTraceEvent, { event: 'gated' }> => event.event === 'gated',
  );
  const deliveredEvents = trace.filter(
    (event): event is Extract<RuntimeTraceEvent, { event: 'delivered' }> =>
      event.event === 'delivered',
  );
  const hasOneAckedOutbox = outbox.length === 1 && outbox[0]?.status === 'acked';
  if (disposition === 'proactive_delivery') {
    const requiresV2Gate = v2Trace || 'disposition' in done.detail;
    if (requiresV2Gate) {
      if (gatedEvents.length !== 1 || deliveredEvents.length !== 1 || !hasOneAckedOutbox) {
        return false;
      }
      const gated = gatedEvents[0]!;
      const outboxRow = outbox[0]!;
      if (gated.detail.verdict !== 'send' && gated.detail.verdict !== 'degrade') return false;
      if (
        outboxRow.kind !== gated.detail.outbox_kind ||
        deliveryJournal.verdict !== gated.detail.verdict ||
        deliveryJournal.completion_mode !== null
      ) {
        return false;
      }
      return (
        trace.indexOf(gated) < trace.indexOf(deliveredEvents[0]!) &&
        trace.indexOf(deliveredEvents[0]!) < trace.indexOf(done) &&
        deliveryJournal.state === 'DONE'
      );
    }
    const gateMatches =
      gatedEvents.length === 0 ||
      (gatedEvents.length === 1 &&
        trace.indexOf(gatedEvents[0]!) < trace.indexOf(deliveredEvents[0]!));
    return (
      deliveredEvents.length === 1 &&
      gateMatches &&
      trace.indexOf(deliveredEvents[0]!) < trace.indexOf(done) &&
      hasOneAckedOutbox &&
      deliveryJournal.state === 'DONE' &&
      (deliveryJournal.verdict === 'send' || deliveryJournal.verdict === 'degrade') &&
      deliveryJournal.completion_mode === null
    );
  }
  return (
    disposition === 'internal_no_output' &&
    doneEvents.length === 1 &&
    gatedEvents.length === 0 &&
    deliveredEvents.length === 0 &&
    outbox.length === 0 &&
    deliveryJournal.state === 'DONE' &&
    deliveryJournal.verdict === null &&
    deliveryJournal.completion_mode === 'trusted_internal_no_output'
  );
}

function runtimeFailedEvidenceMatchesDisposition(
  trace: readonly RuntimeTraceEvent[],
  outbox: readonly { kind?: string; status: string }[],
  deliveryJournal: Readonly<{
    state: string;
    verdict: string | null;
    completion_mode: JournalCompletionMode | null;
  }>,
  evidenceFlavor?: RuntimeEvidenceFlavor,
): boolean {
  // Historical V1 reader compatibility is explicit: it never carried the V2 disposition witness.
  if (!requiresV2DispositionEvidence(trace, evidenceFlavor)) return true;

  const dispositionWitness = tracedV2Disposition(trace);
  if (dispositionWitness.kind === 'conflicting') return false;

  const failedEvents = trace.filter(
    (event): event is Extract<RuntimeTraceEvent, { event: 'failed' }> => event.event === 'failed',
  );
  if (failedEvents.length !== 1) return false;
  const failed = failedEvents[0]!;
  const doneEvents = trace.filter(
    (event): event is Extract<RuntimeTraceEvent, { event: 'done' }> => event.event === 'done',
  );
  if (doneEvents.length > 0) {
    return (
      doneEvents.length === 1 &&
      failed.detail.reason === 'replay:artifact_invalid' &&
      runtimeDoneEvidenceMatchesDisposition(trace, outbox, deliveryJournal, evidenceFlavor)
    );
  }

  if (deliveryJournal.completion_mode !== null) return false;

  const gatedEvents = trace.filter(
    (event): event is Extract<RuntimeTraceEvent, { event: 'gated' }> => event.event === 'gated',
  );
  const deliveredEvents = trace.filter(
    (event): event is Extract<RuntimeTraceEvent, { event: 'delivered' }> =>
      event.event === 'delivered',
  );
  const hasDeliveryFacts =
    gatedEvents.length > 0 ||
    deliveredEvents.length > 0 ||
    outbox.length > 0 ||
    deliveryJournal.verdict !== null;
  // A trusted V2 failure can happen before the provider has chosen an output disposition. Once
  // any gate, outbox, delivery, or journal-verdict fact exists, however, the real V2 path has
  // already persisted a disposition witness. Never infer proactive delivery from a damaged trace.
  if (hasDeliveryFacts && dispositionWitness.kind !== 'consistent') return false;
  if (
    dispositionWitness.kind === 'consistent' &&
    dispositionWitness.disposition !== 'proactive_delivery'
  ) {
    return (
      deliveryJournal.state === 'FAILED' &&
      deliveryJournal.verdict === null &&
      gatedEvents.length === 0 &&
      deliveredEvents.length === 0 &&
      outbox.length === 0
    );
  }
  if (gatedEvents.length === 0) {
    return (
      deliveryJournal.state === 'FAILED' &&
      deliveredEvents.length === 0 &&
      outbox.length === 0 &&
      deliveryJournal.verdict === null
    );
  }
  if (gatedEvents.length !== 1) return false;

  const gated = gatedEvents[0]!;
  if (trace.indexOf(gated) >= trace.indexOf(failed)) return false;
  if (gated.detail.verdict === 'hold' || gated.detail.verdict === 'drop') {
    return (
      deliveryJournal.state === 'FAILED' &&
      deliveryJournal.verdict === gated.detail.verdict &&
      deliveredEvents.length === 0 &&
      outbox.length === 0
    );
  }
  if (!('outbox_kind' in gated.detail)) return false;

  if (
    deliveryJournal.verdict !== gated.detail.verdict ||
    outbox.length !== 1 ||
    outbox[0]?.kind !== gated.detail.outbox_kind
  ) {
    return false;
  }
  const row = outbox[0]!;
  if (row.status === 'acked') {
    // The outbox acknowledgement is irreversible durable receipt. A sidecar-integrity failure
    // can occur after that receipt commits but before RunLoopDO writes its DELIVERED trace/state;
    // only replay:artifact_invalid may describe that narrow receipt-before-transition window.
    const receiptBeforeRuntimeDelivery =
      deliveredEvents.length === 0 && failed.detail.reason === 'replay:artifact_invalid';
    const deliveredBeforeFailure =
      deliveredEvents.length === 1 &&
      trace.indexOf(gated) < trace.indexOf(deliveredEvents[0]!) &&
      trace.indexOf(deliveredEvents[0]!) < trace.indexOf(failed) &&
      isPostAckIntegrityFailure(failed.detail.reason);
    return (
      deliveryJournal.state === 'DONE' &&
      trace.indexOf(gated) < trace.indexOf(failed) &&
      (receiptBeforeRuntimeDelivery || deliveredBeforeFailure)
    );
  }
  return (
    deliveryJournal.state === 'FAILED' &&
    deliveredEvents.length === 0 &&
    (row.status === 'pending' || row.status === 'sent_unacked')
  );
}

function isPostAckIntegrityFailure(reason: string): boolean {
  return reason === 'replay:artifact_invalid' || reason.startsWith('context:');
}

function fixtureFsmCanAdvance(
  fixture: Readonly<{ trace: readonly RuntimeTraceEvent[] }>,
  from: z.infer<typeof runtimeRunStateSchema>,
  to: z.infer<typeof runtimeRunStateSchema>,
): boolean {
  if (runtimeRunCanAdvance(from, to)) return true;
  const done = fixture.trace.find((event) => event.event === 'done');
  if (from === 'TOOLS_DONE' && to === 'DONE' && done !== undefined) {
    return doneDisposition(done) === 'internal_no_output';
  }
  const failed = fixture.trace.find(
    (event): event is Extract<RuntimeTraceEvent, { event: 'failed' }> => event.event === 'failed',
  );
  if (from === 'DONE' && to === 'FAILED') {
    return done !== undefined && failed?.detail.reason === 'replay:artifact_invalid';
  }
  return (
    from === 'DELIVERED' &&
    to === 'FAILED' &&
    (failed?.detail.reason === 'replay:artifact_invalid' ||
      failed?.detail.reason.startsWith('context:') === true)
  );
}

function doneDisposition(
  done: Extract<RuntimeTraceEvent, { event: 'done' }>,
): z.infer<typeof invocationOutputDispositionKindSchema> {
  return 'disposition' in done.detail ? done.detail.disposition : 'proactive_delivery';
}

type TracedV2Disposition =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{
      kind: 'consistent';
      disposition: z.infer<typeof invocationOutputDispositionKindSchema>;
    }>
  | Readonly<{ kind: 'conflicting' }>;

// A V2 terminal may derive its output disposition from the provider observation, solicited
// egress witness, and/or done event. They are independent durable facts, so disagreement is
// evidence corruption rather than a reason to infer the more permissive proactive branch.
function tracedV2Disposition(trace: readonly RuntimeTraceEvent[]): TracedV2Disposition {
  const dispositions: z.infer<typeof invocationOutputDispositionKindSchema>[] = [];
  for (const event of trace) {
    if (event.event === 'llm_observed' && 'output_disposition' in event.detail) {
      dispositions.push(event.detail.output_disposition);
    } else if (event.event === 'egress_checked') {
      dispositions.push(event.detail.disposition);
    } else if (event.event === 'done' && 'disposition' in event.detail) {
      dispositions.push(event.detail.disposition);
    }
  }
  if (dispositions.length === 0) return { kind: 'absent' };
  const disposition = dispositions[0]!;
  return dispositions.every((candidate) => candidate === disposition)
    ? { kind: 'consistent', disposition }
    : { kind: 'conflicting' };
}

function traceUsesExplicitV2Evidence(trace: readonly RuntimeTraceEvent[]): boolean {
  return trace.some(
    (event) =>
      (event.event === 'context_built' && event.detail.source === 'context-composer-v2') ||
      (event.event === 'llm_observed' && 'output_disposition' in event.detail) ||
      event.event === 'egress_checked' ||
      (event.event === 'done' && 'disposition' in event.detail),
  );
}

function requiresV2DispositionEvidence(
  trace: readonly RuntimeTraceEvent[],
  evidenceFlavor?: RuntimeEvidenceFlavor,
): boolean {
  return evidenceFlavor === 'trusted_v2' || traceUsesExplicitV2Evidence(trace);
}

export function traceDetailKeysArePublic(value: unknown): boolean {
  return runtimeTraceDetailSchema.safeParse(value).success;
}
