import { describe, expect, it } from 'vitest';
import {
  runtimeReplayFixtureSchema,
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
  detail: { trigger: 'brief', schedule_ref: 'brief:morning' },
  occurred_at: 1,
} as const;

describe('runtime evidence contracts', () => {
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
      rules: [
        {
          id: 'trace_order',
          status: 'pass',
          evidence: 'trace sequence is monotonic and starts with scheduled_wake',
        },
      ],
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
        trace: [baseTraceEvent],
        fsm: ['PENDING', 'DONE'],
        outbox: [{ kind: 'brief', status: 'acked', attempts: 1 }],
        delivery_journal: { state: 'DONE', verdict: 'send' },
        current: { state: 'DONE', failure_reason: null },
        eval: evalResult,
      }).success,
    ).toBe(true);
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
