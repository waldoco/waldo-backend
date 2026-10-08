import { beforeEach, it, expect, vi } from 'vitest';
const calls = vi.hoisted(() => ({ writer: 0, inputs: [] as string[], remember: 0 }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  const writer = (body as { text?: { format?: { type: string } } }).text?.format?.type === 'json_schema';
  if (writer) calls.writer++;
  calls.inputs.push(JSON.stringify(body));
  return { id: 'fixture', output_text: 'pong', output: calls.inputs.length === 1 ? [{ type: 'function_call', call_id: 'save', name: 'remember', arguments: JSON.stringify({ kind: 'fact', text: 'Synthetic hello', evidence_quote: 'Synthetic hello' }) }] : [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { rememberArgsSchema } = await import('@waldo/contracts');
const memory = { incompleteTopics: () => [], pendingTopics: () => [], claims: () => [], allClaims: () => [], recall: () => [], nodes: () => [], edges: () => [], barriers: () => [], beginSettle: () => {}, endSettle: () => {}, settle: () => {}, sweepInterruptedSettles: () => 0 };
const responder = () => createOwnerResponder('fixture', undefined, memory as never, undefined, undefined, [{ name: 'remember', description: 'fixture', schema: rememberArgsSchema, autonomy_gated: false, trigger_allowlist: ['user_message'], mutates_state: true, handle: async () => { calls.remember++; return { ok: true, data: { id: 1, status: 'stored' }, source_taint: null }; } }] as never);
const advertised = () => JSON.parse(calls.inputs[0]!).tools.some((tool: { name: string }) => tool.name === 'remember');
const timer = <T>(_name: string, work: () => Promise<T>) => work();
beforeEach(() => { calls.writer = 0; calls.inputs = []; calls.remember = 0; });

it('host-selected memoryWrites:false blocks remember independent of owner prose', async () => {
  const reply = await responder().respond({ traceId: 'optout', conversationRef: 'owner', surface: 'telegram', text: 'Synthetic hello', memoryWrites: false }, timer);
  expect(calls.inputs).toHaveLength(2);
  expect(calls.remember).toBe(0);
  expect(advertised()).toBe(false);
  expect(calls.writer).toBe(0);
  expect(reply).not.toContain('memory stored (accepted)');
});

it('default behavior offers the memory tool but never runs an automatic writer or treats owner prose as host control', async () => {
  const reply = await responder().respond({ traceId: 'default', conversationRef: 'owner', surface: 'telegram', text: 'No memory writes.' }, timer);
  expect(calls.inputs).toHaveLength(2);
  expect(advertised()).toBe(true);
  expect(calls.remember).toBe(1);
  expect(calls.writer).toBe(0);
  expect(reply).toContain('memory stored');
});

it('captures host control before any awaited reply and rejects a model write after envelope mutation', async () => {
  const turn = { traceId: 'mutation', conversationRef: 'owner', surface: 'telegram', text: 'Synthetic hello', memoryWrites: false };
  const replying = responder().respond(turn, timer);
  turn.memoryWrites = true;
  await replying;
  expect(calls.inputs).toHaveLength(2);
  expect(calls.remember).toBe(0);
  expect(advertised()).toBe(false);
  expect(calls.writer).toBe(0);
});

it('captures host control before entering a scoped responder and rejects a model write after envelope mutation', async () => {
  const runScope = { runId: 'fixture-run', attempt: 'fixture-attempt', deadline: Date.now() + 30_000, signal: new AbortController().signal, admit: () => {}, commit: <T>(work: () => T) => work() };
  const turn = { traceId: 'scoped-mutation', conversationRef: 'owner', surface: 'telegram', text: 'Synthetic hello', memoryWrites: false, runScope };
  const replying = responder().respond(turn, timer);
  turn.memoryWrites = true;
  await replying;
  expect(calls.inputs).toHaveLength(2);
  expect(calls.remember).toBe(0);
  expect(advertised()).toBe(false);
  expect(calls.writer).toBe(0);
});
