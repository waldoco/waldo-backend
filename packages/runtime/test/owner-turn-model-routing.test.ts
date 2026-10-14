import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_LUNA_MODEL, type LLMRequest } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { ConversationStore } from '../src/channels/conversation-store';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { COMPACTION } from '../src/conversation/compaction';
import { ownerJobAdmission } from '../src/identity/surface-owner-admission';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { claimStore, type ClaimStore } from '../src/memory/claims';
import { localTrustedBriefScheduleInput } from '../src/run-loop/adapters';
import { ownerTyped } from './helpers/owner-typed';

const NO_CLAIM_OPS = JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null });
const ANSWERS: Readonly<Record<string, string>> = { reaction: '{"reaction":"👌"}', thread_title: '{"title":"Weekend plans"}', claim_ops: NO_CLAIM_OPS };
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const scope = (runId: string): RunEffectScope => ({ runId, attempt: `${runId}-attempt`, deadline: Date.now() + 60_000, signal: new AbortController().signal, admit: () => undefined, commit: work => work() });

// A responder with the production model defaults, whose gateway records the model and effort of every call it receives.
const responder = ({ store, memory, privateOwner }: { store?: ConversationStore; memory?: ClaimStore; privateOwner?: Parameters<typeof createOwnerResponder>[21] } = {}) => {
  const requests: LLMRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    requests.push(request);
    const text = ANSWERS[request.response_format?.name ?? ''] ?? 'Done.';
    return { ok: true, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
  } };
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[1] = store; args[2] = memory; args[10] = gateway; args[18] = ['👌']; args[21] = privateOwner;
  return { requests, owner: createOwnerResponder(...args), routed: () => requests.map(request => [request.model, request.reasoning_effort]) };
};
const SOL_MEDIUM = [OPENAI_GPT_6_1_SOL_MODEL, 'medium'];
const LUNA_LOW = [OPENAI_GPT_6_LUNA_MODEL, 'low'];

it('an owner turn asks Sol at medium effort', async () => {
  const { owner, routed } = responder();
  await owner.respond(ownerTyped({ traceId: 'route-owner-1', conversationRef: 'telegram-1', surface: 'telegram', text: 'find me a quiet hotel near the venue for Friday', memoryWrites: false }), time);
  expect(routed()).toEqual([SOL_MEDIUM]);
});

// Production turns carry their run's scope, so they run in a responder rebuilt for that scope; so does their reaction.
it('an owner turn and its reaction in their own run scope keep Sol at medium and Luna at low', async () => {
  const { owner, routed } = responder();
  await owner.respond(ownerTyped({ traceId: 'route-scoped-1', conversationRef: 'telegram-1', surface: 'telegram', text: 'book the cheaper of the two hotels', memoryWrites: false, runScope: scope('owner-run') }), time);
  await owner.chooseReaction(ownerTyped({ traceId: 'route-scoped-2', conversationRef: 'telegram-1', surface: 'telegram', text: 'great, thanks', runScope: scope('reaction-run') }));
  expect(routed()).toEqual([SOL_MEDIUM, LUNA_LOW]);
});

it('choosing a reaction and titling a thread ask Luna at low effort', async () => {
  const { owner, routed } = responder();
  await owner.chooseReaction(ownerTyped({ traceId: 'route-reaction-1', conversationRef: 'telegram-1', surface: 'telegram', text: 'thanks, that works' }));
  await owner.threadTitle('route-title-1', 'owner: plan my weekend\nwaldo: Here is a plan.', scope('title-run'));
  expect(routed()).toEqual([LUNA_LOW, LUNA_LOW]);
});

it('nightly memory consolidation asks Luna at low effort', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('model-routing-memory')), async (_instance, state) => {
    const { owner, routed } = responder({ memory: claimStore(state.storage.sql, work => state.storage.transactionSync(work)) });
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

// After a turn in its own run scope, compaction runs in the responder rebuilt for that turn.
it('compacting the history of owner turns that ran in their own run scope asks Luna at low effort', async () => {
  const defaults = { ...COMPACTION };
  Object.assign(COMPACTION, { enabled: true, budgetTokens: 160, minOwnerRows: 2, minIntervalMs: 0 });
  try {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('model-routing-compaction')), async (_instance, state) => {
      const store = canonicalOwnerConversationStore(state.storage, { invocation: localTrustedBriefScheduleInput().admission as never, assertCurrent: async () => undefined });
      const { owner, routed } = responder({ store });
      for (let n = 1; n <= 6; n += 1) await owner.respond(ownerTyped({ traceId: `route-compact-${n}`, conversationRef: 'owner', surface: 'app', text: `Question ${n}: ${'q'.repeat(90)}`, runScope: scope(`compact-run-${n}`) }), time);
      await owner.compactIfDue!('owner');
      expect(routed()).toEqual([...Array(6).fill(SOL_MEDIUM), LUNA_LOW]);
    });
  } finally { Object.assign(COMPACTION, defaults); }
});

// A deployed owner's reminders and jobs run in a responder rebuilt for the owner the job host admits.
it('a reminder for an admitted owner asks Luna at low effort', async () => {
  const admission = await ownerJobAdmission({ lookup: async () => ({ ownerId: '10000000-0000-0000-0000-000000000001', bindingRef: 'runtime:owner-demo', revision: '5', physicalDoId: 'actual-do' }),
    expectedPhysicalDoId: 'actual-do', job: 'reminder', occurrenceKey: 'route-reminder-2:1', occurredAt: Date.now() - 1 });
  const { owner, routed } = responder({ privateOwner: { jobHost: { admit: async () => admission, chain: (_admission, surfaceChain) => surfaceChain } } });
  await owner.remind('route-reminder-2:1', 'telegram-7', 'call Sam', time, 'telegram');
  expect(routed()).toEqual([LUNA_LOW]);
});

// Reasoning tokens count against max_output_tokens; OpenAI's reasoning guide asks for at least 25,000 tokens of room.
it('gives a Sol owner turn 25,000 output tokens of room and keeps a Luna auxiliary call at 4,096', async () => {
  const { owner, requests } = responder();
  await owner.respond(ownerTyped({ traceId: 'route-room-1', conversationRef: 'telegram-1', surface: 'telegram', text: 'compare three hotels near the venue', memoryWrites: false }), time);
  await owner.chooseReaction(ownerTyped({ traceId: 'route-room-2', conversationRef: 'telegram-1', surface: 'telegram', text: 'perfect' }));
  expect(requests.map(request => [request.model, request.reasoning_effort, request.max_tokens])).toEqual([[...SOL_MEDIUM, 25_000], [...LUNA_LOW, 4_096]]);
});
