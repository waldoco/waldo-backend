import {
  RUNTIME_EVIDENCE_SCHEMA_VERSION,
  parseRuntimeTraceDetail,
  runtimeReplayFixtureSchema,
  runtimeTerminalEvidenceMatchesDisposition,
  runtimeTraceDetailEnvelopeSchema,
  runtimeTraceEvalSchema,
  runtimeTraceEventSchema,
  runtimeTraceEventNameSchema,
  traceDetailKeysArePublic,
  type DeliveryVerdict,
  type JournalCompletionMode,
  type OutboxStatus,
  type PushClass,
  type RunState,
  type RuntimeReplayFixture,
  type RuntimeEvidenceFlavor,
  type RuntimeTraceDetail,
  type RuntimeTraceDetailEnvelope,
  type RuntimeTraceEval,
  type RuntimeTraceEvent,
  type RuntimeTraceEventName,
  type RuntimeTraceFamily,
  type RuntimeTracePrivacy,
  type RuntimeTraceStatus,
  type RuntimeRunFailureReason,
  type RuntimeRunState,
} from '@waldo/contracts';

export type RuntimeTraceSqlRow = {
  seq: number;
  event_key: string | null;
  event: string;
  detail_json: string;
  created_at: number;
};

export type RuntimeEvidenceInput = {
  runId: string;
  // This is derived by RunLoopDO from its immutable invocation marker. It deliberately does
  // not depend on whether an individual V2 trace row survived a storage incident.
  evidenceFlavor: RuntimeEvidenceFlavor;
  traceRows: RuntimeTraceSqlRow[];
  fsm: RuntimeRunState[];
  outbox: { kind: PushClass; status: OutboxStatus; attempts: number }[];
  deliveryJournal: {
    state: RunState;
    verdict: DeliveryVerdict | null;
    completion_mode: JournalCompletionMode | null;
  };
  current: { state: RuntimeRunState; failure_reason: RuntimeRunFailureReason | null };
};

export function runtimeTraceEventKey(input: {
  runId: string;
  event: string;
  seq: number;
}): string {
  const event = runtimeTraceEventNameSchema.parse(input.event);
  return `${input.runId}:${traceFamilyFor(event)}:${event}:${input.seq}`;
}

export function normaliseRuntimeTraceDetail(
  event: string,
  detail: Record<string, unknown>,
): RuntimeTraceDetail {
  const parsedEvent = runtimeTraceEventNameSchema.parse(event);
  const withoutUndefined = stripUndefined(detail);
  const normalizedDetail =
    parsedEvent === 'scheduled_wake' && typeof withoutUndefined.schedule_id === 'string'
      ? {
          ...withoutUndefined,
          schedule_ref: withoutUndefined.schedule_id,
          schedule_id: undefined,
        }
      : withoutUndefined;
  return parseRuntimeTraceDetail(parsedEvent, stripUndefined(normalizedDetail));
}

export function buildRuntimeReplayFixture(input: RuntimeEvidenceInput): RuntimeReplayFixture {
  const trace = buildRuntimeTrace(input);
  const evalResult = scoreRuntimeTrace({
    runId: input.runId,
    evidenceFlavor: input.evidenceFlavor,
    trace,
    outbox: input.outbox,
    deliveryJournal: input.deliveryJournal,
    current: input.current,
  });
  return runtimeReplayFixtureSchema.parse({
    schema_version: RUNTIME_EVIDENCE_SCHEMA_VERSION,
    fixture_id: `hey111:${input.runId}`,
    source_trace_id: input.runId,
    hermetic: true,
    live_provider: false,
    evidence_flavor: input.evidenceFlavor,
    trace,
    fsm: input.fsm,
    outbox: input.outbox,
    delivery_journal: input.deliveryJournal,
    current: input.current,
    eval: evalResult,
  });
}

export function scoreRuntimeFixture(fixture: RuntimeReplayFixture): RuntimeTraceEval {
  return scoreRuntimeTrace({
    runId: fixture.source_trace_id,
    evidenceFlavor: fixture.evidence_flavor,
    trace: fixture.trace,
    outbox: fixture.outbox,
    deliveryJournal: fixture.delivery_journal,
    current: fixture.current,
  });
}

function buildRuntimeTrace(input: RuntimeEvidenceInput): RuntimeTraceEvent[] {
  const trace = input.traceRows.map((row) => {
    const event = runtimeTraceEventNameSchema.parse(row.event);
    const detail = normaliseRuntimeTraceDetail(event, parseJsonObject(row.detail_json));
    const detailEnvelope = runtimeTraceDetailEnvelopeSchema.parse({ event, detail });
    return runtimeTraceEventSchema.parse({
      schema_version: RUNTIME_EVIDENCE_SCHEMA_VERSION,
      trace_id: input.runId,
      run_id: input.runId,
      seq: row.seq,
      event_key: row.event_key ?? runtimeTraceEventKey({
        runId: input.runId,
        event,
        seq: row.seq,
      }),
      family: traceFamilyFor(event),
      event,
      status: traceStatusFor(detailEnvelope),
      privacy: tracePrivacyFor(event),
      detail,
      occurred_at: row.created_at,
    });
  });

  if (
    input.current.state === 'FAILED' &&
    !trace.some((event) => event.family === 'outcome' && event.status === 'failed')
  ) {
    const last = trace.at(-1);
    trace.push(
      runtimeTraceEventSchema.parse({
        schema_version: RUNTIME_EVIDENCE_SCHEMA_VERSION,
        trace_id: input.runId,
        run_id: input.runId,
        seq: (last?.seq ?? -1) + 1,
        event_key: runtimeTraceEventKey({
          runId: input.runId,
          event: 'failed',
          seq: (last?.seq ?? -1) + 1,
        }),
        family: 'outcome',
        event: 'failed',
        status: 'failed',
        privacy: 'operational_metadata',
        detail: { reason: input.current.failure_reason ?? 'unknown' },
        occurred_at: (last?.occurred_at ?? 0) + 1,
      }),
    );
  }

  return trace;
}

function scoreRuntimeTrace(input: {
  runId: string;
  evidenceFlavor: RuntimeEvidenceFlavor;
  trace: RuntimeTraceEvent[];
  outbox: { status: string }[];
  deliveryJournal: {
    state: RunState;
    verdict: DeliveryVerdict | null;
    completion_mode: JournalCompletionMode | null;
  };
  current: { state: RuntimeRunState; failure_reason: RuntimeRunFailureReason | null };
}): RuntimeTraceEval {
  const traceOrderOk = input.trace.every((event, index) => {
    const previous = input.trace[index - 1];
    return previous === undefined || event.seq > previous.seq;
  });
  const startsWithWake = input.trace[0]?.event === 'scheduled_wake';
  const terminalVisible =
    input.current.state === 'DONE'
      ? input.trace.some((event) => event.event === 'done')
      : input.trace.some((event) => event.event === 'failed');
  const failedRunVisible =
    input.current.state !== 'FAILED' ||
    (input.current.failure_reason !== null &&
      input.trace.some(
        (event) =>
          (event.family === 'governor' && event.status === 'denied') ||
          (event.family === 'outcome' && event.status === 'failed'),
      ));
  const privacyOk = input.trace.every((event) => traceDetailKeysArePublic(event.detail));
  const outboxOk =
    input.current.state === 'DONE' || input.current.state === 'FAILED'
      ? runtimeTerminalEvidenceMatchesDisposition(
          input.trace,
          input.outbox,
          input.deliveryJournal,
          input.current.state,
          input.evidenceFlavor,
        )
      : true;

  const rules = [
    {
      id: 'trace_order',
      status: traceOrderOk && startsWithWake ? 'pass' : 'fail',
      evidence: traceOrderOk && startsWithWake
        ? 'trace sequence is monotonic and starts with scheduled_wake'
        : 'trace sequence is missing its wake prefix or monotonic ordering',
    },
    {
      id: 'terminal_visible',
      status: terminalVisible ? 'pass' : 'fail',
      evidence: terminalVisible
        ? 'terminal runtime state is visible in trace evidence'
        : 'terminal runtime state is not visible in trace evidence',
    },
    {
      id: 'privacy_guard',
      status: privacyOk ? 'pass' : 'fail',
      evidence: privacyOk
        ? 'trace details match the closed event schemas'
        : 'trace details do not match the closed event schemas',
    },
    {
      id: 'outbox_consistency',
      status: outboxOk ? 'pass' : 'fail',
      evidence: outboxOk
        ? 'terminal completion evidence is consistent with output disposition'
        : 'done run has inconsistent output disposition evidence',
    },
    {
      id: 'failure_visible',
      status: failedRunVisible ? 'pass' : 'fail',
      evidence: failedRunVisible
        ? 'failed runs carry a terminal reason or denial evidence'
        : 'failed run lacks terminal failure evidence',
    },
  ] as const;
  const parsedRules = rules.map((rule) => ({
    ...rule,
    status: rule.status,
  }));

  return runtimeTraceEvalSchema.parse({
    schema_version: RUNTIME_EVIDENCE_SCHEMA_VERSION,
    trace_id: input.runId,
    run_id: input.runId,
    result: parsedRules.some((rule) => rule.status === 'fail') ? 'fail' : 'pass',
    rules: parsedRules,
    wis: {
      available: false,
      reason: 'not_observed_fake_first',
    },
  });
}

function traceFamilyFor(event: RuntimeTraceEventName): RuntimeTraceFamily {
  switch (event) {
    case 'scheduled_wake':
      return 'wake';
    case 'governor_admitted':
    case 'governor_denied':
    case 'egress_checked':
      return 'governor';
    case 'session_reset':
      return 'session';
    case 'context_built':
      return 'context';
    case 'llm_called':
    case 'llm_observed':
    case 'provider_effect_rejected':
      return 'llm';
    case 'tool_parse_failed':
    case 'tool_dispatched':
      return 'tool';
    case 'gated':
      return 'gate';
    case 'delivered':
      return 'delivery';
    case 'done':
    case 'failed':
    case 'scribe_denied':
      return 'outcome';
  }
}

function traceStatusFor(envelope: RuntimeTraceDetailEnvelope): RuntimeTraceStatus {
  switch (envelope.event) {
    case 'scheduled_wake':
      return 'scheduled';
    case 'governor_admitted':
      return 'admitted';
    case 'governor_denied':
    case 'scribe_denied':
      return 'denied';
    case 'tool_parse_failed':
    case 'provider_effect_rejected':
    case 'failed':
      return 'failed';
    case 'gated':
      return envelope.detail.verdict === 'send' ? 'send' : 'ok';
    case 'delivered':
      return 'acked';
    case 'done':
      return 'done';
    case 'tool_dispatched':
      return envelope.detail.denied.length > 0 ? 'denied' : 'ok';
    case 'egress_checked':
      return envelope.detail.verdict === 'deny' ? 'denied' : 'ok';
    case 'session_reset':
    case 'context_built':
    case 'llm_called':
    case 'llm_observed':
      return 'ok';
  }
}

function tracePrivacyFor(event: RuntimeTraceEventName): RuntimeTracePrivacy {
  switch (event) {
    case 'scheduled_wake':
      return 'operational_ref';
    case 'governor_admitted':
    case 'governor_denied':
    case 'egress_checked':
    case 'gated':
    case 'scribe_denied':
      return 'policy_metadata';
    case 'context_built':
      return 'derived_summary';
    case 'session_reset':
    case 'llm_called':
    case 'llm_observed':
    case 'provider_effect_rejected':
    case 'tool_parse_failed':
    case 'tool_dispatched':
    case 'delivered':
    case 'done':
    case 'failed':
      return 'operational_metadata';
  }
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected JSON object');
  }
  return parsed as Record<string, unknown>;
}
