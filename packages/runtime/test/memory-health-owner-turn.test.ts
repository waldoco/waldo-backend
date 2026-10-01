import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ writerModels: [] as string[], writerInputs: [] as string[], replyModels: [] as string[], replyInputs: [] as string[], addOp: '' }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  const b = body as { model: string; text?: { format?: { type: string } } };
  const writer = b.text?.format?.type === 'json_schema';
  if (writer) { seen.writerModels.push(b.model); seen.writerInputs.push(JSON.stringify(body)); } else { seen.replyModels.push(b.model); seen.replyInputs.push(JSON.stringify(body)); }
  return { id: 'fixture', output_text: writer ? seen.addOp : 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { claimStore } = await import('../src/memory/claims');
const { OPENAI_GPT_6_LUNA_MODEL } = await import('@waldo/contracts');

// Owner-turn path, model-call fixture (synthetic values, scripted writer output, mocked provider):
// owner message -> writer call (model + input) -> applyClaimOps -> next turn's reply prompt.
// Observed: one owner turn made two writer calls (both on the memory model) and the reply model is also gpt-6-luna here, so this does not show writer/reply separation. Not covered: a real writer model deciding what to record; no live provider.
const SAID = 'my HbA1c was 9.1 last week and I take metformin 500mg';
const op = (evidence: string) => JSON.stringify({ add: [{ kind: 'health', text: 'HbA1c was 9.1 last week; takes metformin 500mg', source: 'stated', evidence, touches_forgotten: false }], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null });

it('the writer sees the owner message, runs on the memory model, and the next reply prompt carries the exact values', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('owner-turn-health')), async (_i, state) => {
    const store = claimStore(state.storage.sql);
    const responder = createOwnerResponder('fixture', undefined, store as never);
    const turn = (traceId: string, text: string) => responder.respond({ traceId, conversationRef: 'owner', surface: 'telegram', text }, (_n, work) => work());
    seen.addOp = op(`owner, tg-1: "${SAID}"`);
    await turn('tg-1', `I should note ${SAID}`);
    expect(new Set(seen.writerModels)).toEqual(new Set([OPENAI_GPT_6_LUNA_MODEL]));
    expect(seen.writerInputs[0]).toContain('HbA1c was 9.1');
    seen.addOp = op('x');
    seen.writerInputs = [];
    await turn('tg-2', 'what was my HbA1c?');
    const reply = seen.replyInputs.at(-1)!;
    expect(reply).toContain('9.1');
    expect(reply).toContain('metformin 500mg');
  });
});
