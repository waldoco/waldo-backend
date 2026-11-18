import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, ANTHROPIC_PROVIDER, buildSessionState, type LLMRequest, type LLMTool, type LLMToolTurn } from '@waldo/contracts';
import { runToolLoop } from '../src/conversation/tool-loop';
import { AnthropicMessagesAdapter } from '../src/llm/anthropic';
import { resolveRunLoopAdapters } from '../src/llm/run-loop-adapters';
import { getContextHandler } from '../src/tools/live/get-context';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

// WALDO_THINKING_REPLAY. Anthropic's thinking guide: thinking blocks go back complete and unmodified with the tool results,
// and each one is bound to the system prompt, the tools and every message before it (tool_choice is outside that check).
// The trace below runs the real tool loop through the real adapter on a recording client and asserts what each request put
// on the wire: one tool list, one system prompt and one thinking setting from the first round through the closing one,
// every request's messages a prefix of the next, and each round's thinking sent back in place.

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = (): ToolDispatcherContext => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message', canaryTokens: CANARIES, sourceTaint: null, toolArgSourceTaint: null, hasApproval: () => true,
  sanitise: adapters.safety.sanitise, session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: Date.now() }),
});
const read = getContextHandler({ timezone: 'UTC', now: () => new Date('2026-11-18T09:00:00Z') });
const usage = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const SYSTEM = `You are Waldo.\n${'Stable instructions. '.repeat(400)}`;

type Sent = Readonly<{ body: Record<string, unknown>; headers: Record<string, string> | undefined }>;
// Every round thinks, then calls get_context; the client answers whatever it is sent the same way.
const recordingAdapter = (replayThinking: boolean) => {
  const sent: Sent[] = [];
  const create = async (body: Record<string, unknown>, options?: { headers?: Record<string, string> }) => {
    sent.push({ body: structuredClone(body), headers: options?.headers });
    const n = sent.length;
    return { id: `msg_${n}`, type: 'message', role: 'assistant', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, stop_reason: 'tool_use', usage,
      content: [{ type: 'thinking', thinking: '', signature: `sig-${n}` }, { type: 'tool_use', id: `call-${n}`, name: 'get_context', input: { topic: `t${n}` } }] };
  };
  return { sent, adapter: new AnthropicMessagesAdapter({ apiKey: 'test-key', client: { messages: { create } } as never, ...(replayThinking ? { replayThinking } : {}) }) };
};

// The owner turn's step, reduced: the same system prompt and request every round, the tools the loop offers, its turns.
const turn = async (replayThinking: boolean, keepMenuToClose: boolean, maxSteps = 3) => {
  const { sent, adapter } = recordingAdapter(replayThinking);
  const step = { provider: ANTHROPIC_PROVIDER, model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, cache: 'anthropic_native' as const };
  const closeCalls: number[] = [];
  const reply = await runToolLoop({
    handlers: [read], ctx: ctx(), maxSteps, stableMenu: true,
    ...(keepMenuToClose ? { keepMenuToClose, onCloseCalls: (calls: number) => closeCalls.push(calls) } : {}),
    step: async (tools: readonly LLMTool[] | undefined, turns: readonly LLMToolTurn[]) => {
      const request: LLMRequest = { model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, system: SYSTEM, messages: [{ role: 'user', content: 'Plan my afternoon.' }], max_tokens: 1_024, temperature: 0.2, reasoning_effort: 'medium',
        ...(tools ? { tools: [...tools] } : {}), ...(turns.length ? { tool_turns: [...turns] } : {}) };
      const result = await adapter.complete({ request, route: { trigger: 'user_message', primary: step, fallback: [], floor: 'template' }, step, context: 'full_context', fallback_step: 'configured_model', headers: { 'cf-aig-collect-log-payload': 'false' } });
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  });
  return { sent, reply, closeCalls };
};

// What the prefix check and the cache read: the request without its cache markers.
const unmarked = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(unmarked);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, inner]) => [key, unmarked(inner)]));
};
const messagesOf = (sent: Sent) => unmarked(sent.body.messages) as Array<{ role: string; content: Array<Record<string, unknown>> }>;
const blockTypes = (sent: Sent) => messagesOf(sent).map((message) => `${message.role}:${message.content.map((block) => block.type).join(',')}`);

afterEach(() => vi.restoreAllMocks());

describe('thinking replay through a turn\'s tool loop', () => {
  it('keeps the tool list, system prompt and thinking setting byte-identical from the first round through the closing one', async () => {
    const { sent, reply, closeCalls } = await turn(true, true);
    // Three tool rounds, then the closing round.
    expect(sent).toHaveLength(4);
    const first = sent[0]!;
    for (const later of sent.slice(1)) {
      expect(JSON.stringify(unmarked(later.body.tools))).toBe(JSON.stringify(unmarked(first.body.tools)));
      expect(JSON.stringify(unmarked(later.body.system))).toBe(JSON.stringify(unmarked(first.body.system)));
      expect(later.body.thinking).toEqual(first.body.thinking);
    }
    for (const request of sent) {
      expect(request.body).not.toHaveProperty('tool_choice');
      expect(request.body.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
      expect(request.headers).toEqual({ 'anthropic-beta': 'thinking-binding-controls-2026-08-01' });
    }
    // Append-only: each request's messages are a prefix of the next one's, the closing request included.
    for (let k = 0; k + 1 < sent.length; k += 1) {
      const [now, next] = [messagesOf(sent[k]!), messagesOf(sent[k + 1]!)];
      expect(next.slice(0, now.length)).toEqual(now);
    }
    // Each round's thinking goes back in place, ahead of its call, with its signature unchanged.
    expect(blockTypes(sent[3]!)).toEqual(['user:text', 'assistant:thinking,tool_use', 'user:tool_result', 'assistant:thinking,tool_use', 'user:tool_result', 'assistant:thinking,tool_use', 'user:tool_result']);
    expect(messagesOf(sent[3]!).filter((message) => message.role === 'assistant').map((message) => message.content[0]!.signature)).toEqual(['sig-1', 'sig-2', 'sig-3']);
    // The closing request's newest result says no more tools; the call the model made anyway did not run.
    const lastResult = messagesOf(sent[3]!).at(-1)!.content.at(-1)!;
    expect(String(lastResult.content)).toContain('no more tool calls');
    expect(closeCalls).toEqual([1]);
    expect(reply).toContain('I reached my limit for one go');
  });

  it('adds the closing note once, when the round cap already wrote one', async () => {
    const { sent } = await turn(true, true, 5);
    const closing = String(messagesOf(sent.at(-1)!).at(-1)!.content.at(-1)!.content);
    expect(closing.match(/no more tool calls/g)).toHaveLength(1);
  });

  it('without the switch, replays no thinking and swaps the tools at the close (the cache and thinking break this asserts against)', async () => {
    const { sent } = await turn(false, false);
    expect(sent).toHaveLength(4);
    for (const request of sent) {
      expect(request.body).not.toHaveProperty('thinking');
      expect(request.headers).toBeUndefined();
      expect(blockTypes(request).some((types) => types.includes('thinking'))).toBe(false);
    }
    expect(sent[2]!.body).not.toHaveProperty('tool_choice');
    expect(sent[3]!.body.tool_choice).toEqual({ type: 'none' });
    expect(JSON.stringify(sent[3]!.body.tools)).not.toBe(JSON.stringify(sent[2]!.body.tools));
  });

  it('logs each response that dropped replayed thinking, by reason and count, with no content', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    const create = async () => ({ id: 'msg_1', type: 'message', role: 'assistant', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Done.' }],
      input_transformations: [
        { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
        { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'prefix_binding_mismatch' },
        { type: 'thinking_dropped', path: 'messages.5.content.0', reason: 'model_binding_mismatch' },
        { type: 'something_new', reason: 'ignored' },
      ] });
    const adapter = new AnthropicMessagesAdapter({ apiKey: 'test-key', client: { messages: { create } } as never, replayThinking: true });
    const step = { provider: ANTHROPIC_PROVIDER, model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, cache: 'none' as const };
    const result = await adapter.complete({ request: { model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 64, temperature: 0.2 }, route: { trigger: 'user_message', primary: step, fallback: [], floor: 'template' }, step, context: 'full_context', fallback_step: 'configured_model', headers: { 'cf-aig-collect-log-payload': 'false' } });
    expect(result.ok).toBe(true);
    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { hop: 'anthropic_thinking_dropped', ok: false, code: 'prefix_binding_mismatch', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, count: 2 },
      { hop: 'anthropic_thinking_dropped', ok: false, code: 'model_binding_mismatch', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, count: 1 },
    ]);
  });
});
