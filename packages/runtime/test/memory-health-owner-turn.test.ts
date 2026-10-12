import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
const seen = vi.hoisted(() => ({ inputs: [] as string[], outputs: [] as unknown[][] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  seen.inputs.push(JSON.stringify(body));
  return { id: 'fixture', output_text: 'pong', output: seen.outputs.shift() ?? [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { claimStore } = await import('../src/memory/claims');
const { memoryHandlers } = await import('../src/tools/live/memory');
beforeEach(() => { seen.inputs = []; seen.outputs = []; });
const SAID = 'my HbA1c was 9.1 last week';
const tool = (name: string, args: unknown) => [{ type: 'function_call', call_id: name, name, arguments: JSON.stringify(args) }];
const session = (name: string, work: (store: ReturnType<typeof claimStore>, turn: (text: string) => Promise<string>) => Promise<void>) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_i, state) => {
    const store = claimStore(state.storage.sql, fn => state.storage.transactionSync(fn));
    const tools = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', hideHistory: async () => undefined });
    const responder = createOwnerResponder('fixture', undefined, store, undefined, undefined, tools);
    let id = 0;
    await work(store, text => responder.respond({ traceId: `tg-${++id}`, conversationRef: 'owner', surface: 'telegram', text }, (_n, fn) => fn()));
  });

it('the main model remembers a grounded lab value, returns a receipt and explicitly recalls it on the next turn', async () => {
  await session('owner-turn-health-lab', async (store, turn) => {
    seen.outputs.push(tool('remember', { kind: 'health', text: 'HbA1c was 9.1 last week', evidence_quote: SAID }), []);
    expect(await turn(SAID)).toContain('memory stored');
    expect(seen.inputs).toHaveLength(2);
    expect(store.claims()).toMatchObject([{ text: 'HbA1c was 9.1 last week', kind: 'health', source: 'stated', origin: 'owner', evidence: SAID, source_ref: 'owner, tg-1' }]);
    seen.outputs.push(tool('read_memory', { query: 'HbA1c' }), []);
    expect(await turn('what was my HbA1c?')).toBe('pong');
    expect(seen.inputs).toHaveLength(4);
    expect(seen.inputs.at(-1)).toContain('HbA1c was 9.1 last week');
    expect(seen.inputs.at(-1)).toContain('context_only_not_action_approval');
    expect(store.claims()).toHaveLength(1);
    for (const input of seen.inputs) expect(input).not.toContain('claim_ops');
    const system = JSON.parse(seen.inputs[2]!).instructions as string;
    expect(system).toContain('HbA1c was 9.1 last week');
    expect(system).not.toContain('<relevant_claims>');
  });
});

it('an invented lab quote is rejected in the main loop and cannot reach subsequent memory recall', async () => {
  await session('owner-turn-health-invented', async (store, turn) => {
    seen.outputs.push(tool('remember', { kind: 'health', text: 'HbA1c was 7.2 last month', evidence_quote: 'my HbA1c was 7.2 last month' }), []);
    expect(await turn('I felt tired today')).toContain('memory stored (failed)');
    expect(seen.inputs).toHaveLength(2);
    expect(seen.inputs[1]).toContain('not grounded');
    expect(store.allClaims()).toEqual([]);
    seen.outputs.push(tool('read_memory', { query: 'HbA1c' }), []);
    await turn('what was my HbA1c?');
    expect(seen.inputs).toHaveLength(4);
    expect(JSON.parse(seen.inputs[2]!).instructions).not.toContain('7.2');
    expect(seen.inputs.at(-1)).not.toContain('7.2');
    expect(seen.inputs.at(-1)).toContain('context_only_not_action_approval');
    expect(store.allClaims()).toEqual([]);
    for (const input of seen.inputs) expect(input).not.toContain('claim_ops');
  });
});
