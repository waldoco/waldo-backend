import { describe, expect, it } from 'vitest';
import {
  RUNTIME_RUN_STATE_SEQUENCE,
  canonicalRuntimeRunIdempotencySerialization,
  runtimeRunCanAdvance,
  runtimeRunIdempotencyInputSchema,
  runtimeRunRecordSchema,
  runtimeRunStateSchema,
  runtimeRunStateTransitions,
} from './run';

const baseRecord = {
  run_id: 'run-1',
  user_id: 'user-1',
  trigger: 'brief' as const,
  variant: 'morning' as const,
  state: 'PENDING' as const,
  step: 0,
  attempts: 0,
  run_nonce: 'message-1',
  context_json: null,
  scratch_json: null,
  created_at: 1_000,
  updated_at: 1_000,
  next_expected_wake: null,
  failure_reason: null,
};

describe('runtimeRunState', () => {
  it('pins the full ADR-0054 run journal states in order', () => {
    expect(runtimeRunStateSchema.options).toEqual([
      'PENDING',
      'CONTEXT_BUILT',
      'LLM_CALLED',
      'TOOLS_DONE',
      'GATED',
      'DELIVERED',
      'DONE',
      'FAILED',
    ]);
    expect(RUNTIME_RUN_STATE_SEQUENCE).toEqual(runtimeRunStateSchema.options);
  });

  it('rejects reduced tracer-only states', () => {
    expect(runtimeRunStateSchema.safeParse('RUN_OPENED').success).toBe(false);
    expect(runtimeRunStateSchema.safeParse('GOVERNOR_ADMITTED').success).toBe(false);
  });
});

describe('runtimeRunStateTransitions', () => {
  it('allows the journal path and the no-tools/no-send fast paths', () => {
    expect(runtimeRunStateTransitions.PENDING).toEqual(['CONTEXT_BUILT', 'FAILED']);
    expect(runtimeRunStateTransitions.LLM_CALLED).toEqual(['TOOLS_DONE', 'GATED', 'FAILED']);
    expect(runtimeRunStateTransitions.GATED).toEqual(['DELIVERED', 'DONE', 'FAILED']);
    expect(runtimeRunCanAdvance('LLM_CALLED', 'GATED')).toBe(true);
    expect(runtimeRunCanAdvance('GATED', 'DONE')).toBe(true);
  });

  it('does not permit skipped or terminal transitions', () => {
    expect(runtimeRunCanAdvance('PENDING', 'GATED')).toBe(false);
    expect(runtimeRunCanAdvance('DONE', 'FAILED')).toBe(false);
    expect(runtimeRunCanAdvance('FAILED', 'PENDING')).toBe(false);
  });
});

describe('runtimeRunRecord', () => {
  it('accepts a well-formed active run record', () => {
    expect(runtimeRunRecordSchema.safeParse(baseRecord).success).toBe(true);
  });

  it('requires FAILED to be the only state with a failure reason', () => {
    expect(
      runtimeRunRecordSchema.safeParse({ ...baseRecord, state: 'DONE', failure_reason: 'oops' })
        .success,
    ).toBe(false);
    expect(runtimeRunRecordSchema.safeParse({ ...baseRecord, state: 'FAILED' }).success).toBe(
      false,
    );
    expect(
      runtimeRunRecordSchema.safeParse({
        ...baseRecord,
        state: 'FAILED',
        failure_reason: 'provider_unavailable',
      }).success,
    ).toBe(true);
  });

  it('rejects time-travel updates and raw-health fields', () => {
    expect(runtimeRunRecordSchema.safeParse({ ...baseRecord, updated_at: 999 }).success).toBe(
      false,
    );
    expect(runtimeRunRecordSchema.safeParse({ ...baseRecord, hrv_ms: 42 }).success).toBe(false);
  });
});

describe('runtimeRunIdempotencyInput', () => {
  it('accepts message-nonce and scheduled-occurrence identity inputs', () => {
    expect(
      runtimeRunIdempotencyInputSchema.safeParse({
        kind: 'message_nonce',
        user_id: 'user-1',
        trigger: 'user_message',
        variant: null,
        run_nonce: 'msg-123',
      }).success,
    ).toBe(true);
    expect(
      runtimeRunIdempotencyInputSchema.safeParse({
        kind: 'scheduled_occurrence',
        user_id: 'user-1',
        trigger: 'brief',
        variant: 'morning',
        schedule_id: 'brief:morning',
        occurrence_at: 1_000,
      }).success,
    ).toBe(true);
  });

  it('serializes identity inputs in a stable order that preserves occurrence identity', () => {
    const serialized = canonicalRuntimeRunIdempotencySerialization({
      kind: 'scheduled_occurrence',
      user_id: 'user-1',
      trigger: 'brief',
      variant: 'morning',
      schedule_id: 'brief:morning',
      occurrence_at: 1_000,
    });

    expect(serialized).toBe(
      JSON.stringify([
        ['kind', 'scheduled_occurrence'],
        ['user_id', 'user-1'],
        ['trigger', 'brief'],
        ['variant', 'morning'],
        ['schedule_id', 'brief:morning'],
        ['occurrence_at', 1_000],
      ]),
    );
    expect(serialized).not.toContain('15min');
  });

  it('rejects extra bucket-style identity fields', () => {
    expect(
      runtimeRunIdempotencyInputSchema.safeParse({
        kind: 'message_nonce',
        user_id: 'user-1',
        trigger: 'brief',
        variant: 'morning',
        run_nonce: 'nonce-1',
        bucket_15m: 1_000,
      }).success,
    ).toBe(false);
  });
});
