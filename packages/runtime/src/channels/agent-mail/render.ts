import { WALDO_LOGO_PNG_BASE64, WALDO_LOGO_HEIGHT, WALDO_LOGO_WIDTH } from './logo';

// Turns a draft Waldo wrote into the exact mail that leaves Waldo's own mailbox. Pure: the same input always gives the
// same bytes, so the approval card, the stored message and the send are one thing. The model writes every word; the
// frame adds only the logo, the layout and a signature saying whose assistant Waldo is. Every field the model or a
// directory supplies is untrusted: text is escaped, links must be http(s) and show where they go, header values lose
// control characters, and an address that is not plainly an address refuses the whole render.

export type AgentMailDraft = Readonly<{
  subject: string;
  // Paragraphs, **bold**, *italic*, [links](https://…), bare https:// links, - or 1. lists and one | pipe | table.
  body_markdown: string;
  // A highlighted note above the body, in the same inline markdown.
  callout?: string;
  // One button-style link below the body.
  action?: Readonly<{ label: string; url: string }>;
}>;
export type AgentMailSender = Readonly<{ address: string; ownerFirstName: string | null }>;
// Bcc is left out: in raw MIME a Bcc header is visible to every recipient.
export type AgentMailRecipients = Readonly<{ to: readonly string[]; cc?: readonly string[] }>;
// The caller mints the Message-ID and fixes the date, so a re-render of an approved draft is byte-identical.
export type AgentMailWire = Readonly<{ messageId: string; date: number; inReplyTo?: string; references?: readonly string[] }>;

// What the approval card shows: these strings are what the recipient's client decodes from the MIME, except that the
// wire carries CRLF line ends where these carry LF.
export type AgentMailPreview = Readonly<{
  from: Readonly<{ name: string; address: string }>;
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  text: string;
  html: string;
}>;
// The same message for Cloudflare Email Service's structured send(), built from the same strings as the MIME.
export type AgentMailParts = Readonly<{
  from: Readonly<{ email: string; name: string }>;
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  text: string;
  html: string;
  headers: Readonly<Record<string, string>>;
  attachments: readonly Readonly<{ content: string; filename: string; type: 'image/png'; disposition: 'inline'; contentId: string }>[];
}>;
export type AgentMailRenderError =
  | 'invalid_sender' | 'invalid_recipient' | 'no_recipients' | 'too_many_recipients' | 'invalid_wire'
  | 'empty_subject' | 'subject_too_long' | 'empty_body' | 'body_too_long' | 'invalid_action' | 'too_large';
export type AgentMailRendered =
  | Readonly<{ ok: true; mime: string; preview: AgentMailPreview; parts: AgentMailParts }>
  | Readonly<{ ok: false; code: AgentMailRenderError }>;

// Cloudflare Email Service refuses more than 50 combined recipients.
export const AGENT_MAIL_MAX_RECIPIENTS = 50;
export const AGENT_MAIL_SUBJECT_MAX = 250;
// Bounds the markdown before it is parsed, so a hostile body costs bounded time.
export const AGENT_MAIL_BODY_MAX = 50_000;
// Gmail clips a message whose HTML passes about 102 KB behind a "[Message clipped]" link; staying under it keeps the
// whole draft, signature included, on the recipient's screen.
export const AGENT_MAIL_HTML_MAX = 100_000;
export const AGENT_MAIL_MIME_MAX = 1024 * 1024;
const NAME_MAX = 64;
const ACTION_LABEL_MAX = 80;
const URL_MAX = 2048;
const TABLE_COLUMNS_MAX = 8;

// Light-mode tokens from waldo-landing app/globals.css, flattened to opaque hex because Outlook for Windows drops rgba().
const INK = '#1A1A1A', MUTED = '#6B6B68', CANVAS = '#F4F3F0', CARD = '#FFFFFF', BORDER = '#EDEDED', ACCENT = '#FB943F', ACCENT_SUBTLE = '#FFF4EC', ON_INK = '#FAFAF8';
const FONT = "ui-rounded,'SF Pro Rounded',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
// '=_' never occurs in quoted-printable or base64 output, so these fixed boundaries cannot collide with a part's body.
const ALT = '=_waldo_alt', REL = '=_waldo_rel';
const LOGO_FILE = 'waldo.png';

const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const validAddress = (value: string) => value.length <= 254 && value.indexOf('@') <= 64 && ADDRESS.test(value);
const MESSAGE_ID = /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/;
const validMessageId = (value: string) => value.length <= 900 && MESSAGE_ID.test(value);

// A lone surrogate has no UTF-8 form; the wire would carry U+FFFD where the card showed something else, so it becomes
// U+FFFD before anything is rendered.
const wellFormed = (value: string) => value.replace(/\p{Surrogate}/gu, '\ufffd');
// C0 and C1 controls, DEL and the Unicode line and paragraph separators all end a header line in some parser.
const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').trim();

type Inline = Readonly<{ kind: 'text'; text: string } | { kind: 'strong'; children: readonly Inline[] } | { kind: 'em'; children: readonly Inline[] } | { kind: 'link'; label: string; href: string }>;
type Block = Readonly<
  | { kind: 'paragraph'; lines: readonly (readonly Inline[])[] }
  | { kind: 'list'; ordered: boolean; items: readonly (readonly (readonly Inline[])[])[] }
  | { kind: 'table'; head: readonly (readonly Inline[])[]; rows: readonly (readonly (readonly Inline[])[])[] }
>;

// The URL as the WHATWG parser normalizes it, which is also how it is shown: an internationalized host is shown in
// punycode, so the visible address is the one the link opens.
const safeHref = (raw: string): string | null => {
  if (raw.length > URL_MAX) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
};

// Emphasis spans are bounded so a line of unclosed markers costs linear, not quadratic, time; a longer span stays literal.
const INLINE = /\[([^[\]\n]{1,500})\]\(([^()\s]{1,2048})\)|\*\*(?!\s)(.{1,500}?)(?<!\s)\*\*|(?<![\w*])\*(?![\s*])(.{1,500}?)(?<![\s*])\*(?![\w*])|(?<![\w_])_(?![\s_])(.{1,500}?)(?<![\s_])_(?![\w_])|(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])/g;
const inline = (source: string): Inline[] => {
  const out: Inline[] = [];
  let at = 0;
  const text = (value: string) => { if (value) out.push({ kind: 'text', text: value }); };
  for (const match of source.matchAll(INLINE)) {
    text(source.slice(at, match.index));
    at = match.index + match[0].length;
    const [whole, label, target, strong, star, under, bare] = match;
    if (label !== undefined) {
      const href = safeHref(target!);
      if (href) out.push({ kind: 'link', label, href }); else text(whole);
    } else if (strong !== undefined) out.push({ kind: 'strong', children: inline(strong) });
    else if (star !== undefined || under !== undefined) out.push({ kind: 'em', children: inline((star ?? under)!) });
    else {
      const href = safeHref(bare!);
      if (href) out.push({ kind: 'link', label: bare!, href }); else text(whole);
    }
  }
  text(source.slice(at));
  return out;
};

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/, NUMBERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => inline(cell.trim()));

// A block is a run of lines between blank lines. It is a table only when every line is a row and the second is the
// | --- | rule with the header's column count; otherwise list items and plain lines split it into lists and paragraphs.
const parse = (markdown: string): Block[] => markdown.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/).flatMap(chunk => {
  const lines = chunk.split('\n').filter(line => line.trim());
  if (lines.length === 0) return [];
  const head = lines[0]!.includes('|') ? cells(lines[0]!) : [];
  if (lines.length >= 2 && head.length >= 2 && head.length <= TABLE_COLUMNS_MAX && TABLE_RULE.test(lines[1]!) && cells(lines[1]!).length === head.length && lines.slice(2).every(line => line.includes('|'))) {
    return [{ kind: 'table', head, rows: lines.slice(2).map(line => cells(line).slice(0, head.length)) }];
  }
  const blocks: Block[] = [];
  let paragraph: Inline[][] | null = null, list: { ordered: boolean; items: Inline[][][] } | null = null;
  for (const line of lines) {
    const item = BULLET.exec(line) ?? NUMBERED.exec(line);
    const ordered = item !== null && !BULLET.test(line);
    if (item && (!list || list.ordered === ordered)) {
      if (!list) { list = { ordered, items: [] }; blocks.push({ kind: 'list', ...list }); paragraph = null; }
      list.items.push([inline(item[1]!.trim())]);
    } else if (item) {
      list = { ordered, items: [[inline(item[1]!.trim())]] };
      blocks.push({ kind: 'list', ...list });
    } else if (list && /^\s/.test(line)) list.items.at(-1)!.push(inline(line.trim()));
    else {
      list = null;
      if (!paragraph) { paragraph = []; blocks.push({ kind: 'paragraph', lines: paragraph }); }
      paragraph.push(inline(line.trim()));
    }
  }
  return blocks;
});

const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const LINK_STYLE = `color:${INK};text-decoration:underline;text-decoration-color:${ACCENT}`;
const htmlInline = (nodes: readonly Inline[]): string => nodes.map(node =>
  node.kind === 'text' ? escape(node.text)
    : node.kind === 'strong' ? `<strong>${htmlInline(node.children)}</strong>`
      : node.kind === 'em' ? `<em>${htmlInline(node.children)}</em>`
        : node.label === node.href || safeHref(node.label) === node.href ? `<a href="${escape(node.href)}" style="${LINK_STYLE}">${escape(node.href)}</a>`
          : `<a href="${escape(node.href)}" style="${LINK_STYLE}">${escape(node.label)}</a> <span style="color:${MUTED}">(${escape(node.href)})</span>`).join('');
const textInline = (nodes: readonly Inline[]): string => nodes.map(node =>
  node.kind === 'text' ? node.text
    : node.kind === 'strong' || node.kind === 'em' ? textInline(node.children)
      : node.label === node.href || safeHref(node.label) === node.href ? node.href : `${node.label} (${node.href})`).join('');

const P = 'margin:0 0 16px 0';
const htmlBlock = (block: Block): string => {
  if (block.kind === 'paragraph') return `<p style="${P}">${block.lines.map(htmlInline).join('<br>')}</p>`;
  if (block.kind === 'list') {
    const tag = block.ordered ? 'ol' : 'ul';
    return `<${tag} style="margin:0 0 16px 0;padding:0 0 0 24px">${block.items.map(item => `<li style="margin:0 0 6px 0">${item.map(htmlInline).join('<br>')}</li>`).join('')}</${tag}>`;
  }
  const cell = (tag: 'th' | 'td', nodes: readonly Inline[]) => `<${tag} align="left" style="padding:6px 12px 6px 0;border-bottom:1px solid ${BORDER};text-align:left;vertical-align:top${tag === 'th' ? ';font-weight:600' : ''}">${htmlInline(nodes)}</${tag}>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 16px 0;font-size:14px;line-height:1.45">`
    + `<tr>${block.head.map(nodes => cell('th', nodes)).join('')}</tr>${block.rows.map(row => `<tr>${block.head.map((_, i) => cell('td', row[i] ?? [])).join('')}</tr>`).join('')}</table>`;
};
const textBlock = (block: Block): string => {
  if (block.kind === 'paragraph') return block.lines.map(textInline).join('\n');
  if (block.kind === 'list') return block.items.map((item, i) => `${block.ordered ? `${i + 1}.` : '-'} ${item.map(textInline).join('\n   ')}`).join('\n');
  const grid = [block.head, ...block.rows].map(row => block.head.map((_, i) => textInline(row[i] ?? [])));
  const widths = block.head.map((_, i) => Math.max(...grid.map(row => [...row[i]!].length)));
  const line = (row: readonly string[]) => row.map((value, i) => value + ' '.repeat(widths[i]! - [...value].length)).join(' | ').trimEnd();
  return [line(grid[0]!), widths.map(width => '-'.repeat(Math.max(width, 3))).join('-|-'), ...grid.slice(1).map(line)].join('\n');
};

const encodedWords = (value: string): string[] => {
  // 39 UTF-8 bytes is 52 base64 characters, so each word stays within RFC 2047's 75 and a folded line within 78.
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => { words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...chunk))}?=`); chunk = []; };
  for (const char of value) {
    const bytes = new TextEncoder().encode(char);
    if (chunk.length + bytes.length > 39) flush();
    chunk.push(...bytes);
  }
  if (chunk.length) flush();
  return words;
};
// Plain ASCII goes out as itself, folded only at its own spaces so unfolding gives it back exactly. Anything a client
// would decode instead of show, non-ASCII or a literal "=?", goes out as encoded words, so the card and the client agree.
const headerText = (name: string, value: string): string => {
  if (/[^\x20-\x7e]|=\?/.test(value)) return `${name}: ${encodedWords(value).join('\r\n ')}`;
  let out = `${name}:`, line = out.length;
  for (const [i, word] of value.split(' ').entries()) {
    const sep = i === 0 ? ' ' : line + word.length + 1 > 78 ? '\r\n ' : ' ';
    out += sep + word;
    line = sep === ' ' ? line + 1 + word.length : 1 + word.length;
  }
  return out;
};
const addressHeader = (name: string, addresses: readonly string[]) => addresses.reduce((out, address, i) => {
  const last = out.slice(out.lastIndexOf('\n') + 1);
  return i === 0 ? `${out} ${address}` : `${out},${last.length + address.length + 2 > 78 ? '\r\n' : ''} ${address}`;
}, `${name}:`);
const displayName = (name: string) => /[^\x20-\x7e]|=\?/.test(name) ? encodedWords(name).join('\r\n ') : `"${name.replace(/[\\"]/g, char => `\\${char}`)}"`;
const idsHeader = (name: string, ids: readonly string[]) => ids.reduce((out, id) => {
  const last = out.slice(out.lastIndexOf('\n') + 1);
  return `${out}${last.length + id.length + 1 > 78 ? '\r\n' : ''} ${id}`;
}, `${name}:`);

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const rfc5322Date = (at: number) => {
  const d = new Date(at), pad = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
};

// RFC 2045 quoted-printable with CRLF line ends: lines of at most 76 characters, '=' and anything outside printable
// ASCII as =XX, and a space or tab before a line end encoded so no transport can strip it.
const quotedPrintable = (text: string): string => text.split('\n').map(line => {
  const bytes = new TextEncoder().encode(line);
  const tokens = [...bytes].map((byte, i) => (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && i < bytes.length - 1)
    ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`);
  const out: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (current.length + token.length > 75) { out.push(`${current}=`); current = ''; }
    current += token;
  }
  out.push(current);
  return out.join('\r\n');
}).join('\r\n');
const base64Lines = (base64: string) => base64.match(/.{1,76}/g)!.join('\r\n');

const signatureName = (first: string | null) => first ? `Waldo, ${first}'s assistant` : 'Waldo';

const htmlDocument = (subject: string, blocks: readonly Block[], callout: readonly Inline[] | null, action: Readonly<{ label: string; href: string }> | null, first: string | null, address: string, contentId: string) => {
  const calloutHtml = callout ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0"><tr><td style="background-color:${ACCENT_SUBTLE};border-radius:12px;padding:14px 16px">${htmlInline(callout)}</td></tr></table>` : '';
  const actionHtml = action ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px 0"><tr><td style="background-color:${INK};border-radius:12px"><a href="${escape(action.href)}" style="display:inline-block;padding:12px 20px;color:${ON_INK};font-weight:600;text-decoration:none">${escape(action.label)}</a></td></tr></table>`
    + `<p style="margin:0 0 16px 0;font-size:13px;color:${MUTED};word-break:break-all">${escape(action.href)}</p>` : '';
  const signature = `<p style="margin:8px 0 0 0;padding:16px 0 0 0;border-top:1px solid ${BORDER};font-size:13px;line-height:1.5;color:${MUTED}">`
    + `<strong style="color:${INK}">Waldo</strong>${first ? `<br>${escape(first)}'s assistant` : ''}<br>${escape(address)}</p>`;
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">'
    + `<title>${escape(subject)}</title></head>\n<body style="margin:0;padding:0;background-color:${CANVAS}">\n`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CANVAS}"><tr><td align="center" style="padding:24px 12px">\n`
    + `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%">\n`
    + `<tr><td style="padding:0 4px 16px 4px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
    + `<td style="vertical-align:middle"><img src="cid:${contentId}" width="${WALDO_LOGO_WIDTH}" height="${WALDO_LOGO_HEIGHT}" alt="Waldo" style="display:block;border:0;outline:none"></td>`
    + `<td style="vertical-align:middle;padding:0 0 0 10px;font-family:${FONT};font-size:18px;font-weight:600;color:${INK}">Waldo</td></tr></table></td></tr>\n`
    + `<tr><td style="background-color:${CARD};border:1px solid ${BORDER};border-radius:16px;padding:28px;font-family:${FONT};font-size:15px;line-height:1.55;color:${INK}">\n`
    + `${calloutHtml}${blocks.map(htmlBlock).join('\n')}\n${actionHtml}${signature}\n</td></tr>\n</table>\n</td></tr></table>\n</body></html>`;
};

export function renderAgentMail(input: AgentMailDraft, owner: AgentMailSender, recipients: AgentMailRecipients, wire: AgentMailWire): AgentMailRendered {
  const draft: AgentMailDraft = {
    subject: wellFormed(input.subject), body_markdown: wellFormed(input.body_markdown),
    ...(input.callout !== undefined ? { callout: wellFormed(input.callout) } : {}),
    ...(input.action ? { action: { label: wellFormed(input.action.label), url: input.action.url } } : {}),
  };
  const sender: AgentMailSender = { address: owner.address, ownerFirstName: owner.ownerFirstName === null ? null : wellFormed(owner.ownerFirstName) };
  const fail = (code: AgentMailRenderError): AgentMailRendered => ({ ok: false, code });
  if (!validAddress(sender.address)) return fail('invalid_sender');
  const to = [...recipients.to], cc = [...recipients.cc ?? []];
  if (to.length === 0) return fail('no_recipients');
  if (to.length + cc.length > AGENT_MAIL_MAX_RECIPIENTS) return fail('too_many_recipients');
  if (![...to, ...cc].every(validAddress)) return fail('invalid_recipient');
  if (!validMessageId(wire.messageId) || (wire.inReplyTo !== undefined && !validMessageId(wire.inReplyTo)) || wire.references?.some(id => !validMessageId(id)) || !Number.isFinite(wire.date) || Number.isNaN(new Date(wire.date).getTime())) return fail('invalid_wire');
  const subject = oneLine(draft.subject);
  if (!subject) return fail('empty_subject');
  if ([...subject].length > AGENT_MAIL_SUBJECT_MAX) return fail('subject_too_long');
  if (draft.body_markdown.length + (draft.callout?.length ?? 0) > AGENT_MAIL_BODY_MAX) return fail('body_too_long');
  const blocks = parse(draft.body_markdown);
  if (blocks.length === 0) return fail('empty_body');
  const calloutText = draft.callout?.trim() ? oneLine(draft.callout) : null;
  const callout = calloutText ? inline(calloutText) : null;
  let action: { label: string; href: string } | null = null;
  if (draft.action) {
    const label = oneLine(draft.action.label), href = safeHref(draft.action.url.trim());
    if (!label || [...label].length > ACTION_LABEL_MAX || !href) return fail('invalid_action');
    action = { label, href };
  }
  const first = sender.ownerFirstName ? [...oneLine(sender.ownerFirstName)].slice(0, NAME_MAX).join('').trim() || null : null;
  const fromName = signatureName(first);
  const domain = sender.address.slice(sender.address.lastIndexOf('@') + 1).toLowerCase();
  const contentId = `waldo-logo@${domain}`;

  const html = htmlDocument(subject, blocks, callout, action, first, sender.address, contentId);
  if (new TextEncoder().encode(html).length > AGENT_MAIL_HTML_MAX) return fail('too_large');
  const text = [
    ...(callout ? [textInline(callout)] : []),
    ...blocks.map(textBlock),
    ...(action ? [`${action.label}: ${action.href}`] : []),
    `-- \nWaldo${first ? `\n${first}'s assistant` : ''}\n${sender.address}`,
  ].join('\n\n') + '\n';

  const threading = { ...(wire.inReplyTo ? { 'In-Reply-To': wire.inReplyTo } : {}), ...(wire.references?.length ? { References: wire.references.join(' ') } : {}) };
  const mime = [
    `From: ${displayName(fromName)} <${sender.address}>`,
    addressHeader('To', to),
    ...(cc.length ? [addressHeader('Cc', cc)] : []),
    headerText('Subject', subject),
    `Date: ${rfc5322Date(wire.date)}`,
    `Message-ID: ${wire.messageId}`,
    ...(wire.inReplyTo ? [`In-Reply-To: ${wire.inReplyTo}`] : []),
    ...(wire.references?.length ? [idsHeader('References', wire.references)] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${ALT}"`,
    '',
    `--${ALT}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(text),
    `--${ALT}`,
    `Content-Type: multipart/related; boundary="${REL}"; type="text/html"`,
    '',
    `--${REL}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(html),
    `--${REL}`,
    `Content-Type: image/png; name="${LOGO_FILE}"`,
    'Content-Transfer-Encoding: base64',
    `Content-ID: <${contentId}>`,
    `Content-Disposition: inline; filename="${LOGO_FILE}"`,
    '',
    base64Lines(WALDO_LOGO_PNG_BASE64),
    `--${REL}--`,
    `--${ALT}--`,
    '',
  ].join('\r\n');
  if (mime.length > AGENT_MAIL_MIME_MAX) return fail('too_large');

  return {
    ok: true,
    mime,
    preview: { from: { name: fromName, address: sender.address }, to, cc, subject, text, html },
    parts: {
      from: { email: sender.address, name: fromName }, to, cc, subject, text, html, headers: threading,
      attachments: [{ content: WALDO_LOGO_PNG_BASE64, filename: LOGO_FILE, type: 'image/png', disposition: 'inline', contentId }],
    },
  };
}
