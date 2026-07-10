import { describe, expect, it } from 'vitest';
import {
  runtimeReplayFixtureSchema,
  runtimeTraceDetailSchema,
  runtimeTraceEvalSchema,
  runtimeTraceEventSchema,
  runtimeTraceFamilySchema,
} from './evidence';

const baseTraceEvent = {
  schema_version: 1,
  trace_id: 'run-evidence-01',
  run_id: 'run-evidence-01',
  seq: 0,
  event_key: 'run-evidence-01:wake:scheduled_wake:0',
  family: 'wake',
  event: 'scheduled_wake',
  status: 'scheduled',
  privacy: 'operational_ref',
  detail: { trigger: 'brief', schedule_ref: 'brief:morning', occurrence_at: 1 },
  occurred_at: 1,
} as const;

const deliveredTraceEvent = {
  schema_version: 1,
  trace_id: 'run-evidence-01',
  run_id: 'run-evidence-01',
  seq: 1,
  event_key: 'run-evidence-01:delivery:delivered:1',
  family: 'delivery',
  event: 'delivered',
  status: 'acked',
  privacy: 'operational_metadata',
  detail: { sink: 'fake', status: 'acked' },
  occurred_at: 2,
} as const;

const doneTraceEvent = {
  schema_version: 1,
  trace_id: 'run-evidence-01',
  run_id: 'run-evidence-01',
  seq: 2,
  event_key: 'run-evidence-01:outcome:done:2',
  family: 'outcome',
  event: 'done',
  status: 'done',
  privacy: 'operational_metadata',
  detail: { terminal: true },
  occurred_at: 3,
} as const;

const terminalTrace = [baseTraceEvent, deliveredTraceEvent, doneTraceEvent] as const;
const doneFsm = [
  'PENDING',
  'CONTEXT_BUILT',
  'LLM_CALLED',
  'TOOLS_DONE',
  'GATED',
  'DELIVERED',
  'DONE',
] as const;

const passingRules = [
  {
    id: 'trace_order',
    status: 'pass',
    evidence: 'trace sequence is monotonic and starts with scheduled_wake',
  },
  {
    id: 'terminal_visible',
    status: 'pass',
    evidence: 'terminal runtime state is visible in trace evidence',
  },
  {
    id: 'privacy_guard',
    status: 'pass',
    evidence: 'trace details match the closed event schemas',
  },
  {
    id: 'outbox_consistency',
    status: 'pass',
    evidence: 'terminal delivery evidence is consistent with outbox state',
  },
  {
    id: 'failure_visible',
    status: 'pass',
    evidence: 'failed runs carry a terminal reason or denial evidence',
  },
] as const;

describe('runtime evidence contracts', () => {
  it('rejects arbitrary trace detail fields', () => {
    expect(
      runtimeTraceDetailSchema.safeParse({ measurement: 'HRV 58 ms' }).success,
    ).toBe(false);
  });

  it('pins the HEY-111 trace event families', () => {
    expect(runtimeTraceFamilySchema.options).toEqual([
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
  });

  it('accepts redacted runtime trace events with explicit privacy classification', () => {
    expect(runtimeTraceEventSchema.parse(baseTraceEvent)).toEqual(baseTraceEvent);
  });

  it('rejects trace details that try to carry private payload fields', () => {
    expect(
      runtimeTraceEventSchema.safeParse({
        ...baseTraceEvent,
        detail: { prompt: 'not stored' },
      }).success,
    ).toBe(false);

    expect(
      runtimeTraceEventSchema.safeParse({
        ...baseTraceEvent,
        detail: { nested: { raw_health: 'not stored' } },
      }).success,
    ).toBe(false);
  });

  it('keeps replay fixtures hermetic and tied to typed trace/eval evidence', () => {
    const evalResult = runtimeTraceEvalSchema.parse({
      schema_version: 1,
      trace_id: 'run-evidence-01',
      run_id: 'run-evidence-01',
      result: 'pass',
      rules: passingRules,
      wis: {
        available: false,
        reason: 'not_observed_fake_first',
      },
    });

    expect(
      runtimeReplayFixtureSchema.safeParse({
        schema_version: 1,
        fixture_id: 'hey111:run-evidence-01',
        source_trace_id: 'run-evidence-01',
        hermetic: true,
        live_provider: false,
        trace: terminalTrace,
        fsm: doneFsm,
        outbox: [{ kind: 'brief', status: 'acked', attempts: 1 }],
        delivery_journal: { state: 'DONE', verdict: 'send' },
        current: { state: 'DONE', failure_reason: null },
        eval: evalResult,
      }).success,
    ).toBe(true);
  });

  it('rejects incomplete, contradictory, or identity-drifted eval evidence', () => {
    const baseEval = {
      schema_version: 1,
      trace_id: 'run-evidence-01',
      run_id: 'run-evidence-01',
      result: 'pass',
      rules: passingRules,
      wis: { available: false, reason: 'not_observed_fake_first' },
    } as const;

    expect(runtimeTraceEvalSchema.safeParse({ ...baseEval, rules: [] }).success).toBe(false);
    expect(
      runtimeTraceEvalSchema.safeParse({
        ...baseEval,
        rules: passingRules.map((rule, index) =>
          index === 0 ? { ...rule, status: 'fail' as const } : rule,
        ),
      }).success,
    ).toBe(false);
    expect(
      runtimeTraceEvalSchema.safeParse({ ...baseEval, run_id: 'run-evidence-02' }).success,
    ).toBe(false);
  });

  it('rejects noncanonical event keys and replay identity/state drift', () => {
    expect(
      runtimeTraceEventSchema.safeParse({
        ...baseTraceEvent,
        event_key: 'private@example.com',
      }).success,
    ).toBe(false);

    const evalResult = runtimeTraceEvalSchema.parse({
      schema_version: 1,
      trace_id: 'run-evidence-01',
      run_id: 'run-evidence-01',
      result: 'pass',
      rules: passingRules,
      wis: { available: false, reason: 'not_observed_fake_first' },
    });
    const baseFixture = {
      schema_version: 1,
      fixture_id: 'hey111:run-evidence-01',
      source_trace_id: 'run-evidence-01',
      hermetic: true,
      live_provider: false,
      trace: terminalTrace,
      fsm: doneFsm,
      outbox: [{ kind: 'brief', status: 'acked', attempts: 1 }],
      delivery_journal: { state: 'DONE', verdict: 'send' },
      current: { state: 'DONE', failure_reason: null },
      eval: evalResult,
    } as const;

    expect(
      runtimeReplayFixtureSchema.safeParse({
        ...baseFixture,
        current: { state: 'FAILED', failure_reason: null },
      }).success,
    ).toBe(false);
    expect(
      runtimeReplayFixtureSchema.safeParse({
        ...baseFixture,
        trace: [{ ...baseTraceEvent, run_id: 'run-evidence-02' }],
      }).success,
    ).toBe(false);
  });

  it('rejects replay fixtures that claim live providers are part of local evidence', () => {
    expect(
      runtimeReplayFixtureSchema.safeParse({
        schema_version: 1,
        fixture_id: 'hey111:run-evidence-01',
        source_trace_id: 'run-evidence-01',
        hermetic: true,
        live_provider: true,
        trace: [baseTraceEvent],
        fsm: ['PENDING', 'DONE'],
        outbox: [],
        delivery_journal: { state: 'DONE', verdict: 'send' },
        current: { state: 'DONE', failure_reason: null },
        eval: {
          schema_version: 1,
          trace_id: 'run-evidence-01',
          run_id: 'run-evidence-01',
          result: 'pass',
          rules: [],
          wis: { available: false, reason: 'not_observed_fake_first' },
        },
      }).success,
    ).toBe(false);
  });
});
