import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ inputs: [] as string[], args: {} as Record<string, unknown> }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  const b = body as { text?: { format?: { type: string } } };
  if (b.text?.format?.type === 'json_schema') return { id: 'w', output_text: '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  calls.inputs.push(JSON.stringify(body));
  if (calls.inputs.length === 1) return { id: 'r1', output_text: '', output: [{ type: 'function_call', call_id: 'c1', name: 'search_episodes', arguments: JSON.stringify(calls.args) }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return { id: 'r2', output_text: 'done', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { episodeIndex } = await import('../src/channels/episodes');
const { searchEpisodesHandler } = await import('../src/tools/live/search-episodes');

const memory = { claims: () => [], recall: () => [], nodes: () => [], edges: () => [], barriers: () => [], beginSettle: () => {}, endSettle: () => {}, settle: () => {}, sweepInterruptedSettles: () => 0 };
const FULL = `latest options test arrive ${'so '.repeat(30)}A leaves 16:30 for 22k, B leaves 17:45 for 18.5k`;

// Model-call layer: the scripted model calls search_episodes through the real owner turn,
// dispatcher and hooks, and the next model input must carry what the tool returned.
const run = (name: string, args: Record<string, unknown>) => runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_i, state) => {
  calls.inputs = []; calls.args = args;
  const index = episodeIndex(state.storage.sql);
  index.add('tg-9', 'owner', FULL, Date.parse('2026-10-01T02:31:18Z'));
  const ref = index.search('latest options test', 1)[0]!.ref;
  calls.args = JSON.parse(JSON.stringify(args).replace('REF', ref));
  const store = { load: async () => ({ entries: [], leafId: null }), save: async () => {} };
  const a: Parameters<typeof createOwnerResponder> = ['fixture', store as never, memory as never];
  a[5] = [searchEpisodesHandler(index)] as never;
  const responder = createOwnerResponder(...a);
  await responder.respond({ traceId: 'tg-1', conversationRef: 'owner', surface: 'telegram', text: 'what was the latest?' } as never, async (_l: string, work: () => Promise<unknown>) => work() as never);
  return calls.inputs[1] ?? '';
});

it('the model reads the full stored turn by ref', async () => {
  expect(await run('se-id', { ref: 'REF' })).toContain('18.5k');
});
it('an unknown entry_id returns a truthful null episode, not a guess', async () => {
  const second = await run('se-missing', { ref: '4040404' });
  expect(second).toContain('episode');
  expect(second).not.toContain('18.5k');
});
it('a request mixing query and entry_id is rejected before the tool runs', async () => {
  const second = await run('se-mixed', { query: 'latest', ref: 'REF' });
  expect(second).not.toContain('18.5k');
});
