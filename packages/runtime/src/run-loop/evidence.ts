import {
  RUNTIME_EVIDENCE_SCHEMA_VERSION,
  runtimeReplayFixtureSchema,
  runtimeTraceDetailSchema,
  runtimeTraceEvalSchema,
  runtimeTraceEventSchema,
  traceDetailKeysArePublic,
  type RuntimeReplayFixture,
  type RuntimeTraceDetail,
  type RuntimeTraceEval,
  type RuntimeTraceEvent,
  type RuntimeTraceFamily,
  type RuntimeTracePrivacy,
  type RuntimeTraceStatus,
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
  traceRows: RuntimeTraceSqlRow[];
  fsm: RuntimeRunState[];
  outbox: { kind: string; status: string; attempts: number }[];
  deliveryJournal: { state: string; verdict: string | null };
  current: { state: RuntimeRunState; failure_reason: string | null };
};

export function runtimeTraceEventKey(input: {
  runId: string;
  event: string;
  step: number;
}): string {
  return `${input.runId}:${traceFamilyFor(input.event)}:${input.event}:${input.step}`;
}

export function normaliseRuntimeTraceDetail(
  event: string,
  detail: Record<string, unknown>,
): RuntimeTraceDetail {
  const withoutUndefined = stripUndefined(detail);
  const publicDetail =
    event === 'scheduled_wake' && typeof withoutUndefined.schedule_id === 'string'
      ? {
          ...withoutUndefined,
          schedule_ref: withoutUndefined.schedule_id,
          schedule_id: undefined,
        }
      : withoutUndefined;
  return runtimeTraceDetailSchema.parse(stripUndefined(publicDetail));
}

export function buildRuntimeReplayFixture(input: RuntimeEvidenceInput): RuntimeReplayFixture {
  const trace = buildRuntimeTrace(input);
  const evalResult = scoreRuntimeTrace({
    runId: input.runId,
    trace,
    outbox: input.outbox,
    current: input.current,
  });
  return runtimeReplayFixtureSchema.parse({
    schema_version: RUNTIME_EVIDENCE_SCHEMA_VERSION,
    fixture_id: `hey111:${input.runId}`,
    source_trace_id: input.runId,
    hermetic: true,
    live_provider: false,
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
    trace: fixture.trace,
    outbox: fixture.outbox,
    current: fixture.current,
  });
}

function buildRuntimeTrace(input: RuntimeEvidenceInput): RuntimeTraceEvent[] {
  const trace = input.traceRows.map((row) => {
    const detail = normaliseRuntimeTraceDetail(row.event, parseJsonObject(row.detail_json));
    return runtimeTraceEventSchema.parse({
      schema_version: RUNTIME_EVIDENCE_SCHEMA_VERSION,
      trace_id: input.runId,
      run_id: input.runId,
      seq: row.seq,
      event_key: row.event_key ?? runtimeTraceEventKey({
        runId: input.runId,
        event: row.event,
        step: row.seq,
      }),
      family: traceFamilyFor(row.event),
      event: row.event,
      status: traceStatusFor(row.event, detail),
      privacy: tracePrivacyFor(row.event),
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
          step: (last?.seq ?? -1) + 1,
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
  trace: RuntimeTraceEvent[];
  outbox: { status: string }[];
  current: { state: RuntimeRunState; failure_reason: string | null };
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
    input.current.state === 'DONE'
      ? input.outbox.some((row) => row.status === 'acked') &&
        input.trace.some((event) => event.family === 'delivery' && event.status === 'acked')
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
        ? 'trace details contain no forbidden private payload keys'
        : 'trace details include forbidden private payload keys',
    },
    {
      id: 'outbox_consistency',
      status: outboxOk ? 'pass' : 'fail',
      evidence: outboxOk
        ? 'terminal delivery evidence is consistent with outbox state'
        : 'done run lacks acked outbox or delivery evidence',
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

function traceFamilyFor(event: string): RuntimeTraceFamily {
  if (event === 'scheduled_wake') return 'wake';
  if (event.startsWith('governor_')) return 'governor';
  if (event === 'session_reset') return 'session';
  if (event === 'context_built') return 'context';
  if (event.startsWith('llm_')) return 'llm';
  if (event.startsWith('tool_')) return 'tool';
  if (event === 'gated') return 'gate';
  if (event === 'delivered') return 'delivery';
  if (event === 'done' || event === 'failed') return 'outcome';
  return 'outbox';
}

function traceStatusFor(event: string, detail: RuntimeTraceDetail): RuntimeTraceStatus {
  if (event === 'scheduled_wake') return 'scheduled';
  if (event === 'governor_admitted') return 'admitted';
  if (event === 'governor_denied') return 'denied';
  if (event === 'gated' && detail.verdict === 'send') return 'send';
  if (event === 'delivered') return 'acked';
  if (event === 'done') return 'done';
  if (event === 'failed') return 'failed';
  if (event === 'tool_dispatched') {
    const denied = detail.denied;
    return Array.isArray(denied) && denied.length > 0 ? 'denied' : 'ok';
  }
  return 'ok';
}

function tracePrivacyFor(event: string): RuntimeTracePrivacy {
  if (event === 'scheduled_wake') return 'operational_ref';
  if (event.startsWith('governor_') || event === 'gated') return 'policy_metadata';
  if (event === 'context_built') return 'derived_summary';
  return 'operational_metadata';
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
