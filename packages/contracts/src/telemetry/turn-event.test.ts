import { describe, expect, it } from 'vitest';
import {
  TURN_EVENT_SCHEMA_VERSION,
  costKindSchema,
  executionRungSchema,
  rungBlockedReasonSchema,
  turnEventSchema,
  turnOutcomeSchema,
  turnTelemetryFreeOfText,
} from './turn-event';

const minimal = { trace: 'tg-1', hop: 'llm_reply', ms: 12, ok: true };

describe('turn event schema v9', () => {
  it('pins the schema version and the ladder, outcome and cost vocabularies', () => {
    expect(TURN_EVENT_SCHEMA_VERSION).toBe('9');
    expect(executionRungSchema.options).toEqual(['memory', 'connector', 'email', 'fetch', 'browser', 'sandbox', 'mac', 'human']);
    expect(rungBlockedReasonSchema.options).toEqual(['approval_required', 'policy_denied', 'budget_exhausted', 'unavailable', 'auth_required', 'timed_out', 'unsupported', 'on_hold']);
    expect(turnOutcomeSchema.options).toEqual(['answered', 'completed', 'failed', 'dropped', 'delivery_pending', 'blocked']);
    expect(costKindSchema.options).toEqual(['turn', 'background', 'worker', 'heartbeat', 'eval']);
  });

  it('accepts every v8 field unchanged', () => {
    const v8 = {
      ...minimal, owner: 'do-1', owner_id: '10000000-0000-0000-0000-00000000000a', owner_email: 'a@test.invalid', owner_identity: 'verified',
      principal: 'prn_x', error: 'boom', detail: 'd', code: 'transient:x', guard: 'g', cost_kind: 'turn', responsibility_id: 'r1',
      usage: { model: 'm', input: 10, output: 2, cached: 4, web_searches: 1 },
      shape: { system_bytes: 1, request_bytes: 2, context: { tools_count: 3, tools_bytes: 400, tool_turns_bytes: 0, history_messages: 1, history_bytes: 9, current_bytes: 3, attachments: 0, system_sections: { behavior: 1 } } },
      text: { input: 'hi', output: 'yo', reasoning: 'r' },
    };
    expect(turnEventSchema.parse(v8)).toEqual(v8);
  });

  it('accepts the v9 additions as optional, typed fields', () => {
    const v9 = {
      ...minimal,
      tools_called: 2, parallel_batches: 1, rung: 'connector', blocked_reason: 'approval_required', job_id: 'job_01HZX', job_profile: 'reader',
      browser_ms: 0, sandbox_ms: 0, error_code: 'rate_limited', provider: 'openai', fallback_fired: false, ttft_ms: 420, outcome: 'answered',
      usage: { model: 'm', input: 10, output: 2, cached: 4 },
      shape: { system_bytes: 1, request_bytes: 2, context: { tools_count: 3, tools_bytes: 400, tools_tokens_est: 100, tool_turns_bytes: 0, history_messages: 1, history_bytes: 9, current_bytes: 3, attachments: 0 } },
    };
    expect(turnEventSchema.parse(v9)).toEqual(v9);
    expect(turnEventSchema.parse(minimal)).toEqual(minimal);
  });

  it('carries the voice block version on a call as a count, never text', () => {
    const shape = { system_bytes: 1, request_bytes: 2, voice_version: 2 };
    expect(turnEventSchema.parse({ ...minimal, shape })).toEqual({ ...minimal, shape });
    expect(turnEventSchema.safeParse({ ...minimal, shape: { ...shape, voice_version: 'v2' } }).success).toBe(false);
    expect(turnEventSchema.safeParse({ ...minimal, shape: { ...shape, voice_version: -1 } }).success).toBe(false);
  });

  it('rejects free text or unknown enum members in the v9 fields', () => {
    expect(turnEventSchema.safeParse({ ...minimal, rung: 'telepathy' }).success).toBe(false);
    expect(turnEventSchema.safeParse({ ...minimal, outcome: 'meh' }).success).toBe(false);
    expect(turnEventSchema.safeParse({ ...minimal, job_id: 'the owner said hello' }).success).toBe(false);
    expect(turnEventSchema.safeParse({ ...minimal, job_profile: 'Reader Profile (v2)' }).success).toBe(false);
    expect(turnEventSchema.safeParse({ ...minimal, error_code: 'OpenAI said: boom!' }).success).toBe(false);
    expect(turnEventSchema.safeParse({ ...minimal, tools_called: -1 }).success).toBe(false);
    expect(turnEventSchema.safeParse({ ...minimal, ttft_ms: Number.NaN }).success).toBe(false);
  });

  it('names the fields that may carry free text, so sinks know what to gate', () => {
    expect(turnTelemetryFreeOfText({ ...minimal, error: 'x', detail: 'y', text: { input: 'z' }, guard: 'g', owner_email: 'e' })).toEqual({ ...minimal });
    expect(turnTelemetryFreeOfText({ ...minimal, rung: 'mac', tools_called: 1 })).toEqual({ ...minimal, rung: 'mac', tools_called: 1 });
  });
});
