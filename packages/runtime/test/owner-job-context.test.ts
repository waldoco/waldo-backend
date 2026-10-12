import { expect, it } from 'vitest';
import { ownerJobSchema } from '@waldo/contracts';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { ownerJobAdmission } from '../src/identity/surface-owner-admission';

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
