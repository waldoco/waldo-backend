import PostalMime from 'postal-mime';
import { describe, expect, it } from 'vitest';
import { WALDO_MARK_PNG_BASE64 } from '../src/channels/agent-mail/mark';
import {
  AGENT_MAIL_BODY_MAX, AGENT_MAIL_HTML_MAX, AGENT_MAIL_MAX_RECIPIENTS, AGENT_MAIL_MIME_MAX, renderAgentMail,
  type AgentMailDraft, type AgentMailRecipients, type AgentMailSender, type AgentMailWire,
} from '../src/channels/agent-mail/render';

// The rendered message is checked by parsing it back with the same MIME parser agent mail reads inbound mail with: what
// a recipient's client decodes must be what the approval card shows. Every fixture is synthetic.
const SENDER: AgentMailSender = { address: 'priya@mail.test.invalid', ownerFirstName: 'Priya' };
const TO: AgentMailRecipients = { to: ['sam@example.test'], cc: ['alex@example.test'] };
const WIRE: AgentMailWire = { messageId: '<a1b2c3@mail.test.invalid>', date: Date.UTC(2026, 9, 31, 9, 30, 0) };
const DRAFT: AgentMailDraft = {
  subject: 'Moving Thursday’s design review',
  body_markdown: [
    'Hi Sam,',
    'Priya asked me to move **Thursday’s design review** to *Friday at 3pm*. The agenda is unchanged:',
    '- Header layout\n- Pricing page copy\n  with the new tiers\n- Next steps',
    '| Slot | Room |\n| --- | --- |\n| Fri 15:00 | Juniper |\n| Fri 16:00 | Cedar |',
    'The notes are at [the shared doc](https://docs.example.test/review?id=42&v=2), and the old invite is https://cal.example.test/e/9.',
    'Thanks,',
  ].join('\n\n'),
  callout: 'New time: **Friday, 3pm**',
  action: { label: 'Accept the new time', url: 'https://cal.example.test/accept/9' },
};

const render = (draft: Partial<AgentMailDraft> = {}, sender: Partial<AgentMailSender> = {}, recipients: AgentMailRecipients = TO, wire: Partial<AgentMailWire> = {}) =>
  renderAgentMail({ ...DRAFT, ...draft }, { ...SENDER, ...sender }, recipients, { ...WIRE, ...wire });
const ok = (result: ReturnType<typeof renderAgentMail>) => {
  if (!result.ok) throw new Error(`render refused: ${result.code}`);
  return result;
};
const lf = (value: string | undefined) => value?.replace(/\r\n/g, '\n');
const headerBlock = (mime: string) => mime.slice(0, mime.indexOf('\r\n\r\n'));
const headerNames = (mime: string) => headerBlock(mime).split('\r\n').filter(line => !/^[ \t]/.test(line)).map(line => line.slice(0, line.indexOf(':')));
const parsed = (mime: string) => PostalMime.parse(mime, { attachmentEncoding: 'base64' });

// The card's fields equal what the parser decodes from the wire bytes.
const expectRoundTrip = async (result: Extract<ReturnType<typeof renderAgentMail>, { ok: true }>) => {
  const mail = await parsed(result.mime);
  expect(mail.subject).toBe(result.preview.subject);
  expect(mail.from).toEqual({ name: result.preview.from.name, address: result.preview.from.address });
  expect(mail.to!.map(entry => entry.address)).toEqual(result.preview.to);
  expect((mail.cc ?? []).map(entry => entry.address)).toEqual(result.preview.cc);
  expect(lf(mail.text)).toBe(result.preview.text);
  expect(lf(mail.html)).toBe(result.preview.html);
  return mail;
};

describe('renderAgentMail', () => {
  it('renders the draft as multipart/alternative of text and related HTML with Waldo\'s mark inline by CID', async () => {
    const result = ok(render());
    const { mime } = result;
    expect(headerNames(mime)).toEqual(['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'MIME-Version', 'Content-Type']);
    expect(mime).toContain('From: "Waldo, Priya\'s assistant" <priya@mail.test.invalid>\r\n');
    expect(mime).toContain('Date: Sat, 31 Oct 2026 09:30:00 +0000\r\n');
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="=_waldo_alt"\r\n');
    // Part order: plain text first, then the related HTML and its image, so a client shows the richest part it can.
    const order = ['--=_waldo_alt\r\nContent-Type: text/plain', '--=_waldo_alt\r\nContent-Type: multipart/related', '--=_waldo_rel\r\nContent-Type: text/html', '--=_waldo_rel\r\nContent-Type: image/png', '--=_waldo_rel--', '--=_waldo_alt--'];
    expect(order.map(marker => mime.indexOf(marker))).toEqual([...order.map(marker => mime.indexOf(marker))].sort((a, b) => a - b));
    expect(order.every(marker => mime.split(marker).length === 2)).toBe(true);

    const mail = await expectRoundTrip(result);
    expect(mail.messageId).toBe(WIRE.messageId);
    expect(mail.attachments).toHaveLength(1);
    const [mark] = mail.attachments;
    expect(mark).toMatchObject({ mimeType: 'image/png', disposition: 'inline', contentId: '<waldo-mark@mail.test.invalid>', content: WALDO_MARK_PNG_BASE64 });
    expect(result.preview.html).toContain('<img src="cid:waldo-mark@mail.test.invalid" width="61" height="48" alt="Waldo"');
    expect(result.parts.attachments).toEqual([{ content: WALDO_MARK_PNG_BASE64, filename: 'waldo.png', type: 'image/png', disposition: 'inline', contentId: 'waldo-mark@mail.test.invalid' }]);
    expect(result.parts).toMatchObject({ from: { email: SENDER.address, name: "Waldo, Priya's assistant" }, to: TO.to, cc: TO.cc, subject: result.preview.subject, text: result.preview.text, html: result.preview.html, headers: {} });
  });

  it('frames the model words without adding its own: the body, callout, action and signature in both parts', () => {
    const { preview } = ok(render());
    expect(preview.html).toContain('<strong>Thursday’s design review</strong>');
    expect(preview.html).toContain('<em>Friday at 3pm</em>');
    expect(preview.html).toMatch(/<ul [^>]*><li [^>]*>Header layout<\/li><li [^>]*>Pricing page copy<br>with the new tiers<\/li><li [^>]*>Next steps<\/li><\/ul>/);
    expect(preview.html).toMatch(/<th [^>]*>Slot<\/th><th [^>]*>Room<\/th><\/tr><tr><td [^>]*>Fri 15:00<\/td><td [^>]*>Juniper<\/td>/);
    expect(preview.html).toContain('<a href="https://docs.example.test/review?id=42&#38;v=2" style="color:#1A1A1A;text-decoration:underline;text-decoration-color:#FB943F">the shared doc</a> <span style="color:#6B6B68">(https://docs.example.test/review?id=42&#38;v=2)</span>');
    expect(preview.html).toContain('>Accept the new time</a>');
    expect(preview.html).toMatch(/<img src="cid:waldo-mark@mail\.test\.invalid" [^>]*><\/td><td [^>]*><strong style="color:#1A1A1A">Waldo<\/strong>, Priya's assistant<br>priya@mail\.test\.invalid<\/td>/);
    expect(preview.html.indexOf('cid:')).toBeGreaterThan(preview.html.indexOf('Accept the new time'));

    expect(preview.text).toBe([
      'New time: Friday, 3pm',
      'Hi Sam,',
      'Priya asked me to move Thursday’s design review to Friday at 3pm. The agenda is unchanged:',
      '- Header layout\n- Pricing page copy\n   with the new tiers\n- Next steps',
      'Slot      | Room\n----------|--------\nFri 15:00 | Juniper\nFri 16:00 | Cedar',
      'The notes are at the shared doc (https://docs.example.test/review?id=42&v=2), and the old invite is https://cal.example.test/e/9.',
      'Thanks,',
      'Accept the new time: https://cal.example.test/accept/9',
      "-- \nWaldo, Priya's assistant\npriya@mail.test.invalid",
    ].join('\n\n') + '\n');
  });

  it('keeps every word of the draft in the plain-text part, with no markup', () => {
    const { preview } = ok(render());
    const words = (value: string) => value.replace(/<[^>]*>/g, ' ').replace(/&#38;/g, '&').replace(/&#39;/g, "'").match(/[\p{L}\p{N}’']+/gu) ?? [];
    const htmlBody = preview.html.slice(preview.html.indexOf('<body'));
    expect(new Set(words(preview.text))).toEqual(new Set(words(htmlBody)));
    expect(preview.text).not.toMatch(/\*\*|<[a-z]|&#/);
  });

  it('gives the same bytes for the same input and different bytes for a different draft', () => {
    expect(ok(render()).mime).toBe(ok(render()).mime);
    expect(ok(render({ body_markdown: 'Hi Sam.' })).mime).not.toBe(ok(render()).mime);
    expect(ok(render({}, {}, TO, { messageId: '<other@mail.test.invalid>' })).mime).not.toBe(ok(render()).mime);
  });

  it('threads a reply with In-Reply-To and folded References', async () => {
    const references = Array.from({ length: 6 }, (_, i) => `<thread-${i}-0123456789@example.test>`);
    const result = ok(render({}, {}, TO, { inReplyTo: references.at(-1), references }));
    expect(headerNames(result.mime)).toEqual(['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'MIME-Version', 'Content-Type']);
    const mail = await expectRoundTrip(result);
    expect(mail.inReplyTo).toBe(references.at(-1));
    expect(mail.references!.split(/\s+/)).toEqual(references);
    expect(result.parts.headers).toEqual({ 'In-Reply-To': references.at(-1), References: references.join(' ') });
  });

  it('keeps the newest References that fit Cloudflare\'s 2,048-byte header value', async () => {
    const references = Array.from({ length: 100 }, (_, i) => `<${String(i).padStart(3, '0')}-${'r'.repeat(40)}@example.test>`);
    const result = ok(render({}, {}, TO, { inReplyTo: references.at(-1), references }));
    const kept = result.parts.headers.References!.split(' ');
    expect(new TextEncoder().encode(result.parts.headers.References!).length).toBeLessThanOrEqual(2048);
    // Each id is 59 bytes, 60 with its separator: 34 fit in 2,048 (2,039 bytes) and a 35th would make 2,099.
    expect(kept).toHaveLength(34);
    expect(kept).toEqual(references.slice(-kept.length));
    expect((await parsed(result.mime)).references!.split(/\s+/)).toEqual(kept);
  });

  it('signs as Waldo alone when the owner has no first name', async () => {
    const result = ok(render({}, { ownerFirstName: null }));
    expect(result.preview.from.name).toBe('Waldo');
    expect(result.preview.text.endsWith('-- \nWaldo\npriya@mail.test.invalid\n')).toBe(true);
    await expectRoundTrip(result);
    expect(ok(render({}, { ownerFirstName: ' \r\n ' })).preview.from.name).toBe('Waldo');
  });

  it('encodes non-ASCII subjects and names as encoded words that decode to the card text', async () => {
    const result = ok(render({ subject: 'Привет 👋 — réunion de vendredi, un sujet assez long pour plier la ligne', body_markdown: '日本語のテキスト\n\nZoë' }, { ownerFirstName: 'Zoë' }));
    expect(result.mime).toMatch(/^[\x00-\x7f]*$/);
    expect(headerBlock(result.mime)).toMatch(/Subject: =\?UTF-8\?B\?[^?]+\?=\r\n =\?UTF-8\?B\?/);
    const mail = await expectRoundTrip(result);
    expect(mail.from!.name).toBe("Waldo, Zoë's assistant");
  });

  describe('client safety', () => {
    const { mime, preview } = ok(render());
    it('uses inline styles, tables, a 600px column and a system font stack only', () => {
      expect(preview.html).not.toMatch(/<style|<link|<script|<svg|<iframe|<form|<object|@import|@font-face|url\(|javascript:|\sclass=|\son[a-z]+=/i);
      expect(preview.html).toContain('style="width:100%;max-width:600px"');
      // Only Outlook's Word engine reads the fixed 600px column; everyone else gets the fluid one.
      expect([...preview.html.matchAll(/<!--\[if mso\]>(.*?)<!\[endif\]-->/g)].map(match => match[1])).toEqual(['<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td>', '</td></tr></table>']);
      expect(preview.html.replace(/<!--\[if mso\]>.*?<!\[endif\]-->/g, '')).not.toContain('width="600"');
      expect(preview.html).toContain("font-family:ui-rounded,'SF Pro Rounded',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif");
      expect(preview.html).not.toMatch(/rgba?\(/);
      expect([...preview.html.matchAll(/<img [^>]*src="([^"]*)"/g)].map(match => match[1])).toEqual(['cid:waldo-mark@mail.test.invalid']);
    });
    it('is 7-bit with CRLF line ends, header lines within 78 and body lines within 76', () => {
      expect(mime).toMatch(/^[\x00-\x7f]*$/);
      expect(mime.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
      const [head, body] = [headerBlock(mime), mime.slice(mime.indexOf('\r\n\r\n') + 4)];
      expect(head.split('\r\n').filter(line => !line.startsWith('From:')).every(line => line.length <= 78)).toBe(true);
      expect(body.split('\r\n').every(line => line.length <= 76)).toBe(true);
    });
    it('shows the mark even with remote images blocked: nothing in the message is fetched', () => {
      expect([...preview.html.matchAll(/(?:src|background)="([^"]*)"/g)].every(match => match[1]!.startsWith('cid:'))).toBe(true);
    });
  });

  describe('hostile input', () => {
    it('keeps header injection out of the subject and the sender name', async () => {
      const result = ok(render({ subject: 'Hello\r\nBcc: victim@example.test\r\n\r\n<b>body</b>' }, { ownerFirstName: 'Pri"ya\\\r\nBcc: x@example.test' }));
      expect(headerNames(result.mime)).toEqual(['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'MIME-Version', 'Content-Type']);
      expect(result.preview.subject).toBe('Hello Bcc: victim@example.test <b>body</b>');
      expect(result.preview.from.name).toBe('Waldo, Pri"ya\\ Bcc: x@example.test\'s assistant');
      const mail = await expectRoundTrip(result);
      expect(mail.bcc).toBeUndefined();
    });

    it.each([
      'sam@example.test\r\nBcc: victim@example.test', 'Sam <sam@example.test>', 'sam@example.test, alex@example.test', '"sam"@example.test',
      'sam@localhost', 'sam@@example.test', '.sam@example.test', 'sam..x@example.test', 'sam@-example.test', 'sam@example.test.', 'såm@example.test', '',
      `${'a'.repeat(65)}@example.test`,
    ])('refuses the recipient %j', address => {
      expect(render({}, {}, { to: [address] })).toEqual({ ok: false, code: 'invalid_recipient' });
      expect(render({}, {}, { to: ['sam@example.test'], cc: [address] })).toEqual({ ok: false, code: 'invalid_recipient' });
    });

    it('refuses a bad sender address, no recipients, too many, or bad wire ids', () => {
      expect(render({}, { address: 'priya@mail.test.invalid\r\nX: y' })).toEqual({ ok: false, code: 'invalid_sender' });
      expect(render({}, {}, { to: [] })).toEqual({ ok: false, code: 'no_recipients' });
      const many = Array.from({ length: AGENT_MAIL_MAX_RECIPIENTS + 1 }, (_, i) => `r${i}@example.test`);
      expect(render({}, {}, { to: many.slice(0, 1), cc: many.slice(1) })).toEqual({ ok: false, code: 'too_many_recipients' });
      expect(render({}, {}, { to: many.slice(0, AGENT_MAIL_MAX_RECIPIENTS) }).ok).toBe(true);
      for (const wire of [{ messageId: 'a1b2@mail.test.invalid' }, { messageId: '<a b@x>' }, { inReplyTo: '<x@y>\r\nBcc: z@y' }, { references: ['<ok@x>', '<bad>'] }, { date: Number.NaN }, { date: 1e20 }]) {
        expect(render({}, {}, TO, wire)).toEqual({ ok: false, code: 'invalid_wire' });
      }
    });

    it('escapes HTML the model writes instead of passing it through', async () => {
      const result = ok(render({ body_markdown: '<script>alert(1)</script> <img src=x onerror=alert(1)> &amp; "quotes" \'single\'', callout: '<b>loud</b>' }));
      expect(result.preview.html).not.toMatch(/<script|<img src=x|<b>/);
      expect(result.preview.html).toContain('&#60;script&#62;alert(1)&#60;/script&#62; &#60;img src=x onerror=alert(1)&#62; &#38;amp; &#34;quotes&#34; &#39;single&#39;');
      expect(result.preview.text).toContain('<script>alert(1)</script> <img src=x onerror=alert(1)> &amp; "quotes" \'single\'');
      await expectRoundTrip(result);
    });

    it('links only http and https, and always shows where a link goes', () => {
      const { preview } = ok(render({ body_markdown: [
        '[click](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=) [file](file:///etc/passwd) [mail](mailto:a@b.test)',
        '[https://good.example.test](https://evil.example.test/login)',
        '[pay](https://аpple.example.test/pay)',
        '[q](https://x.example.test/a"onmouseover="alert(1))',
      ].join('\n\n') }));
      expect([...preview.html.matchAll(/href="([^"]*)"/g)].map(match => match[1])).toEqual([
        'https://evil.example.test/login', 'https://xn--pple-43d.example.test/pay', 'https://x.example.test/a%22onmouseover=%22alert', 'https://cal.example.test/accept/9',
      ]);
      expect(preview.html).toContain('[click](javascript:alert(1))');
      expect(preview.text).toContain('https://good.example.test (https://evil.example.test/login)');
      expect(preview.text).toContain('pay (https://xn--pple-43d.example.test/pay)');
      expect(render({ action: { label: 'Go', url: 'javascript:alert(1)' } })).toEqual({ ok: false, code: 'invalid_action' });
      expect(render({ action: { label: ' ', url: 'https://x.example.test' } })).toEqual({ ok: false, code: 'invalid_action' });
      expect(render({ action: { label: 'x'.repeat(81), url: 'https://x.example.test' } })).toEqual({ ok: false, code: 'invalid_action' });
    });

    it('shows a literal encoded-word subject and boundary-like body text as typed', async () => {
      const result = ok(render({ subject: '=?UTF-8?B?SGFja2Vk?=', body_markdown: '--=_waldo_alt\n--=_waldo_rel--\n=_ =3D =\nlast line ends with a space ' }));
      const mail = await expectRoundTrip(result);
      expect(mail.subject).toBe('=?UTF-8?B?SGFja2Vk?=');
      expect(mail.attachments).toHaveLength(1);
    });

    it('survives a fuzzed mix of hostile characters in every model and directory field', async () => {
      const alphabet = ['\r', '\n', '\r\n', '\u0000', '\u0007', '\u007f', '\u0085', '\u2028', '\u202e', '<', '>', '"', "'", '&', '=', '?', '=?', '?=', '*', '**', '_', '[', ']', '(', ')', '|', '- ', '1. ', '---', '\\', '\t', ' ', ' ', 'a', 'Z', '9', 'é', 'ß', '中', '👋', '🏳️‍🌈', '\ud800', 'http://', 'https://x.example.test/', 'javascript:', '--=_waldo_alt', 'Bcc: ', ':'];
      let seed = 0x5eed;
      const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const noise = (max: number) => Array.from({ length: Math.floor(next() * max) }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
      let rendered = 0;
      for (let i = 0; i < 250; i += 1) {
        const result = render({ subject: noise(40), body_markdown: noise(200), callout: noise(30), ...(next() < 0.3 ? { action: { label: noise(10), url: noise(8) } } : {}) }, { ownerFirstName: noise(12) });
        if (!result.ok) { expect(['empty_subject', 'empty_body', 'invalid_action']).toContain(result.code); continue; }
        rendered += 1;
        expect(result.mime).toMatch(/^[\x00-\x7f]*$/);
        expect(result.mime.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
        expect(headerNames(result.mime)).toEqual(['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'MIME-Version', 'Content-Type']);
        expect(result.preview.html.replace(/<!--\[if mso\]>.*?<!\[endif\]-->/g, '')).not.toMatch(/<(?!\/?(?:!doctype|html|head|meta|title|body|table|tr|td|th|img|p|br|strong|em|a|span|ul|ol|li)\b)/i);
        expect([...result.preview.html.matchAll(/href="([^"]*)"/g)].every(match => /^https?:\/\//.test(match[1]!))).toBe(true);
        await expectRoundTrip(result);
      }
      expect(rendered).toBeGreaterThan(100);
    });

    it('renders a body of unclosed emphasis markers in bounded time', () => {
      const started = performance.now();
      const result = render({ body_markdown: ' *a'.repeat(Math.floor(AGENT_MAIL_BODY_MAX / 3) - 100) });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result.ok).toBe(true);
    });
  });

  describe('bounds', () => {
    it('refuses an empty subject or body', () => {
      expect(render({ subject: ' \r\n\t' })).toEqual({ ok: false, code: 'empty_subject' });
      expect(render({ body_markdown: '\n \n\t\n' })).toEqual({ ok: false, code: 'empty_body' });
      expect(render({ subject: 'x'.repeat(251) })).toEqual({ ok: false, code: 'subject_too_long' });
      expect(render({ subject: '👋'.repeat(250) }).ok).toBe(true);
    });
    it('refuses a body over the markdown bound before parsing it', () => {
      expect(render({ body_markdown: 'a'.repeat(AGENT_MAIL_BODY_MAX + 1) })).toEqual({ ok: false, code: 'body_too_long' });
      expect(render({ body_markdown: 'a'.repeat(AGENT_MAIL_BODY_MAX - 100), callout: 'b'.repeat(101) })).toEqual({ ok: false, code: 'body_too_long' });
    });
    it('refuses a draft whose HTML would pass Gmail\'s clip size, and keeps the largest accepted message bounded', () => {
      expect(render({ body_markdown: '&'.repeat(AGENT_MAIL_BODY_MAX - 100) })).toEqual({ ok: false, code: 'too_large' });
      const prose = 'The quarterly review moves to Friday; Juniper is booked. '.repeat(Math.floor(AGENT_MAIL_BODY_MAX / 60));
      const result = ok(render({ body_markdown: prose }));
      expect(new TextEncoder().encode(result.preview.html).length).toBeLessThanOrEqual(AGENT_MAIL_HTML_MAX);
      expect(result.mime.length).toBeLessThanOrEqual(AGENT_MAIL_MIME_MAX);
      const wide = ok(render({ body_markdown: 'ü'.repeat(30_000) }));
      expect(wide.mime.length).toBeLessThanOrEqual(AGENT_MAIL_MIME_MAX);
    });
  });
});
