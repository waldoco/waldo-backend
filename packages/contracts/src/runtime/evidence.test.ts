import { describe, expect, it } from 'vitest';
import { ROSTER } from '../model/roster';
import {
  runtimeDoneEvidenceMatchesDisposition,
  runtimeTerminalEvidenceMatchesDisposition,
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

const gatedTraceEvent = {
  schema_version: 1,
  trace_id: 'run-evidence-01',
  run_id: 'run-evidence-01',
  seq: 1,
  event_key: 'run-evidence-01:gate:gated:1',
  family: 'gate',
  event: 'gated',
  status: 'send',
  privacy: 'policy_metadata',
  detail: { verdict: 'send', outbox_kind: 'brief', delivery_text_source: 'fallback' },
  occurred_at: 2,
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

// This fixture deliberately remains a legacy V1 reader proof: historical evidence may have a
// delivered effect without a separate gate trace. Explicit V2 traces are checked more strictly.
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
    evidence: 'terminal completion evidence is consistent with output disposition',
  },
  {
    id: 'failure_visible',
    status: 'pass',
    evidence: 'failed runs carry a terminal reason or denial evidence',
  },
] as const;

const legacyPassingRules = [
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

  it('accepts only bounded content-free rejected provider receipt evidence', () => {
    const rejected = {
      schema_version: 1,
      trace_id: 'run-evidence-01',
      run_id: 'run-evidence-01',
      seq: 1,
      event_key: 'run-evidence-01:llm:provider_effect_rejected:1',
      family: 'llm',
      event: 'provider_effect_rejected',
      status: 'failed',
      privacy: 'operational_metadata',
      detail: {
        phase: 'provider_plan',
        outcome: 'invalid_response',
        fallback_step: 'configured_model',
      },
      occurred_at: 2,
    } as const;
    expect(runtimeTraceEventSchema.safeParse(rejected).success).toBe(true);
    expect(
      runtimeTraceEventSchema.safeParse({
        ...rejected,
        detail: { ...rejected.detail, response: 'private provider response' },
      }).success,
    ).toBe(false);
    expect(runtimeTraceEventSchema.safeParse({ ...rejected, status: 'ok' }).success).toBe(false);
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

  it('keeps archived V1 outbox evidence readable while rejecting it for explicit V2 evidence', () => {
    const legacyEval = runtimeTraceEvalSchema.parse({
      schema_version: 1,
      trace_id: 'run-evidence-01',
      run_id: 'run-evidence-01',
      result: 'pass',
      rules: legacyPassingRules,
      wis: { available: false, reason: 'not_observed_fake_first' },
    });
    const legacyFixture = {
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
      eval: legacyEval,
    } as const;
    const parsedLegacyFixture = runtimeReplayFixtureSchema.parse(legacyFixture);
    // Omission is the explicit historical-reader compatibility path. New trusted writers always
    // provide the immutable flavor witness instead of relying on surviving trace content.
    expect(parsedLegacyFixture.evidence_flavor).toBe('historical_v1');

    const explicitV2Done = {
      ...doneTraceEvent,
      seq: 3,
      event_key: 'run-evidence-01:outcome:done:3',
      detail: { terminal: true, disposition: 'proactive_delivery' as const },
      occurred_at: 4,
    };
    const explicitV2Delivered = {
      ...deliveredTraceEvent,
      seq: 2,
      event_key: 'run-evidence-01:delivery:delivered:2',
      occurred_at: 3,
    };
    expect(
      runtimeReplayFixtureSchema.safeParse({
        ...legacyFixture,
        trace: [baseTraceEvent, gatedTraceEvent, explicitV2Delivered, explicitV2Done],
      }).success,
    ).toBe(false);
    expect(
      runtimeReplayFixtureSchema.safeParse({
        ...legacyFixture,
        trace: [baseTraceEvent, gatedTraceEvent, explicitV2Delivered, explicitV2Done],
        eval: runtimeTraceEvalSchema.parse({
          schema_version: 1,
          trace_id: 'run-evidence-01',
          run_id: 'run-evidence-01',
          result: 'pass',
          rules: passingRules,
          wis: { available: false, reason: 'not_observed_fake_first' },
        }),
      }).success,
    ).toBe(true);
  });

  it('does not silently downgrade trusted V2 terminal evidence when its context trace is missing', () => {
    const delivered = {
      ...deliveredTraceEvent,
      seq: 2,
      event_key: 'run-evidence-01:delivery:delivered:2',
      occurred_at: 3,
    } as const;
    const legacyShapedDone = {
      ...doneTraceEvent,
      seq: 3,
      event_key: 'run-evidence-01:outcome:done:3',
      occurred_at: 4,
    } as const;
    const fixture = (gate: 'send' | 'degrade' | 'hold' | 'drop') => {
      const gated =
        gate === 'send' || gate === 'degrade'
          ? {
              ...gatedTraceEvent,
              status: gate === 'send' ? ('send' as const) : ('ok' as const),
              detail: {
                verdict: gate,
                outbox_kind: 'brief' as const,
                delivery_text_source: 'fallback' as const,
              },
            }
          : {
              ...gatedTraceEvent,
              status: 'ok' as const,
              detail: {
                verdict: gate,
                reason:
                  gate === 'hold'
                    ? ('cooldown_active' as const)
                    : ('once_ever_already_sent' as const),
                delivery_text_source: 'fallback' as const,
              },
            };
      return {
        schema_version: 1,
        fixture_id: 'hey111:run-evidence-01',
        source_trace_id: 'run-evidence-01',
        hermetic: true,
        live_provider: false,
        // This intentionally has no V2 context/disposition trace witness. It is the damaged
        // trace shape that historical V1 readers must keep accepting.
        trace: [baseTraceEvent, gated, delivered, legacyShapedDone],
        fsm: doneFsm,
        outbox: [{ kind: 'brief', status: 'acked', attempts: 1 }],
        delivery_journal: {
          state: 'DONE',
          verdict: gate === 'send' ? ('degrade' as const) : ('send' as const),
          completion_mode: null,
        },
        current: { state: 'DONE', failure_reason: null },
        eval: {
          schema_version: 1,
          trace_id: 'run-evidence-01',
          run_id: 'run-evidence-01',
          result: 'pass',
          rules: passingRules,
          wis: { available: false, reason: 'not_observed_fake_first' },
        },
      } as const;
    };

    for (const gate of ['hold', 'drop', 'send', 'degrade'] as const) {
      const historical = fixture(gate);
      expect(runtimeReplayFixtureSchema.safeParse(historical).success).toBe(true);
      expect(
        runtimeReplayFixtureSchema.safeParse({
          ...historical,
          evidence_flavor: 'trusted_v2',
        }).success,
      ).toBe(false);
    }
  });

  it('permits no-effect DONE evidence only for internal_no_output, never a solicited reply', () => {
    const internalDone = {
      ...doneTraceEvent,
      seq: 1,
      event_key: 'run-evidence-01:outcome:done:1',
      detail: { terminal: true, disposition: 'internal_no_output' as const },
      occurred_at: 2,
    };
    const internalFixture = {
      schema_version: 1,
      fixture_id: 'hey111:run-evidence-01',
      source_trace_id: 'run-evidence-01',
      hermetic: true,
      live_provider: false,
      trace: [baseTraceEvent, internalDone],
      fsm: ['PENDING', 'CONTEXT_BUILT', 'LLM_CALLED', 'TOOLS_DONE', 'DONE'],
      outbox: [],
      delivery_journal: {
        state: 'DONE',
        verdict: null,
        completion_mode: 'trusted_internal_no_output',
      },
      current: { state: 'DONE', failure_reason: null },
      eval: {
        schema_version: 1,
        trace_id: 'run-evidence-01',
        run_id: 'run-evidence-01',
        result: 'pass',
        rules: passingRules,
        wis: { available: false, reason: 'not_observed_fake_first' },
      },
    } as const;
    expect(runtimeReplayFixtureSchema.safeParse(internalFixture).success).toBe(true);
    expect(
      runtimeReplayFixtureSchema.safeParse({
        ...internalFixture,
        delivery_journal: { state: 'DONE', verdict: null },
      }).success,
    ).toBe(false);
    expect(
      runtimeReplayFixtureSchema.safeParse({
        ...internalFixture,
        trace: [
          baseTraceEvent,
          { ...internalDone, detail: { terminal: true, disposition: 'solicited_reply' as const } },
        ],
      }).success,
    ).toBe(false);
    expect(
      runtimeReplayFixtureSchema.safeParse({
        ...internalFixture,
        trace: [
          baseTraceEvent,
          internalDone,
          { ...internalDone, seq: 2, event_key: 'run-evidence-01:outcome:done:2', occurred_at: 3 },
        ],
      }).success,
    ).toBe(false);
    expect(
      runtimeReplayFixtureSchema.safeParse({
        ...internalFixture,
        trace: [
          baseTraceEvent,
          { ...gatedTraceEvent, seq: 1, event_key: 'run-evidence-01:gate:gated:1' },
          { ...internalDone, seq: 2, event_key: 'run-evidence-01:outcome:done:2', occurred_at: 3 },
        ],
      }).success,
    ).toBe(false);
    const v2Context = {
      schema_version: 1,
      trace_id: 'run-evidence-01',
      run_id: 'run-evidence-01',
      seq: 1,
      event_key: 'run-evidence-01:context:context_built:1',
      family: 'context',
      event: 'context_built',
      status: 'ok',
      privacy: 'derived_summary',
      detail: {
        source: 'context-composer-v2',
        context_ref: 'ctx_11111111111111111111111111111111',
        source_count: 1,
        source_taint: null,
      },
      occurred_at: 2,
    } as const;
    const v2Gated = {
      ...gatedTraceEvent,
      seq: 2,
      event_key: 'run-evidence-01:gate:gated:2',
      occurred_at: 3,
    };
    const v2Delivered = {
      ...deliveredTraceEvent,
      seq: 3,
      event_key: 'run-evidence-01:delivery:delivered:3',
      occurred_at: 4,
    };
    const v2Done = {
      ...doneTraceEvent,
      seq: 4,
      event_key: 'run-evidence-01:outcome:done:4',
      detail: { terminal: true, disposition: 'proactive_delivery' as const },
      occurred_at: 5,
    };
    const v2Fixture = {
      ...internalFixture,
      trace: [baseTraceEvent, v2Context, v2Gated, v2Delivered, v2Done],
      fsm: doneFsm,
      outbox: [{ kind: 'brief', status: 'acked', attempts: 1 }],
      delivery_journal: { state: 'DONE', verdict: 'send' as const, completion_mode: null },
    };
    expect(runtimeReplayFixtureSchema.safeParse(v2Fixture).success).toBe(true);
    expect(
      runtimeReplayFixtureSchema.safeParse({
        ...v2Fixture,
        trace: [baseTraceEvent, v2Context, v2Delivered, v2Done],
      }).success,
    ).toBe(false);
    expect(
      runtimeReplayFixtureSchema.safeParse({
        ...v2Fixture,
        trace: [
          baseTraceEvent,
          v2Context,
          v2Gated,
          v2Delivered,
          {
            ...v2Delivered,
            seq: 4,
            event_key: 'run-evidence-01:delivery:delivered:4',
            occurred_at: 5,
          },
          { ...v2Done, seq: 5, event_key: 'run-evidence-01:outcome:done:5', occurred_at: 6 },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects explicit V2 gate facts that contradict terminal delivery receipts', () => {
    const v2Context = {
      ...baseTraceEvent,
      seq: 1,
      event_key: 'run-evidence-01:context:context_built:1',
      family: 'context',
      event: 'context_built',
      status: 'ok',
      privacy: 'derived_summary',
      detail: {
        source: 'context-composer-v2',
        context_ref: 'ctx_11111111111111111111111111111111',
        source_count: 1,
        source_taint: null,
      },
      occurred_at: 2,
    } as const;
    const proactiveDone = {
      ...doneTraceEvent,
      seq: 4,
      event_key: 'run-evidence-01:outcome:done:4',
      detail: { terminal: true, disposition: 'proactive_delivery' as const },
      occurred_at: 5,
    } as const;
    const delivered = {
      ...deliveredTraceEvent,
      seq: 3,
      event_key: 'run-evidence-01:delivery:delivered:3',
      occurred_at: 4,
    };
    const fixture = (input: {
      gate: 'send' | 'degrade' | 'hold' | 'drop';
      journal: 'send' | 'degrade' | 'hold' | 'drop';
      outboxKind?: 'brief' | 'fetch_alert';
      completionMode?: 'trusted_internal_no_output' | null;
    }) => {
      const gate =
        input.gate === 'send' || input.gate === 'degrade'
          ? {
              ...gatedTraceEvent,
              seq: 2,
              event_key: 'run-evidence-01:gate:gated:2',
              status: input.gate === 'send' ? ('send' as const) : ('ok' as const),
              detail: {
                verdict: input.gate,
                outbox_kind: 'brief' as const,
                delivery_text_source: 'fallback' as const,
              },
              occurred_at: 3,
            }
          : {
              ...gatedTraceEvent,
              seq: 2,
              event_key: 'run-evidence-01:gate:gated:2',
              status: 'ok' as const,
              detail: {
                verdict: input.gate,
                reason: 'cooldown_active' as const,
                delivery_text_source: 'fallback' as const,
              },
              occurred_at: 3,
            };
      return {
        schema_version: 1,
        fixture_id: 'hey111:run-evidence-01',
        source_trace_id: 'run-evidence-01',
        hermetic: true,
        live_provider: false,
        trace: [baseTraceEvent, v2Context, gate, delivered, proactiveDone],
        fsm: doneFsm,
        outbox: [{ kind: input.outboxKind ?? 'brief', status: 'acked', attempts: 1 }],
        delivery_journal: {
          state: 'DONE',
          verdict: input.journal,
          completion_mode: input.completionMode ?? null,
        },
        current: { state: 'DONE', failure_reason: null },
        eval: {
          schema_version: 1,
          trace_id: 'run-evidence-01',
          run_id: 'run-evidence-01',
          result: 'pass',
          rules: passingRules,
          wis: { available: false, reason: 'not_observed_fake_first' },
        },
      } as const;
    };

    const validDegrade = fixture({ gate: 'degrade', journal: 'degrade' });
    expect(runtimeReplayFixtureSchema.safeParse(validDegrade).success).toBe(true);
    expect(
      runtimeDoneEvidenceMatchesDisposition(
        validDegrade.trace,
        validDegrade.outbox,
        validDegrade.delivery_journal,
      ),
    ).toBe(true);

    for (const contradiction of [
      fixture({ gate: 'hold', journal: 'send' }),
      fixture({ gate: 'drop', journal: 'send' }),
      fixture({ gate: 'send', journal: 'degrade' }),
      fixture({ gate: 'degrade', journal: 'send' }),
      fixture({ gate: 'send', journal: 'send', outboxKind: 'fetch_alert' }),
      fixture({ gate: 'send', journal: 'send', completionMode: 'trusted_internal_no_output' }),
    ]) {
      expect(runtimeReplayFixtureSchema.safeParse(contradiction).success).toBe(false);
      expect(
        runtimeDoneEvidenceMatchesDisposition(
          contradiction.trace,
          contradiction.outbox,
          contradiction.delivery_journal,
        ),
      ).toBe(false);
    }
  });

  it('rejects explicit V2 FAILED fixtures whose gate, journal, outbox, and receipt facts disagree', () => {
    const v2Context = {
      ...baseTraceEvent,
      seq: 1,
      event_key: 'run-evidence-01:context:context_built:1',
      family: 'context',
      event: 'context_built',
      status: 'ok',
      privacy: 'derived_summary',
      detail: {
        source: 'context-composer-v2',
        context_ref: 'ctx_11111111111111111111111111111111',
        source_count: 1,
        source_taint: null,
      },
      occurred_at: 2,
    } as const;
    const proactiveObserved = {
      ...baseTraceEvent,
      seq: 2,
      event_key: 'run-evidence-01:llm:llm_observed:2',
      family: 'llm',
      event: 'llm_observed',
      status: 'ok',
      privacy: 'operational_metadata',
      detail: {
        model: ROSTER.primary,
        fallback_step: 'configured_model',
        output_disposition: 'proactive_delivery',
      },
      occurred_at: 3,
    } as const;
    const fixture = (input: {
      gate: 'send' | 'degrade' | 'hold' | 'drop';
      journal: 'send' | 'degrade' | 'hold' | 'drop';
      delivered: boolean;
      acked?: boolean;
      failure?: 'replay:artifact_invalid' | 'context:materials_unavailable';
    }) => {
      const acked = input.acked ?? input.delivered;
      const gate =
        input.gate === 'send' || input.gate === 'degrade'
          ? {
              ...gatedTraceEvent,
              seq: 3,
              event_key: 'run-evidence-01:gate:gated:3',
              status: input.gate === 'send' ? ('send' as const) : ('ok' as const),
              detail: {
                verdict: input.gate,
                outbox_kind: 'brief' as const,
                delivery_text_source: 'fallback' as const,
              },
              occurred_at: 4,
            }
          : {
              ...gatedTraceEvent,
              seq: 3,
              event_key: 'run-evidence-01:gate:gated:3',
              status: 'ok' as const,
              detail: {
                verdict: input.gate,
                reason:
                  input.gate === 'hold'
                    ? ('cooldown_active' as const)
                    : ('once_ever_already_sent' as const),
                delivery_text_source: 'fallback' as const,
              },
              occurred_at: 4,
            };
      const delivery = {
        ...deliveredTraceEvent,
        seq: 4,
        event_key: 'run-evidence-01:delivery:delivered:4',
        occurred_at: 5,
      } as const;
      const failed = {
        schema_version: 1,
        trace_id: 'run-evidence-01',
        run_id: 'run-evidence-01',
        seq: input.delivered ? 5 : 4,
        event_key: input.delivered
          ? 'run-evidence-01:outcome:failed:5'
          : 'run-evidence-01:outcome:failed:4',
        family: 'outcome',
        event: 'failed',
        status: 'failed',
        privacy: 'operational_metadata',
        detail: {
          reason: input.failure ??
            (acked
              ? ('replay:artifact_invalid' as const)
            : input.gate === 'hold'
              ? ('delivery_gate:cooldown_active' as const)
              : input.gate === 'drop'
                ? ('delivery_gate:once_ever_already_sent' as const)
                : ('replay:artifact_invalid' as const)),
        },
        occurred_at: input.delivered ? 6 : 5,
      } as const;
      return {
        schema_version: 1,
        fixture_id: 'hey111:run-evidence-01',
        source_trace_id: 'run-evidence-01',
        hermetic: true,
        live_provider: false,
        trace: input.delivered
          ? [baseTraceEvent, v2Context, proactiveObserved, gate, delivery, failed]
          : [baseTraceEvent, v2Context, proactiveObserved, gate, failed],
        fsm: input.delivered
          ? ['PENDING', 'CONTEXT_BUILT', 'LLM_CALLED', 'TOOLS_DONE', 'GATED', 'DELIVERED', 'FAILED']
          : ['PENDING', 'CONTEXT_BUILT', 'LLM_CALLED', 'TOOLS_DONE', 'GATED', 'FAILED'],
        outbox: acked ? [{ kind: 'brief', status: 'acked', attempts: 1 }] : [],
        delivery_journal: {
          state: acked ? 'DONE' : 'FAILED',
          verdict: input.journal,
          completion_mode: null,
        },
        current: {
          state: 'FAILED',
          failure_reason: failed.detail.reason,
        },
        eval: {
          schema_version: 1,
          trace_id: 'run-evidence-01',
          run_id: 'run-evidence-01',
          result: 'pass',
          rules: passingRules,
          wis: { available: false, reason: 'not_observed_fake_first' },
        },
      } as const;
    };

    for (const valid of [
      fixture({ gate: 'hold', journal: 'hold', delivered: false }),
      fixture({ gate: 'drop', journal: 'drop', delivered: false }),
      fixture({ gate: 'send', journal: 'send', delivered: true }),
      fixture({ gate: 'degrade', journal: 'degrade', delivered: true }),
      fixture({ gate: 'send', journal: 'send', delivered: false, acked: true }),
      fixture({
        gate: 'send',
        journal: 'send',
        delivered: true,
        failure: 'context:materials_unavailable',
      }),
    ]) {
      expect(runtimeReplayFixtureSchema.safeParse(valid).success).toBe(true);
    }

    for (const contradiction of [
      fixture({ gate: 'hold', journal: 'send', delivered: true }),
      fixture({ gate: 'drop', journal: 'send', delivered: true }),
      fixture({ gate: 'send', journal: 'degrade', delivered: true }),
      fixture({ gate: 'degrade', journal: 'send', delivered: true }),
      fixture({
        gate: 'send',
        journal: 'send',
        delivered: false,
        acked: true,
        failure: 'context:materials_unavailable',
      }),
    ]) {
      expect(runtimeReplayFixtureSchema.safeParse(contradiction).success).toBe(false);
    }
  });

  it.each([
    ['solicited_reply', 'hold', 'cooldown_active', []],
    ['solicited_reply', 'drop', 'once_ever_already_sent', []],
    ['internal_no_output', 'send', undefined, [{ kind: 'brief', status: 'pending', attempts: 0 }]],
    ['internal_no_output', 'degrade', undefined, [{ kind: 'brief', status: 'pending', attempts: 0 }]],
  ] as const)(
    'rejects a V2 %s failure carrying forbidden proactive %s facts',
    (disposition, verdict, reason, outbox) => {
      const context = {
        ...baseTraceEvent,
        seq: 1,
        event_key: 'run-evidence-01:context:context_built:1',
        family: 'context',
        event: 'context_built',
        status: 'ok',
        privacy: 'derived_summary',
        detail: {
          source: 'context-composer-v2',
          context_ref: 'ctx_11111111111111111111111111111111',
          source_count: 1,
          source_taint: null,
        },
        occurred_at: 2,
      } as const;
      const observed = {
        ...baseTraceEvent,
        seq: 2,
        event_key: 'run-evidence-01:llm:llm_observed:2',
        family: 'llm',
        event: 'llm_observed',
        status: 'ok',
        privacy: 'operational_metadata',
        detail: {
          model: ROSTER.primary,
          fallback_step: 'configured_model',
          output_disposition: disposition,
        },
        occurred_at: 3,
      } as const;
      const gated =
        verdict === 'hold' || verdict === 'drop'
          ? {
              ...baseTraceEvent,
              seq: 3,
              event_key: 'run-evidence-01:gate:gated:3',
              family: 'gate',
              event: 'gated',
              status: 'ok',
              privacy: 'policy_metadata',
              detail: {
                verdict,
                reason,
                delivery_text_source: 'llm',
              },
              occurred_at: 4,
            }
          : {
              ...baseTraceEvent,
              seq: 3,
              event_key: 'run-evidence-01:gate:gated:3',
              family: 'gate',
              event: 'gated',
              status: verdict === 'send' ? 'send' : 'ok',
              privacy: 'policy_metadata',
              detail: {
                verdict,
                outbox_kind: 'brief',
                delivery_text_source: 'llm',
              },
              occurred_at: 4,
            };
      const failed = {
        ...baseTraceEvent,
        seq: 4,
        event_key: 'run-evidence-01:outcome:failed:4',
        family: 'outcome',
        event: 'failed',
        status: 'failed',
        privacy: 'operational_metadata',
        detail: {
          reason:
            verdict === 'hold'
              ? 'delivery_gate:cooldown_active'
              : verdict === 'drop'
                ? 'delivery_gate:once_ever_already_sent'
                : 'replay:artifact_invalid',
        },
        occurred_at: 5,
      } as const;
      const trace = [baseTraceEvent, context, observed, gated, failed].map((event) =>
        runtimeTraceEventSchema.parse(event),
      );
      const journal = { state: 'FAILED', verdict, completion_mode: null } as const;
      const fixture = {
        schema_version: 1,
        fixture_id: 'hey177:run-evidence-01',
        source_trace_id: 'run-evidence-01',
        hermetic: true,
        live_provider: false,
        evidence_flavor: 'trusted_v2',
        trace,
        fsm: ['PENDING', 'CONTEXT_BUILT', 'LLM_CALLED', 'TOOLS_DONE', 'GATED', 'FAILED'],
        outbox,
        delivery_journal: journal,
        current: { state: 'FAILED', failure_reason: failed.detail.reason },
        eval: {
          schema_version: 1,
          trace_id: 'run-evidence-01',
          run_id: 'run-evidence-01',
          result: 'pass',
          rules: passingRules,
          wis: { available: false, reason: 'not_observed_fake_first' },
        },
      } as const;

      expect(
        runtimeTerminalEvidenceMatchesDisposition(
          trace,
          outbox,
          journal,
          'FAILED',
          'trusted_v2',
        ),
      ).toBe(false);
      expect(runtimeReplayFixtureSchema.safeParse(fixture).success).toBe(false);
    },
  );

  it.each([
    ['hold', 'cooldown_active', []],
    ['drop', 'once_ever_already_sent', []],
    ['send', undefined, [{ kind: 'brief', status: 'pending', attempts: 0 }]],
    ['degrade', undefined, [{ kind: 'brief', status: 'pending', attempts: 0 }]],
  ] as const)(
    'rejects a V2 FAILED %s trace with proactive facts but no disposition witness',
    (verdict, reason, outbox) => {
      const context = {
        ...baseTraceEvent,
        seq: 1,
        event_key: 'run-evidence-01:context:context_built:1',
        family: 'context',
        event: 'context_built',
        status: 'ok',
        privacy: 'derived_summary',
        detail: {
          source: 'context-composer-v2',
          context_ref: 'ctx_11111111111111111111111111111111',
          source_count: 1,
          source_taint: null,
        },
        occurred_at: 2,
      } as const;
      const gated =
        verdict === 'hold' || verdict === 'drop'
          ? {
              ...baseTraceEvent,
              seq: 2,
              event_key: 'run-evidence-01:gate:gated:2',
              family: 'gate',
              event: 'gated',
              status: 'ok',
              privacy: 'policy_metadata',
              detail: { verdict, reason, delivery_text_source: 'llm' },
              occurred_at: 3,
            }
          : {
              ...baseTraceEvent,
              seq: 2,
              event_key: 'run-evidence-01:gate:gated:2',
              family: 'gate',
              event: 'gated',
              status: verdict === 'send' ? 'send' : 'ok',
              privacy: 'policy_metadata',
              detail: {
                verdict,
                outbox_kind: 'brief',
                delivery_text_source: 'llm',
              },
              occurred_at: 3,
            };
      const failed = {
        ...baseTraceEvent,
        seq: 3,
        event_key: 'run-evidence-01:outcome:failed:3',
        family: 'outcome',
        event: 'failed',
        status: 'failed',
        privacy: 'operational_metadata',
        detail: {
          reason:
            verdict === 'hold'
              ? 'delivery_gate:cooldown_active'
              : verdict === 'drop'
                ? 'delivery_gate:once_ever_already_sent'
                : 'replay:artifact_invalid',
        },
        occurred_at: 4,
      } as const;
      const trace = [baseTraceEvent, context, gated, failed].map((event) =>
        runtimeTraceEventSchema.parse(event),
      );
      const journal = { state: 'FAILED', verdict, completion_mode: null } as const;
      const fixture = {
        schema_version: 1,
        fixture_id: 'hey177:run-evidence-01',
        source_trace_id: 'run-evidence-01',
        hermetic: true,
        live_provider: false,
        evidence_flavor: 'trusted_v2',
        trace,
        fsm: ['PENDING', 'CONTEXT_BUILT', 'LLM_CALLED', 'TOOLS_DONE', 'GATED', 'FAILED'],
        outbox,
        delivery_journal: journal,
        current: { state: 'FAILED', failure_reason: failed.detail.reason },
        eval: {
          schema_version: 1,
          trace_id: 'run-evidence-01',
          run_id: 'run-evidence-01',
          result: 'pass',
          rules: passingRules,
          wis: { available: false, reason: 'not_observed_fake_first' },
        },
      } as const;

      expect(
        runtimeTerminalEvidenceMatchesDisposition(
          trace,
          outbox,
          journal,
          'FAILED',
          'trusted_v2',
        ),
      ).toBe(false);
      expect(runtimeReplayFixtureSchema.safeParse(fixture).success).toBe(false);
    },
  );

  it('preserves valid FAILED post-delivery recovery evidence', () => {
    const delivered = {
      ...deliveredTraceEvent,
      seq: 2,
      event_key: 'run-evidence-01:delivery:delivered:2',
      occurred_at: 3,
    } as const;
    const failed = {
      schema_version: 1,
      trace_id: 'run-evidence-01',
      run_id: 'run-evidence-01',
      seq: 3,
      event_key: 'run-evidence-01:outcome:failed:3',
      family: 'outcome',
      event: 'failed',
      status: 'failed',
      privacy: 'operational_metadata',
      detail: { reason: 'replay:artifact_invalid' },
      occurred_at: 4,
    } as const;
    expect(
      runtimeReplayFixtureSchema.safeParse({
        schema_version: 1,
        fixture_id: 'hey111:run-evidence-01',
        source_trace_id: 'run-evidence-01',
        hermetic: true,
        live_provider: false,
        trace: [baseTraceEvent, gatedTraceEvent, delivered, failed],
        fsm: ['PENDING', 'CONTEXT_BUILT', 'LLM_CALLED', 'TOOLS_DONE', 'GATED', 'DELIVERED', 'FAILED'],
        outbox: [{ kind: 'brief', status: 'acked', attempts: 1 }],
        delivery_journal: { state: 'FAILED', verdict: 'send', completion_mode: null },
        current: { state: 'FAILED', failure_reason: 'replay:artifact_invalid' },
        eval: {
          schema_version: 1,
          trace_id: 'run-evidence-01',
          run_id: 'run-evidence-01',
          result: 'pass',
          rules: passingRules,
          wis: { available: false, reason: 'not_observed_fake_first' },
        },
      }).success,
    ).toBe(true);
  });

  it('permits only a typed integrity failure after otherwise complete DONE delivery evidence', () => {
    const delivered = {
      ...deliveredTraceEvent,
      seq: 2,
      event_key: 'run-evidence-01:delivery:delivered:2',
      occurred_at: 3,
    } as const;
    const done = {
      ...doneTraceEvent,
      seq: 3,
      event_key: 'run-evidence-01:outcome:done:3',
      detail: { terminal: true, disposition: 'proactive_delivery' as const },
      occurred_at: 4,
    } as const;
    const failed = {
      schema_version: 1,
      trace_id: 'run-evidence-01',
      run_id: 'run-evidence-01',
      seq: 4,
      event_key: 'run-evidence-01:outcome:failed:4',
      family: 'outcome',
      event: 'failed',
      status: 'failed',
      privacy: 'operational_metadata',
      detail: { reason: 'replay:artifact_invalid' },
      occurred_at: 5,
    } as const;
    const fixture = {
      schema_version: 1,
      fixture_id: 'hey111:run-evidence-01',
      source_trace_id: 'run-evidence-01',
      hermetic: true,
      live_provider: false,
      trace: [baseTraceEvent, gatedTraceEvent, delivered, done, failed],
      fsm: ['PENDING', 'CONTEXT_BUILT', 'LLM_CALLED', 'TOOLS_DONE', 'GATED', 'DELIVERED', 'DONE', 'FAILED'],
      outbox: [{ kind: 'brief', status: 'acked', attempts: 1 }],
      delivery_journal: { state: 'DONE', verdict: 'send', completion_mode: null },
      current: { state: 'FAILED', failure_reason: 'replay:artifact_invalid' },
      eval: {
        schema_version: 1,
        trace_id: 'run-evidence-01',
        run_id: 'run-evidence-01',
        result: 'pass',
        rules: passingRules,
        wis: { available: false, reason: 'not_observed_fake_first' },
      },
    } as const;
    expect(runtimeReplayFixtureSchema.safeParse(fixture).success).toBe(true);
    expect(
      runtimeReplayFixtureSchema.safeParse({
        ...fixture,
        delivery_journal: { state: 'FAILED', verdict: 'send', completion_mode: null },
      }).success,
    ).toBe(false);
    expect(
      runtimeReplayFixtureSchema.safeParse({
        ...fixture,
        current: { state: 'FAILED', failure_reason: 'context:materials_unavailable' },
        trace: [
          ...fixture.trace.slice(0, -1),
          { ...failed, detail: { reason: 'context:materials_unavailable' as const } },
        ],
      }).success,
    ).toBe(false);
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
