import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { reminderBook } from '../src/channels/reminders';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { z } from 'zod';
import { EXTERNAL_ORIGIN_TOOLS, TOOL_PERMISSIONS, triggerTypeSchema, type ConversationEntry, type LLMRequest, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { ConversationStore } from '../src/channels/conversation-store';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { taintedCallNeedsOwnerApproval } from '../src/hooks/registry';

// A reminder the owner set on their own words is their ask, made earlier: when it fires and has read outside content, its inward,
// undoable writes (owner_inward: a meal or workout log, a reminder, an artifact revised or restored) run with no card, as they
// would in the owner's own turn, and the reply lists each one. Nothing else it does changes: a send, a standing order, a forget,
// anything privileged still goes on the owner's card. A reminder it sets after the outside read is marked outside, so it never
// carries the owner's ask on. Every id and text is synthetic.
const allowed = (name: string) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly string[]).includes(name));
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();

describe('the gate for a reminder the owner asked for', () => {
  it('lets an inward, undoable write through after an outside read, and nothing else', async () => {
    const asked = { ownerInitiated: false, ownerAskedInward: true };
    expect(await taintedCallNeedsOwnerApproval('log_meal', 'external', { description: 'dal and rice' }, asked)).toBe(false);
    expect(await taintedCallNeedsOwnerApproval('log_meal', 'external', { description: 'dal and rice' }, { ownerInitiated: false })).toBe(true);
    // start_task and steer_task hand work to a background worker, which may reach the web: the ask never covers them.
    for (const tool of ['start_task', 'steer_task', 'set_standing_order', 'forget_memory', 'delete_health_log', 'execute_action', 'call_mcp_tool', 'send_message'] as const) {
      expect(await taintedCallNeedsOwnerApproval(tool, 'external', {}, asked)).toBe(true);
    }
  });
});

const responder = (steps: Readonly<{ tool: string; args: unknown }>[]) => {
  const calls: string[] = [];
  const fake = (name: string) => ({ name: name as ToolName, description: `The ${name} tool.`, schema: z.object({}).passthrough(), trigger_allowlist: allowed(name),
    handle: async () => { calls.push(name); return { ok: true as const, data: { done: name }, source_taint: (EXTERNAL_ORIGIN_TOOLS as readonly string[]).includes(name) ? 'external' as const : null }; } });
  const requests: LLMRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    requests.push(request);
    const next = request.response_format ? undefined : steps.shift();
    return { ok: true, data: { model: request.model, text: request.response_format ? '{}' : next ? '' : 'Done.', ...(next ? { tool_calls: [{ call_id: `c${requests.length}`, name: next.tool, arguments: JSON.stringify(next.args) }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const saved: ConversationEntry[] = [];
  const store: ConversationStore = { load: async () => ({ entries: [...saved], leafId: saved.at(-1)?.id ?? null }), save: async (rows) => { saved.push(...rows); } };
  const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture', toolLoader: 'harness' }];
  args[1] = store; args[3] = () => undefined; args[5] = ['search_communication', 'log_meal', 'set_reminder', 'send_message'].map(fake) as never; args[7] = false; args[10] = gateway;
  return { calls, requests, owner: createOwnerResponder(...args) };
};
const timing = { due: '2030-03-04T21:00', now: '2030-03-04T21:00', timezone: 'UTC' };
const script = () => [
  { tool: 'search_communication', args: { query: 'from:canteen' } },
  { tool: 'log_meal', args: { description: 'dal and rice' } },
  { tool: 'set_reminder', args: { note: 'pay the canteen', at: '2030-03-05T09:00', repeat: 'none' } },
  { tool: 'send_message', args: { channel: 'telegram', content: 'paid', idempotency_key: 'a'.repeat(64) } },
];

describe('an owner reminder that fires and reads mail', () => {
  it('asked by the owner: logs the meal and sets the reminder with no card; the send still goes on the card', async () => {
    const { owner, calls, requests } = responder(script());
    await owner.remind('reminder:1:1', 'telegram-7', 'Log dinner', time, 'telegram', timing, true);
    expect(calls).toEqual(['search_communication', 'log_meal', 'set_reminder']);
    expect(requests.at(-1)!.tool_turns!.find((turn) => turn.call.name === 'send_message')!.output).toMatch(/card|approv/i);
  });

  it('not asked by the owner (set by Waldo, or in a turn that read outside content): the meal log and the reminder go on the card too', async () => {
    const { owner, calls } = responder(script());
    await owner.remind('reminder:2:1', 'telegram-7', 'Log dinner', time, 'telegram', timing);
    expect(calls).toEqual(['search_communication']);
  });
});

// What a late answer to the owner's message carries: an empty message is no one's words, so nothing it sets is the owner's ask.
describe('a late answer to the owner\'s message', () => {
  it('with no words of the owner\'s in it, is not their own words', async () => {
    const seen: unknown[] = [];
    const steps = [{ tool: 'set_reminder', args: { note: 'pay the canteen', at: '2030-03-05T09:00', repeat: 'none' } }];
    const fake = { name: 'set_reminder' as ToolName, description: 'The set_reminder tool.', schema: z.object({}).passthrough(), trigger_allowlist: allowed('set_reminder'),
      handle: async (_args: unknown, ctx: { ownerMessage?: unknown }) => { seen.push(ctx.ownerMessage); return { ok: true as const, data: { id: 'reminder:1' }, source_taint: null }; } };
    const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
      const next = request.response_format ? undefined : steps.shift();
      return { ok: true, data: { model: request.model, text: request.response_format ? '{}' : next ? '' : 'Done.', ...(next ? { tool_calls: [{ call_id: 'c1', name: next.tool, arguments: JSON.stringify(next.args) }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    } };
    const saved: ConversationEntry[] = [];
    const store: ConversationStore = { load: async () => ({ entries: [...saved], leafId: saved.at(-1)?.id ?? null }), save: async (rows) => { saved.push(...rows); } };
    const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture', toolLoader: 'harness' }];
    args[1] = store; args[3] = () => undefined; args[5] = [fake] as never; args[7] = false; args[10] = gateway;
    await createOwnerResponder(...args).prompt('late:1', 'telegram-7', 'Answer the owner\'s message now.', time, 'telegram', undefined, undefined, undefined, undefined, undefined, true, undefined, undefined, undefined,
      { text: '', messageRef: 'm1', conversationRef: 'telegram-7', surface: 'telegram', receivedAt: Date.now() - 60_000 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ownWordsOnly: false });
  });
});

describe('the reminder book keeps who asked', () => {
  it('records the owner\'s ask only where nothing outside was read, and drops it with the reminder', async () => {
    const seen = await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('reminder-asked')), async (_, state) => {
      let n = 0;
      const book = reminderBook(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { timezone: 'UTC', now: () => new Date('2030-03-04T09:00:00Z') } as never, () => `r${n += 1}`);
      const own = await book.set({ note: 'log dinner', at: '2030-03-04T21:00', repeat: 'none' }, { asked: true });
      const read = await book.set({ note: 'pay the canteen', at: '2030-03-04T21:00', repeat: 'none' }, { outside: true, asked: true });
      const before = { own: book.asked(own.id), read: book.asked(read.id), readOutside: book.outside(read.id) };
      await book.cancel(own.id);
      return { before, after: book.asked(own.id) };
    });
    expect(seen).toEqual({ before: { own: true, read: false, readOutside: true }, after: false });
  });
});
