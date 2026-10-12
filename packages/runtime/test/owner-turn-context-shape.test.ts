import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { ownerMessageAdmission } from '../src/identity/owner-message-admission';
const seen = vi.hoisted(() => ({ instructions: [] as string[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: { instructions?: string }) => {
  seen.instructions.push(body.instructions ?? '');
  return { id: 'fixture', output_text: 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { claimStore } = await import('../src/memory/claims');
const { memoryHandlers } = await import('../src/tools/live/memory');

const sectionsAddUp = (shape: NonNullable<TurnLogEntry['shape']>) => {
  const { skill_procedures: procedures = 0, ...joined } = shape.context!.system_sections!;
  const pieces = Object.values(joined);
  expect(pieces.reduce((sum, bytes) => sum + bytes, 0) + 2 * (pieces.length - 1) + procedures).toBe(shape.system_bytes);
};

it('the reply call reports what fills its context, and the system sections add up to the system prompt', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('owner-turn-context-shape')), async (_instance, state) => {
    const store = claimStore(state.storage.sql, fn => state.storage.transactionSync(fn));
    const tools = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', hideHistory: async () => undefined });
    const logged: TurnLogEntry[] = [];
    const responder = createOwnerResponder('fixture', undefined, store, entry => { logged.push(entry); }, undefined, tools);
    await responder.respond({ traceId: 'tg-shape-1', conversationRef: 'owner', surface: 'telegram', text: 'what is on today?' }, (_name, work) => work());
    const reply = logged.filter(entry => entry.hop === 'llm_reply').at(-1)!;
    const shape = reply.shape!;
    const context = shape.context!;
    expect(context.tools_count).toBeGreaterThan(0);
    expect(context.tools_bytes).toBeGreaterThan(0);
    expect(context.current_bytes).toBeGreaterThan(0);
    expect(context.tool_turns_bytes).toBe(0);
    const sections = context.system_sections!;
    expect(sections.behavior).toBeGreaterThan(0);
    expect(sections.clock).toBeGreaterThan(0);
    sectionsAddUp(shape);
  });
});

const scope = (): RunEffectScope => ({ runId: 'run-prefix', attempt: 'attempt-one', deadline: Date.now() + 30_000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() });
const appTurn = async (occurrenceKey: string, text: string, now: Date) => {
  const runScope = scope();
  const admission = await ownerMessageAdmission({
    lookup: async () => ({ owner_id: '10000000-0000-0000-0000-000000000001', do_name: 'owner-demo', state_version: 0, admission_revision: '1', presence_id: '20000000-0000-0000-0000-000000000001', provider: 'telegram', subject: '1001' }),
    scope: runScope, locator: { environment: 'staging', namespace: 'owner-staging', doName: 'owner-demo', doId: 'actual-do' },
    actualDoId: 'actual-do', expectedDoId: (name: string) => name === 'owner-demo' ? 'actual-do' : 'other-do',
    allowedDoNames: ['owner-demo'], provider: 'telegram', subject: '1001', text, occurrenceKey, occurredAt: Date.now() - 1, now: Date.now,
  });
  const context = createOwnerTurnContext(admission);
  const logged: TurnLogEntry[] = [];
  seen.instructions = [];
  const responder = createOwnerResponder('fixture', undefined, undefined, entry => { logged.push(entry); }, { timezone: 'Asia/Kolkata', now: () => now }, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [], runScope, undefined, { context });
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`prefix-${occurrenceKey}`)), () =>
    responder.respond({ traceId: `app-${occurrenceKey}`, conversationRef: context.conversationRef, surface: 'app', text }, (_name, work) => work()));
  return { instructions: new TextEncoder().encode(seen.instructions.at(-1)!), shape: logged.find(entry => entry.hop === 'llm_reply')!.shape! };
};

// The provider caches a prompt by its exact leading bytes, so per-turn text and the clock must come after the stable behavior.
it('two app turns that differ in text and clock share the behavior bytes as their system prompt prefix', async () => {
  const first = await appTurn('prefix-1', 'what is on today?', new Date('2026-10-10T03:00:00Z'));
  const second = await appTurn('prefix-2', 'book the dentist for friday afternoon', new Date('2026-10-10T15:30:00Z'));
  const behavior = first.shape.context!.system_sections!.behavior!;
  expect(first.shape.context!.system_sections!.reasons).toBeGreaterThan(0);
  expect(second.shape.context!.system_sections!.behavior).toBe(behavior);
  let common = 0;
  while (common < first.instructions.length && first.instructions[common] === second.instructions[common]) common += 1;
  expect(common).toBeGreaterThanOrEqual(behavior);
  sectionsAddUp(first.shape);
  sectionsAddUp(second.shape);
});
