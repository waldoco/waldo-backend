import { describe, expect, it } from 'vitest';
import { buildSessionState, type LLMTool, type LLMToolCall } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { runToolLoop } from '../src/conversation/tool-loop';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { RUN_CLOSE_MARGIN_MS, TOOL_ROUNDS_PER_TURN_BUDGET } from '../src/llm/time-budget';
import { getContextHandler } from '../src/tools/live/get-context';

// A machine turn (a check-back, a scheduled job) runs inside the alarm that claimed it, so it gets the alarm's time less the
// close margin, not a flat two minutes. It gives way at its next round when the owner's own message is waiting.
const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-10-21T08:20:00Z') };
const ctx = () => ({ authenticatedUserId: 'owner-1', trigger: 'user_message' as const, canaryTokens: CANARIES, sourceTaint: null, toolArgSourceTaint: null,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }) });
const look = (round: number): LLMToolCall => ({ call_id: `look-${round}`, name: 'get_context', arguments: '{}' });

describe('a machine turn gives way to the owner', () => {
  it('once yieldNow says so, the next step is offered no tools and its words are the reply', async () => {
    const offered: Array<readonly LLMTool[] | undefined> = [];
    let waiting = false;
    const text = await runToolLoop({
      handlers: [getContextHandler(clock)], ctx: ctx(), maxSteps: 50, yieldNow: () => waiting,
      step: async (tools) => { offered.push(tools); if (offered.length === 2) waiting = true; return tools ? { text: '', tool_calls: [look(offered.length)] } : { text: 'Checked; nothing moved.' }; },
    });
    expect(text).toBe('Checked; nothing moved.');
    expect(offered.map((tools) => tools === undefined)).toEqual([false, false, true]);
  });

  it('without a waiting owner it runs on', async () => {
    let round = 0;
    const text = await runToolLoop({ handlers: [getContextHandler(clock)], ctx: ctx(), maxSteps: 50, yieldNow: () => false,
      step: async () => (++round <= 5 ? { text: '', tool_calls: [look(round)] } : { text: 'done' }) });
    expect(text).toBe('done');
    expect(round).toBe(6);
  });
});

describe('a machine turn on the alarm\'s time', () => {
  const steps = (rounds: number) => {
    const requests: LLMGatewayRequest[] = [];
    const gateway: LLMGatewayAdapter = { complete: async (input) => {
      requests.push(input);
      const base = { model: input.request.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 };
      const done = input.request.tool_turns?.length ?? 0;
      return done < rounds && input.request.tools?.length ? { ok: true, data: { ...base, text: '', tool_calls: [look(done)] } } : { ok: true, data: { ...base, text: 'All checked.' } };
    } };
    return { gateway, requests };
  };
  const responder = (gateway: LLMGatewayAdapter, machineTime?: () => Readonly<{ deadline: number; yieldNow(): boolean }> | undefined) => {
    const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture-openai', anthropicApiKey: 'fixture-anthropic', primary: 'openai', floorReply: true }];
    args[4] = clock; args[5] = [getContextHandler(clock)]; args[10] = gateway; args[16] = ['example.com']; args[18] = ['👌'];
    if (machineTime) args[21] = { machineTime };
    return createOwnerResponder(...args);
  };
  const job = (machineTime?: () => Readonly<{ deadline: number; yieldNow(): boolean }> | undefined) => {
    const { gateway, requests } = steps(40);
    return responder(gateway, machineTime).prompt('job-1', 'owner', 'Check the vendor thread and report.', async (_hop, work) => work(), undefined, ['get_context'])
      .then((reply) => ({ reply, rounds: requests.at(-1)!.request.tool_turns?.length ?? 0 }));
  };

  it('takes more than two minutes\' rounds when the alarm has ten minutes left', async () => {
    const { reply, rounds } = await job(() => ({ deadline: Date.now() + 10 * 60_000 - RUN_CLOSE_MARGIN_MS, yieldNow: () => false }));
    expect(reply).toBe('All checked.');
    expect(rounds).toBe(40);
  });

  it('keeps the two-minute budget outside an alarm', async () => {
    const { rounds } = await job();
    expect(rounds).toBe(TOOL_ROUNDS_PER_TURN_BUDGET);
  });

  it('gives way at its next round when the owner\'s message is waiting', async () => {
    let calls = 0;
    const { reply, rounds } = await job(() => ({ deadline: Date.now() + 10 * 60_000, yieldNow: () => ++calls > 3 }));
    expect(reply).toBe('All checked.');
    expect(rounds).toBeLessThan(6);
  });
});
