import { ownerTyped } from './helpers/owner-typed';
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { claimStore } from '../src/memory/claims';
import { memoryHandlers } from '../src/tools/live/memory';
import { createOwnerResponder } from '../src/channels/owner-turn';

// Scripted model: each reply call takes the next scripted output; the inputs are kept so the tool result can be read.
const seen = vi.hoisted(() => ({ inputs: [] as string[], outputs: [] as unknown[][] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  seen.inputs.push(JSON.stringify(body));
  return { id: 'fixture', output_text: 'Done', output: seen.outputs.shift() ?? [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
beforeEach(() => { seen.inputs.length = 0; seen.outputs.length = 0; });
const timer = <T>(_name: string, work: () => Promise<T>) => work();
const remember = (args: object) => [{ type: 'function_call', call_id: 'remember-1', name: 'remember', arguments: JSON.stringify(args) }];

// Synthetic readings only. Memory keeps how the owner is, in words: a remember that would store a measurement in its
// text, its evidence or an alias stores nothing and says why, and the qualitative note in the same message still saves.
const SAID = 'My resting heart rate was 52 this morning and I slept badly after late coffee';
it.each([
  ['in the text', { kind: 'health', text: 'Resting heart rate was 52 this morning', evidence_quote: 'My resting heart rate was 52 this morning' }],
  ['only in the evidence', { kind: 'health', text: 'Checks heart rate in the mornings', evidence_quote: 'My resting heart rate was 52 this morning' }],
  ['only in an alias', { kind: 'health', text: 'Sleeps badly after late coffee', evidence_quote: 'I slept badly after late coffee', aliases: ['heart rate 52'] }],
])('a remember carrying a numeric health value %s stores nothing and says why', async (_where, args) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`remember-floor-${crypto.randomUUID()}`)), async (_instance, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    const tools = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', hideHistory: async () => undefined });
    seen.outputs.push(remember(args), []);
    const reply = await createOwnerResponder('fixture', undefined, store, undefined, undefined, tools)
      .respond(ownerTyped({ traceId: 'tg-1', conversationRef: 'owner', surface: 'telegram', text: SAID }), timer);
    expect(store.claims()).toEqual([]);
    expect(reply).toContain('memory stored (failed)');
    expect(seen.inputs.at(-1)).toContain('never a measurement');
  });
});

// The floor refuses only a measurement: an ordinary fact that puts a number near a word a metric also uses still saves.
it.each([
  ['fact', 'Needs to file Form 16 by July'],
  ['event', 'Visa form due 20 Oct'],
  ['goal', 'Next steps for the 3 projects'],
  ['routine', 'Pulse check meeting at 7'],
  ['routine', 'Laundry load at 6'],
  ['goal', 'Recovery week 2 of marathon plan'],
  ['routine', 'Kids go to sleep after 30 minutes of reading'],
  ['event', 'Flight 6E 204 leaves at 06:40'],
  ['routine', 'Meeting with HR at 10:30'],
])('a remember of an ordinary %s with a number saves: %s', async (kind, text) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`remember-floor-${crypto.randomUUID()}`)), async (_instance, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    const tools = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', hideHistory: async () => undefined });
    seen.outputs.push(remember({ kind, text, evidence_quote: text }), []);
    await createOwnerResponder('fixture', undefined, store, undefined, undefined, tools)
      .respond(ownerTyped({ traceId: 'tg-3', conversationRef: 'owner', surface: 'telegram', text }), timer);
    expect(store.claims().map((claim) => claim.text)).toEqual([text]);
  });
});

it('a qualitative health note from the same message is stored', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('remember-floor-words')), async (_instance, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    const tools = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', hideHistory: async () => undefined });
    seen.outputs.push(remember({ kind: 'health', text: 'Sleeps badly after late coffee', evidence_quote: 'I slept badly after late coffee' }), []);
    await createOwnerResponder('fixture', undefined, store, undefined, undefined, tools)
      .respond(ownerTyped({ traceId: 'tg-2', conversationRef: 'owner', surface: 'telegram', text: SAID }), timer);
    expect(store.claims().map((claim) => claim.text)).toEqual(['Sleeps badly after late coffee']);
  });
});
