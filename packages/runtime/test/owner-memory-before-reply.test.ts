import { beforeEach, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ order: [] as string[], replyInputs: [] as string[], writerFails: false }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  const b = body as { text?: { format?: { type: string } } };
  const writer = b.text?.format?.type === 'json_schema';
  if (writer) {
    calls.order.push('writer');
    if (calls.writerFails) throw new Error('writer unavailable');
  } else {
    calls.order.push('reply');
    calls.replyInputs.push(JSON.stringify(body));
  }
  return { id: 'fixture', output_text: writer ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const memory = { claims: () => [], recall: () => [], nodes: () => [], edges: () => [], barriers: () => [], beginSettle: () => {}, endSettle: () => {}, settle: () => {}, sweepInterruptedSettles: () => 0 };
const turn = (text: string, memoryWrites?: boolean) => {
  const responder = createOwnerResponder('fixture', undefined, memory as never);
  return responder.respond({ traceId: `t-${text}`, conversationRef: 'owner', surface: 'telegram', text, ...(memoryWrites === undefined ? {} : { memoryWrites }) }, (_name, work) => work());
};
const FAILURE_NOTE = 'Saving this to memory failed';

beforeEach(() => { calls.order = []; calls.replyInputs = []; calls.writerFails = false; });

it('records the owner turn before the reply is composed', async () => {
  expect(await turn('I moved gym to mornings')).toBe('pong');
  expect(calls.order).toEqual(['writer', 'reply']);
  expect(calls.replyInputs[0]).not.toContain(FAILURE_NOTE);
});

it('a failed write is handed to the reply turn so the owner is told it was not saved', async () => {
  calls.writerFails = true;
  await turn('I moved gym to mornings');
  expect(calls.order[0]).toBe('writer');
  expect(calls.order.at(-1)).toBe('reply');
  expect(calls.replyInputs[0]).toContain(FAILURE_NOTE);
});

it('host-disabled memory writes skip the writer and add no failure note', async () => {
  await turn('hello', false);
  expect(calls.order).toEqual(['reply']);
  expect(calls.replyInputs[0]).not.toContain(FAILURE_NOTE);
});
