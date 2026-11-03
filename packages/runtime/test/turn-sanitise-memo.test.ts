import { describe, expect, it } from 'vitest';
import { buildSessionState, type LLMRequest, type LLMToolTurn, type SanitiseInput } from '@waldo/contracts';
import type { HookRuntimeContext } from '../src/hooks/registry';
import { RuntimeLLMProvider, TurnSanitiseMemo, type LLMGatewayAdapter } from '../src/llm/provider';
import { sanitise } from '../src/scribe/sanitiser';

// An owner turn re-sends its system prompt and history on every tool round. Within one turn the sanitiser result for an
// exact input is reused; anything that changes the input (text, canaries, taint, budget) is scanned again.
const canaries = ['1111111111111111', '2222222222222222', '3333333333333333'];
const otherCanaries = ['4444444444444444', '5555555555555555', '6666666666666666'];
const SYSTEM = 'You are Waldo. Be concise.\n\n' + 'Stable instructions. '.repeat(400);
const history = [{ role: 'user' as const, content: 'earlier question' }, { role: 'assistant' as const, content: 'earlier reply' }, { role: 'user' as const, content: 'what is on today?' }];
const turn = (index: number, output: string): LLMToolTurn => ({ call: { call_id: `call-${index}`, name: 'read_thread', arguments: '{}' }, output, source_taint: 'external' });

const recordingGateway = () => {
  const requests: LLMRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    requests.push(request);
    return { ok: true, data: { model: request.model, text: 'ok', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
  } };
  return { requests, gateway };
};
const counted = () => {
  const calls: SanitiseInput[] = [];
  return { calls, sanitise: (input: SanitiseInput) => { calls.push(input); return sanitise(input); } };
};
const ctxWith = (overrides: Partial<HookRuntimeContext>, tokens = canaries): HookRuntimeContext => ({
  authenticatedUserId: 'user-1', trigger: 'brief', canaryTokens: tokens,
  session: buildSessionState({ trigger: 'brief', canary_tokens: tokens, started_at: 1_700_000_000_000 }),
  sourceTaint: null, toolArgSourceTaint: null, sanitise, ...overrides,
});
const round = (gateway: LLMGatewayAdapter, ctx: HookRuntimeContext, turns: LLMToolTurn[], messages = history, sanitiseMemo?: TurnSanitiseMemo) => new RuntimeLLMProvider({ gateway, ...(sanitiseMemo ? { sanitiseMemo } : {}) }).complete({
  trigger: 'brief',
  renderRequest: () => ({ system: SYSTEM, messages, max_tokens: 512, temperature: 0.2, ...(turns.length ? { tool_turns: turns } : {}) }),
}, ctx);
const scans = (calls: readonly SanitiseInput[], payload: unknown) => calls.filter((call) => JSON.stringify(call.payload) === JSON.stringify(payload)).length;

describe('turn-scoped sanitisation memo', () => {
  it('scans the system prompt, the history and each earlier tool result once across a turn\'s rounds', async () => {
    const { calls, sanitise: sanitiseCounted } = counted();
    const { gateway } = recordingGateway();
    const ctx = ctxWith({ sanitise: sanitiseCounted });
    const memo = new TurnSanitiseMemo();
    const turns = [turn(1, 'Thread one says hello.'), turn(2, 'Thread two says goodbye.'), turn(3, 'Thread three is short.')];
    for (let rounds = 0; rounds <= turns.length; rounds += 1) expect((await round(gateway, ctx, turns.slice(0, rounds), history, memo)).ok).toBe(true);
    expect(scans(calls, SYSTEM)).toBe(1);
    expect(scans(calls, history)).toBe(1);
    expect(scans(calls, [turns[0]])).toBe(1);
  });

  it('sends byte-identical requests with and without the memo', async () => {
    const turns = [turn(1, 'Thread one: reach me at someone@example.com.'), turn(2, 'Thread two says goodbye.')];
    const send = async (memo?: TurnSanitiseMemo) => {
      const { requests, gateway } = recordingGateway();
      const ctx = ctxWith({});
      for (let rounds = 0; rounds <= turns.length; rounds += 1) await round(gateway, ctx, turns.slice(0, rounds), history, memo);
      return JSON.stringify(requests);
    };
    expect(await send(new TurnSanitiseMemo())).toBe(await send());
  });

  it('scans again when the canaries change mid-turn, and denies the text that now carries one', async () => {
    const { calls, sanitise: sanitiseCounted } = counted();
    const { gateway } = recordingGateway();
    const memo = new TurnSanitiseMemo();
    const carrying = [...history.slice(0, -1), { role: 'user' as const, content: `what is on today? ${otherCanaries[0]}` }];
    expect((await round(gateway, ctxWith({ sanitise: sanitiseCounted }), [], carrying, memo)).ok).toBe(true);
    const rotated = await round(gateway, ctxWith({ sanitise: sanitiseCounted }, otherCanaries), [], carrying, memo);
    expect(rotated.ok).toBe(false);
    expect(scans(calls, SYSTEM)).toBe(2);
  });

  it('scans again when a forget changes the history mid-turn, and never serves the earlier text', async () => {
    const { calls, sanitise: sanitiseCounted } = counted();
    const { requests, gateway } = recordingGateway();
    const ctx = ctxWith({ sanitise: sanitiseCounted });
    const memo = new TurnSanitiseMemo();
    const forgotten = [{ role: 'user' as const, content: '[forgotten]' }, ...history.slice(1)];
    await round(gateway, ctx, [], history, memo);
    await round(gateway, ctx, [], forgotten, memo);
    expect(scans(calls, forgotten)).toBe(1);
    expect(requests[1]!.messages).toEqual(forgotten);
  });

  it('scans again when the taint of the same text changes', async () => {
    const { calls, sanitise: sanitiseCounted } = counted();
    const { gateway } = recordingGateway();
    const memo = new TurnSanitiseMemo();
    await round(gateway, ctxWith({ sanitise: sanitiseCounted }), [], history, memo);
    await round(gateway, ctxWith({ sanitise: sanitiseCounted, sourceTaint: 'external' }), [], history, memo);
    expect(scans(calls, history)).toBe(2);
  });

  it('hands every caller its own copy, so a caller that changes a result cannot change the next round', async () => {
    const memo = new TurnSanitiseMemo();
    const input = { payload: [{ role: 'user', content: 'hello' }], destination: 'internal_context', canary_tokens: canaries, source_taint: null } as const satisfies SanitiseInput;
    const first = await memo.result(sanitise, input);
    if (!first.ok) throw new Error('fixture denied');
    (first.payload as Array<{ content: string }>)[0]!.content = 'changed';
    expect(await memo.result(sanitise, input)).toMatchObject({ ok: true, payload: [{ role: 'user', content: 'hello' }] });
  });

  it('does not keep a failed scan, and does not reuse results across sanitiser functions', async () => {
    const memo = new TurnSanitiseMemo();
    const input = { payload: 'hello', destination: 'system_prompt', canary_tokens: canaries, source_taint: null } as const satisfies SanitiseInput;
    let failures = 1;
    const flaky = (value: SanitiseInput) => { if (failures-- > 0) throw new Error('unavailable'); return sanitise(value); };
    await expect(memo.result(flaky, input)).rejects.toThrow('unavailable');
    await expect(memo.result(flaky, input)).resolves.toMatchObject({ ok: true });
    const other = counted();
    await memo.result(other.sanitise, input);
    expect(other.calls).toHaveLength(1);
  });
});
