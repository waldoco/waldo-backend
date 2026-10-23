import { expect, it } from 'vitest';
import { ANTHROPIC_PROVIDER, OPENAI_PROVIDER, type ErrorCode, type Provider } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { createReplyStream, type ReplyDraftSurface } from '../src/conversation/reply-stream';
import { ARTIFACT_LINK_REMOVED_NOTICE } from '../src/conversation/artifact-link-guard';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { getContextHandler } from '../src/tools/live/get-context';
import { ownerTyped } from './helpers/owner-typed';

// The owner's turn with a reply stream attached: what the owner sees early is a prefix of the reply the turn returns,
// a tool round never shows, a reply the delivery path rewrites stops streaming before the rewritten part, and a provider
// that dies mid-answer has its draft withdrawn so the fallback's answer replaces it. Without a stream the turn is the
// turn it always was.

type Step = Readonly<{ tool: string }> | Readonly<{ text: string; streamThenFail?: ErrorCode }> | Readonly<{ fail: ErrorCode }>;
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// One script per provider, one step per call. A text step streams its text in small pieces when the call carries a stream,
// as the adapter does for a final answer; streamThenFail streams half of it and then fails the call.
const scripted = (scripts: Partial<Record<Provider, readonly Step[]>>) => {
  const requests: LLMGatewayRequest[] = [];
  const queues = new Map<Provider, Step[]>();
  const gateway: LLMGatewayAdapter = { complete: async (input) => {
    requests.push(input);
    const queue = queues.get(input.step.provider) ?? queues.set(input.step.provider, [...(scripts[input.step.provider] ?? [{ fail: 'transient' }])]).get(input.step.provider)!;
    const step = queue.length > 1 ? queue.shift()! : queue[0]!;
    if ('fail' in step) return { ok: false, code: step.fail, error: 'down' };
    const base = { model: input.request.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 };
    if ('tool' in step) return { ok: true, data: { ...base, text: '', tool_calls: [{ call_id: `c${requests.length}`, name: step.tool, arguments: '{}' }] } };
    const pieces = step.text.match(/.{1,6}/gs) ?? [];
    for (const piece of step.streamThenFail ? pieces.slice(0, Math.ceil(pieces.length / 2)) : pieces) { input.stream?.delta(piece); await tick(); }
    if (step.streamThenFail) return { ok: false, code: step.streamThenFail, error: 'stream broke' };
    return { ok: true, data: { ...base, text: step.text } };
  } };
  return { gateway, requests };
};

const responder = (gateway: LLMGatewayAdapter, log: (entry: TurnLogEntry) => void = () => undefined) => {
  const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture-openai', anthropicApiKey: 'fixture-anthropic' }];
  args[3] = log; args[4] = { timezone: 'Asia/Kolkata', now: () => new Date('2026-10-20T08:20:00Z') }; args[5] = [getContextHandler({ timezone: 'Asia/Kolkata', now: () => new Date('2026-10-20T08:20:00Z') })]; args[10] = gateway; args[18] = ['👌'];
  return createOwnerResponder(...args);
};
const drafts = () => {
  const shown: string[] = [];
  const surface: ReplyDraftSurface = { show: async (text) => { shown.push(text); }, minIntervalMs: 0, maxUpdates: 1000, maxChars: 4096 };
  return { shown, stream: createReplyStream(surface) };
};
const turn = (traceId: string, extra: Record<string, unknown> = {}) => ownerTyped({ traceId, conversationRef: 'telegram-1', surface: 'telegram', text: 'plan my afternoon', memoryWrites: false, ...extra });
const words = (count: number, word = 'block') => Array.from({ length: count }, (_, i) => `${word}${i}`).join(' ');

it('shows only prefixes of the reply the turn returns, after the tool round, and settles as matched', async () => {
  const answer = `Here is your afternoon. ${words(90)}`;
  const { gateway } = scripted({ [OPENAI_PROVIDER]: [{ tool: 'get_context' }, { text: answer }] });
  const { shown, stream } = drafts();
  const reply = await responder(gateway).respond(turn('stream-1', { replyStream: stream }), time);
  const outcome = await stream.settle(reply);
  expect(reply).toBe(answer);
  expect(shown.length).toBeGreaterThan(0);
  for (const text of shown) expect(reply.startsWith(text)).toBe(true);
  expect(outcome).toMatchObject({ outcome: 'matched', withdrawals: 0 });
});

it('without a stream the turn sends the same requests, logs the same hops and returns the same reply', async () => {
  const run = async (withStream: boolean) => {
    const answer = `Here is your afternoon. ${words(90)}`;
    const { gateway, requests } = scripted({ [OPENAI_PROVIDER]: [{ tool: 'get_context' }, { text: answer }] });
    const hops: TurnLogEntry[] = [];
    const reply = await responder(gateway, (entry) => hops.push(entry)).respond(turn('stream-2', withStream ? { replyStream: drafts().stream } : {}), time);
    const shape = (entry: TurnLogEntry) => ({ hop: entry.hop, ok: entry.ok, code: entry.code, detail: entry.detail?.replace(/\d+/g, 'n') });
    return { reply, requests, hops: hops.map(shape) };
  };
  const off = await run(false), on = await run(true);
  expect(off.requests.every((request) => !('stream' in request))).toBe(true);
  expect(on.requests.every((request) => 'stream' in request)).toBe(true);
  expect(on.reply).toBe(off.reply);
  expect(JSON.stringify(on.requests.map(({ stream: _stream, ...request }) => request), null, 1)).toBe(JSON.stringify(off.requests, null, 1));
  expect(on.hops).toEqual(off.hops);
});

it('a reply the artifact-link guard rewrites never shows the link, and what showed is still a prefix of the delivered reply', async () => {
  const answer = `${words(70)} Your file: https://files.example.test/artifacts/art:a304fb9e ${words(70, 'tail')}`;
  const { gateway } = scripted({ [OPENAI_PROVIDER]: [{ text: answer }] });
  const { shown, stream } = drafts();
  const reply = await responder(gateway).respond(turn('stream-3', { replyStream: stream }), time);
  const outcome = await stream.settle(reply);
  expect(reply).toContain(ARTIFACT_LINK_REMOVED_NOTICE);
  expect(shown.length).toBeGreaterThan(0);
  for (const text of shown) { expect(text).not.toContain('art:'); expect(reply.startsWith(text)).toBe(true); }
  expect(outcome).toMatchObject({ outcome: 'matched', stopped: 'artifact_link' });
});

it('a primary that dies mid-answer has its draft withdrawn and the fallback answer replaces it', async () => {
  const { gateway, requests } = scripted({
    [OPENAI_PROVIDER]: [{ text: `The primary started ${words(120, 'half')}`, streamThenFail: 'transient' }, { fail: 'transient' }],
    [ANTHROPIC_PROVIDER]: [{ text: 'The fallback answer, whole.' }],
  });
  const { shown, stream } = drafts();
  const reply = await responder(gateway).respond(turn('stream-4', { replyStream: stream }), time);
  const outcome = await stream.settle(reply);
  expect(reply).toBe('The fallback answer, whole.');
  expect(requests.map((request) => request.step.provider)).toEqual([OPENAI_PROVIDER, OPENAI_PROVIDER, ANTHROPIC_PROVIDER]);
  expect(shown.some((text) => text.startsWith('The primary started'))).toBe(true);
  expect(shown.at(-1)).toBe('');
  expect(outcome).toMatchObject({ outcome: 'none', withdrawals: 1 });
});

it('a side call in the same turn (a subagent, a title, a reaction) never feeds the stream', async () => {
  const { gateway, requests } = scripted({ [OPENAI_PROVIDER]: [{ text: `Done. ${words(80)}` }, { text: '{"reaction":"👌"}' }] });
  const { stream } = drafts();
  const owner = responder(gateway);
  await owner.respond(turn('stream-5', { replyStream: stream }), time);
  await owner.chooseReaction(turn('stream-5', { replyStream: stream }));
  expect(requests.filter((request) => 'stream' in request)).toHaveLength(1);
});
