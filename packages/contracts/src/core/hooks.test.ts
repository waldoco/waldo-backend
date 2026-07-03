// Owning ADRs: ADR-0032 (9-event hook order, locked priorities, independent traversal,
// halt semantics) + ADR-0049 accepted amendment (taint→privileged-action gate) + ADR-0024/
// ADR-0034 (sanitise before compression on PostToolUse) + ADR-0018 (autonomy gate).
// Invariant under test: the 9-event enum in firing order (the enum, not the ADR title's
// stale count of 7, is the contract); event-discriminated strict payloads whose model
// vocabulary resolves through model/roster only (the legacy adapters/llm import is a
// rejected framing); halt-only failure results coded from core/error; the verbatim
// numbered Pre/PostToolUse priorities; and TWO separate named gates — autonomy pinned at
// PreToolUse 300, taint unpinned — whose runtime ordering/merger is recorded as open.
// Failure mode caught: enum or priority drift the runtime runner would inherit as a
// reordered or skipped safety layer; a payload admitting a non-roster model id or a
// non-canonical error code; a non-halting failure branch; the taint gate silently merged
// into (or numbered among) the six PreToolUse slots before the dispatcher decision.
import { describe, expect, it } from 'vitest';
import { sourceTaintSchema } from '../memory/sanitise';
import { ROSTER } from '../model/roster';
import {
  AUTONOMY_GATE,
  DEFAULT_HOOK_TIMEOUT_MS,
  hookEventSchema,
  hookGateSchema,
  hookPayloadSchema,
  hookResultSchema,
  invocationOutcomeSchema,
  POST_TOOL_USE_PRIORITIES,
  PRE_TOOL_USE_PRIORITIES,
  TAINT_PRIVILEGED_ACTION_GATE,
  taintGateTrips,
} from './hooks';

const basePreLLM = { event: 'PreLLMCall', messages: [], model: ROSTER.primary } as const;
const basePostLLM = {
  event: 'PostLLMCall',
  response: { text: 'ok' },
  tokens_in: 1_200,
  tokens_out: 340,
} as const;
const basePreTool = { event: 'PreToolUse', tool: 'get_crs', args: {} } as const;
const basePostTool = { event: 'PostToolUse', tool: 'get_crs', result: {}, latency_ms: 42 } as const;

describe('hookEvent', () => {
  it('is exactly the nine canonical events, in firing order', () => {
    expect(hookEventSchema.options).toEqual([
      'OnInvocationStart',
      'PrePromptBuild',
      'PostPromptBuild',
      'PreLLMCall',
      'PostLLMCall',
      'PreToolUse',
      'PostToolUse',
      'OnError',
      'OnInvocationEnd',
    ]);
  });

  it('rejects an event outside the nine', () => {
    expect(hookEventSchema.safeParse('BeforeTool').success).toBe(false);
  });
});

describe('invocationOutcome', () => {
  it('is exactly the three outcomes, in order', () => {
    expect(invocationOutcomeSchema.options).toEqual(['success', 'fallback', 'failure']);
  });

  it('rejects an out-of-domain outcome', () => {
    expect(invocationOutcomeSchema.safeParse('error').success).toBe(false);
  });
});

describe('hookPayload', () => {
  const validPayloads = [
    { event: 'OnInvocationStart', trace_id: 'trace-01' },
    { event: 'PrePromptBuild' },
    { event: 'PostPromptBuild', prompt: 'canvas' },
    basePreLLM,
    basePostLLM,
    basePreTool,
    basePostTool,
    { event: 'OnError', error: 'boom', code: 'transient' },
    { event: 'OnInvocationEnd', outcome: 'success' },
  ] as const;

  it('carries exactly one variant per hook event, in enum order', () => {
    expect(validPayloads.map((p) => p.event)).toEqual([...hookEventSchema.options]);
  });

  it.each(validPayloads)('accepts a valid $event payload', (payload) => {
    expect(hookPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects an unknown event discriminator', () => {
    expect(hookPayloadSchema.safeParse({ event: 'BeforeTool' }).success).toBe(false);
  });

  it('rejects a non-roster model id on PreLLMCall', () => {
    expect(
      hookPayloadSchema.safeParse({ ...basePreLLM, model: 'not-a-roster-model' }).success,
    ).toBe(false);
  });

  it('rejects a negative token count on PostLLMCall', () => {
    expect(hookPayloadSchema.safeParse({ ...basePostLLM, tokens_in: -1 }).success).toBe(false);
  });

  it('rejects a fractional token count (integers only)', () => {
    expect(hookPayloadSchema.safeParse({ ...basePostLLM, tokens_out: 1.5 }).success).toBe(false);
  });

  it('rejects a fractional latency_ms (integer milliseconds only)', () => {
    expect(hookPayloadSchema.safeParse({ ...basePostTool, latency_ms: 4.2 }).success).toBe(false);
  });

  it('rejects an empty tool name on PreToolUse', () => {
    expect(hookPayloadSchema.safeParse({ ...basePreTool, tool: '' }).success).toBe(false);
  });

  it('rejects an empty trace_id on OnInvocationStart', () => {
    expect(
      hookPayloadSchema.safeParse({ event: 'OnInvocationStart', trace_id: '' }).success,
    ).toBe(false);
  });

  it('rejects an empty prompt on PostPromptBuild', () => {
    expect(hookPayloadSchema.safeParse({ event: 'PostPromptBuild', prompt: '' }).success).toBe(
      false,
    );
  });

  it('rejects a non-canonical error code on OnError', () => {
    expect(
      hookPayloadSchema.safeParse({ event: 'OnError', error: 'boom', code: 'unknown' }).success,
    ).toBe(false);
  });

  it('rejects a stale outcome literal on OnInvocationEnd', () => {
    expect(
      hookPayloadSchema.safeParse({ event: 'OnInvocationEnd', outcome: 'error' }).success,
    ).toBe(false);
  });

  it('rejects a field leaked from another variant (strict payloads)', () => {
    expect(
      hookPayloadSchema.safeParse({ event: 'PrePromptBuild', prompt: 'canvas' }).success,
    ).toBe(false);
  });
});

describe('hookResult', () => {
  it('accepts a pass-through result without a payload', () => {
    expect(hookResultSchema.safeParse({ ok: true }).success).toBe(true);
  });

  it('accepts a full replacement payload', () => {
    expect(hookResultSchema.safeParse({ ok: true, payload: basePreTool }).success).toBe(true);
  });

  it('accepts a coded halt', () => {
    expect(
      hookResultSchema.safeParse({ ok: false, halt: true, reason: 'timeout', code: 'transient' })
        .success,
    ).toBe(true);
  });

  it('rejects a failure that does not halt (halt is literal true)', () => {
    expect(
      hookResultSchema.safeParse({ ok: false, halt: false, reason: 'timeout', code: 'transient' })
        .success,
    ).toBe(false);
  });

  it('rejects a halt without a machine-readable code', () => {
    expect(hookResultSchema.safeParse({ ok: false, halt: true, reason: 'timeout' }).success).toBe(
      false,
    );
  });

  it('rejects a non-canonical halt code', () => {
    expect(
      hookResultSchema.safeParse({ ok: false, halt: true, reason: 'timeout', code: 'denied' })
        .success,
    ).toBe(false);
  });

  it('rejects an empty halt reason', () => {
    expect(
      hookResultSchema.safeParse({ ok: false, halt: true, reason: '', code: 'transient' }).success,
    ).toBe(false);
  });

  it('rejects an extra field on the pass branch (strict objects)', () => {
    expect(hookResultSchema.safeParse({ ok: true, reason: 'noise' }).success).toBe(false);
  });
});

describe('DEFAULT_HOOK_TIMEOUT_MS', () => {
  it('is the ADR-0032 per-hook fallback budget', () => {
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(100);
  });
});

describe('locked tool-dispatch priorities', () => {
  it('PreToolUse slots are the six ADR-0032 gates, numbered in order', () => {
    expect(Object.entries(PRE_TOOL_USE_PRIORITIES)).toEqual([
      ['tool_in_acl_check', 100],
      ['tool_arg_zod_validate', 200],
      ['autonomy_gate_check', 300],
      ['rate_limit_per_tool', 400],
      ['egress_allowlist_check', 500],
      ['tool_audit_log_pre', 600],
    ]);
  });

  it('PostToolUse slots are the four ADR-0032 gates, numbered in order', () => {
    expect(Object.entries(POST_TOOL_USE_PRIORITIES)).toEqual([
      ['tool_result_sanitise', 100],
      ['tool_output_compression', 200],
      ['tool_audit_log_post', 300],
      ['effectiveness_signal_capture', 400],
    ]);
  });

  it('sanitise runs before compression (ADR-0034 corrected order)', () => {
    expect(POST_TOOL_USE_PRIORITIES.tool_result_sanitise).toBeLessThan(
      POST_TOOL_USE_PRIORITIES.tool_output_compression,
    );
  });
});

describe('the two privileged-action gates — separate, merger open', () => {
  it('autonomy gate is pinned at PreToolUse 300', () => {
    expect(hookGateSchema.safeParse(AUTONOMY_GATE).success).toBe(true);
    expect(AUTONOMY_GATE.name).toBe('autonomy_gate_check');
    expect(AUTONOMY_GATE.events).toEqual(['PreToolUse']);
    expect(AUTONOMY_GATE.priority).toBe(PRE_TOOL_USE_PRIORITIES.autonomy_gate_check);
  });

  it('taint gate parses with an unpinned slot (open dispatcher decision)', () => {
    expect(hookGateSchema.safeParse(TAINT_PRIVILEGED_ACTION_GATE).success).toBe(true);
    expect(TAINT_PRIVILEGED_ACTION_GATE.name).toBe('taint_privileged_action_gate');
    expect(TAINT_PRIVILEGED_ACTION_GATE.events).toEqual(['PreToolUse', 'PostToolUse']);
    expect(TAINT_PRIVILEGED_ACTION_GATE.priority).toBe(null);
  });

  it('taint gate is ADDITIONAL — never one of the numbered slots', () => {
    expect(Object.keys(PRE_TOOL_USE_PRIORITIES)).not.toContain(TAINT_PRIVILEGED_ACTION_GATE.name);
    expect(Object.keys(POST_TOOL_USE_PRIORITIES)).not.toContain(TAINT_PRIVILEGED_ACTION_GATE.name);
  });

  it('does NOT encode a merged privileged-action gate', () => {
    // Whether the two gates merge is the open decision; the contract records them separate,
    // so a build that collapses them must change this test consciously.
    expect(AUTONOMY_GATE.name).not.toBe(TAINT_PRIVILEGED_ACTION_GATE.name);
  });

  it('rejects a zero priority (numbered slots are positive)', () => {
    expect(
      hookGateSchema.safeParse({ name: 'gate', events: ['PreToolUse'], priority: 0 }).success,
    ).toBe(false);
  });

  it('rejects an empty events list', () => {
    expect(hookGateSchema.safeParse({ name: 'gate', events: [], priority: null }).success).toBe(
      false,
    );
  });
});

describe('taintGateTrips', () => {
  it('trips exactly on the sanitise-owned external taint', () => {
    expect(taintGateTrips(sourceTaintSchema.parse('external'))).toBe(true);
    expect(taintGateTrips(sourceTaintSchema.parse(null))).toBe(false);
  });
});
