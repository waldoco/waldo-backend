import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_LUNA_MODEL, type LLMRequest } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { claimStore, type ClaimStore } from '../src/memory/claims';
import { ownerTyped } from './helpers/owner-typed';

const NO_CLAIM_OPS = JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null });
const ANSWERS: Readonly<Record<string, string>> = { reaction: '{"reaction":"👌"}', thread_title: '{"title":"Weekend plans"}', claim_ops: NO_CLAIM_OPS };
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const scope = (): RunEffectScope => ({ runId: 'title-run', attempt: 'title-attempt', deadline: Date.now() + 60_000, signal: new AbortController().signal, admit: () => undefined, commit: work => work() });

// A responder with the production model defaults, whose gateway records the model and effort of every call it receives.
const responder = (memory?: ClaimStore) => {
  const requests: LLMRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    requests.push(request);
    const text = ANSWERS[request.response_format?.name ?? ''] ?? 'Done.';
    return { ok: true, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
  } };
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[2] = memory; args[10] = gateway; args[18] = ['👌'];
  return { requests, owner: createOwnerResponder(...args), routed: () => requests.map(request => [request.model, request.reasoning_effort]) };
};
const SOL_MEDIUM = [OPENAI_GPT_6_1_SOL_MODEL, 'medium'];
const LUNA_LOW = [OPENAI_GPT_6_LUNA_MODEL, 'low'];

it('an owner turn asks Sol at medium effort', async () => {
  const { owner, routed } = responder();
  await owner.respond(ownerTyped({ traceId: 'route-owner-1', conversationRef: 'telegram-1', surface: 'telegram', text: 'find me a quiet hotel near the venue for Friday', memoryWrites: false }), time);
  expect(routed()).toEqual([SOL_MEDIUM]);
});

it('choosing a reaction and titling a thread ask Luna at low effort', async () => {
  const { owner, routed } = responder();
  await owner.chooseReaction(ownerTyped({ traceId: 'route-reaction-1', conversationRef: 'telegram-1', surface: 'telegram', text: 'thanks, that works' }));
  await owner.threadTitle('route-title-1', 'owner: plan my weekend\nwaldo: Here is a plan.', scope());
  expect(routed()).toEqual([LUNA_LOW, LUNA_LOW]);
});

it('nightly memory consolidation asks Luna at low effort', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('model-routing-memory')), async (_instance, state) => {
    const { owner, routed } = responder(claimStore(state.storage.sql, work => state.storage.transactionSync(work)));
    await owner.consolidate('nightly:route', 'owner: I swim every Friday before work');
    expect(routed()).toEqual([LUNA_LOW]);
  });
});

it('a reminder, a scheduled job, a background decision and the day plan ask Luna at low effort', async () => {
  const { owner, routed } = responder();
  await owner.remind('route-reminder-1', 'telegram-1', 'call Sam', time, 'telegram');
  await owner.prompt('route-job-1', 'telegram-1', 'Write the morning card from these facts: two meetings, one open loop.', time, 'telegram');
  await owner.prompt('route-decision-1', 'telegram-1', 'Is this meeting worth a prep note?', time, 'telegram', [], async () => undefined, { name: 'decision', schema: { type: 'object' } });
  await owner.planDay('route-plan-1', 'Plan the day around two meetings.');
  expect(routed()).toEqual([LUNA_LOW, LUNA_LOW, LUNA_LOW, LUNA_LOW]);
});
