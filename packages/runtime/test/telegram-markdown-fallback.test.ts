import { describe, expect, it } from 'vitest';
import { telegramRichReply } from '../src/channels/rich-format';

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
  it('drops emphasis markers, writes links as text (url) and keeps bullets', () => {
    const { fallback_text } = telegramRichReply(REPLY);
    expect(fallback_text).toBe(`Two options:\n- 10 red roses + cake (${URL}) — ₹1,145 listed.\n- Same-day delivery (https://shop.example.test/sameday) is extra, usually ₹99.`);
    for (const marker of ['**', '](', '__']) expect(fallback_text).not.toContain(marker);
  });

  it('keeps star bullets, literal stars and code untouched', () => {
    expect(telegramRichReply('* first\n* second: 2 * 3 = 6, `a*b*c`').fallback_text).toBe('* first\n* second: 2 * 3 = 6, `a*b*c`');
  });
});
