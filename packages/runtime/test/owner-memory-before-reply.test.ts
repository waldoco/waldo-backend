import { beforeEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ order: [] as string[], replyInputs: [] as string[], onFirstReply: undefined as undefined | (() => void), outputs: [] as unknown[][] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  calls.order.push((body as { text?: { format?: { type: string } } }).text?.format?.type === 'json_schema' ? 'writer' : 'reply');
  calls.replyInputs.push(JSON.stringify(body));
  if (calls.replyInputs.length === 1) calls.onFirstReply?.();
  return { id: 'fixture', output_text: 'pong', output: calls.outputs.shift() ?? [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { loopHandlers } = await import('../src/channels/loops');
const { rememberArgsSchema } = await import('@waldo/contracts');
const memory = { incompleteTopics: () => [], pendingTopics: () => [], claims: () => [], allClaims: () => [], recall: () => [], nodes: () => [], edges: () => [], barriers: () => [], beginSettle: () => {}, endSettle: () => {}, settle: () => {}, sweepInterruptedSettles: () => 0 };
const loopBook = { close: () => true, open: () => ({}), list: () => [], closed: () => [], proactivity: () => ({}), setProactivity: () => ({}) };
const tool = (name: string, args: unknown) => [{ type: 'function_call', call_id: name, name, arguments: JSON.stringify(args) }];
// Narrow handler fake tests transport/order/receipts. Real grounding/store handlers are exercised in memory-health-owner-turn.
const setup = (opts: { memoryWrites?: boolean; fail?: boolean; throws?: boolean; loops?: boolean } = {}) => {
  const saved: Array<{ modelPayload: string; appPayload: string }> = [];
  const writes: unknown[] = [];
  const store = { load: async () => ({ entries: [], leafId: null }), save: async (rows: ReadonlyArray<{ modelPayload: string; appPayload: string }>) => { saved.push(...rows); } };
  const remember = { name: 'remember', description: 'fixture memory tool', schema: rememberArgsSchema, autonomy_gated: false, trigger_allowlist: ['user_message'], mutates_state: true, handle: async (args: unknown) => {
    calls.order.push('remember');
    if (opts.throws) throw new Error('memory storage unavailable');
    if (opts.fail) return { ok: false, code: 'invalid_args', error: 'Evidence quote is not grounded in an owner-authored message.', source_taint: null };
    writes.push(args);
    return { ok: true, data: { id: 1, status: 'stored' }, source_taint: null };
  } };
  const responder = createOwnerResponder('fixture', store as never, memory as never, undefined, undefined, [remember, ...(opts.loops ? loopHandlers(loopBook as never) : [])] as never);
  const run = (text: string) => responder.respond({ traceId: 'tg-1', conversationRef: 'owner', surface: 'telegram', text, ...(opts.memoryWrites === undefined ? {} : { memoryWrites: opts.memoryWrites }) }, (_name, work) => work());
  return { responder, run, saved, writes };
};
beforeEach(() => { calls.order = []; calls.replyInputs = []; calls.outputs = []; calls.onFirstReply = undefined; });

it('the owner turn reaches the main model first; only its remember call writes and earns a receipt', async () => {
  const { run, writes } = setup();
  calls.outputs.push(tool('remember', { kind: 'routine', text: 'Gym in mornings', evidence_quote: 'gym to mornings' }), []);
  expect(await run('I moved gym to mornings')).toContain('memory stored');
  expect(calls.order).toEqual(['reply', 'remember', 'reply']);
  expect(writes).toEqual([{ kind: 'routine', text: 'Gym in mornings', evidence_quote: 'gym to mornings' }]);
  expect(calls.replyInputs[1]).toContain('stored');
  expect(calls.replyInputs[0]).not.toContain('memory line for this turn');
});

it('a failed remember call is disclosed by its tool result and failed receipt, never an automatic writer notice', async () => {
  const { run, writes, saved } = setup({ fail: true });
  calls.outputs.push(tool('remember', { kind: 'routine', text: 'Gym in mornings', evidence_quote: 'gym to mornings' }), []);
  expect(await run('I moved gym to mornings')).toContain('memory stored (failed)');
  expect(calls.order).toEqual(['reply', 'remember', 'reply']);
  expect(writes).toEqual([]);
  expect(calls.replyInputs[1]).toContain('not grounded');
  for (const input of calls.replyInputs) expect(input).not.toContain('nothing was stored');
  expect(saved.map(row => row.modelPayload + row.appPayload).join('\n')).not.toContain('nothing was stored');
});

it('host-disabled memory writes remove remember even if the model attempts to call it', async () => {
  const { run, writes } = setup({ memoryWrites: false });
  calls.outputs.push(tool('remember', { kind: 'routine', text: 'Gym in mornings', evidence_quote: 'gym to mornings' }), []);
  const reply = await run('I moved gym to mornings');
  expect(calls.order).toEqual(['reply', 'reply']);
  expect(writes).toEqual([]);
  expect(JSON.parse(calls.replyInputs[0]!).tools.some((t: { name: string }) => t.name === 'remember')).toBe(false);
  expect(reply).not.toContain('memory stored (accepted)');
  expect(calls.replyInputs[0]).not.toContain('nothing was stored');
});

it('steering reaches the next main-model round without an intervening writer; a chosen remember call can store it', async () => {
  const { responder, run, writes } = setup({ loops: true });
  calls.outputs.push(tool('close_loop', { id: 'x', outcome: 'done' }), tool('remember', { kind: 'preference', text: 'Vegan', evidence_quote: 'I am vegan now' }), []);
  calls.onFirstReply = () => { responder.control.steer(5, 'also I am vegan now'); };
  expect(await run('plan dinner')).toContain('memory stored');
  expect(calls.order).toEqual(['reply', 'reply', 'remember', 'reply']);
  expect(calls.replyInputs[1]).toContain('also I am vegan now');
  expect(writes).toEqual([{ kind: 'preference', text: 'Vegan', evidence_quote: 'I am vegan now' }]);
  for (const input of calls.replyInputs) expect(input).not.toContain('nothing was stored');
});

it('a throwing remember tool yields a failed receipt, not the removed partial-writer notice', async () => {
  const { run, writes } = setup({ throws: true });
  calls.outputs.push(tool('remember', { kind: 'routine', text: 'Gym in mornings', evidence_quote: 'gym to mornings' }), []);
  expect(await run('I moved gym to mornings')).toContain('memory stored (failed)');
  expect(calls.order).toEqual(['reply', 'remember', 'reply']);
  expect(writes).toEqual([]);
  const output = JSON.parse(JSON.parse(calls.replyInputs[1]!).input.find((item: { type: string }) => item.type === 'function_call_output').output);
  expect(output).toEqual({ ok: false, error: 'tool handler failed', code: 'transient', reason: 'handler_failed' });
  expect(calls.replyInputs[1]).not.toContain('memory storage unavailable');
  for (const input of calls.replyInputs) expect(input).not.toContain('only partly stored');
});
