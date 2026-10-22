import { ownerTyped } from './helpers/owner-typed';
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { readThreadArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema } from '@waldo/contracts';
import { claimStore } from '../src/memory/claims';
import { memoryHandlers } from '../src/tools/live/memory';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { gateTraceEntry } from '../src/observability/trace-privacy';

// Scripted model: each reply call takes the next scripted output; the inputs are kept so the tool result can be read.
const seen = vi.hoisted(() => ({ inputs: [] as string[], outputs: [] as unknown[][] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  seen.inputs.push(JSON.stringify(body));
  return { id: 'fixture', output_text: 'Done', output: seen.outputs.shift() ?? [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
beforeEach(() => { seen.inputs.length = 0; seen.outputs.length = 0; });
const timer = <T>(_name: string, work: () => Promise<T>) => work();
const call = (name: string, args: object) => [{ type: 'function_call', call_id: `${name}-1`, name, arguments: JSON.stringify(args) }];
const remember = (args: object) => call('remember', args);
const NOW = new Date('2026-10-22T09:00:00.000Z');
// An outside source: a mail thread whose body carries readings. Its result is stamped external, which taints the turn.
const mail = { name: 'read_thread' as const, description: 'Read a mail thread.', schema: readThreadArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('read_thread')),
  handle: async () => ({ ok: true as const, data: { subject: 'Your lab report', body: 'Resting heart rate 48 bpm. Fasting glucose 92 mg/dL.' }, source_taint: 'external' as const }) };

const ownerTurn = async (name: string, text: string, outputs: unknown[][], extra: readonly unknown[] = []) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), async (_instance, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    const tools = [...memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', now: () => NOW, hideHistory: async () => undefined }), ...extra];
    const logs: TurnLogEntry[] = [];
    seen.outputs.push(...outputs);
    const reply = await createOwnerResponder('fixture', undefined, store, entry => logs.push(entry), undefined, tools as never)
      .respond(ownerTyped({ traceId: 'tg-1', conversationRef: 'owner', surface: 'telegram', text }), timer);
    return { reply, claims: store.claims(), logs };
  });

// What the owner tells Waldo about their own health may be kept, numbers included: a goal as a standing entry, a reading as
// what they said that day. The date rides the claim's text (the model's instruction) and its row. Synthetic values only.
it.each([
  ['a goal', 'I aim for 7 hours of sleep', { kind: 'goal', text: 'Aims for 7 hours of sleep', evidence_quote: 'I aim for 7 hours of sleep' }],
  ['a reading', 'my resting HR was 52 this morning', { kind: 'health', text: 'On 22 Oct said resting HR was 52', evidence_quote: 'my resting HR was 52 this morning' }],
  ['a reading with an alias', 'my resting HR was 52 this morning', { kind: 'health', text: 'On 22 Oct said resting HR was 52', evidence_quote: 'my resting HR was 52 this morning', aliases: ['resting HR 52'] }],
])('remember keeps %s the owner stated, with its date', async (_what, said, args) => {
  const { reply, claims } = await ownerTurn('remember-owner-health', said, [remember(args), []]);
  // The date is the model's to write: remember's description tells it how.
  expect(seen.inputs[0]).toContain('write it with the day they said it');
  expect(reply).not.toContain('memory stored (failed)');
  expect(claims).toMatchObject([{ kind: args.kind, text: args.text, evidence: args.evidence_quote, origin: 'owner', source: 'stated', source_ref: 'owner, tg-1', created_at: NOW.toISOString() }]);
});

// The hard boundary keys on source, not wording: once this turn read outside content, a remember carrying a health
// reading stores nothing, even with an owner quote as its evidence. The reply says the save failed and why.
it('a reading that came from tainted mail is not written to memory', async () => {
  const { reply, claims } = await ownerTurn('remember-tainted-mail', 'Read my lab mail and remember my results', [
    call('read_thread', { thread_id: 'lab-1' }),
    remember({ kind: 'health', text: 'Lab report on 22 Oct: resting HR 48 bpm, fasting glucose 92 mg/dL', evidence_quote: 'remember my results' }),
    [],
  ], [mail]);
  expect(claims).toEqual([]);
  expect(reply).toContain('memory stored (failed)');
  expect(seen.inputs.at(-1)).toContain('outside content');
});

it('a tainted turn still keeps an owner note that carries no reading', async () => {
  const { claims } = await ownerTurn('remember-tainted-words', 'Read my lab mail. I sleep badly after late coffee', [
    call('read_thread', { thread_id: 'lab-1' }),
    remember({ kind: 'health', text: 'Sleeps badly after late coffee', evidence_quote: 'I sleep badly after late coffee' }),
    [],
  ], [mail]);
  expect(claims.map((claim) => claim.text)).toEqual(['Sleeps badly after late coffee']);
});

// The value reaches the owner's memory and the model, never a log line: what the production sinks emit (the gate with
// text capture off, the console line without text) carries no part of the reading.
it('no log line carries the value', async () => {
  const { claims, logs } = await ownerTurn('remember-no-log', 'my resting HR was 52 this morning', [remember({ kind: 'health', text: 'On 22 Oct said resting HR was 52', evidence_quote: 'my resting HR was 52 this morning' }), []]);
  expect(claims).toHaveLength(1);
  expect(logs.length).toBeGreaterThan(0);
  for (const entry of logs) {
    const line = JSON.stringify({ ...gateTraceEntry(entry, false), text: undefined });
    expect(line).not.toMatch(/resting HR/i);
    expect(line).not.toMatch(/"[^"]*\b52\b[^"]*"/);
  }
});

// An ordinary fact that puts a number near a word a metric also uses saves as it always did.
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
  ['fact', 'The laptop weighs 1.4 kg'],
])('a remember of an ordinary %s with a number saves: %s', async (kind, text) => {
  const { claims } = await ownerTurn('remember-ordinary', text, [remember({ kind, text, evidence_quote: text }), []]);
  expect(claims.map((claim) => claim.text)).toEqual([text]);
});

// The boundary holds a health reading only: an ordinary fact with a number saves in a tainted turn too.
it('a tainted turn keeps an ordinary fact with a number', async () => {
  const text = 'The laptop weighs 1.4 kg';
  const { claims } = await ownerTurn('remember-tainted-ordinary', `Check my mail. ${text}`, [call('read_thread', { thread_id: 'lab-1' }), remember({ kind: 'fact', text, evidence_quote: text }), []], [mail]);
  expect(claims.map((claim) => claim.text)).toEqual([text]);
});
