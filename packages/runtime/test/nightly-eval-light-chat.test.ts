import { expect, it } from 'vitest';
import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { LIGHT_CHAT_SCENARIOS } from '../evals/nightly/light-chat-scenarios';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import { runTrial } from '../evals/nightly/trial';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { scriptedGateway } from '../src/testing/scripted-gateway';

// The light-chat set's deterministic half: its trials run the owner's turns with WALDO_LIGHT_CHAT on, count each light step
// and hand-over, and a trial whose light model answered a plan or health ask itself fails its receipt. Whether a live light
// model hands over is the live run's measure (light_handovers / light_steps).
const scenario = (id: string) => LIGHT_CHAT_SCENARIOS.find((entry) => entry.id === id)!;
// The light step is the request that offers escalate. It hands over or answers, as `light` says; the chat model's steps
// are the scripted ones.
const gateway = (light: 'escalate' | 'answer'): LLMGatewayAdapter & Readonly<{ lightCalls: () => number }> => {
  const chat = scriptedGateway({ rules: [], unmatchedText: 'Here is the plan: board prep at eleven, and the open time after lunch is yours.' });
  let lightCalls = 0;
  return {
    lightCalls: () => lightCalls,
    complete: async (input) => {
      if (!input.request.tools?.some((tool) => tool.name === 'escalate')) return chat.complete(input);
      lightCalls += 1;
      const base = { model: input.request.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 };
      return { ok: true, data: light === 'escalate' ? { ...base, text: '', tool_calls: [{ call_id: `light-${lightCalls}`, name: 'escalate', arguments: '{}' }] } : { ...base, text: 'Any time.' } };
    },
  };
};

it('registers the light-chat set in the full catalogue, outside the capped live subset, with the switch on', () => {
  expect(LIGHT_CHAT_SCENARIOS.map((entry) => entry.id)).toEqual(['lc-h10-provisional-how-am-i-doing', 'lc-h11-plan-tomorrow-low-form', 'lc-t20-health-aware-plan', 'lc-plan-the-afternoon', 'lc-quick-thanks']);
  for (const entry of LIGHT_CHAT_SCENARIOS) {
    expect(NIGHTLY_SCENARIOS).toContain(entry);
    expect(entry.light_chat).toBe(true);
    expect(entry.live_subset).toBeUndefined();
  }
});

it('a day plan handed over counts one light step and one hand-over, and passes its receipts', async () => {
  const model = gateway('escalate');
  const record = await runTrial(scenario('lc-plan-the-afternoon'), { gateway: model, budget: callBudget(40), model: WALDO_CHAT_MODEL });
  expect(record.status).toBe('ran');
  expect(model.lightCalls()).toBe(1);
  expect(record.light_routes).toEqual(['escalated']);
  expect(record.metrics).toMatchObject({ light_steps: 1, light_handovers: 1 });
  expect(failedReceipts([...STATE_INVARIANTS, ...scenario('lc-plan-the-afternoon').receipts!], record)).toEqual([]);
});

it('a day plan the light model answered itself fails the hand-over receipt; quick chat may stay light', async () => {
  const kept = await runTrial(scenario('lc-plan-the-afternoon'), { gateway: gateway('answer'), budget: callBudget(40), model: WALDO_CHAT_MODEL });
  expect(kept.metrics).toMatchObject({ light_steps: 1, light_handovers: 0 });
  expect(failedReceipts(scenario('lc-plan-the-afternoon').receipts!, kept)).toEqual(['every owner turn handed its light step to the chat model']);

  const thanks = await runTrial(scenario('lc-quick-thanks'), { gateway: gateway('answer'), budget: callBudget(40), model: WALDO_CHAT_MODEL });
  expect(thanks.light_routes).toEqual(['answered']);
  expect(failedReceipts([...STATE_INVARIANTS, ...scenario('lc-quick-thanks').receipts!], thanks)).toEqual([]);
});

it('a scenario without the switch takes no light step', async () => {
  const model = gateway('escalate');
  const { light_chat: _on, ...off } = scenario('lc-plan-the-afternoon');
  const record = await runTrial(off, { gateway: model, budget: callBudget(40), model: WALDO_CHAT_MODEL });
  expect(model.lightCalls()).toBe(0);
  expect(record.metrics).toMatchObject({ light_steps: 0, light_handovers: 0 });
});
