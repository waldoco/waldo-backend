// A-6 red-first: a long owner reply crosses the scribe reply cap and reaches Telegram as
// sequential <=4,096-char messages split on paragraph, then sentence, boundaries, and a
// multi-part final redelivers per part. Tool arguments cross tool_arg_sanitise at
// PreToolUse at each tool's own destination, so a 5 KB workspace_write body executes.
import { ROSTER, type SanitiseResult } from '@waldo/contracts';
import { describe, expect, it, vi } from 'vitest';
import { runHooks, type HookRuntimeContext } from '../src/hooks/registry';
import { sanitise } from '../src/scribe/sanitiser';
import { splitTelegramText, TELEGRAM_MESSAGE_MAX_CHARS, TelegramRejection } from '../src/channels/telegram-api';
import { TelegramFinalOutbox, FINAL_OUTBOX_KEY } from '../src/channels/telegram-final-outbox';
import { redactMailFollowupEntries } from '../src/channels/telegram-final-outbox';
import { telegramRichReply } from '../src/channels/rich-format';

const validCanaries = ['1111111111111111', '2222222222222222', '3333333333333333'];

function runtimeCtx(overrides: Partial<HookRuntimeContext> = {}): HookRuntimeContext {
  return {
    authenticatedUserId: 'user-1',
    trigger: 'user_message',
    canaryTokens: validCanaries,
    now: () => 1_700_000_000_000,
    rateLimitCheck: () => true,
    hasApproval: () => true,
    sourceTaint: null,
    toolArgSourceTaint: null,
    sanitise: ({ payload, source_taint }) =>
      ({ ok: true, payload, source_taint, redactions: [] }) satisfies SanitiseResult,
    ...overrides,
  };
}

describe('cap-reply-5k', () => {
  it('passes a 5 KB owner reply through PostLLMCall scribe instead of failing oversize', async () => {
    const text = 'the quick brown fox jumps over the lazy dog. '.repeat(110).trim();
    expect(text.length).toBeGreaterThan(4_096);
    expect(text.length).toBeLessThanOrEqual(32_768);
    const result = await runHooks(
      'PostLLMCall',
      {
        event: 'PostLLMCall',
        response: {
          model: ROSTER.fallback,
          text,
          input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1,
        },
        tokens_in: 1,
        tokens_out: 1,
      },
      runtimeCtx({ sanitise }),
    );
    expect(result.event).toBe('PostLLMCall');
    if (result.event !== 'PostLLMCall') throw new Error('unreachable');
    expect((result.response as { text: string }).text).toBe(text);
  });
});

describe('cap-toolarg-5k', () => {
  it('passes a 5 KB tool-call argument through PostLLMCall byte-identical', async () => {
    const args = JSON.stringify({ path: 'notes.md', mime: 'text/plain', expected_revision: 0, text: 'line of notes\n'.repeat(400) });
    expect(args.length).toBeGreaterThan(5_000);
    const result = await runHooks(
      'PostLLMCall',
      {
        event: 'PostLLMCall',
        response: {
          model: ROSTER.fallback,
          text: 'Saved it.',
          tool_calls: [{ call_id: 'c1', name: 'workspace_write', arguments: args }],
          input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1,
        },
        tokens_in: 1,
        tokens_out: 1,
      },
      runtimeCtx({ sanitise }),
    );
    expect(result.event).toBe('PostLLMCall');
    if (result.event !== 'PostLLMCall') throw new Error('unreachable');
    expect((result.response as { tool_calls: { arguments: string }[] }).tool_calls[0]!.arguments).toBe(args);
  });

  it('accepts a 5 KB workspace_write body at PreToolUse so the tool executes', async () => {
    const ctx = runtimeCtx({ sanitise });
    await runHooks('OnInvocationStart', { event: 'OnInvocationStart', trace_id: 'trace-cap-toolarg' }, ctx);
    const args = { path: 'notes.md', mime: 'text/plain', expected_revision: 0, text: 'line of notes\n'.repeat(400) };
    expect(args.text.length).toBeGreaterThan(5_000);
    const result = await runHooks('PreToolUse', { event: 'PreToolUse', tool: 'workspace_write', args }, ctx);
    if (result.event !== 'PreToolUse') throw new Error('unreachable');
    expect(result.args).toEqual(args);
  });

  it('still refuses a 5 KB send_message body: the channel cap is the tool schema, not the reply cap', async () => {
    const ctx = runtimeCtx({ sanitise });
    await runHooks('OnInvocationStart', { event: 'OnInvocationStart', trace_id: 'trace-cap-send' }, ctx);
    const args = { channel: 'telegram', content: 'x'.repeat(5_000), idempotency_key: 'a'.repeat(64) };
    await expect(
      runHooks('PreToolUse', { event: 'PreToolUse', tool: 'send_message', args }, ctx),
    ).rejects.toMatchObject({ code: 'invalid_args' });
  });
});

describe('splitTelegramText', () => {
  it('returns a short text unchanged as one part', () => {
    expect(splitTelegramText('hello')).toEqual(['hello']);
  });

  it('splits on paragraph boundaries when each paragraph fits', () => {
    const a = 'a'.repeat(3_000);
    const b = 'b'.repeat(3_000);
    expect(splitTelegramText(`${a}\n\n${b}`)).toEqual([a, b]);
  });

  it('packs paragraphs while they fit, then breaks', () => {
    const a = 'a'.repeat(2_000);
    const b = 'b'.repeat(2_000);
    const c = 'c'.repeat(2_000);
    expect(splitTelegramText(`${a}\n\n${b}\n\n${c}`)).toEqual([`${a}\n\n${b}`, c]);
  });

  it('splits an oversized paragraph on sentence boundaries', () => {
    const sentence = `${'word '.repeat(19)}end. `;
    const paragraph = sentence.repeat(50).trim();
    expect(paragraph.length).toBeGreaterThan(TELEGRAM_MESSAGE_MAX_CHARS);
    const parts = splitTelegramText(paragraph);
    expect(parts.length).toBe(2);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
      expect(part.endsWith('.')).toBe(true);
    }
    expect(parts.join(' ')).toBe(paragraph);
  });

  it('hard-cuts a single sentence longer than the cap so the content still goes out', () => {
    const word = 'x'.repeat(9_000);
    const parts = splitTelegramText(word);
    expect(parts.map(part => part.length)).toEqual([4_096, 4_096, 808]);
    expect(parts.join('')).toBe(word);
  });
});

const outboxFixture = () => {
  const data = new Map<string, unknown>(); let now = 1000;
  const kv = { get: <T>(key: string): T | undefined => structuredClone(data.get(key)) as T | undefined,
    put: (key: string, value: unknown) => { data.set(key, structuredClone(value)); } } as DurableObjectStorage['kv'];
  const outbox = new TelegramFinalOutbox(kv, () => now);
  const input = { id: 'turn:1', trace: 'tg-1', payload: { chat_id: 7, text: 'final' }, ownerSubject: '7', doName: 'owner-7' };
  const settled = vi.fn(async () => undefined);
  return { kv, outbox, input, settled, advance: () => { now += 31000; }, now: () => now };
};

describe('telegram final outbox multi-part delivery', () => {
  it('delivers a long final as sequential sendMessage calls on paragraph boundaries', async () => {
    const f = outboxFixture();
    const paragraphs = ['a'.repeat(2_800), 'b'.repeat(2_800), 'c'.repeat(2_800)];
    await f.outbox.enqueue({ ...f.input, payload: { chat_id: 7, text: paragraphs.join('\n\n') } });
    expect(f.outbox.records()[0]!.parts).toHaveLength(3);
    f.advance();
    const acks = [101, 102, 103];
    const send = vi.fn(async (_payload: { chat_id: number; text: string }) => ({ message_id: acks.shift(), chat: { id: 7 } }));
    await f.outbox.drain({ allowed: async () => true, send, settled: f.settled });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(call => (call[0] as { text: string }).text)).toEqual(paragraphs);
    for (const call of send.mock.calls) {
      expect((call[0] as { text: string }).text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
    }
    expect(f.outbox.records()[0]).toMatchObject({ status: 'delivered', messageId: 103, deliveredParts: 3 });
  });

  it('redelivery of a 3-part final resumes at the first undelivered part', async () => {
    const f = outboxFixture();
    const paragraphs = ['a'.repeat(2_800), 'b'.repeat(2_800), 'c'.repeat(2_800)];
    await f.outbox.enqueue({ ...f.input, payload: { chat_id: 7, text: paragraphs.join('\n\n') } });
    f.advance();
    const send = vi.fn()
      .mockResolvedValueOnce({ message_id: 101, chat: { id: 7 } })
      .mockRejectedValueOnce(new TelegramRejection(429, 'slow down', 30))
      .mockResolvedValue({ message_id: 102, chat: { id: 7 } });
    await f.outbox.drain({ allowed: async () => true, send, settled: f.settled });
    expect(send).toHaveBeenCalledTimes(2);
    expect(f.outbox.records()[0]).toMatchObject({ status: 'pending', deliveredParts: 1 });
    f.advance();
    await new TelegramFinalOutbox(f.kv, f.now).drain({ allowed: async () => true, send, settled: f.settled });
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls.map(call => (call[0] as { text: string }).text)).toEqual([
      paragraphs[0], paragraphs[1], paragraphs[1], paragraphs[2],
    ]);
    expect(f.outbox.records()[0]).toMatchObject({ status: 'delivered', messageId: 102, attempts: 2, deliveredParts: 3 });
  });

  it('keeps a short final byte-identical: one send, unchanged request', async () => {
    const f = outboxFixture();
    await f.outbox.enqueue(f.input);
    f.advance();
    const send = vi.fn(async (_payload: { chat_id: number; text: string }) => ({ message_id: 42, chat: { id: 7 } }));
    await f.outbox.drain({ allowed: async () => true, send, settled: f.settled });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual({ chat_id: 7, text: 'final' });
    expect(f.outbox.records()[0]).toMatchObject({ status: 'delivered', messageId: 42, deliveredParts: 1 });
  });

  it('re-renders a rich reply per part so no part exceeds the cap after HTML escaping', async () => {
    const f = outboxFixture();
    const markdown = `**bold & bright** ${'text & more '.repeat(12)}`;
    const paragraph = markdown.repeat(30);
    expect(paragraph.length).toBeGreaterThan(TELEGRAM_MESSAGE_MAX_CHARS);
    const rich = telegramRichReply(paragraph);
    await f.outbox.enqueue({ ...f.input, payload: { chat_id: 7, ...rich } });
    f.advance();
    const send = vi.fn(async (_payload: { chat_id: number; text: string }) => ({ message_id: 201, chat: { id: 7 } }));
    await f.outbox.drain({ allowed: async () => true, send, settled: f.settled });
    expect(send.mock.calls.length).toBeGreaterThan(1);
    for (const call of send.mock.calls) {
      // sendTelegramFinal holds fallback_text back from the wire; it only sends on a
      // can't-parse-entities rejection.
      const payload = call[0] as { text: string; parse_mode?: string };
      expect(payload.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
      expect(payload.parse_mode).toBe('HTML');
    }
    const stored = f.outbox.records()[0]!;
    expect(stored.parts!.length).toBe(send.mock.calls.length);
    for (const part of stored.parts!) {
      expect(part.fallback_text?.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
    }
    expect(f.outbox.records()[0]!.status).toBe('delivered');
  });

  it('maintenance scrub clears stored parts with the payload text', async () => {
    const f = outboxFixture();
    const paragraphs = ['a'.repeat(2_800), 'b'.repeat(2_800)];
    await f.outbox.enqueue({ ...f.input, payload: { chat_id: 7, text: paragraphs.join('\n\n') } });
    const rows = f.outbox.records();
    rows[0]!.status = 'delivered'; rows[0]!.settled = true; rows[0]!.createdAt = -90000000;
    f.kv.put(FINAL_OUTBOX_KEY, rows);
    await f.outbox.maintain();
    expect(f.outbox.records()[0]?.payload.text).toBe('');
    expect(f.outbox.records()[0]?.parts).toEqual([]);
  });

  it('owner-forget redaction rewrites stored parts with the payload', async () => {
    const f = outboxFixture();
    const secret = 'forgotten-detail';
    const text = `${'a'.repeat(2_800)} ${secret}\n\n${'b'.repeat(2_800)}`;
    await f.outbox.enqueue({
      ...f.input,
      payload: { chat_id: 7, text },
      mailFollowup: { loopId: 'l', due: '2026-10-03T10:00', sourceRef: 'mail:t', timezone: 'UTC', messageId: 'm' },
    });
    redactMailFollowupEntries(f.kv, [secret], '[redacted]');
    const row = f.outbox.records()[0]!;
    expect(row.parts?.some(part => part.text.includes(secret))).toBe(false);
    expect(row.parts?.some(part => part.text.includes('[redacted]'))).toBe(true);
  });
});
