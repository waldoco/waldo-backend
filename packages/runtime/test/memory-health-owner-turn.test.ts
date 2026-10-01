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
// The two writer calls in one turn are traced below: the first writer output is halted by the
// medical_gate (it contains a dose) and owner-turn re-asks with CLINICAL_REDIRECT. Not covered: a real writer model deciding what to record; no live provider.
const SAID = 'my HbA1c was 9.1 last week and I take metformin 500mg';
const SAID_LAB = 'my HbA1c was 9.1 last week';
const op = (evidence: string, text = 'HbA1c was 9.1 last week; takes metformin 500mg') => JSON.stringify({ add: [{ kind: 'health', text, source: 'stated', evidence, touches_forgotten: false }], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null });

const NOOP = JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null });
const system = (): string => (JSON.parse(seen.replyInputs.at(-1)!) as { instructions: string }).instructions;
const session = async (name: string, firstOp: string, said: string, work: (r: { store: ReturnType<typeof claimStore>; hops: string[]; turn2: () => Promise<void> }) => void | Promise<void>) => {
  seen.writerInputs = []; seen.writerModels = []; seen.replyInputs = [];
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_i, state) => {
    const store = claimStore(state.storage.sql);
    const hops: string[] = [];
    const responder = createOwnerResponder('fixture', undefined, store as never, (entry) => { const e = entry as { hop: string; ok?: boolean; code?: string }; hops.push(`${e.hop}:${e.ok === true}:${e.code ?? ''}`); });
    const turn = (traceId: string, text: string) => responder.respond({ traceId, conversationRef: 'owner', surface: 'telegram', text }, (_n, work) => work());
    seen.addOp = firstOp;
    await turn('tg-1', `I should note ${said}`);
    await work({ store, hops, turn2: async () => { seen.addOp = NOOP; await turn('tg-2', 'what was my HbA1c?'); } });
  });
};

it('a writer output carrying a dose is halted by the medical gate twice; nothing is stored and the reply is told it may be partly stored', async () => {
  let rows = -1; let hops: string[] = [];
  await session('owner-turn-health-dose', op(`owner, tg-1: "${SAID}"`), SAID, ({ store, hops: h }) => { rows = store.claims().length; hops = [...h] });
  expect(new Set(seen.writerModels)).toEqual(new Set([OPENAI_GPT_6_LUNA_MODEL]));
  expect(seen.writerInputs[0]).toContain('HbA1c was 9.1');
  expect(seen.writerInputs[1]).toContain('Answer again'); // CLINICAL_REDIRECT re-ask, second call of the turn
  expect(hops.filter((h) => h.startsWith('llm_memory'))).toEqual(['llm_memory:false:forbidden:medical_gate', 'llm_memory_redirect:false:forbidden:medical_gate']);
  expect(hops).toContain('memory:false:provider_error');
  expect(rows).toBe(0);
  expect(seen.replyInputs[0]).toContain('only partly stored'); expect(seen.replyInputs[0]).not.toContain('nothing was stored');
});

it('a lab-value-only claim is stored by the real writer path and a no-op writer turn still answers from the claim', async () => {
  let stored: Array<{ kind: string; source: string; evidence: string }> = [];
  let memorySection = '';
  let ownerSection = '';
  let noopWriterCalls = -1;
  await session('owner-turn-health-lab', op(`owner, tg-1: "${SAID_LAB}"`, 'HbA1c was 9.1 last week'), SAID_LAB, async ({ store, turn2 }) => {
    stored = store.claims().map((c) => ({ kind: c.kind, source: c.source, evidence: c.evidence }));
    const before = seen.writerInputs.length;
    await turn2();
    noopWriterCalls = seen.writerInputs.length - before;
    const sys = system();
    memorySection = sys.slice(sys.indexOf('Owner memory'));
    ownerSection = sys;
  });
  expect(stored).toEqual([{ kind: 'health', source: 'stated', evidence: `owner, tg-1: "${SAID_LAB}"` }]);
  expect(noopWriterCalls).toBe(1); // turn 2's writer ran and was a strict no-op
  expect(memorySection).toContain('HbA1c was 9.1 last week'); // system prompt memory section, from the store
  expect(ownerSection).not.toContain('Answer again');
});
