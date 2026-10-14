import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ownerJobSchema } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { OwnerResponder } from '../src/channels/owner-turn-envelope';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { ownerJobAdmission } from '../src/identity/surface-owner-admission';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore, type ClaimStore } from '../src/memory/claims';

const OWNER = '10000000-0000-0000-0000-000000000001';
const CANARIES = ['0123456789abcdef', '1123456789abcdef', '2123456789abcdef'];

it.each(ownerJobSchema.options)('a scheduled %s job composes as its admitted owner, with the job behaviour', async (job) => {
  const admission = await ownerJobAdmission({ lookup: async () => ({ ownerId: OWNER, bindingRef: 'runtime:owner-demo', revision: '5', physicalDoId: 'actual-do' }),
    expectedPhysicalDoId: 'actual-do', job, occurrenceKey: `${job}:1`, occurredAt: Date.now() - 1 });
  const context = createOwnerTurnContext(admission);
  const composed = await context.composer.compose(context.invocation, { ...context.snapshot(), canary_tokens: CANARIES, replay_context_ref: null });
  expect(composed.ok).toBe(true);
  if (!composed.ok) return;
  expect(composed.prompt).toContain('Authenticated owner prn_10000000000000000000000000000001');
  expect(composed.prompt).toContain('scheduled job');
  expect(composed.prompt).not.toContain('Respond to the current owner request');
  expect(context.conversationRef).toBe('owner:prn_10000000000000000000000000000001');
});

it('an admitted job carries the host\'s owner profile line in its composed context, once', async () => {
  const line = 'From the owner\'s Google account, not yet confirmed by the owner: their name is "Ada Fixture".';
  const admission = await ownerJobAdmission({ lookup: async () => ({ ownerId: OWNER, bindingRef: 'runtime:owner-demo', revision: '5', physicalDoId: 'actual-do' }),
    expectedPhysicalDoId: 'actual-do', job: 'reminder', occurrenceKey: 'rem-1:1', occurredAt: Date.now() - 1 });
  const requests: LLMGatewayRequest['request'][] = [];
  const gateway: LLMGatewayAdapter = { complete: async request => {
    requests.push(request.request);
    return { ok: true, data: { model: request.request.model, text: 'Time to call Sam.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const responder = createOwnerResponder('fixture', undefined, undefined, undefined, undefined, [], undefined, false, undefined, undefined, gateway,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { jobHost: { admit: async () => admission, chain: (_admission, surfaceChain) => surfaceChain }, ownerProfile: async () => line });
  await responder.remind('rem-1:1', 'telegram-7', 'call Sam', async (_hop, work) => work(), 'telegram');
  expect(requests).toHaveLength(1);
  expect(requests[0]!.system).toContain('Authenticated owner prn_10000000000000000000000000000001');
  expect(requests[0]!.system!.split(line).length - 1).toBe(1);
});

// A dreaming job's memory writes are effects, so each reads the job's authority afresh after its model call: an owner whose
// binding changes while the model drafts the change gets nothing written.
const ops = (partial: Record<string, unknown>) => JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, ...partial });
const SAID = 'I swim every Friday before work';
const LEARNED = ops({ add: [{ kind: 'fact', text: 'Swims every Friday before work', source: 'stated', evidence: `"${SAID}"`, touches_forgotten: false, aliases: [], aliases_touch_forgotten: false }] });
const memoryWrites: readonly (readonly [string, (store: ClaimStore) => string, (responder: OwnerResponder) => Promise<unknown>])[] = [
  ['consolidate', () => LEARNED, responder => responder.consolidate('nightly:1', SAID)],
  ['migrate', () => LEARNED, responder => responder.migrate('nightly:1', SAID)],
  ['promote', store => {
    store.add({ kind: 'pattern', text: 'Short sleep before busy days', source: 'stated', evidence: 'first', origin: 'owner' }, '2026-09-24T04:00:00Z');
    store.add({ kind: 'observation', text: 'Low energy after busy evenings', source: 'stated', evidence: 'second', origin: 'owner' }, '2026-09-25T04:00:00Z');
    const supports = store.claims().map(claim => claim.id);
    for (const id of supports) store.seen(id, '2026-09-26T04:00:00Z');
    return JSON.stringify({ nodes: [{ id: null, domain: 'sleep', label: 'Busy-day sleep', summary: 'Owner supported', strength: 0.8, status: 'active', durable: true,
      reason: 'lasting owner pattern', supporting_spots: supports }], edges: [], promoted: supports });
  }, responder => responder.promote('nightly:1')],
];
it.each(memoryWrites)('a dreaming job\'s %s writes nothing when the owner\'s binding changes during its model call', async (name, seed, call) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`job-memory-${name}`)), async (_instance, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    const reply = seed(store);
    const before = JSON.stringify([store.claims(), store.nodes()]);
    let revision = '5';
    // A fixed clock keeps the cached check inside its window, so only a fresh read can see the change.
    const at = Date.parse('2026-10-14T03:00:00Z');
    const admission = await ownerJobAdmission({ lookup: async () => ({ ownerId: OWNER, bindingRef: 'runtime:owner-demo', revision, physicalDoId: 'actual-do' }),
      expectedPhysicalDoId: 'actual-do', job: 'dreaming', occurrenceKey: 'nightly:1', occurredAt: at - 1, now: () => at });
    const gateway: LLMGatewayAdapter = { complete: async request => {
      revision = '6';
      return { ok: true, data: { model: request.request.model, text: reply, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    } };
    const responder = createOwnerResponder('fixture', undefined, store, undefined, undefined, [], undefined, false, undefined, undefined, gateway,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { jobHost: { admit: async () => admission, chain: (_admission, surfaceChain) => surfaceChain } });
    await expect(call(responder)).rejects.toMatchObject({ code: 'rejected' });
    expect(JSON.stringify([store.claims(), store.nodes()])).toBe(before);
  });
});
