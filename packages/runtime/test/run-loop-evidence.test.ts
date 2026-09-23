import type { RuntimeReplayFixture } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { scoreRuntimeFixture } from '../src/run-loop/evidence';

describe('RunLoop evidence scoring', () => {
  it('does not score a forged no-effect solicited DONE fixture as delivery-consistent', () => {
    // The contracts parser rejects this fixture before normal use. Score it anyway as a hostile
    // in-memory input so this runtime-side defense cannot drift from the contract predicate.
    const forged = {
      source_trace_id: 'run-evidence-01',
      trace: [
        {
          seq: 0,
          event: 'scheduled_wake',
          detail: { trigger: 'brief', schedule_ref: 'brief:test', occurrence_at: 1 },
        },
        {
          seq: 1,
          event: 'done',
          detail: { terminal: true, disposition: 'solicited_reply' },
        },
      ],
      outbox: [],
      delivery_journal: { state: 'DONE', verdict: null, completion_mode: null },
      current: { state: 'DONE', failure_reason: null },
    } as unknown as RuntimeReplayFixture;

    const scored = scoreRuntimeFixture(forged);
    expect(scored.result).toBe('fail');
    expect(scored.rules.find((rule) => rule.id === 'outbox_consistency')).toMatchObject({
      status: 'fail',
    });
  });

  it('does not score a forged V2 FAILED hold with an acknowledged delivery as consistent', () => {
    // Contract parsing rejects this fixture. Score the hostile in-memory shape as well so the
    // runtime evaluator cannot reintroduce the DONE-only loophole independently.
    const forged = {
      source_trace_id: 'run-evidence-01',
      evidence_flavor: 'trusted_v2',
      trace: [
        {
          seq: 0,
          event: 'scheduled_wake',
          detail: { trigger: 'brief', schedule_ref: 'brief:test', occurrence_at: 1 },
        },
        {
          seq: 1,
          event: 'context_built',
          detail: {
            source: 'context-composer-v2',
            context_ref: 'ctx_11111111111111111111111111111111',
            source_count: 1,
            source_taint: null,
          },
        },
        {
          seq: 2,
          event: 'gated',
          detail: {
            verdict: 'hold',
            reason: 'cooldown_active',
            delivery_text_source: 'llm',
          },
        },
        { seq: 3, event: 'delivered', detail: { sink: 'fake', status: 'acked' } },
        { seq: 4, event: 'failed', detail: { reason: 'replay:artifact_invalid' } },
      ],
      outbox: [{ kind: 'brief', status: 'acked', attempts: 1 }],
      delivery_journal: { state: 'FAILED', verdict: 'send', completion_mode: null },
      current: { state: 'FAILED', failure_reason: 'replay:artifact_invalid' },
    } as unknown as RuntimeReplayFixture;

    const scored = scoreRuntimeFixture(forged);
    expect(scored.result).toBe('fail');
    expect(scored.rules.find((rule) => rule.id === 'outbox_consistency')).toMatchObject({
      status: 'fail',
    });
  });
});
