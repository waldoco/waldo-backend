import { describe, expect, it, vi } from 'vitest';
import { plainTelegram, telegramRichReply } from '../src/channels/rich-format';
import { sendTelegramFinal, TelegramRejection } from '../src/channels/telegram-api';
import { TelegramFinalOutbox } from '../src/channels/telegram-final-outbox';

const URL = 'https://shop.example.test/roses?id=7&size=m';
const REPLY = `Two options:\n- **[10 red roses + cake](${URL}) — ₹1,145 listed.**\n- [**Same-day** delivery](https://shop.example.test/sameday) is __extra__, *usually* ₹99.`;

// Telegram's HTML subset: only these tags, properly nested, no entity inside code or pre, no link inside a link.
const telegramAccepts = (html: string): boolean => {
  const stack: string[] = [];
  for (const [, closing, tag] of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (!['b', 'a', 'code', 'pre'].includes(tag!)) return false;
    if (closing) { if (stack.pop() !== tag) return false; continue; }
    if (stack.includes('code') || stack.includes('pre') || (tag === 'a' && stack.includes('a'))) return false;
    stack.push(tag!);
  }
  return stack.length === 0;
};

describe('Telegram HTML for bold and links nested in each other', () => {
  it('converts bold wrapping a link, as in the live reply', () => {
    const html = telegramRichReply(`**[10 red roses + cake](${URL}) — ₹1,145 listed.**`).text;
    expect(html).toBe(`<b><a href="${URL.replace('&', '&#38;')}">10 red roses + cake</a> — ₹1,145 listed.</b>`);
    expect(telegramAccepts(html)).toBe(true);
  });

  it('converts a link wrapping bold', () => {
    const html = telegramRichReply('[see **this** offer](https://shop.example.test/a)').text;
    expect(html).toBe('<a href="https://shop.example.test/a">see <b>this</b> offer</a>');
    expect(telegramAccepts(html)).toBe(true);
  });

  it('renders the whole reply with no bold or link markers left and a valid tag structure', () => {
    const html = telegramRichReply(REPLY).text;
    expect(telegramAccepts(html)).toBe(true);
    expect(html).not.toContain('**');
    expect(html).not.toContain('](');
  });
});

describe('Telegram plain-text fallback', () => {
  it('keeps the Markdown source as the frozen fallback, so a re-render keeps the formatting', () => {
    expect(telegramRichReply(REPLY).fallback_text).toBe(REPLY);
  });

  it('drops emphasis markers, writes links as text (url) and keeps bullets', () => {
    const plain = plainTelegram(REPLY);
    expect(plain).toBe(`Two options:\n- 10 red roses + cake (${URL}) — ₹1,145 listed.\n- Same-day delivery (https://shop.example.test/sameday) is extra, usually ₹99.`);
    for (const marker of ['**', '](', '__']) expect(plain).not.toContain(marker);
  });

  it('keeps star bullets, literal stars and code untouched', () => {
    expect(plainTelegram('* first\n* second: 2 * 3 = 6, `a*b*c`')).toBe('* first\n* second: 2 * 3 = 6, `a*b*c`');
  });

  it('sends the plain rendering only on the entity-rejection retry', async () => {
    const send = vi.fn().mockRejectedValueOnce(new TelegramRejection(400, "Bad Request: can't parse entities: unsupported tag")).mockResolvedValue({ message_id: 3 });
    await sendTelegramFinal(send, { chat_id: 7, ...telegramRichReply(REPLY) });
    expect(send.mock.calls[0]![0]).toMatchObject({ parse_mode: 'HTML', text: telegramRichReply(REPLY).text });
    expect(send.mock.calls[1]![0]).toEqual({ chat_id: 7, text: plainTelegram(REPLY) });
  });
});

describe('a reply long enough to split', () => {
  it('keeps bold and links in every part', async () => {
    const lines = Array.from({ length: 120 }, (_, n) => `- **Option ${n}** [shop ${n}](https://shop.example.test/item/${n}) is listed at ₹${1000 + n} with same-day delivery available.`);
    const data = new Map<string, unknown>();
    const kv = { get: <T,>(key: string) => structuredClone(data.get(key)) as T, put: (key: string, value: unknown) => data.set(key, structuredClone(value)) } as unknown as DurableObjectStorage['kv'];
    const outbox = new TelegramFinalOutbox(kv, () => 1_000);
    await outbox.enqueue({ id: 'turn:1', trace: 'tg-1', payload: { chat_id: 7, ...telegramRichReply(lines.join('\n')) }, ownerSubject: '7', doName: 'owner-7' });
    const parts = outbox.records()[0]!.parts!;
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.text).toContain('<b>Option');
      expect(part.text).toContain('<a href="https://shop.example.test/item/');
      expect(part.text).not.toContain('**');
      expect(telegramAccepts(part.text)).toBe(true);
    }
  });
});
