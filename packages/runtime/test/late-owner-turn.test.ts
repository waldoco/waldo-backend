import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_PERMISSIONS, triggerTypeSchema, type LLMRequest, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { ConversationStore } from '../src/channels/conversation-store';
import type { LateOwnerMessage } from '../src/channels/owner-turn-envelope';
import { ownerJobAdmission } from '../src/identity/surface-owner-admission';
import type { LLMGatewayAdapter } from '../src/llm/provider';

// A late answer to the owner's own message (the retry after every provider failed) runs with what that owner turn would have
// held: the owner-only tools, remember grounded in the owner's own words, and the owner's say-so for inward writes.
const OWNER = '10000000-0000-0000-0000-000000000001';
const MESSAGE = 'Remember that I moved the board call to Thursdays, and keep an eye on the Northwind contract.';
const LATE: LateOwnerMessage = { text: MESSAGE, messageRef: 'tg-41', conversationRef: 'telegram-7', surface: 'telegram', receivedAt: Date.now() - 20 * 60_000 };

const allowed = (name: string) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly string[]).includes(name));
type Seen = { name: string; ctx: Record<string, unknown>; args: unknown };
const run = async (late: LateOwnerMessage | undefined, call?: Readonly<{ name: string; args: object }>) => {
  const seen: Seen[] = [];
  const fake = (name: string) => ({ name: name as ToolName, description: `The ${name} tool.`, schema: z.object({}).passthrough(), trigger_allowlist: allowed(name), mutates_state: true,
    handle: async (args: unknown, ctx: Record<string, unknown>) => { seen.push({ name, ctx, args }); return { ok: true as const, data: { done: name }, source_taint: null }; } });
  const tools = ['remember', 'forget_memory', 'track_medication', 'search_history', 'open_loop', 'read_memory'].map(fake);
  const requests: LLMRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    requests.push(request);
    const first = !request.response_format && requests.filter((seenRequest) => !seenRequest.response_format).length === 1;
    const tool_calls = first && call ? [{ call_id: 'c1', name: call.name, arguments: JSON.stringify(call.args) }] : undefined;
    return { ok: true, data: { model: request.model, text: request.response_format ? '{}' : tool_calls ? '' : 'Done: noted, and I am watching the contract.', ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const admission = await ownerJobAdmission({ lookup: async () => ({ ownerId: OWNER, bindingRef: 'runtime:owner-demo', revision: '5', physicalDoId: 'actual-do' }),
    expectedPhysicalDoId: 'actual-do', job: 'heartbeat', occurrenceKey: `retry:${crypto.randomUUID()}`, occurredAt: Date.now() - 1 });
  const saved: Parameters<ConversationStore['save']>[0][number][] = [];
  const store: ConversationStore = { load: async () => ({ entries: [...saved], leafId: saved.at(-1)?.id ?? null }), save: async (rows) => { saved.push(...rows); } };
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[1] = store; args[3] = () => undefined; args[5] = tools as never; args[7] = false; args[10] = gateway;
  args[21] = { jobHost: { admit: async () => admission, chain: (_admission, surfaceChain) => surfaceChain } };
  const owner = createOwnerResponder(...args);
  const reply = await owner.prompt('retry:job-1', 'telegram-7', `[You could not answer the owner's message from 09:40. Their message, as they wrote it:]\n\n<owner_message>\n${MESSAGE}\n</owner_message>`,
    async (_hop, work) => work(), 'telegram', tools.map((tool) => tool.name), undefined, undefined, undefined, undefined, true, undefined, undefined, undefined, late);
  return { reply, seen, offered: (requests.find((request) => !request.response_format)!.tools ?? []).map((tool) => tool.name), saved };
};

describe('a late answer to the owner\'s own message runs as that owner turn', () => {
  it('holds the owner-only tools and memory writes the owner turn would have; a plain job does not', async () => {
    const late = await run(LATE);
    expect(late.offered).toEqual(expect.arrayContaining(['remember', 'forget_memory', 'track_medication', 'search_history']));
    const job = await run(undefined);
    for (const name of ['forget_memory', 'track_medication', 'search_history']) expect(job.offered).not.toContain(name);
  });

  it('a plain job holding remember keeps only Waldo\'s own note, never the owner\'s words', async () => {
    const { seen } = await run(undefined, { name: 'remember', args: { kind: 'fact', text: 'The board call is on Thursdays.', evidence_quote: 'calendar' } });
    const ctx = seen.find((call) => call.name === 'remember')!.ctx as { memoryTurn?: unknown; memoryRun?: { ownerId: string }; authenticatedUserId: string };
    expect(ctx.memoryTurn).toBeUndefined();
    expect(ctx.memoryRun?.ownerId).toBe(ctx.authenticatedUserId);
  });

  it('remember is grounded in the owner\'s own words of that message, with the owner\'s say-so', async () => {
    const { seen } = await run(LATE, { name: 'remember', args: { kind: 'preference', text: 'The board call is on Thursdays.', evidence_quote: 'I moved the board call to Thursdays' } });
    const ctx = seen.find((call) => call.name === 'remember')!.ctx as { ownerInitiated?: boolean; memoryTurn?: { current: { message_ref: string; text: string } } };
    expect(ctx.ownerInitiated).toBe(true);
    expect(ctx.memoryTurn?.current).toMatchObject({ message_ref: 'tg-41', text: MESSAGE });
  });

  it('keeps an eye on something the owner asked for: open_loop runs without a mail source', async () => {
    const { seen } = await run(LATE, { name: 'open_loop', args: { title: 'Watch the Northwind contract', due: null } });
    expect(seen.map((call) => call.name)).toContain('open_loop');
  });

  it('is still stored as Waldo\'s run, never as a new owner message', async () => {
    const { saved } = await run(LATE);
    expect(saved.find((row) => row.id === 'retry:job-1')?.inputOrigin).toBe('machine');
  });
});
