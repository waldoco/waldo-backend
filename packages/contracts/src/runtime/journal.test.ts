import { describe, expect, it } from 'vitest';
import { journalRowSchema, runStateSchema, runStateTransitions } from './journal';

// ADR-0054: durable journal rows must remain readable after any legal terminal transition.
const baseRow = {
  run_id: 'run-1',
  user_id: 'user-1',
  trigger: 'fetch_alert',
  gate_reason: null,
  occurrence_at: 1_000,
  created_at: 1_000,
  updated_at: 1_000,
};

describe('runState', () => {
  it('is the reduced tracer FSM, in order', () => {
    expect(runStateSchema.options).toEqual([
      'RUN_OPENED',
      'GOVERNOR_ADMITTED',
      'GATED',
      'SINK_SENT',
      'ACK_RECORDED',
      'DONE',
      'FAILED',
    ]);
  });

  it('rejects an unknown state', () => {
    expect(runStateSchema.safeParse('LLM_CALLED').success).toBe(false);
  });
});

describe('runStateTransitions', () => {
  it('advances the one path forward, with FAILED reachable from every non-terminal state', () => {
    expect(runStateTransitions.RUN_OPENED).toEqual(['GOVERNOR_ADMITTED', 'FAILED']);
    expect(runStateTransitions.GOVERNOR_ADMITTED).toEqual(['GATED', 'FAILED']);
    expect(runStateTransitions.ACK_RECORDED).toEqual(['DONE', 'FAILED']);
  });

  it('has no outgoing transitions from terminal states', () => {
    expect(runStateTransitions.DONE).toEqual([]);
    expect(runStateTransitions.FAILED).toEqual([]);
  });

  it('does not permit skipping GOVERNOR_ADMITTED (RUN_OPENED -> GATED is illegal)', () => {
    expect(runStateTransitions.RUN_OPENED).not.toContain('GATED');
  });
});

describe('journalRow', () => {
  it('accepts a well-formed pre-verdict row', () => {
    expect(
      journalRowSchema.safeParse({ ...baseRow, state: 'RUN_OPENED', verdict: null }).success,
    ).toBe(true);
  });

  it('rejects arbitrary trigger text in the reduced runtime journal', () => {
    expect(
      journalRowSchema.safeParse({
        ...baseRow,
        trigger: 'user said HRV 42',
        state: 'RUN_OPENED',
        verdict: null,
      }).success,
    ).toBe(false);
  });

  it('accepts a verdict once the row is GATED or later before terminal failure', () => {
    expect(
      journalRowSchema.safeParse({ ...baseRow, state: 'GATED', verdict: 'send' }).success,
    ).toBe(true);
    expect(
      journalRowSchema.safeParse({ ...baseRow, state: 'DONE', verdict: 'send' }).success,
    ).toBe(true);
  });

  it('accepts FAILED rows with or without a prior committed verdict', () => {
    expect(
      journalRowSchema.safeParse({ ...baseRow, state: 'FAILED', verdict: null }).success,
    ).toBe(true);
    expect(
      journalRowSchema.safeParse({ ...baseRow, state: 'FAILED', verdict: 'send' }).success,
    ).toBe(true);
  });

  it('requires a closed gate reason for non-send verdicts', () => {
    expect(
      journalRowSchema.safeParse({
        ...baseRow,
        state: 'FAILED',
        verdict: 'hold',
        gate_reason: 'cooldown_active',
      }).success,
    ).toBe(true);
    expect(
      journalRowSchema.safeParse({
        ...baseRow,
        state: 'FAILED',
        verdict: 'drop',
        gate_reason: null,
      }).success,
    ).toBe(false);
    expect(
      journalRowSchema.safeParse({
        ...baseRow,
        state: 'GATED',
        verdict: 'degrade',
        gate_reason: 'budget_cap_exhausted',
      }).success,
    ).toBe(true);
    expect(
      journalRowSchema.safeParse({
        ...baseRow,
        state: 'GATED',
        verdict: 'send',
        gate_reason: 'cooldown_active',
      }).success,
    ).toBe(false);
  });

  it('rejects a verdict set before GATED', () => {
    expect(
      journalRowSchema.safeParse({ ...baseRow, state: 'GOVERNOR_ADMITTED', verdict: 'send' })
        .success,
    ).toBe(false);
  });

  it('rejects missing verdicts once a non-terminal row is GATED or later', () => {
    expect(journalRowSchema.safeParse({ ...baseRow, state: 'GATED', verdict: null }).success).toBe(
      false,
    );
    expect(
      journalRowSchema.safeParse({ ...baseRow, state: 'SINK_SENT', verdict: null }).success,
    ).toBe(false);
    expect(journalRowSchema.safeParse({ ...baseRow, state: 'DONE', verdict: null }).success).toBe(
      false,
    );
  });

  it('accepts a null-verdict DONE row only with the durable trusted no-output discriminator', () => {
    expect(
      journalRowSchema.safeParse({
        ...baseRow,
        state: 'DONE',
        verdict: null,
        completion_mode: 'trusted_internal_no_output',
      }).success,
    ).toBe(true);
    expect(
      journalRowSchema.safeParse({
        ...baseRow,
        state: 'FAILED',
        verdict: null,
        completion_mode: 'trusted_internal_no_output',
      }).success,
    ).toBe(false);
  });

  it('accepts any known runtime trigger, not only fetch_alert', () => {
    expect(
      journalRowSchema.safeParse({
        ...baseRow,
        trigger: 'pre_activity_spot',
        state: 'RUN_OPENED',
        verdict: null,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown state and a null run_id', () => {
    expect(
      journalRowSchema.safeParse({ ...baseRow, state: 'BOGUS', verdict: null }).success,
    ).toBe(false);
    expect(
      journalRowSchema.safeParse({ ...baseRow, run_id: '', state: 'RUN_OPENED', verdict: null })
        .success,
    ).toBe(false);
  });
});
