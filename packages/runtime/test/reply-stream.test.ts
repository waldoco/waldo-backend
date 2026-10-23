import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { createReplyStream, releasable, type ReplyCheck, type ReplyDraftSurface } from '../src/conversation/reply-stream';
import { replyGate, RELEASE_HOLD_BACK, withReplyStream } from '../src/conversation/reply-gate';
import { sanitise } from '../src/scribe/sanitiser';
import type { LLMGatewayAdapter } from '../src/llm/provider';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', 'aaaabbbbccccdddd'];
const gate = (topics: readonly string[] = []) => replyGate({ sanitise, canaries: CANARIES, topics });
const passAll: ReplyCheck = async () => ({ ok: true, holdBack: 0 });

// A clock the test moves: sleeping advances it, so cadence is checked without real waits.
const fakeClock = () => {
  let at = 0;
  return { now: () => at, sleep: async (ms: number) => { at += ms; }, advance: (ms: number) => { at += ms; } };
};
const surface = (over: Partial<ReplyDraftSurface> = {}) => {
  const shown: { text: string; at: number }[] = [];
  const clock = fakeClock();
  const draft: ReplyDraftSurface = { show: async (text) => { shown.push({ text, at: clock.now() }); }, minIntervalMs: 0, maxUpdates: 1000, maxChars: 4096, ...over };
  return { shown, clock, draft };
};
const settleWrites = () => new Promise((resolve) => setTimeout(resolve, 0));
const words = (count: number, word = 'plan') => Array.from({ length: count }, (_, i) => `${word}${i}`).join(' ');

describe('releasable', () => {
  it('cuts at a word boundary the hold-back behind the end, within the cap', () => {
    expect(releasable('alpha beta gamma delta', 6, 100)).toBe('alpha beta gamma');
    expect(releasable('alpha beta gamma delta', 7, 100)).toBe('alpha beta');
    expect(releasable('alpha beta', 20, 100)).toBe('');
    expect(releasable('alpha beta gamma delta', 0, 12)).toBe('alpha beta');
  });
});

describe('reply stream', () => {
  it('shows only whole-word prefixes of the final text and settles as matched', async () => {
    const { shown, clock, draft } = surface();
    const stream = createReplyStream(draft, clock);
    stream.begin(gate());
    const final = words(120);
    for (const piece of final.match(/.{1,7}/gs)!) { stream.deltas.delta(piece); await settleWrites(); }
    const outcome = await stream.settle(final);
    expect(shown.length).toBeGreaterThan(0);
    for (const { text } of shown) {
      expect(final.startsWith(text)).toBe(true);
      expect(final.length - text.length).toBeGreaterThanOrEqual(RELEASE_HOLD_BACK);
      expect(text).toBe(text.trim());
    }
    expect(outcome).toMatchObject({ outcome: 'matched', updates: shown.length, withdrawals: 0 });
    expect(outcome).not.toHaveProperty('stopped');
  });

  it.each([
    ['a canary token', CANARIES[1]!, 'canary'],
    ['an artifact link the turn did not receipt', 'https://waldo.example/f/art:123', 'artifact_link'],
    ['an OAuth link with its state', 'https://accounts.google.com/o/oauth2/v2/auth?state=abc123', 'secret_url'],
    ['a secret the scribe denies', 'api_key=abcdefghijklmnop1234', 'scribe_denied'],
    ['an armoured key block', '-----BEGIN PRIVATE KEY----- MIIEvQIBADANBg', 'armoured_block'],
  ])('stops before %s and never shows it', async (_name, offending, reason) => {
    const { shown, clock, draft } = surface();
    const stream = createReplyStream(draft, clock);
    stream.begin(gate());
    const final = `${words(80)} ${offending} ${words(80, 'more')}`;
    for (const piece of final.match(/.{1,5}/gs)!) { stream.deltas.delta(piece); await settleWrites(); }
    const outcome = await stream.settle(final);
    expect(shown.length).toBeGreaterThan(0);
    for (const { text } of shown) expect(text.length).toBeLessThan(final.indexOf(offending));
    expect(outcome.stopped).toBe(reason);
    expect(outcome.outcome).toBe('matched');
  });

  it('stops at a held or forgotten topic, holding back further than the topic is long', async () => {
    const topic = 'the surprise party for Priya at the lake house';
    const { shown, clock, draft } = surface();
    const stream = createReplyStream(draft, clock);
    stream.begin(gate([topic]));
    const final = `${words(60)} About ${topic}, ${words(60, 'tail')}`;
    for (const piece of final.match(/.{1,4}/gs)!) { stream.deltas.delta(piece); await settleWrites(); }
    const outcome = await stream.settle(final);
    expect(shown.every(({ text }) => !text.includes('surprise'))).toBe(true);
    expect(outcome.stopped).toBe('held_topic');
  });

  it('withdraws what a failed call showed when the next call begins, and the fallback text replaces it', async () => {
    const { shown, clock, draft } = surface();
    const stream = createReplyStream(draft, clock);
    stream.begin(passAll);
    stream.deltas.delta('first draft words that will not survive ');
    await settleWrites();
    expect(shown.at(-1)?.text).toBe('first draft words that will not survive');
    stream.begin(passAll);
    await settleWrites();
    expect(shown.at(-1)?.text).toBe('');
    const outcome = await stream.settle('The fallback answer.');
    expect(outcome).toMatchObject({ outcome: 'none', withdrawals: 1 });
  });

  it('keeps to the surface cadence and update cap', async () => {
    const { shown, clock, draft } = surface({ minIntervalMs: 1000, maxUpdates: 3 });
    const stream = createReplyStream(draft, clock);
    stream.begin(passAll);
    for (let i = 0; i < 40; i += 1) { stream.deltas.delta(`word${i} `); clock.advance(100); await settleWrites(); }
    const outcome = await stream.settle(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
    expect(shown).toHaveLength(3);
    for (let i = 1; i < shown.length; i += 1) expect(shown[i]!.at - shown[i - 1]!.at).toBeGreaterThanOrEqual(1000);
    expect(outcome).toMatchObject({ outcome: 'matched', updates: 3, stopped: 'update_cap' });
  });

  it('a surface that fails stops the stream without failing the turn', async () => {
    const { clock } = surface();
    const stream = createReplyStream({ show: async () => { throw new Error('429'); }, minIntervalMs: 0, maxUpdates: 10, maxChars: 4096 }, clock);
    stream.begin(passAll);
    stream.deltas.delta('some words here ');
    await settleWrites();
    stream.deltas.delta('and more words ');
    const outcome = await stream.settle('some words here and more words');
    expect(outcome.stopped).toBe('surface_failed');
  });

  it('reports a turn that ended without a reply as failed, and a reply the draft is not a prefix of as diverged', async () => {
    for (const [delivered, expected] of [[null, 'failed'], ['Something else entirely.', 'diverged']] as const) {
      const { clock, draft } = surface();
      const stream = createReplyStream(draft, clock);
      stream.begin(passAll);
      stream.deltas.delta('shown words here ');
      await settleWrites();
      expect((await stream.settle(delivered)).outcome).toBe(expected);
    }
  });

  it('ignores text that arrives after the turn settled', async () => {
    const { shown, clock, draft } = surface();
    const stream = createReplyStream(draft, clock);
    stream.begin(passAll);
    await stream.settle(null);
    stream.deltas.delta('late words ');
    await settleWrites();
    expect(shown).toEqual([]);
  });
});

describe('replyGate', () => {
  // The PostLLMCall scribe hook sanitises the whole response object; the gate sanitises the text alone. They must agree.
  it.each([
    'Your afternoon has two meetings and a gap at three.',
    'Your resting heart rate was 62 bpm today, a little above your usual.',
    'Call Priya at 555-123-4567 or email priya@example.com.',
    'Meet at 12 Baker Street at noon.',
    'Here it is: api_key=abcdefghijklmnop1234',
    'Bearer abcdefghijklmnopqrstuvwxyz0123456789',
  ])('agrees with the reply hook on %j', async (text) => {
    const hook = sanitise({ payload: { model: WALDO_CHAT_MODEL, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 }, destination: 'owner_reply', source_taint: null, canary_tokens: CANARIES });
    const unchanged = hook.ok && (hook.payload as { text?: unknown }).text === text;
    expect((await gate()(text)).ok).toBe(unchanged);
  });
});

describe('withReplyStream', () => {
  const base = { model: WALDO_CHAT_MODEL, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } as const;
  it('passes the gateway through untouched when no stream is attached', () => {
    const gateway: LLMGatewayAdapter = { complete: async () => ({ ok: true, data: { ...base, text: 'x' } }) };
    expect(withReplyStream(gateway, undefined, () => passAll)).toBe(gateway);
  });

  it('withdraws a call that went on to call tools, or failed, or threw', async () => {
    for (const outcome of ['tools', 'failed', 'threw'] as const) {
      const { shown, clock, draft } = surface();
      const stream = createReplyStream(draft, clock);
      const gateway: LLMGatewayAdapter = { complete: async (input) => {
        input.stream?.delta('Let me look that up for you now ');
        await settleWrites();
        if (outcome === 'threw') throw new Error('socket closed');
        return outcome === 'failed' ? { ok: false, code: 'transient', error: 'down' } : { ok: true, data: { ...base, text: 'Let me look', tool_calls: [{ call_id: 'c1', name: 'get_context', arguments: '{}' }] } };
      } };
      await withReplyStream(gateway, stream, () => passAll).complete({} as never).catch(() => undefined);
      await settleWrites();
      expect(shown.map(({ text }) => text)).toEqual(['Let me look that up for you now', '']);
    }
  });
});
