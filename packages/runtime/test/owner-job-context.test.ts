import { expect, it } from 'vitest';
import { ownerJobSchema } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { ownerJobAdmission } from '../src/identity/surface-owner-admission';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';

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
