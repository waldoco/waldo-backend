import { describe, expect, it } from 'vitest';
import {
  runtimeRunRowSchema,
  runtimeRunStateSchema,
  runtimeRunStateTransitions,
} from './run';

const baseRow = {
  run_id: 'run-1',
  user_id: 'user-1',
  trigger: 'fetch_alert',
  checkpoint_id: null,
  occurrence_at: 1_000,
  created_at: 1_000,
  updated_at: 1_000,
};

describe('runtimeRunState', () => {
  it('pins the ADR-0054 durable resume states in order', () => {
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
  });

  it('rejects the reduced tracer-only states', () => {
    expect(runtimeRunStateSchema.safeParse('RUN_OPENED').success).toBe(false);
    expect(runtimeRunStateSchema.safeParse('SINK_SENT').success).toBe(false);
  });
});

describe('runtimeRunStateTransitions', () => {
  it('advances one committed resume point at a time', () => {
    expect(runtimeRunStateTransitions.PENDING).toEqual(['CONTEXT_BUILT', 'FAILED']);
    expect(runtimeRunStateTransitions.CONTEXT_BUILT).toEqual(['LLM_CALLED', 'FAILED']);
    expect(runtimeRunStateTransitions.LLM_CALLED).toEqual(['TOOLS_DONE', 'FAILED']);
    expect(runtimeRunStateTransitions.TOOLS_DONE).toEqual(['GATED', 'FAILED']);
    expect(runtimeRunStateTransitions.GATED).toEqual(['DELIVERED', 'FAILED']);
    expect(runtimeRunStateTransitions.DELIVERED).toEqual(['DONE', 'FAILED']);
  });

  it('does not permit skipping the delivery gate', () => {
    expect(runtimeRunStateTransitions.TOOLS_DONE).not.toContain('DELIVERED');
    expect(runtimeRunStateTransitions.PENDING).not.toContain('GATED');
  });

  it('has no outgoing transitions from terminal states', () => {
    expect(runtimeRunStateTransitions.DONE).toEqual([]);
    expect(runtimeRunStateTransitions.FAILED).toEqual([]);
  });
});

describe('runtimeRunRow', () => {
  it('accepts a pre-gate row without a delivery verdict', () => {
    expect(
      runtimeRunRowSchema.safeParse({
        ...baseRow,
        state: 'PENDING',
        delivery_verdict: null,
      }).success,
    ).toBe(true);
  });

  it('accepts a checkpoint pointer without owning the checkpoint format', () => {
    expect(
      runtimeRunRowSchema.safeParse({
        ...baseRow,
        state: 'CONTEXT_BUILT',
        checkpoint_id: 'checkpoint-1',
        delivery_verdict: null,
      }).success,
    ).toBe(true);
  });

  it('accepts a delivery verdict only from GATED onward', () => {
    expect(
      runtimeRunRowSchema.safeParse({
        ...baseRow,
        state: 'GATED',
        delivery_verdict: 'send',
      }).success,
    ).toBe(true);
    expect(
      runtimeRunRowSchema.safeParse({
        ...baseRow,
        state: 'DELIVERED',
        delivery_verdict: 'hold',
      }).success,
    ).toBe(true);
  });

  it('rejects a delivery verdict before the gate commits', () => {
    expect(
      runtimeRunRowSchema.safeParse({
        ...baseRow,
        state: 'TOOLS_DONE',
        delivery_verdict: 'send',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown triggers and blank ids', () => {
    expect(
      runtimeRunRowSchema.safeParse({
        ...baseRow,
        trigger: 'unknown',
        state: 'PENDING',
        delivery_verdict: null,
      }).success,
    ).toBe(false);
    expect(
      runtimeRunRowSchema.safeParse({
        ...baseRow,
        run_id: '',
        state: 'PENDING',
        delivery_verdict: null,
      }).success,
    ).toBe(false);
  });
});
