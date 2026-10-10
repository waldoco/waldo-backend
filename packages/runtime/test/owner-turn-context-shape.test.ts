import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
vi.mock('openai', () => ({ default: class { responses = { create: async () =>
  ({ id: 'fixture', output_text: 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } }) }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { claimStore } = await import('../src/memory/claims');
const { memoryHandlers } = await import('../src/tools/live/memory');

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
    const { skill_procedures: procedures = 0, ...joined } = sections;
    const pieces = Object.values(joined);
    expect(pieces.reduce((sum, bytes) => sum + bytes, 0) + 2 * (pieces.length - 1) + procedures).toBe(shape.system_bytes);
  });
});
