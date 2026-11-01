import { rememberArgsSchema } from '@waldo/contracts';
import { ownerTyped } from './helpers/owner-typed';
import { beforeEach, expect, it, vi } from 'vitest';

// A reply that newer owner messages overtook before it did anything is not sent or saved: the host answers them together.
const calls = vi.hoisted(() => ({ outputs: [] as unknown[][], replies: 0 }));
vi.mock('openai', () => ({ default: class { responses = { create: async () => {
  calls.replies += 1;
  return { id: 'fixture', output_text: 'Hey. What do you need?', output: calls.outputs.shift() ?? [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder, OvertakenTurnError } = await import('../src/channels/owner-turn');

const memory = { pendingTopics: () => [], claims: () => [], allClaims: () => [], recall: () => [], nodes: () => [], edges: () => [], statements: () => [], barriers: () => [], forgetGeneration: () => 0, settle: () => {} };
const setup = (newer: () => boolean) => {
  const saved: unknown[] = [];
  const store = { load: async () => ({ entries: [], leafId: null }), save: async (rows: readonly unknown[]) => { saved.push(...rows); } };
  const remember = { name: 'remember', description: 'fixture memory tool', schema: rememberArgsSchema, autonomy_gated: false, trigger_allowlist: ['user_message'], mutates_state: true,
    handle: async () => ({ ok: true, data: { id: 1, status: 'stored' }, source_taint: null }) };
  const args = ['fixture', store, memory, undefined, undefined, [remember]] as unknown as Parameters<typeof createOwnerResponder>;
  args[21] = { newerOwnerInput: newer };
  const responder = createOwnerResponder(...args);
  const run = (text: string) => responder.respond(ownerTyped({ traceId: 'whatsapp-1', conversationRef: 'owner', surface: 'whatsapp', text }), (_name, work) => work());
  return { responder, run, saved };
};
beforeEach(() => { calls.outputs = []; calls.replies = 0; });

it('drops a reply that did nothing when newer owner messages are waiting: nothing is saved', async () => {
  const { run, saved } = setup(() => true);
  await expect(run('Hey Waldo')).rejects.toBeInstanceOf(OvertakenTurnError);
  expect(calls.replies).toBe(1);
  expect(saved).toEqual([]);
});

it('sends the reply when nothing newer is waiting', async () => {
  const { run, saved } = setup(() => false);
  expect(await run('Hey Waldo')).toBe('Hey. What do you need?');
  expect(saved.length).toBeGreaterThan(0);
});

it('never drops a reply whose turn called a tool, even with newer messages waiting', async () => {
  let asked = 0;
  const { run } = setup(() => { asked += 1; return true; });
  calls.outputs.push([{ type: 'function_call', call_id: 'c1', name: 'remember', arguments: JSON.stringify({ kind: 'routine', text: 'Gym in mornings', evidence_quote: 'gym to mornings' }) }], []);
  expect(await run('I moved gym to mornings')).toContain('Hey. What do you need?');
  expect(asked).toBe(0);
});

it('never asks for a machine turn', async () => {
  let asked = 0;
  const { responder } = setup(() => { asked += 1; return true; });
  await responder.prompt('job-1', 'owner', '[Reminder] stretch', (_name, work) => work());
  expect(asked).toBe(0);
});
