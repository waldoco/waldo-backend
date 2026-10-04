import { expect, it, vi } from 'vitest';
import { telegramRichReply } from '../src/channels/rich-format';
import { TelegramOwnerListener } from '../src/channels/telegram-listener';
import { TelegramRejection, sendTelegramFinal } from '../src/channels/telegram-api';
import { TelegramFinalOutbox, redactMailFollowupEntries } from '../src/channels/telegram-final-outbox';

it('renders generated file readback with a code-styled link label without disabling neighboring code', () => {
  const text = 'Read `notes.md`: [`Open notes.md`](https://example.test/a?rev=1&v=2)\n```md\n**literal** <tag> & [x](url)\n```';
  expect(telegramRichReply(text).text).toBe('Read <code>notes.md</code>: <a href="https://example.test/a?rev=1&#38;v=2">Open notes.md</a>\n<pre>**literal** &#60;tag&#62; &#38; [x](url)\n</pre>');
});

it('renders a bold code filename as opaque code, without illegal nested entities', () => {
  expect(telegramRichReply('Read **`notes.md`** [open](https://example.test)').text).toBe('Read <code>notes.md</code> <a href="https://example.test">open</a>');
});

it('supports mixed bold/code file descriptions and bold/code link labels without nested code entities', () => {
  expect(telegramRichReply('**File `notes.md`** [**`open`**](https://example.test)').text).toBe('<b>File notes.md</b> <a href="https://example.test"><b>open</b></a>');
});

it('preserves escaped user-authored literal markup in the generated presentation', () => {
  expect(telegramRichReply('Literal \\`ticks\\` and \\[x](https://example.test)').text).toBe('Literal `ticks` and [x](https://example.test)');
});

it('falls back to the exact guarded final after a definite entity rejection', async () => {
  const text = '**Read** `notes.md` <tag> & [open](https://example.test)';
  const send = vi.fn().mockRejectedValueOnce(new TelegramRejection(400, "Bad Request: can't parse entities: unsupported tag")).mockResolvedValue({ message_id: 3 });
  const listener = new TelegramOwnerListener({ ownerTelegramId: 7, api: { sendMessage: send, sendChatAction: async () => undefined, setMessageReaction: async () => undefined }, respond: async () => text, saveOffset: async () => undefined });
  expect(await listener.handle({ updateId: 1, senderId: 7, chatId: 7, messageId: 2, sentAt: null, text: 'read' })).toBe('answered');
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]![0]).toEqual({ chat_id: 7, text });
});

it.each([
  new Error('network unknown'), new TelegramRejection(400, 'Bad Request: chat not found'),
  new TelegramRejection(403, 'forbidden'), new TelegramRejection(429, 'slow', 30),
  new Error('telegram transport unknown'),
])('never falls back after a non-format or ambiguous failure: %s', async error => {
  const send = vi.fn().mockRejectedValue(error);
  await expect(sendTelegramFinal(send, { chat_id: 7, ...telegramRichReply('**Read**') })).rejects.toBe(error);
  expect(send).toHaveBeenCalledTimes(1);
});

it('keeps literal sends untouched and never sends internal fallback fields to Telegram', async () => {
  const text = 'User: `**literal**` [x](https://example.test)';
  const send = vi.fn(async () => undefined);
  await sendTelegramFinal(send, { chat_id: 7, text });
  expect(send).toHaveBeenCalledWith({ chat_id: 7, text });
});

const fixture = async () => {
  const data = new Map<string, unknown>(); let now = 1_000;
  const kv = { get: <T>(key: string) => structuredClone(data.get(key)) as T, put: (key: string, value: unknown) => data.set(key, structuredClone(value)) } as unknown as DurableObjectStorage['kv'];
  const outbox = new TelegramFinalOutbox(kv, () => now);
  const text = '**Read** `notes.md` <private> & [open](https://example.test)';
  const input = { id: 'turn:1', trace: 'tg-1', payload: { chat_id: 7, ...telegramRichReply(text) }, ownerSubject: '7', doName: 'owner-7' };
  await outbox.enqueue(input); now += 300;
  return { kv, outbox, text, input, now: () => now, advance: () => { now += 86_400_000; } };
};
const rejection = () => new TelegramRejection(400, "Bad Request: can't parse entities: unsupported tag");

it('freezes fallback bytes and delivers plain text after rejection without mutating the rich intent', async () => {
  const f = await fixture();
  const send = vi.fn().mockRejectedValueOnce(rejection()).mockResolvedValue({ message_id: 3, chat: { id: 7 } });
  await new TelegramFinalOutbox(f.kv, f.now).drain({ allowed: async () => true, send, settled: async () => undefined });
  expect(send.mock.calls[0]![0]).not.toHaveProperty('fallback_text');
  expect(send.mock.calls[1]![0]).toEqual({ chat_id: 7, text: f.text });
  expect(f.outbox.records()[0]).toMatchObject({ status: 'delivered', attempts: 1, payload: f.input.payload });
  f.advance(); await f.outbox.maintain();
  expect(f.outbox.records()[0]!.payload).toEqual({ chat_id: 7, text: '' });
});

it('rechecks ownership between rich rejection and plain fallback', async () => {
  const f = await fixture();
  const allowed = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
  const send = vi.fn().mockRejectedValue(rejection());
  await f.outbox.drain({ allowed, send, settled: async () => undefined });
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.outbox.records()[0]).toMatchObject({ status: 'blocked', reason: 'egress_blocked' });
});

it('never replays a fallback whose network result was ambiguous', async () => {
  const f = await fixture();
  const send = vi.fn().mockRejectedValueOnce(rejection()).mockRejectedValueOnce(new Error('network unknown'));
  await f.outbox.drain({ allowed: async () => true, send, settled: async () => undefined });
  await new TelegramFinalOutbox(f.kv, f.now).drain({ allowed: async () => true, send, settled: async () => undefined });
  expect(send).toHaveBeenCalledTimes(2);
  expect(f.outbox.records()[0]).toMatchObject({ status: 'quarantined', reason: 'send_unknown' });
});

it('does not fall back on an invalid rich acknowledgement', async () => {
  const f = await fixture(); const send = vi.fn(async () => ({ message_id: 'bad' }));
  await f.outbox.drain({ allowed: async () => true, send, settled: async () => undefined });
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.outbox.records()[0]).toMatchObject({ status: 'quarantined', reason: 'invalid_ack' });
});

it('owner-forget scrubs source-derived fallback copies along with rich text', async () => {
  const f = await fixture();
  const rows = f.outbox.records();
  rows[0]!.mailFollowup = { loopId: 'l', due: 'd', sourceRef: 's', timezone: 'UTC', messageId: 'm' };
  f.kv.put('telegram_final_outbox_v1', rows);
  expect(redactMailFollowupEntries(f.kv, ['private'], '[forgotten]')).toEqual({ rewritten: 1, remaining: 0 });
  expect(f.outbox.records()[0]!.payload.fallback_text).not.toContain('private');
  expect(f.outbox.records()[0]).toMatchObject({ status: 'blocked', reason: 'owner_forget' });
});

it('does not send a captured plain fallback after concurrent owner-forget', async () => {
  const f = await fixture(); const rows = f.outbox.records();
  rows[0]!.mailFollowup = { loopId: 'l', due: 'd', sourceRef: 's', timezone: 'UTC', messageId: 'm' };
  f.kv.put('telegram_final_outbox_v1', rows);
  const send = vi.fn(async () => {
    redactMailFollowupEntries(f.kv, ['private'], '[forgotten]');
    throw rejection();
  });
  await f.outbox.drain({ allowed: async () => true, send, settled: async () => undefined });
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.outbox.records()[0]!.payload.fallback_text).not.toContain('private');
  expect(f.outbox.records()[0]).toMatchObject({ status: 'quarantined', reason: 'forget_during_uncertain_send' });
});

it('does not fall back after the frozen delivery expires during the rich send', async () => {
  const f = await fixture(); const rows = f.outbox.records(); rows[0]!.expiresAt = f.now() + 100;
  f.kv.put('telegram_final_outbox_v1', rows);
  const send = vi.fn(async () => { f.advance(); throw rejection(); });
  await f.outbox.drain({ allowed: async () => true, send, settled: async () => undefined });
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.outbox.records()[0]!.status).toBe('blocked');
});

it('a restart while the fallback is in flight quarantines the frozen attempt without replay', async () => {
  const f = await fixture();
  const restartedSend = vi.fn();
  const send = vi.fn().mockRejectedValueOnce(rejection()).mockImplementationOnce(async () => {
    expect(f.outbox.records()[0]!.status).toBe('attempting');
    await new TelegramFinalOutbox(f.kv, f.now).drain({ allowed: async () => true, send: restartedSend, settled: async () => undefined });
    expect(f.outbox.records()[0]!.reason).toBe('restart_during_send');
    throw new Error('connection lost');
  });
  await f.outbox.drain({ allowed: async () => true, send, settled: async () => undefined });
  expect(restartedSend).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(2);
  expect(f.outbox.records()[0]!.status).toBe('quarantined');
});

it.each(['ack', 'unknown'])('concurrent forget during plain fallback is not overwritten after %s', async outcome => {
  const f = await fixture(); const rows = f.outbox.records();
  rows[0]!.mailFollowup = { loopId: 'l', due: 'd', sourceRef: 's', timezone: 'UTC', messageId: 'm' };
  f.kv.put('telegram_final_outbox_v1', rows);
  const send = vi.fn().mockRejectedValueOnce(rejection()).mockImplementationOnce(async () => {
    redactMailFollowupEntries(f.kv, ['private'], '[forgotten]');
    if (outcome === 'unknown') throw new Error('network unknown');
    return { message_id: 3, chat: { id: 7 } };
  });
  await f.outbox.drain({ allowed: async () => true, send, settled: async () => undefined });
  expect(send).toHaveBeenCalledTimes(2);
  expect(f.outbox.records()[0]!.payload.fallback_text).not.toContain('private');
  expect(f.outbox.records()[0]).toMatchObject({ status: 'quarantined', reason: 'forget_during_uncertain_send' });
});

it('rechecks expiry after the asynchronous fallback owner gate', async () => {
  const f = await fixture(); const rows = f.outbox.records(); rows[0]!.expiresAt = f.now() + 100;
  f.kv.put('telegram_final_outbox_v1', rows);
  const allowed = vi.fn().mockResolvedValueOnce(true).mockImplementationOnce(async () => { f.advance(); return true; });
  const send = vi.fn().mockRejectedValue(rejection());
  await f.outbox.drain({ allowed, send, settled: async () => undefined });
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.outbox.records()[0]!.status).toBe('blocked');
});
