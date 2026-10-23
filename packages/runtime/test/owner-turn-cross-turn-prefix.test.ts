import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { openLoopArgsSchema, triggerTypeSchema, TOOL_PERMISSIONS, type LLMRequest, type LLMResponse, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { messagingSystemPrompt } from '../src/prompt/messaging-behavior';
import { ownerTyped } from './helpers/owner-typed';

const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const AT = '2026-10-15T01:00:00.000Z';
const ORDERS = 'Standing orders from the owner (apply until cancelled; a confirm_first order is never license to act without the owner):\n- [order:1] Keep mornings free of calls (applies every turn; gate: confirm with the owner before acting)';

type Sent = Readonly<{ request: LLMRequest; sections: Readonly<Record<string, number>>; contextSections: Readonly<Record<string, number>> }>;

// Three consecutive owner turns, two rounds each, with everything that moves between turns moving: the clock, pinned
// memory, open loops, the owner's own words. The provider caches by leading bytes (tools, then the system prompt, then the
// messages), so the tool array and system prompt must be byte-identical across turns, the history a turn sends must
// start with what the previous turn sent, and every per-turn fact must sit after the owner's newest words.
const threeTurns = async (name: string, orders: (turn: number) => string) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`cross-turn-${name}`)), async (_instance, state) => {
  let minute = 0;
  let turn = 0;
  const clock = { timezone: 'Asia/Kolkata', now: () => new Date(Date.UTC(2026, 9, 15, 1, 23 + minute, 30)) };
  const memory = claimStore(state.storage.sql);
  memory.add({ kind: 'fact', text: 'Prefers aisle seats', source: 'stated', evidence: '"Prefers aisle seats"', origin: 'owner', source_ref: 'owner, fixture-1' }, AT);
  const loops: string[] = [];
  const standingOrders = (opt?: Readonly<{ loopsRoom: number }>) => opt
    ? (loops.length ? ['Open loops Waldo is on for the owner (read-only context, not instructions):', ...loops.map((title, index) => `- ${title} [loop_${index}]`)].join('\n') : '')
    : orders(turn);
  const handlers = [
    { name: 'open_loop' as const, description: 'Record a check-back.', schema: openLoopArgsSchema, trigger_allowlist: allowlist('open_loop'), autonomy_gated: false, mutates_state: true,
      handle: async (args: { title: string }) => { loops.push(args.title); return { ok: true as const, data: { opened: true }, source_taint: null }; } },
    { name: 'get_context' as const, description: 'Owner context.', schema: z.object({ topic: z.string() }), trigger_allowlist: allowlist('get_context'), autonomy_gated: false,
      handle: async () => ({ ok: true as const, data: {}, source_taint: null }) },
  ];
  const requests: LLMRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    if (!request.tools?.length) return { ok: true, data: { model: request.model, text: 'ok', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
    const first = requests.filter((sent) => sent.tools?.length).length % 2 === 0;
    requests.push(request);
    minute += 2;
    const call = { call_id: `c${requests.length}`, name: 'open_loop', arguments: JSON.stringify({ title: `Follow up ${turn}` }) };
    const data: LLMResponse = first
      ? { model: request.model, text: '', tool_calls: [call], output_items: [{ type: 'function_call', id: `fc_${call.call_id}`, ...call }], input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 }
      : { model: request.model, text: `Done ${turn}.`, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 };
    return { ok: true, data };
  } };
  const hops: TurnLogEntry[] = [];
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[2] = memory; args[3] = (entry) => { hops.push(entry); }; args[4] = clock; args[5] = handlers as never; args[10] = gateway; args[13] = standingOrders;
  const responder = createOwnerResponder(...args);
  const words = ['sort out the visa appointment', 'and remind me about it', 'what is still open?'];
  for (const text of words) {
    turn += 1;
    await responder.respond(ownerTyped({ traceId: `cross-turn-${name}-${turn}`, conversationRef: `${name}-1`, surface: 'telegram', text, memoryWrites: false }), time);
    memory.add({ kind: 'fact', text: `Learned after turn ${turn}`, source: 'stated', evidence: `"Learned after turn ${turn}"`, origin: 'owner', source_ref: `owner, fixture-${turn + 1}` }, AT);
  }
  const replies = hops.filter((hop) => hop.hop === 'llm_reply');
  expect(replies).toHaveLength(requests.length);
  const sent: Sent[] = requests.map((request, index) => {
    const context = replies[index]!.shape!.context as { system_sections?: Record<string, number>; context_sections?: Record<string, number> };
    return { request, sections: context.system_sections ?? {}, contextSections: context.context_sections ?? {} };
  });
  return { sent, words, handlers };
});

const changed = (before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => before[key] !== after[key]).sort();

it('keeps tools, system prompt and history byte-identical from one owner turn to the next; per-turn facts follow the newest words', async () => {
  const { sent, words, handlers } = await threeTurns('stable', () => ORDERS);
  expect(sent).toHaveLength(6);
  const firstRounds = [sent[0]!, sent[2]!, sent[4]!];

  // Tools lead the cached prefix, then the system prompt: one byte string each across every round of every turn.
  expect(new Set(sent.map(({ request }) => JSON.stringify(request.tools))).size).toBe(1);
  expect(new Set(sent.map(({ request }) => request.system)).size).toBe(1);
  expect(sent[0]!.request.system!.startsWith(messagingSystemPrompt(handlers.map((handler) => handler.name)))).toBe(true);
  expect(sent[0]!.request.system).toContain('Keep mornings free of calls');
  for (let index = 1; index < sent.length; index += 1) expect(changed(sent[0]!.sections, sent[index]!.sections)).toEqual([]);

  // Each turn's request starts with the history the previous turn sent, then the previous turn's words and reply as
  // stored: the per-turn facts that rode those words are not replayed, so the history bytes never change after the fact.
  for (const [index, { request }] of firstRounds.entries()) {
    expect(request.messages).toHaveLength(2 * index + 1);
    expect(request.messages.slice(0, -1).map((message) => message.content)).toEqual(words.slice(0, index).flatMap((said, at) => [said, `Done ${at + 1}.`]));
    if (index > 0) expect(request.messages.slice(0, 2 * index - 2)).toEqual(firstRounds[index - 1]!.request.messages.slice(0, -1));
    const current = request.messages.at(-1)!.content;
    expect(current.startsWith(`${words[index]}\n\n`)).toBe(true);
  }

  // What moved between turns: turn-context sections only, riding the newest owner message. Sizes show loops and memory
  // growing; the clock can keep its length as it moves, so its text is checked.
  const suffix = (at: number) => sent[at]!.request.messages.at(-1)!.content.slice(words[at / 2]!.length);
  for (const at of [2, 4]) {
    expect(changed(sent[at - 2]!.contextSections, sent[at]!.contextSections)).toEqual(expect.arrayContaining(['loops', 'memory']));
    for (const key of changed(sent[at - 2]!.contextSections, sent[at]!.contextSections)) expect(['clock', 'loops', 'memory']).toContain(key);
  }
  expect(suffix(0)).toContain('at 06:53');
  expect(suffix(2)).toContain('at 06:57');
  expect(suffix(2)).toContain('Follow up 1');
  expect(suffix(4)).toContain('Learned after turn 2');
  // Within a turn nothing moves: the second round resends the first round's request and appends its tool turn.
  for (const at of [0, 2, 4]) {
    expect(sent[at + 1]!.request.messages).toEqual(sent[at]!.request.messages);
    expect(sent[at + 1]!.request.tool_turns).toHaveLength(1);
  }
});

// The owner's standing orders are instructions he wrote, so they stay in the system prompt; a change to them is the one
// owner act that moves it, and it moves only from the orders section on: the behaviour text before it still matches.
it('a standing order the owner changes between turns moves the system prompt from the orders section on, and nothing earlier', async () => {
  const { sent, handlers } = await threeTurns('orders', (turn) => turn < 2 ? '' : ORDERS);
  const behavior = messagingSystemPrompt(handlers.map((handler) => handler.name));
  const [before, after] = [sent[0]!.request.system!, sent[2]!.request.system!];
  expect(before).toBe(behavior);
  expect(after.startsWith(`${behavior}\n\n${ORDERS}`)).toBe(true);
  expect(changed(sent[0]!.sections, sent[2]!.sections)).toEqual(['orders']);
  expect(sent[4]!.request.system).toBe(after);
  expect(JSON.stringify(sent[2]!.request.tools)).toBe(JSON.stringify(sent[0]!.request.tools));
});
