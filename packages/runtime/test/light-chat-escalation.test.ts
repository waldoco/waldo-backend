import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ConversationTree, OPENAI_PROVIDER, OWNER_MODELS, type ConversationEntry, type ErrorCode, type ModelName } from '@waldo/contracts';
import { LIGHT_ROLE_MAX_TOKENS, lightChatRoles, type LightChatRoles } from '../src/channels/async-tools';
import { toContextHealthMaterial } from '../src/channels/health-context';
import { createOwnerResponder, type OwnerContextIntegration } from '../src/channels/owner-turn';
import { secondMessages } from '../src/channels/second-message';
import { STOPPED_REPLY } from '../src/channels/turn-control';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { ownerExchangeHistory } from '../src/conversation/compaction';
import { createReplyStream, type ReplyDraftSurface } from '../src/conversation/reply-stream';
import { ownerModels } from '../src/llm/owner-routes';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { ownerMessageAdmission } from '../src/identity/owner-message-admission';
import { claimStore } from '../src/memory/claims';
import { getContextHandler } from '../src/tools/live/get-context';
import { ownerTyped } from './helpers/owner-typed';

// WALDO_LIGHT_CHAT: the owner's reply takes its first step on the light role, which answers quick chat itself and hands
// anything else to the strong role in the same turn, as the same one reply. The model's judgment is scripted here by what
// each fake model is asked; the owner turn, its tool loop, the provider runtime and the reply stream are real. Models are
// named by role: the deploy provider's own (Anthropic here) and the other provider's.

const ACCESS = { openaiApiKey: 'fixture-openai', anthropicApiKey: 'fixture-anthropic', primary: 'anthropic' } as const;
const { auxiliary: LIGHT_ROLE, chat: STRONG_ROLE } = ownerModels(ACCESS);
const { auxiliary: OTHER_LIGHT, chat: OTHER_STRONG } = OWNER_MODELS[OPENAI_PROVIDER];
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
const LIGHT_SCRIPT: Script = (_request, said) => said.includes('Thanks') ? { text: LIGHT_REPLY } : { text: LIGHT_DRAFT, tool: 'escalate' };
const CHAT_SCRIPT: Script = () => ({ text: CHAT_REPLY });

const fake = (scripts: Partial<Record<ModelName, Script>>, hold?: () => Promise<void>) => {
  const requests: LLMGatewayRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async (input) => {
    requests.push(input);
    const model = input.request.model as ModelName;
    if (model === LIGHT_ROLE) await hold?.();
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
  const args: Parameters<typeof createOwnerResponder> = [{ ...ACCESS, ...(options.floor ? { floorReply: true } : {}) }];
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

it('quick chat stays on the light role: one call, offered only escalate, capped output, no stream and no web search', async () => {
  const { gateway, requests, models, tools } = fake({ [LIGHT_ROLE]: LIGHT_SCRIPT, [STRONG_ROLE]: CHAT_SCRIPT });
  const hops: TurnLogEntry[] = [];
  const { stream } = drafts();
  const reply = await responder(gateway, { log: (entry) => hops.push(entry) }).respond(turn('light-simple', 'Thanks, that is all.', { replyStream: stream }), time);
  expect(reply).toBe(LIGHT_REPLY);
  expect(models()).toEqual([LIGHT_ROLE]);
  expect(tools(0)).toEqual(['escalate']);
  expect(requests[0]!.request.max_tokens).toBe(LIGHT_ROLE_MAX_TOKENS);
  expect('stream' in requests[0]!).toBe(false);
  expect(requests[0]!.request.web_search).toBeUndefined();
  expect(routes(hops)).toEqual(['answered']);
  expect(hops.find((entry) => entry.hop === 'llm_reply_light')?.usage?.model).toBe(LIGHT_ROLE);
  expect(hops.some((entry) => entry.hop === 'llm_reply')).toBe(false);
});

it.each(HANDED_OVER)('%s is handed to the strong role in the same turn: one reply, written by the strong role, and nothing of the light step shown', async (_kind, ask) => {
  const { gateway, requests, models, tools } = fake({ [LIGHT_ROLE]: LIGHT_SCRIPT, [STRONG_ROLE]: CHAT_SCRIPT });
  const hops: TurnLogEntry[] = [];
  const { shown, stream } = drafts();
  const reply = await responder(gateway, { log: (entry) => hops.push(entry) }).respond(turn('light-handover', ask, { replyStream: stream }), time);
  const outcome = await stream.settle(reply);
  expect(reply).toBe(CHAT_REPLY);
  expect(models()).toEqual([LIGHT_ROLE, STRONG_ROLE]);
  expect(tools(0)).toEqual(['escalate']);
  expect(tools(1)).toContain('get_context');
  expect(tools(1)).not.toContain('escalate');
  // The strong role takes the step with the same instructions and conversation, and the turn context the light step went without.
  expect(requests[1]!.request.system).toBe(requests[0]!.request.system);
  expect(requests[1]!.request.messages.slice(0, -1)).toEqual(requests[0]!.request.messages.slice(0, -1));
  expect(String(requests[1]!.request.messages.at(-1)!.content).length).toBeGreaterThan(String(requests[0]!.request.messages.at(-1)!.content).length);
  expect('stream' in requests[0]!).toBe(false);
  expect('stream' in requests[1]!).toBe(true);
  for (const text of shown) expect(text).not.toContain('light');
  expect(shown.length).toBeGreaterThan(0);
  expect(outcome).toMatchObject({ outcome: 'matched', withdrawals: 0 });
  expect(routes(hops)).toEqual(['escalated']);
});

it('a tool call the light step was not offered hands over unrun: only the strong role\'s call reaches the tool', async () => {
  const { gateway, requests, models } = fake({
    [LIGHT_ROLE]: () => ({ tool: 'get_context' }),
    [STRONG_ROLE]: (request: LLMGatewayRequest) => request.request.tool_turns?.length ? { text: CHAT_REPLY } : { tool: 'get_context' },
  });
  const hops: TurnLogEntry[] = [];
  const reply = await responder(gateway, { log: (entry) => hops.push(entry) }).respond(turn('light-tool', 'What time is it in Tokyo?'), time);
  expect(reply).toBe(CHAT_REPLY);
  expect(hops.filter((entry) => entry.hop === 'tool_get_context')).toHaveLength(1);
  expect(models()).toEqual([LIGHT_ROLE, STRONG_ROLE, STRONG_ROLE]);
  expect(requests[1]!.request.tool_turns).toBeUndefined();
  expect(routes(hops)).toEqual(['tool']);
});

it('a light step that fails or is cut off hands over after one attempt, with no floor line and without moving the provider breaker', async () => {
  const cut = fake({ [LIGHT_ROLE]: () => ({ text: 'Half an answ', truncated: true }), [STRONG_ROLE]: CHAT_SCRIPT });
  const cutHops: TurnLogEntry[] = [];
  expect(await responder(cut.gateway, { log: (entry) => cutHops.push(entry), floor: true }).respond(turn('light-cut', 'Thanks!'), time)).toBe(CHAT_REPLY);
  expect(cut.models()).toEqual([LIGHT_ROLE, STRONG_ROLE]);
  expect(routes(cutHops)).toEqual(['truncated']);

  // Four turns on one responder, whose breaker opens a provider after three failures: a light role that keeps timing out
  // never opens it, so the strong role still answers the fourth.
  const down = fake({ [LIGHT_ROLE]: () => ({ fail: 'transient' }), [STRONG_ROLE]: CHAT_SCRIPT });
  const hops: TurnLogEntry[] = [];
  const owner = responder(down.gateway, { log: (entry) => hops.push(entry), floor: true });
  for (let i = 0; i < 4; i += 1) expect(await owner.respond(turn(`light-down-${i}`, 'Thanks!'), time)).toBe(CHAT_REPLY);
  expect(down.models()).toEqual(Array.from({ length: 4 }, () => [LIGHT_ROLE, STRONG_ROLE]).flat());
  expect(routes(hops)).toEqual(['failed', 'failed', 'failed', 'failed']);
  expect(hops.some((entry) => entry.hop === 'provider_breaker')).toBe(false);
});

it('with the strong role down, a handed-over turn falls back to the other provider\'s strong model, never to a light one', async () => {
  const { gateway, models } = fake({ [LIGHT_ROLE]: LIGHT_SCRIPT, [STRONG_ROLE]: () => ({ fail: 'transient' }), [OTHER_STRONG]: CHAT_SCRIPT, [OTHER_LIGHT]: () => ({ text: 'A light model must never answer a handed-over turn.' }) });
  const reply = await responder(gateway).respond(turn('light-fallback', HANDED_OVER[1][1]), time);
  expect(reply).toBe(CHAT_REPLY);
  expect(models()[0]).toBe(LIGHT_ROLE);
  expect(models().slice(1)).not.toContain(LIGHT_ROLE);
  expect(models()).not.toContain(OTHER_LIGHT);
  expect(models().at(-1)).toBe(OTHER_STRONG);
});

it('a stop during the light step ends the turn with no strong call; a steer during it reaches the strong role', async () => {
  let during: () => void = () => {};
  const stopped = fake({ [LIGHT_ROLE]: LIGHT_SCRIPT, [STRONG_ROLE]: CHAT_SCRIPT }, async () => during());
  const owner = responder(stopped.gateway);
  owner.control.bindTarget('run-stop');
  during = () => { expect(owner.control.stopTarget('run-stop')).toBe(true); };
  expect(await owner.respond(turn('light-stop', HANDED_OVER[0][1]), time)).toBe(STOPPED_REPLY);
  expect(stopped.models()).toEqual([LIGHT_ROLE]);
  expect(stopped.tools(0)).toContain('escalate');

  const steered = fake({ [LIGHT_ROLE]: LIGHT_SCRIPT, [STRONG_ROLE]: CHAT_SCRIPT }, async () => during());
  const next = responder(steered.gateway);
  next.control.bindTarget('run-steer');
  during = () => { expect(next.control.steerTarget('run-steer', 1, { text: 'and keep 4pm free', foreignRanges: [] })).toBe(true); during = () => {}; };
  expect(await next.respond(turn('light-steer', HANDED_OVER[0][1]), time)).toBe(CHAT_REPLY);
  expect(steered.models()).toEqual([LIGHT_ROLE, STRONG_ROLE]);
  expect(String(steered.requests[1]!.request.messages.at(-1)?.content)).toContain('and keep 4pm free');
  expect(next.control.unconsumed()).toEqual([]);
});

// A message folded into the turn is not stamped as the owner's own words, so a turn with one waiting takes no light step.
it('a newer owner message waiting on the chat takes the turn to the strong role, which folds it; no light step is taken', async () => {
  const folded: string[] = [];
  const waiting = [{ id: 'msg-2', text: 'and book a table for two', at: Date.parse('2026-10-20T08:19:00Z') }];
  const second = secondMessages({ chat: () => ({ turnId: 'light-second', waiting: () => waiting.filter((message) => !folded.includes(message.id)), fold: (id) => { folded.push(id); return true; } }), timezone: () => clock.timezone });
  const heard = { tool: 'owner_message_heard', args: { message_id: 'msg-2', choice: 'fold' } } as const;
  const { gateway, requests, models } = fake({
    [LIGHT_ROLE]: () => heard,
    [STRONG_ROLE]: (request: LLMGatewayRequest) => request.request.tool_turns?.length ? { text: CHAT_REPLY } : heard,
  });
  const hops: TurnLogEntry[] = [];
  const reply = await responder(gateway, { owner: { lightChat: true, newerOwnerMessages: second.round }, tools: [getContextHandler(clock), second.handler], log: (entry) => hops.push(entry) })
    .respond(turn('light-second', 'Find somewhere for dinner tonight.'), time);
  expect(reply).toBe(CHAT_REPLY);
  expect(folded).toEqual(['msg-2']);
  expect(models()).toEqual([STRONG_ROLE, STRONG_ROLE]);
  expect(String(requests[0]!.request.messages.at(-1)?.content)).toContain('msg-2');
  expect(routes(hops)).toEqual([]);
});

// Synthetic health, distinctive so a leak is found by its words: the energy window line and the driver.
const HEALTH_MARKERS = ['Energy windows today', 'wrist temperature above usual'] as const;
const sharedHealth = async () => toContextHealthMaterial({ context: {
  id: 'ctx-light', day: '2026-10-20', form: { score: 41.37, zone: 'moderate', algorithm_version: 'form.v9', activation: 'accepted', confidence: 0.617, baseline: { state: 'provisional', personal_days: 3, needed: 14, prior: 'adults' } },
  recovery: { score: 73.58, zone: 'good', algorithm_version: 'recovery.v5', activation: 'accepted', confidence: 0.617, baseline: { state: 'provisional', personal_days: 3, needed: 14, prior: 'adults' } },
  windows: [{ start: '09:30', end: '11:30', kind: 'peak' }], drivers: ['wrist temperature above usual'], confidence: 0.617, freshness: 'fresh', tags: [], compiled_at: '2026-10-20T07:20:00Z',
}, previous: null } as never, clock);
const DAY_PLAN = 'The Brief went out at 08:00: protect the design review at 11:00.';

it('the light step reads no admitted health, day plan or tool: a health question with health shared ends on the strong role', async () => {
  expect(await sharedHealth()).not.toBeNull();
  // The light role here would answer anything it could; with nothing to answer from, it hands over.
  const lightAnswersIfItCan: Script = (request) => HEALTH_MARKERS.some((marker) => JSON.stringify(request.request).includes(marker)) ? { text: 'Your energy peaks mid-morning.' } : { tool: 'escalate' };
  const { gateway, requests, models, tools } = fake({ [LIGHT_ROLE]: lightAnswersIfItCan, [STRONG_ROLE]: CHAT_SCRIPT });
  const args: Parameters<typeof createOwnerResponder> = [ACCESS];
  args[4] = clock; args[5] = [getContextHandler(clock)]; args[10] = gateway; args[17] = sharedHealth; args[18] = ['👌'];
  args[21] = { lightChat: true, dayCards: () => DAY_PLAN };
  const reply = await createOwnerResponder(...args).respond(turn('light-health', 'How is my energy today?'), time);
  expect(reply).toBe(CHAT_REPLY);
  expect(models()).toEqual([LIGHT_ROLE, STRONG_ROLE]);
  const light = JSON.stringify(requests[0]!.request), strong = JSON.stringify(requests[1]!.request);
  for (const marker of [...HEALTH_MARKERS, DAY_PLAN]) {
    expect(light).not.toContain(marker);
    expect(strong).toContain(marker);
  }
  expect(tools(0)).toEqual(['escalate']);
});

it('a turn that carries an attachment takes no light step', async () => {
  const { gateway, models } = fake({ [LIGHT_ROLE]: LIGHT_SCRIPT, [STRONG_ROLE]: CHAT_SCRIPT });
  const hops: TurnLogEntry[] = [];
  const image = { kind: 'image' as const, filename: 'label.png', mime_type: 'image/png', data_base64: 'AQ==' };
  expect(await responder(gateway, { log: (entry) => hops.push(entry) }).respond(turn('light-file', 'Thanks, what is this?', { attachments: [image] }), time)).toBe(CHAT_REPLY);
  expect(models()).toEqual([STRONG_ROLE]);
  expect(routes(hops)).toEqual([]);
});

// A Brief, a reminder or a card is a machine turn on the same chat. The light step reads only the owner's own exchange, so
// it cannot answer "what's on today?" from a Brief's plan wording; the strong role reads the whole chat.
const BRIEF_JOB = 'Write the Brief: the violet-harbour review sits at 11:00.';
const BRIEF_REPLY = 'Brief: the violet-harbour review at 11:00 is the anchor today.';
const onLight = (light: Script): Script => (request, said) => request.request.tools?.some((tool) => tool.name === 'escalate') ? light(request, said) : { text: BRIEF_REPLY };

it('the light step reads the owner\'s own exchange and no machine turn: a Brief on the same chat reaches only the strong role', async () => {
  const { gateway, requests, models } = fake({ [LIGHT_ROLE]: onLight(LIGHT_SCRIPT), [STRONG_ROLE]: CHAT_SCRIPT });
  const hops: TurnLogEntry[] = [];
  const owner = responder(gateway, { log: (entry) => hops.push(entry) });
  expect(await owner.respond(turn('light-own-1', 'Thanks for the kiwi-lantern tip.'), time)).toBe(LIGHT_REPLY);
  expect(await owner.prompt('brief-1', 'app-main', BRIEF_JOB, time, 'app')).toBe(BRIEF_REPLY);
  expect(await owner.respond(turn('light-own-2', 'What is on today?'), time)).toBe(CHAT_REPLY);
  expect(models()).toEqual([LIGHT_ROLE, LIGHT_ROLE, LIGHT_ROLE, STRONG_ROLE]);
  const light = requests[2]!.request.messages, strong = requests[3]!.request.messages;
  expect(light.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  expect(light.slice(0, 2).map((message) => message.content)).toEqual(['Thanks for the kiwi-lantern tip.', LIGHT_REPLY]);
  expect(JSON.stringify(light)).not.toContain('violet-harbour');
  for (const marker of ['kiwi-lantern', LIGHT_REPLY, BRIEF_JOB, BRIEF_REPLY]) expect(JSON.stringify(strong)).toContain(marker);
  expect(routes(hops)).toEqual(['answered', 'escalated']);
});

const BRIEF_TARGET = { surface: 'app', messageId: 'brief-1-reply', conversationRef: 'app-main', authorId: null, authorIsBot: true, text: BRIEF_REPLY, truncated: false, sourceTaint: 'external', provenance: { author: 'waldo', forwarded: false } } as const;
const OTHERS_WORDS = [
  ['a reply to a Brief', { replyTo: BRIEF_TARGET }],
  ['a forwarded part', { parts: [{ authorship: 'owner', text: 'Thanks, ' }, { authorship: 'forwarded', text: BRIEF_REPLY }] }],
  ['a transcribed recording with no attachment', { parts: [{ authorship: 'media_note', text: '[Owner sent a voice message.]' }, { authorship: 'file_transcript', text: `Thanks. ${BRIEF_REPLY}` }] }],
] as const;
it.each(OTHERS_WORDS)('%s takes no light step: the strong role answers it, though the light role would have', async (_kind, extra) => {
  const { gateway, models } = fake({ [LIGHT_ROLE]: () => ({ text: LIGHT_REPLY }), [STRONG_ROLE]: CHAT_SCRIPT });
  const hops: TurnLogEntry[] = [];
  expect(await responder(gateway, { log: (entry) => hops.push(entry) }).respond({ ...turn('light-quoted', 'Thanks'), ...extra }, time)).toBe(CHAT_REPLY);
  expect(models()).toEqual([STRONG_ROLE]);
  expect(routes(hops)).toEqual([]);
});

// Words the owner did not write, and Waldo's answer to them, stay out of every later light step too.
it.each(OTHERS_WORDS)('after %s, a later light step reads neither it nor Waldo\'s answer to it; the strong role reads both', async (_kind, extra) => {
  const echo: Script = (request) => JSON.stringify(request.request.messages).includes('violet-harbour') ? { text: 'Noted, the violet-harbour review stays at 11:00.' } : { text: CHAT_REPLY };
  const { gateway, requests, models } = fake({ [LIGHT_ROLE]: LIGHT_SCRIPT, [STRONG_ROLE]: echo });
  const owner = responder(gateway);
  await owner.respond({ ...turn('light-others-1', 'Thanks'), ...extra }, time);
  expect(await owner.respond(turn('light-others-2', 'What is on today?'), time)).toContain('violet-harbour');
  expect(models()).toEqual([STRONG_ROLE, LIGHT_ROLE, STRONG_ROLE]);
  expect(requests[1]!.request.messages.map((message) => message.role)).toEqual(['user']);
  expect(JSON.stringify(requests[1]!.request)).not.toContain('violet-harbour');
  expect(JSON.stringify(requests[2]!.request.messages.slice(0, -1))).toContain('Noted, the violet-harbour review');
});

// The chain as the owner DO writes it: a scheduled message and a "did not finish" notice hang under whatever row was last,
// an owner row in flight included; only the reply the conversation path wrote for an owner input is that input's answer.
it('the owner\'s own exchange keeps stamped owner inputs and their written replies, and nothing else on the chain', () => {
  const tree = new ConversationTree();
  let parentId: string | null = null;
  const row = (id: string, role: 'user' | 'assistant', extra: Partial<ConversationEntry> = {}, parent = parentId) => {
    tree.append({ id, ownerId: 'owner', chatId: 'app-main', parentId: parent, threadAnchorId: null, surface: 'app', modelPayload: id, appPayload: id, modelProjection: { mode: 'include' }, role, ...extra });
    parentId = id;
  };
  const typed = { inputOrigin: 'owner', ownerWordsOnly: true } as const;
  row('o1', 'user', typed); row('o1-reply', 'assistant');
  row('o2', 'user', typed); row('scheduled-x', 'assistant');
  row('o3', 'user', typed); row('o3-did-not-finish', 'assistant', { operation: { id: 'o3', state: 'interrupted' } });
  row('o4', 'user', { inputOrigin: 'owner' }); row('o4-reply', 'assistant');
  row('m1', 'user', { inputOrigin: 'machine' }); row('m1-reply', 'assistant');
  row('o5', 'user', typed);
  expect(ownerExchangeHistory(tree, 'o5').map((message) => message.content)).toEqual(['o1', 'o1-reply', 'o2', 'o3', 'o5']);
});

it('over the spend ceiling no light step is taken: every call is on the auxiliary route already', async () => {
  const { gateway, models, tools } = fake({ [LIGHT_ROLE]: LIGHT_SCRIPT, [STRONG_ROLE]: CHAT_SCRIPT });
  const hops: TurnLogEntry[] = [];
  await responder(gateway, { owner: { lightChat: true, spend: () => ({ spentUsd: 6, ceilingUsd: 5 }) }, log: (entry) => hops.push(entry) }).respond(turn('light-capped', 'Thanks, that is all.'), time);
  expect(models()).toEqual([LIGHT_ROLE]);
  expect(tools(0)).not.toContain('escalate');
  expect(routes(hops)).toEqual([]);
});

// The composer's operations material (workspace, tool results, health) and owner memory and recall, each with a marker the
// strong request must carry, so a light request without them is a real absence.
const OPERATIONS_MARKERS = ['saffron-ledger', 'cobalt-receipt', 'Keeps a copper lantern in the shed'] as const;
it('the light step reads none of the composed operations material, owner memory or recall; the strong role reads them all', async () => {
  const principal = '10000000-0000-0000-0000-000000000001';
  const scope = (): RunEffectScope => ({ runId: 'run-light', attempt: 'attempt-one', deadline: Date.now() + 15 * 60_000, signal: new AbortController().signal, admit: () => undefined, commit: (work) => work() });
  const text = 'Thanks, where did I leave the copper lantern?';
  const admission = await ownerMessageAdmission({
    lookup: async () => ({ owner_id: principal, do_name: 'owner-demo', state_version: 0, admission_revision: '1', presence_id: '20000000-0000-0000-0000-000000000001', provider: 'telegram', subject: '1001' }),
    scope: scope(), locator: { environment: 'staging', namespace: 'owner-staging', doName: 'owner-demo', doId: 'actual-do' },
    actualDoId: 'actual-do', expectedDoId: (name: string) => name === 'owner-demo' ? 'actual-do' : 'other-do',
    allowedDoNames: ['owner-demo'], provider: 'telegram' as const, subject: '1001', text, occurrenceKey: 'light-composed', occurredAt: Date.now() - 1, now: Date.now,
  });
  const at = Date.now() - 1_000;
  const workspace = { text: 'saffron-ledger draft, edited this morning', source: { source_key: 'ws-light', source_kind: 'workspace_snapshot' as const, scope: 'principal' as const, source_taint: 'external' as const, produced_at: at } };
  const toolOutput = { text: 'cobalt-receipt filed for the owner', source: { source_key: 'tool-light', source_kind: 'tool_result' as const, scope: 'principal' as const, source_taint: null, produced_at: at } };
  const context = createOwnerTurnContext(admission, { health: sharedHealth, workspace: async () => [workspace], toolOutputs: async () => [toolOutput] });
  const { gateway, requests, models } = fake({ [LIGHT_ROLE]: () => ({ tool: 'escalate' }), [STRONG_ROLE]: CHAT_SCRIPT });
  const hops: TurnLogEntry[] = [];
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('light-composed')), async (_instance, state) => {
    const memory = claimStore(state.storage.sql);
    memory.add({ kind: 'fact', text: 'Keeps a copper lantern in the shed', source: 'stated', evidence: '"copper lantern"', origin: 'owner', source_ref: 'owner, fixture-1' }, '2026-10-13T00:00:00.000Z');
    const args: Parameters<typeof createOwnerResponder> = [ACCESS];
    args[2] = memory; args[3] = (entry) => hops.push(entry); args[4] = clock; args[5] = [getContextHandler(clock)]; args[10] = gateway; args[18] = ['👌']; args[19] = scope();
    args[21] = { context, lightChat: true };
    expect(await createOwnerResponder(...args).respond(turn('light-composed', text, { conversationRef: context.conversationRef }), time)).toBe(CHAT_REPLY);
  });
  expect(models()).toEqual([LIGHT_ROLE, STRONG_ROLE]);
  const light = JSON.stringify(requests[0]!.request), strong = JSON.stringify(requests[1]!.request);
  for (const marker of [...OPERATIONS_MARKERS, ...HEALTH_MARKERS]) {
    expect(strong, marker).toContain(marker);
    expect(light, marker).not.toContain(marker);
  }
  // The light call's trace sizes the context it was sent, the clock alone, not the strong step's.
  const shape = (hop: string) => hops.find((entry) => entry.hop === hop)?.shape?.context?.context_sections;
  expect(Object.keys(shape('llm_reply_light') ?? {})).toEqual(['clock']);
  expect(Object.keys(shape('llm_reply') ?? {})).toEqual(expect.arrayContaining(['clock', 'memory', 'reasons']));
});

// Guards, which hold on the code before this change too: off, and on machine turns, no light step is taken.
it('with the switch off, or on a machine turn, the reply runs on the strong role as before, with no light step', async () => {
  for (const owner of [{}, { lightChat: false }] as const) {
    const { gateway, requests, models, tools } = fake({ [LIGHT_ROLE]: LIGHT_SCRIPT, [STRONG_ROLE]: CHAT_SCRIPT });
    const hops: TurnLogEntry[] = [];
    const { stream } = drafts();
    expect(await responder(gateway, { owner, log: (entry) => hops.push(entry) }).respond(turn('light-off', 'Thanks, that is all.', { replyStream: stream }), time)).toBe(CHAT_REPLY);
    expect(models()).toEqual([STRONG_ROLE]);
    expect(tools(0)).not.toContain('escalate');
    expect('stream' in requests[0]!).toBe(true);
    expect(hops.map((entry) => entry.hop)).not.toContain('light_route');
  }
  // A machine turn runs on the auxiliary model as it always has, with its own tools and no hand-over.
  const machine = fake({ [LIGHT_ROLE]: () => ({ text: 'Time to stretch.' }) });
  const hops: TurnLogEntry[] = [];
  await responder(machine.gateway, { log: (entry) => hops.push(entry) }).remind('light-machine', 'app-main', 'Stretch', time);
  expect(machine.requests.flatMap((request) => (request.request.tools ?? []).map((tool) => tool.name))).not.toContain('escalate');
  expect(hops.map((entry) => entry.hop)).not.toContain('light_route');
});

it('roles come from the environment: the light step, the strong role and its fallback each run where it is set', async () => {
  const roles: LightChatRoles = lightChatRoles({ WALDO_LIGHT_ROLE_MODEL: OTHER_LIGHT, WALDO_STRONG_ROLE_MODEL: OTHER_STRONG, WALDO_STRONG_ROLE_FALLBACK_MODEL: STRONG_ROLE });
  expect(roles).toEqual({ light: OTHER_LIGHT, strong: OTHER_STRONG, strongFallback: STRONG_ROLE });
  const handed = fake({ [OTHER_LIGHT]: LIGHT_SCRIPT, [OTHER_STRONG]: CHAT_SCRIPT });
  const hops: TurnLogEntry[] = [];
  expect(await responder(handed.gateway, { log: (entry) => hops.push(entry), owner: { lightChat: true, lightRoles: roles } }).respond(turn('light-roles', HANDED_OVER[0][1]), time)).toBe(CHAT_REPLY);
  expect(handed.models()).toEqual([OTHER_LIGHT, OTHER_STRONG]);
  expect(handed.requests[0]!.request.max_tokens).toBe(LIGHT_ROLE_MAX_TOKENS);
  expect(routes(hops)).toEqual(['escalated']);
  // The configured strong role down: its configured fallback answers, and the provider default's light model never does.
  const down = fake({ [OTHER_LIGHT]: LIGHT_SCRIPT, [OTHER_STRONG]: () => ({ fail: 'transient' }), [STRONG_ROLE]: CHAT_SCRIPT });
  expect(await responder(down.gateway, { owner: { lightChat: true, lightRoles: roles } }).respond(turn('light-roles-down', HANDED_OVER[1][1]), time)).toBe(CHAT_REPLY);
  expect(down.models().at(-1)).toBe(STRONG_ROLE);
  expect(down.models()).not.toContain(LIGHT_ROLE);
});

it('a role set to something it may not run on keeps its default, and says so once by variable name', () => {
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (line: string) => { warned.push(line); };
  try {
    expect(lightChatRoles({})).toEqual({});
    expect(lightChatRoles({ WALDO_LIGHT_ROLE_MODEL: 'not-a-model', WALDO_STRONG_ROLE_MODEL: '' })).toEqual({});
    expect(lightChatRoles({ WALDO_LIGHT_ROLE_MODEL: 'not-a-model' })).toEqual({});
    // A strong role never runs on an auxiliary model, this provider's or the other's; a strong model from the other provider is taken.
    expect(lightChatRoles({ WALDO_STRONG_ROLE_MODEL: OTHER_LIGHT, WALDO_STRONG_ROLE_FALLBACK_MODEL: LIGHT_ROLE })).toEqual({});
    expect(lightChatRoles({ WALDO_STRONG_ROLE_MODEL: OTHER_STRONG })).toEqual({ strong: OTHER_STRONG });
    expect(lightChatRoles({ WALDO_LIGHT_ROLE_MAX_TOKENS: '1024' })).toEqual({ lightMaxTokens: 1024 });
    expect(lightChatRoles({ WALDO_LIGHT_ROLE_MAX_TOKENS: '99999' })).toEqual({});
  } finally { console.warn = original; }
  expect(warned).toHaveLength(4);
  expect(warned[1]).toContain('WALDO_STRONG_ROLE_MODEL is an auxiliary model');
  expect(warned[2]).toContain('WALDO_STRONG_ROLE_FALLBACK_MODEL is an auxiliary model');
  expect(warned[3]).toContain('WALDO_LIGHT_ROLE_MAX_TOKENS');
  expect(JSON.parse(warned[0]!)).toMatchObject({ hop: 'light_chat_role_refused', ok: false });
  expect(warned[0]).toContain('WALDO_LIGHT_ROLE_MODEL');
  expect(warned[0]).not.toContain('not-a-model');
});
