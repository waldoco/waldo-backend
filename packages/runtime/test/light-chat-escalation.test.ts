import { expect, it } from 'vitest';
import { ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, OPENAI_GPT_6_1_TERRA_MODEL, OPENAI_GPT_6_LUNA_MODEL, type ErrorCode, type ModelName } from '@waldo/contracts';
import { createOwnerResponder, type OwnerContextIntegration } from '../src/channels/owner-turn';
import { secondMessages } from '../src/channels/second-message';
import { STOPPED_REPLY } from '../src/channels/turn-control';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { createReplyStream, type ReplyDraftSurface } from '../src/conversation/reply-stream';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { getContextHandler } from '../src/tools/live/get-context';
import { ownerTyped } from './helpers/owner-typed';

// WALDO_LIGHT_CHAT: the owner's reply takes its first step on the light model, which answers quick chat itself and hands
// anything else to the chat model in the same turn, as the same one reply. The model's judgment is scripted here by what
// each fake model is asked; the owner turn, its tool loop, the provider runtime and the reply stream are real.

const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-10-20T08:20:00Z') };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const words = (count: number, word: string) => Array.from({ length: count }, (_, i) => `${word}${i}`).join(' ');
const LIGHT_DRAFT = `Sure, let me sketch that out quickly. ${words(80, 'light')}`;
const CHAT_REPLY = `Here is the answer from the chat model. ${words(80, 'chat')}`;
const LIGHT_REPLY = 'Any time.';
// The asks the light model hands over, one per kind the escalate tool names.
const HANDED_OVER = [['a day plan', 'Plan my afternoon around the board prep.'], ['a health question', 'Should I train hard today, given how I slept?'],
  ['a hard ask', 'Compare leasing and buying a car for me over five years.'], ['a draft for someone else', 'Draft a note to Arjun saying I will be ten minutes late.']] as const;

type Act = Readonly<{ text: string; truncated?: true }> | Readonly<{ text?: string; tool: string; args?: unknown }> | Readonly<{ fail: ErrorCode }>;
type Script = (request: LLMGatewayRequest, said: string) => Act;
// The light model answers thanks and hands over everything else, writing a long preamble first; the chat model answers.
const LIGHT: Script = (_request, said) => said.includes('Thanks') ? { text: LIGHT_REPLY } : { text: LIGHT_DRAFT, tool: 'escalate' };
const CHAT: Script = () => ({ text: CHAT_REPLY });

const fake = (scripts: Partial<Record<ModelName, Script>>, hold?: () => Promise<void>) => {
  const requests: LLMGatewayRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async (input) => {
    requests.push(input);
    const model = input.request.model as ModelName;
    if (model === ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL) await hold?.();
    const said = String(input.request.messages.at(-1)?.content ?? '');
    const act = (scripts[model] ?? (() => ({ fail: 'transient' as const })))(input, said);
    if ('fail' in act) return { ok: false, code: act.fail, error: 'down' };
    const base = { model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 };
    const text = 'text' in act ? act.text ?? '' : '';
    for (const piece of text.match(/.{1,8}/gs) ?? []) { input.stream?.delta(piece); await tick(); }
    if ('tool' in act) {
      if (text) input.stream?.retract();
      return { ok: true, data: { ...base, text, tool_calls: [{ call_id: `c${requests.length}`, name: act.tool, arguments: JSON.stringify(act.args ?? {}) }] } };
    }
    return { ok: true, data: { ...base, text, ...('truncated' in act ? { truncated: true } : {}) } };
  } };
  return { gateway, requests, models: () => requests.map((request) => request.request.model), tools: (index: number) => (requests[index]!.request.tools ?? []).map((tool) => tool.name) };
};

const responder = (gateway: LLMGatewayAdapter, options: Readonly<{ log?: (entry: TurnLogEntry) => void; owner?: OwnerContextIntegration; tools?: Parameters<typeof createOwnerResponder>[5]; floor?: true }> = {}) => {
  const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture-openai', anthropicApiKey: 'fixture-anthropic', primary: 'anthropic', ...(options.floor ? { floorReply: true } : {}) }];
  args[3] = options.log ?? (() => undefined); args[4] = clock; args[5] = options.tools ?? [getContextHandler(clock)]; args[10] = gateway; args[18] = ['👌'];
  args[21] = options.owner ?? { lightChat: true };
  return createOwnerResponder(...args);
};
const drafts = () => {
  const shown: string[] = [];
  const surface: ReplyDraftSurface = { show: async (text) => { shown.push(text); }, minIntervalMs: 0, maxUpdates: 1000, maxChars: 4096 };
  return { shown, stream: createReplyStream(surface) };
};
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const turn = (traceId: string, text: string, extra: Record<string, unknown> = {}) => ownerTyped({ traceId, conversationRef: 'app-main', surface: 'app', text, memoryWrites: false, ...extra });
const routes = (hops: readonly TurnLogEntry[]) => hops.filter((entry) => entry.hop === 'light_route').map((entry) => entry.detail);

it('quick chat stays on the light model: one call, with the escalate tool offered, no stream and no web search', async () => {
  const { gateway, requests, models, tools } = fake({ [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: LIGHT, [ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]: CHAT });
  const hops: TurnLogEntry[] = [];
  const { stream } = drafts();
  const reply = await responder(gateway, { log: (entry) => hops.push(entry) }).respond(turn('light-simple', 'Thanks, that is all.', { replyStream: stream }), time);
  expect(reply).toBe(LIGHT_REPLY);
  expect(models()).toEqual([ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]);
  expect(tools(0)).toEqual(expect.arrayContaining(['escalate', 'get_context']));
  expect('stream' in requests[0]!).toBe(false);
  expect(requests[0]!.request.web_search).toBeUndefined();
  expect(routes(hops)).toEqual(['answered']);
  expect(hops.find((entry) => entry.hop === 'llm_reply_light')?.usage?.model).toBe(ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL);
  expect(hops.some((entry) => entry.hop === 'llm_reply')).toBe(false);
});

it.each(HANDED_OVER)('%s is handed to the chat model in the same turn: one reply, written by the chat model, and nothing of the light step shown', async (_kind, ask) => {
  const { gateway, requests, models, tools } = fake({ [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: LIGHT, [ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]: CHAT });
  const hops: TurnLogEntry[] = [];
  const { shown, stream } = drafts();
  const reply = await responder(gateway, { log: (entry) => hops.push(entry) }).respond(turn('light-handover', ask, { replyStream: stream }), time);
  const outcome = await stream.settle(reply);
  expect(reply).toBe(CHAT_REPLY);
  expect(models()).toEqual([ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]);
  expect(tools(0)).toContain('escalate');
  expect(tools(1)).not.toContain('escalate');
  // The chat model takes the very step the light model was given: the same instructions and messages.
  expect(requests[1]!.request.system).toBe(requests[0]!.request.system);
  expect(requests[1]!.request.messages).toEqual(requests[0]!.request.messages);
  expect('stream' in requests[0]!).toBe(false);
  expect('stream' in requests[1]!).toBe(true);
  for (const text of shown) expect(text).not.toContain('light');
  expect(shown.length).toBeGreaterThan(0);
  expect(outcome).toMatchObject({ outcome: 'matched', withdrawals: 0 });
  expect(routes(hops)).toEqual(['escalated']);
});

it('any other tool call from the light step hands over unrun: only the chat model\'s call reaches the tool', async () => {
  const { gateway, requests, models } = fake({
    [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: () => ({ tool: 'get_context' }),
    [ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]: (request) => request.request.tool_turns?.length ? { text: CHAT_REPLY } : { tool: 'get_context' },
  });
  const hops: TurnLogEntry[] = [];
  const reply = await responder(gateway, { log: (entry) => hops.push(entry) }).respond(turn('light-tool', 'What time is it in Tokyo?'), time);
  expect(reply).toBe(CHAT_REPLY);
  expect(hops.filter((entry) => entry.hop === 'tool_get_context')).toHaveLength(1);
  expect(models()).toEqual([ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]);
  expect(requests[1]!.request.tool_turns).toBeUndefined();
  expect(routes(hops)).toEqual(['tool']);
});

it('a light step that fails or is cut off hands over after one attempt, with no floor line and without moving the provider breaker', async () => {
  const cut = fake({ [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: () => ({ text: 'Half an answ', truncated: true }), [ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]: CHAT });
  const cutHops: TurnLogEntry[] = [];
  expect(await responder(cut.gateway, { log: (entry) => cutHops.push(entry), floor: true }).respond(turn('light-cut', 'Thanks!'), time)).toBe(CHAT_REPLY);
  expect(cut.models()).toEqual([ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]);
  expect(routes(cutHops)).toEqual(['truncated']);

  // Four turns on one responder, whose breaker opens a provider after three failures: a light model that keeps timing out
  // never opens it, so the chat model still answers the fourth.
  const down = fake({ [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: () => ({ fail: 'transient' }), [ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]: CHAT });
  const hops: TurnLogEntry[] = [];
  const owner = responder(down.gateway, { log: (entry) => hops.push(entry), floor: true });
  for (let i = 0; i < 4; i += 1) expect(await owner.respond(turn(`light-down-${i}`, 'Thanks!'), time)).toBe(CHAT_REPLY);
  expect(down.models()).toEqual(Array.from({ length: 4 }, () => [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]).flat());
  expect(routes(hops)).toEqual(['failed', 'failed', 'failed', 'failed']);
  expect(hops.some((entry) => entry.hop === 'provider_breaker')).toBe(false);
});

it('with the chat model down, a handed-over turn falls back to the other provider\'s chat model, never to a light model', async () => {
  const { gateway, models } = fake({ [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: LIGHT, [ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]: () => ({ fail: 'transient' }), [OPENAI_GPT_6_1_TERRA_MODEL]: CHAT, [OPENAI_GPT_6_LUNA_MODEL]: () => ({ text: 'Luna should never answer.' }) });
  const reply = await responder(gateway).respond(turn('light-fallback', HANDED_OVER[1][1]), time);
  expect(reply).toBe(CHAT_REPLY);
  expect(models()[0]).toBe(ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL);
  expect(models().slice(1)).not.toContain(ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL);
  expect(models()).not.toContain(OPENAI_GPT_6_LUNA_MODEL);
  expect(models().at(-1)).toBe(OPENAI_GPT_6_1_TERRA_MODEL);
});

it('a stop during the light step ends the turn with no chat call; a steer during it reaches the chat model', async () => {
  let during: () => void = () => {};
  const stopped = fake({ [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: LIGHT, [ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]: CHAT }, async () => during());
  const owner = responder(stopped.gateway);
  owner.control.bindTarget('run-stop');
  during = () => { expect(owner.control.stopTarget('run-stop')).toBe(true); };
  expect(await owner.respond(turn('light-stop', HANDED_OVER[0][1]), time)).toBe(STOPPED_REPLY);
  expect(stopped.models()).toEqual([ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]);
  expect(stopped.tools(0)).toContain('escalate');

  const steered = fake({ [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: LIGHT, [ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]: CHAT }, async () => during());
  const next = responder(steered.gateway);
  next.control.bindTarget('run-steer');
  during = () => { expect(next.control.steerTarget('run-steer', 1, { text: 'and keep 4pm free', foreignRanges: [] })).toBe(true); during = () => {}; };
  expect(await next.respond(turn('light-steer', HANDED_OVER[0][1]), time)).toBe(CHAT_REPLY);
  expect(steered.models()).toEqual([ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]);
  expect(String(steered.requests[1]!.request.messages.at(-1)?.content)).toContain('and keep 4pm free');
  expect(next.control.unconsumed()).toEqual([]);
});

it('a newer owner message waiting on the chat is folded by the chat model, not by the light step', async () => {
  const folded: string[] = [];
  const waiting = [{ id: 'msg-2', text: 'and book a table for two', at: Date.parse('2026-10-20T08:19:00Z') }];
  const second = secondMessages({ chat: () => ({ turnId: 'light-second', waiting: () => waiting.filter((message) => !folded.includes(message.id)), fold: (id) => { folded.push(id); return true; } }), timezone: () => clock.timezone });
  const heard = { tool: 'owner_message_heard', args: { message_id: 'msg-2', choice: 'fold' } } as const;
  const { gateway, requests, models } = fake({
    [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: () => heard,
    [ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]: (request) => request.request.tool_turns?.length ? { text: CHAT_REPLY } : heard,
  });
  const reply = await responder(gateway, { owner: { lightChat: true, newerOwnerMessages: second.round }, tools: [getContextHandler(clock), second.handler] })
    .respond(turn('light-second', 'Find somewhere for dinner tonight.'), time);
  expect(reply).toBe(CHAT_REPLY);
  expect(folded).toEqual(['msg-2']);
  expect(models()).toEqual([ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]);
  expect(String(requests[1]!.request.messages.at(-1)?.content)).toContain('msg-2');
});

// Guards, which hold on the code before this change too: off, and on machine turns, no light step is taken.
it('with the switch off, or on a machine turn, the reply runs on the chat model as before, with no light step', async () => {
  for (const owner of [{}, { lightChat: false }] as const) {
    const { gateway, requests, models, tools } = fake({ [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: LIGHT, [ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]: CHAT });
    const hops: TurnLogEntry[] = [];
    const { stream } = drafts();
    expect(await responder(gateway, { owner, log: (entry) => hops.push(entry) }).respond(turn('light-off', 'Thanks, that is all.', { replyStream: stream }), time)).toBe(CHAT_REPLY);
    expect(models()).toEqual([ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]);
    expect(tools(0)).not.toContain('escalate');
    expect('stream' in requests[0]!).toBe(true);
    expect(hops.map((entry) => entry.hop)).not.toContain('light_route');
  }
  // A machine turn runs on the auxiliary model as it always has, with its own tools and no hand-over.
  const machine = fake({ [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: () => ({ text: 'Time to stretch.' }) });
  const hops: TurnLogEntry[] = [];
  await responder(machine.gateway, { log: (entry) => hops.push(entry) }).remind('light-machine', 'app-main', 'Stretch', time);
  expect(machine.requests.flatMap((request) => (request.request.tools ?? []).map((tool) => tool.name))).not.toContain('escalate');
  expect(hops.map((entry) => entry.hop)).not.toContain('light_route');
});
