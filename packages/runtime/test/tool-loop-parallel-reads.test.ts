import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSessionState, sendMessageArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type LLMToolCall, type LLMToolTurn, type ToolName } from '@waldo/contracts';
import { MAX_CONCURRENT_READS, runToolLoop, type ToolLoopEvent } from '../src/conversation/tool-loop';
import { resolveRunLoopAdapters } from '../src/llm/run-loop-adapters';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { ownerTyped } from './helpers/owner-typed';

// Reads the model asks for together run together; everything they leave behind (results, receipts, taint, refusals,
// tool events) lands in the model's order, as if each call had run alone. Writes stay barriers.

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const freshCtx = () => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message' as const, canaryTokens: CANARIES,
  sourceTaint: null, toolArgSourceTaint: null as 'external' | null,
  sanitise: adapters.safety.sanitise, hasApproval: async () => true,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }),
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Arguments pass the contract schema first (the zod hook), so each fixture call uses its tool's real query field.
const argsSchema = z.object({ query: z.string().optional(), id: z.string().optional(), thread_id: z.string().optional() });
// The dispatcher refuses a handler whose allowlist drifts from the ACL, so fixtures declare exactly the ACL's triggers.
const allowlist = (name: string) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly ToolName[]).includes(name as ToolName));

type Timeline = string[];
// A read that records when it starts and ends, takes `ms`, and may return external content.
const read = (name: string, timeline: Timeline, inFlight: { now: number; max: number }, ms: (topic: string) => number, external = new Set<string>()) => ({
  name, description: `fixture ${name}`, schema: argsSchema, autonomy_gated: false, trigger_allowlist: allowlist(name),
  handle: async (args: unknown) => {
    const { query, id, thread_id } = args as { query?: string; id?: string; thread_id?: string };
    const topic = query ?? id ?? thread_id ?? 'none';
    timeline.push(`start:${name}:${topic}`);
    inFlight.now += 1; inFlight.max = Math.max(inFlight.max, inFlight.now);
    await sleep(ms(topic));
    inFlight.now -= 1;
    timeline.push(`end:${name}:${topic}`);
    return { ok: true, data: { topic }, source_taint: external.has(topic) ? 'external' : null };
  },
});
const write = (timeline: Timeline) => ({
  name: 'send_message', description: 'fixture send', schema: sendMessageArgsSchema, autonomy_gated: true, mutates_state: true as const, trigger_allowlist: allowlist('send_message'),
  handle: async () => { timeline.push('start:send_message'); await sleep(5); timeline.push('end:send_message'); return { ok: true, data: { sent: true }, source_taint: null }; },
});
const call = (name: string, topic: string, id = `${name}-${topic}`): LLMToolCall => ({ call_id: id, name, arguments: JSON.stringify(name === 'read_tool_output' ? { id: topic } : name === 'read_thread' ? { thread_id: topic } : { query: topic }) });
const sendCall: LLMToolCall = { call_id: 'send-1', name: 'send_message', arguments: JSON.stringify({ channel: 'telegram', content: 'Running late, there in ten.', idempotency_key: 'a'.repeat(64) }) };

// One response with `calls`, then a closing answer; returns what the loop handed back and what it emitted.
const turn = async (handlers: readonly unknown[], calls: readonly LLMToolCall[], ctx = freshCtx()) => {
  const events: ToolLoopEvent[] = [];
  const replays: (readonly LLMToolTurn[])[] = [];
  let steps = 0;
  const startedAt = Date.now();
  const text = await runToolLoop({
    handlers: handlers as never, ctx, maxSteps: 4, onTool: (event) => events.push(event),
    step: async (_tools, turns) => { replays.push(turns); steps += 1; return steps === 1 ? { text: '', tool_calls: calls } : { text: 'Done.' }; },
  });
  return { text, events, replays, ctx, elapsed: Date.now() - startedAt, steps };
};

describe('parallel read calls', () => {
  it('three reads from one response run at once and the turn takes about one read, not three', async () => {
    const timeline: Timeline = [], inFlight = { now: 0, max: 0 };
    const handlers = [read('web_search', timeline, inFlight, () => 300), read('search_episodes', timeline, inFlight, () => 300), read('read_memory', timeline, inFlight, () => 300)];
    const { text, events, elapsed } = await turn(handlers, [call('web_search', 'dentist near me'), call('search_episodes', 'dentist'), call('read_memory', 'gym')]);
    expect(text).toBe('Done.');
    expect(inFlight.max).toBe(3);
    // All three start before any ends.
    expect(timeline.slice(0, 3).every((entry) => entry.startsWith('start:'))).toBe(true);
    // In order these take 900 ms; together, about 300. The bound leaves room for a loaded machine.
    expect(elapsed).toBeLessThan(750);
    expect(events.map((event) => event.call.name)).toEqual(['web_search', 'search_episodes', 'read_memory']);
    expect(events.map((event) => event.parallel_batches)).toEqual([1, 0, 0]);
  });

  it('results and tool events land in model order even when the reads finish in reverse', async () => {
    const timeline: Timeline = [], inFlight = { now: 0, max: 0 };
    const delays: Record<string, number> = { a: 60, b: 30, c: 1 };
    const handlers = [read('read_memory', timeline, inFlight, (topic) => delays[topic]!)];
    const { events, replays } = await turn(handlers, [call('read_memory', 'a'), call('read_memory', 'b'), call('read_memory', 'c')]);
    expect(timeline.filter((entry) => entry.startsWith('end:'))).toEqual(['end:read_memory:c', 'end:read_memory:b', 'end:read_memory:a']);
    expect(events.map((event) => JSON.parse(event.call.arguments).query)).toEqual(['a', 'b', 'c']);
    expect(replays[1]!.map((replayed) => JSON.parse(replayed.output).data.topic)).toEqual(['a', 'b', 'c']);
    // Each event's time is its own dispatch, not the batch's.
    expect(events[2]!.ms).toBeLessThan(events[0]!.ms);
  });

  it('a write is a barrier: reads before it finish first, it runs alone, and reads after it start only once it is done', async () => {
    const timeline: Timeline = [], inFlight = { now: 0, max: 0 };
    const handlers = [read('web_search', timeline, inFlight, () => 20), read('read_memory', timeline, inFlight, () => 20), write(timeline)];
    const { events } = await turn(handlers, [call('web_search', 'a'), call('read_memory', 'b'), sendCall, call('web_search', 'c'), call('read_memory', 'd')]);
    const at = (entry: string) => timeline.indexOf(entry);
    expect(at('start:send_message')).toBeGreaterThan(at('end:web_search:a'));
    expect(at('start:send_message')).toBeGreaterThan(at('end:read_memory:b'));
    expect(at('start:web_search:c')).toBeGreaterThan(at('end:send_message'));
    expect(at('start:read_memory:d')).toBeGreaterThan(at('end:send_message'));
    // The two reads after the write ran together.
    expect(at('start:read_memory:d')).toBeLessThan(at('end:web_search:c'));
    expect(events.map((event) => event.call.name)).toEqual(['web_search', 'read_memory', 'send_message', 'web_search', 'read_memory']);
    expect(events.map((event) => event.parallel_batches)).toEqual([1, 0, 1, 1, 0]);
  });

  it('external content read in a batch taints the calls after it in model order, and a privileged write after it gets the approval refusal', async () => {
    const timeline: Timeline = [], inFlight = { now: 0, max: 0 };
    const handlers = [read('web_search', timeline, inFlight, () => 10, new Set(['inbox'])), read('read_memory', timeline, inFlight, () => 10), write(timeline)];
    const { events, ctx } = await turn(handlers, [call('read_memory', 'gym'), call('web_search', 'inbox'), call('read_memory', 'diet'), sendCall]);
    expect(events.map((event) => event.taint)).toEqual([null, 'external', 'external', 'external']);
    const refused = events[3]!;
    expect(refused).toMatchObject({ ok: false, error_code: 'taint_needs_approval' });
    expect(JSON.parse(refused.output)).toMatchObject({ ok: false, error_code: 'taint_needs_approval', fix: expect.any(String), retryable: expect.any(Boolean) });
    expect(timeline).not.toContain('start:send_message');
    expect(ctx.toolArgSourceTaint).toBe('external');
  });

  it('an identical read back to back in one response runs once and the repeat gets the repeat refusal, as in order', async () => {
    const timeline: Timeline = [], inFlight = { now: 0, max: 0 };
    const handlers = [read('read_memory', timeline, inFlight, () => 10)];
    const { events } = await turn(handlers, [call('read_memory', 'gym', 'one'), call('read_memory', 'gym', 'two'), call('read_memory', 'diet')]);
    expect(timeline.filter((entry) => entry === 'start:read_memory:gym')).toHaveLength(1);
    expect(events.map((event) => [event.ok, event.error_code])).toEqual([[true, undefined], [false, 'repeat_refusal'], [true, undefined]]);
  });

  it('a failing read in a batch returns the one refusal shape and the others still land', async () => {
    const timeline: Timeline = [], inFlight = { now: 0, max: 0 };
    const broken = { ...read('search_episodes', timeline, inFlight, () => 1), handle: async () => { throw new Error('store unavailable'); } };
    const handlers = [read('read_memory', timeline, inFlight, () => 10), broken];
    const { events } = await turn(handlers, [call('read_memory', 'a'), call('search_episodes', 'b'), call('read_memory', 'c')]);
    expect(events.map((event) => event.ok)).toEqual([true, false, true]);
    expect(JSON.parse(events[1]!.output)).toEqual({ ok: false, error: expect.any(String), error_code: 'handler_failed', fix: expect.any(String), retryable: false, code: 'transient', reason: 'handler_failed' });
    expect(events[1]!.output).not.toContain('store unavailable');
  });

  it('a batch holds at most the concurrency cap, and the whole response still spends one tool round', async () => {
    const timeline: Timeline = [], inFlight = { now: 0, max: 0 };
    const handlers = [read('read_memory', timeline, inFlight, () => 20)];
    const topics = ['a', 'b', 'c', 'd', 'e', 'f'];
    const { events, steps } = await turn(handlers, topics.map((topic) => call('read_memory', topic)));
    expect(inFlight.max).toBe(MAX_CONCURRENT_READS);
    expect(events).toHaveLength(6);
    expect(events.map((event) => event.parallel_batches)).toEqual([1, 0, 0, 0, 1, 0]);
    expect(steps).toBe(2);
  });

  it.each(['read_tool_output', 'search_communication', 'read_thread'])('%s is not on the concurrent read list, so it runs alone, in order', async (name) => {
    const timeline: Timeline = [], inFlight = { now: 0, max: 0 };
    const handlers = [read(name, timeline, inFlight, () => 20), read('read_memory', timeline, inFlight, () => 20)];
    const { events } = await turn(handlers, [call(name, 'a'), call(name, 'b'), call('read_memory', 'c')]);
    expect(timeline).toEqual([`start:${name}:a`, `end:${name}:a`, `start:${name}:b`, `end:${name}:b`, 'start:read_memory:c', 'end:read_memory:c']);
    expect(events.map((event) => event.parallel_batches)).toEqual([1, 1, 1]);
  });
});

describe('parallel read calls on an owner turn', () => {
  it('the turn trace shows three reads in one batch, in model order, each result replayed to the model in that order', async () => {
    const timeline: Timeline = [], inFlight = { now: 0, max: 0 };
    const requests: LLMGatewayRequest[] = [];
    const gateway: LLMGatewayAdapter = { complete: async (request) => {
      requests.push(request);
      const base = { model: request.request.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 };
      if (requests.length > 1) return { ok: true, data: { ...base, text: 'Here is your day.' } };
      return { ok: true, data: { ...base, text: '', tool_calls: ['calendar', 'mail', 'gym'].map((topic) => call('read_memory', topic)) } };
    } };
    const hops: TurnLogEntry[] = [];
    const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture-openai' }];
    args[3] = (entry) => { if (entry.hop.startsWith('tool_')) hops.push(entry); };
    args[5] = [read('read_memory', timeline, inFlight, () => 50)] as never; args[10] = gateway;
    const reply = await createOwnerResponder(...args).respond(ownerTyped({ traceId: 'parallel-1', conversationRef: 'telegram-1', surface: 'telegram', text: 'what does today look like', memoryWrites: false }), async (_hop, work) => work());
    expect(reply).toBe('Here is your day.');
    expect(inFlight.max).toBe(3);
    expect(hops.map((hop) => [hop.hop, JSON.parse(hop.text!.input).query, hop.parallel_batches])).toEqual([
      ['tool_read_memory', 'calendar', 1], ['tool_read_memory', 'mail', 0], ['tool_read_memory', 'gym', 0],
    ]);
    expect(requests[1]!.request.tool_turns?.map((replayed) => JSON.parse(replayed.output).data.topic)).toEqual(['calendar', 'mail', 'gym']);
  });
});
