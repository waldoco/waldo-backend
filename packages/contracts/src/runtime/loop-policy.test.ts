import { describe, expect, it } from 'vitest';
import {
  admissionVerdictSchema,
  autonomyLevelSchema,
  isNoProgress,
  killFlagScopeSchema,
  loopInvocationSchema,
  loopKillFlagSchema,
  loopPolicySchema,
  loopPriorityTierByType,
  loopProgressRowSchema,
  loopToolObservationSchema,
  loopTypeSchema,
  outboundTextPassesArt9Floor,
  socketResidencySchema,
} from './loop-policy';

const fullPolicy = {
  name: 'fetch-loop',
  loop_type: 'fetch',
  priority_tier: 1,
  max_tokens_per_run: 4_000,
  max_subagent_spawns_per_run: 0,
  max_iterations_per_run: 4,
  kill_flag_scope: 'loop',
  socket_residency: 'none',
  egress_gated: true,
  autonomy_level: 'L1',
  cooldown_ms: 7_200_000,
} as const;

describe('governor verdict', () => {
  it('stays the tracer admit | deny verdict, not the build-image prose verbs', () => {
    expect(admissionVerdictSchema.options).toEqual(['admit', 'deny']);
    for (const prose of ['drop', 'coalesce', 'degrade', 'hold']) {
      expect(admissionVerdictSchema.safeParse(prose).success).toBe(false);
    }
  });
});

describe('LoopPolicy manifest', () => {
  it('pins the enum vocabularies', () => {
    expect(loopTypeSchema.options).toEqual([
      'fetch',
      'intervention',
      'pre_activity_spot',
      'brief',
      'chat',
      'patrol',
      'dreaming',
      'routine',
    ]);
    expect(killFlagScopeSchema.options).toEqual(['loop', 'global']);
    expect(socketResidencySchema.options).toEqual(['active-chat-only', 'none']);
    expect(autonomyLevelSchema.options).toEqual(['L0', 'L1', 'L2', 'L3']);
  });

  it('accepts the full ADR-0074 policy shape', () => {
    expect(loopPolicySchema.safeParse(fullPolicy).success).toBe(true);
  });

  it('rejects the old minimal tracer policy as a full LoopPolicy', () => {
    expect(loopPolicySchema.safeParse({ name: 'tracer', admit: true }).success).toBe(false);
  });

  it('keeps active-chat-only socket residency on chat loops only', () => {
    expect(
      loopPolicySchema.safeParse({
        ...fullPolicy,
        loop_type: 'chat',
        socket_residency: 'active-chat-only',
      }).success,
    ).toBe(true);
    expect(
      loopPolicySchema.safeParse({
        ...fullPolicy,
        socket_residency: 'active-chat-only',
      }).success,
    ).toBe(false);
  });

  it('pins acute-health-first precedence', () => {
    expect(loopPriorityTierByType).toEqual({
      fetch: 1,
      intervention: 2,
      pre_activity_spot: 3,
      brief: 4,
      chat: 5,
      patrol: 5,
      dreaming: 5,
      routine: 5,
    });
  });
});

describe('loopProgressRow and no-progress guard', () => {
  it('accepts bounded counters and rejects impossible ratios', () => {
    expect(
      loopProgressRowSchema.safeParse({
        loop_name: 'patrol',
        occurrence_id: 'occ-1',
        call_count: 10,
        unique_param_hashes: 2,
        successes: 1,
        updated_at: 1_000,
      }).success,
    ).toBe(true);
    expect(
      loopProgressRowSchema.safeParse({
        loop_name: 'patrol',
        occurrence_id: 'occ-1',
        call_count: 1,
        unique_param_hashes: 2,
        successes: 0,
        updated_at: 1_000,
      }).success,
    ).toBe(false);
  });

  it('requires low diversity and low success before declaring no progress', () => {
    const stuck = {
      loop_name: 'patrol',
      occurrence_id: 'occ-1',
      call_count: 10,
      unique_param_hashes: 1,
      successes: 0,
      updated_at: 1_000,
    };
    expect(isNoProgress(stuck, 0.2, 0.2)).toBe(true);
    expect(isNoProgress({ ...stuck, successes: 8 }, 0.2, 0.2)).toBe(false);
    expect(isNoProgress({ ...stuck, unique_param_hashes: 8 }, 0.2, 0.2)).toBe(false);
  });
});

describe('loop tool observation and kill flag', () => {
  const hash = 'a'.repeat(64);

  it('accepts SHA-256 observation hashes', () => {
    expect(
      loopToolObservationSchema.safeParse({
        tool_name: 'read_memory',
        canonical_params_hash: hash,
        result_hash: hash,
      }).success,
    ).toBe(true);
  });

  it('rejects bad hashes and unknown tools', () => {
    expect(
      loopToolObservationSchema.safeParse({
        tool_name: 'read_memory',
        canonical_params_hash: 'x',
        result_hash: hash,
      }).success,
    ).toBe(false);
    expect(
      loopToolObservationSchema.safeParse({
        tool_name: 'made_up_tool',
        canonical_params_hash: hash,
        result_hash: hash,
      }).success,
    ).toBe(false);
  });

  it('accepts loop and global kill flags', () => {
    expect(
      loopKillFlagSchema.safeParse({
        scope: 'global',
        loop_name: null,
        active: true,
        updated_at: 1_000,
      }).success,
    ).toBe(true);
  });
});

describe('outbound Art-9 floor', () => {
  it('blocks obvious raw health values before external delivery', () => {
    expect(outboundTextPassesArt9Floor('HRV 42 and slept 5.5h')).toBe(false);
    expect(outboundTextPassesArt9Floor('heart rate: 110 bpm')).toBe(false);
    expect(outboundTextPassesArt9Floor('SpO2 95%')).toBe(false);
  });

  it('allows zone-word summaries', () => {
    expect(outboundTextPassesArt9Floor('Recovery looks compromised; keep the morning quiet.')).toBe(
      true,
    );
  });
});

describe('loopInvocation', () => {
  it('binds loop execution to an existing trigger and occurrence id', () => {
    expect(
      loopInvocationSchema.safeParse({
        trigger: 'fetch_alert',
        loop_name: 'fetch-loop',
        occurrence_id: 'occ-1',
      }).success,
    ).toBe(true);
  });
});
