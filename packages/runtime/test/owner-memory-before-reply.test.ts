import { beforeEach, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ order: [] as string[], replyInputs: [] as string[], writerFailsFrom: Infinity, writers: 0, writerBad: false, onFirstReply: undefined as undefined | (() => void), toolRound: false }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  const b = body as { text?: { format?: { type: string } } };
  const writer = b.text?.format?.type === 'json_schema';
  if (writer) {
    calls.order.push('writer');
    calls.writers += 1;
    if (calls.writers >= calls.writerFailsFrom) throw new Error('writer unavailable');
  } else {
    calls.order.push('reply');
    calls.replyInputs.push(JSON.stringify(body));
    if (calls.replyInputs.length === 1) calls.onFirstReply?.();
    if (calls.toolRound && calls.replyInputs.length === 1) {
      return { id: 'fixture', output_text: '', output: [{ type: 'function_call', call_id: 'c1', name: 'close_loop', arguments: JSON.stringify({ id: 'x', outcome: 'done' }) }], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
    }
  }
  return { id: 'fixture', output_text: writer ? (calls.writerBad ? 'not json' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}') : 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { loopHandlers } = await import('../src/channels/loops');
const memory = { incompleteTopics: () => [], pendingTopics: () => [], claims: () => [], recall: () => [], nodes: () => [], edges: () => [], barriers: () => [], beginSettle: () => {}, endSettle: () => {}, settle: () => {}, sweepInterruptedSettles: () => 0 };
const loopBook = { close: () => true, open: () => ({}), list: () => [], closed: () => [], proactivity: () => ({}), setProactivity: () => ({}) };
const NOTICE = 'nothing was stored';

const setup = (opts: { memoryWrites?: boolean; tools?: boolean } = {}) => {
  const saved: Array<{ modelPayload: string; appPayload: string }> = [];
  const store = { load: async () => ({ entries: [], leafId: null }), save: async (rows: ReadonlyArray<{ modelPayload: string; appPayload: string }>) => { saved.push(...rows); } };
  const responder = createOwnerResponder('fixture', store as never, memory as never, undefined, undefined, opts.tools ? loopHandlers(loopBook as never) as never : []);
  const run = (text: string) => responder.respond({ traceId: 'tg-1', conversationRef: 'owner', surface: 'telegram', text, ...(opts.memoryWrites === undefined ? {} : { memoryWrites: opts.memoryWrites }) }, (_name, work) => work());
  return { responder, run, saved };
};

beforeEach(() => { calls.order = []; calls.replyInputs = []; calls.writerFailsFrom = Infinity; calls.writers = 0; calls.onFirstReply = undefined; calls.toolRound = false; calls.writerBad = false; });

it('records the owner turn before the reply is composed', async () => {
  const { run } = setup();
  expect(await run('I moved gym to mornings')).toBe('pong');
  expect(calls.order).toEqual(['writer', 'reply']);
  expect(calls.replyInputs[0]).not.toContain(NOTICE);
});

it('a failed write reaches the reply through the system prompt and never enters owner history', async () => {
  calls.writerFailsFrom = 1;
  const { run, saved } = setup();
  await run('I moved gym to mornings');
  expect(calls.order[0]).toBe('writer');
  expect(calls.order.at(-1)).toBe('reply');
  expect(calls.replyInputs[0]).toContain(NOTICE);
  expect(saved.map((row) => row.modelPayload + row.appPayload).join('\n')).not.toContain(NOTICE);
});

it('host-disabled memory writes skip the writer and add no failure notice', async () => {
  const { run } = setup({ memoryWrites: false });
  await run('hello');
  expect(calls.order).toEqual(['reply']);
  expect(calls.replyInputs[0]).not.toContain(NOTICE);
});

it('a steered addition is recorded before the round that answers it, and a failed write is disclosed', async () => {
  calls.toolRound = true;
  calls.writerFailsFrom = 2;
  const { responder, run } = setup({ tools: true });
  calls.onFirstReply = () => { responder.control.steer(5, 'also I am vegan now'); };
  await run('plan dinner');
  expect(calls.order.filter((step) => step === 'writer').length).toBeGreaterThanOrEqual(2);
  const secondWriter = calls.order.indexOf('writer', 1);
  const secondReply = calls.order.lastIndexOf('reply');
  expect(secondWriter).toBeLessThan(secondReply);
  expect(calls.replyInputs[1]).toContain('also I am vegan now');
  expect(calls.replyInputs[1]).toContain(NOTICE);
  expect(calls.replyInputs[0]).not.toContain(NOTICE);
});

it('an error after the writer answered is reported as possibly partial, not as nothing stored', async () => {
  calls.writerBad = true;
  const { run } = setup();
  await run('I moved gym to mornings');
  expect(calls.replyInputs[0]).toContain('only partly stored');
  expect(calls.replyInputs[0]).not.toContain(NOTICE);
});
