import { describe, expect, it } from 'vitest';
import { b64url, googleClient } from '../src/connectors/google';
import { extractArtifacts } from '../src/security/artifact-hygiene';
import { googleHandlers } from '../src/tools/live/google';

// Synthetic mail only. Codes laid out in HTML table cells reach the extractor glued to their label
// ("Verification code482913") or one digit per cell; neither may reach the model.
const encode = (text: string) => b64url(new TextEncoder().encode(text));
const mail = (payload: unknown) => googleClient({ clientId: 'c', clientSecret: 's', redirectUri: 'https://example.invalid' }, { refresh_token: 'r' }, (async (input: RequestInfo | URL) =>
  String(input).includes('oauth2') ? Response.json({ access_token: 'a' }) : Response.json({ messages: [{ id: 'm1', internalDate: '1791417600000', payload }] })) as typeof fetch);
const html = (markup: string) => ({ mimeType: 'text/html', headers: [{ name: 'From', value: 'noreply@example.com' }, { name: 'Subject', value: 'Your sign-in' }], body: { data: encode(markup) } });
const readThread = async (payload: unknown) => {
  const relays: unknown[] = [];
  const handler = googleHandlers({ client: async () => mail(payload) }, { propose: async () => '', proposeSendEmail: async () => '', record: () => {} } as never,
    { timezone: 'UTC', now: () => new Date() }, async (_from, artifacts) => { relays.push(artifacts); return true; }).find(h => h.name === 'read_thread')!;
  return { shown: JSON.stringify(await handler.handle({ thread_id: 't', limit: 10 } as never)), relays };
};

const digits = ['4', '8', '2', '9', '1', '3'];

describe('the extractor', () => {
  it.each([
    ['Verification code482913', '482913'],
    ['Your code is 4 8 2 9 1 3', '482913'],
    ['login code: 482 913', '482913'],
    ['482 913 is your verification code', '482913'],
    // A rendered &nbsp; arrives as U+00A0.
    ['Verification code\u00a04\u00a08\u00a02\u00a09\u00a01\u00a03', '482913'],
    ['login code: 482\u00a0913', '482913'],
    ['Your code is 48 29 13', '482913'],
    ['Your code is 4  8  2  9  1  3', '482913'],
    ['Your code\n        4\n        8\n        2\n        9\n        1\n        3', '482913'],
    ['Your code:\t4829\t1356', '48291356'],
    ['Your code is 1234 5678', '12345678'],
    ['verification code 48 29', '4829'],
    // The relayed value is the code's own capture, never another digit run in the phrase.
    ['Acme2024 verification code 482913', '482913'],
    // Text glued straight onto the adjective, longer than any vendor word, with a noun or separator only the
    // adjective form covers.
    ['abcdefghij'.repeat(4) + 'Xverification pin 123456', '123456'],
    ['abcdefghij'.repeat(4) + 'Xverification code - 123456', '123456'],
    // As a connector-proxy that predates the cell separator renders cells: indentation between them, any width.
    ['Your code\n' + digits.join('\n' + ' '.repeat(40)), '482913'],
    ['Your code \r\n' + digits.join(' \r\n' + ' '.repeat(30)), '482913'],
    ['Your code\n\n' + digits.join('\n\n      \n    '), '482913'],
  ])('catches a code glued to its label or spaced out: %s', (text, code) => {
    const found = extractArtifacts(text);
    expect(found.artifacts).toEqual([{ kind: 'otp', value: code }]);
    expect(found.text.replace(/\D/g, '')).toBe('');
  });

  it.each(['Postcode12345 area', 'see codes 1234 below', 'room 4 8 2 9 is free', 'code 1 2 3 is too short', 'error code 404', 'Room 4021'])('leaves ordinary text alone: %s', (text) => {
    expect(extractArtifacts(text).artifacts).toEqual([]);
  });
});

describe('codes in HTML table cells', () => {
  it('never reach read_thread from an HTML-only mail, and are relayed', async () => {
    const { shown, relays } = await readThread(html('<table><tr><td>Verification code</td><td>482913</td></tr></table>'));
    expect(shown).not.toContain('482913');
    expect(relays).toEqual([[{ kind: 'otp', value: '482913' }]]);
  });

  it('never reach read_thread one digit per cell', async () => {
    const { shown, relays } = await readThread(html('<table><tr><td>Your verification code</td><td>4</td><td>8</td><td>2</td><td>9</td><td>1</td><td>3</td></tr></table>'));
    for (const leaked of ['482913', '4 8 2 9', '9 1 3']) expect(shown).not.toContain(leaked);
    expect(relays).toEqual([[{ kind: 'otp', value: '482913' }]]);
  });

  it('never reach read_thread from a minified HTML alternative to an empty plain part', async () => {
    const { shown } = await readThread({ mimeType: 'multipart/alternative', headers: [{ name: 'From', value: 'noreply@example.com' }], parts: [
      { mimeType: 'text/plain', body: { data: encode('') } },
      { mimeType: 'text/html', body: { data: encode('<table><tr><td>Verification code</td><td>482913</td></tr></table>') } },
    ] });
    expect(shown).not.toContain('482913');
  });

  // Digits split by whitespace, with both halves applied: the cell separator and the extractor.
  it.each([
    ['a spaced code in the next cell', '<table><tr><td>Your code</td><td>48 29 13</td></tr></table>', '482913'],
    ['two digits per cell', '<table><tr><td>Your code</td><td>48</td><td>29</td><td>13</td></tr></table>', '482913'],
    ['one digit per cell, pretty-printed', '<table>\n  <tr>\n    <td>Your code</td>\n' + [4, 8, 2, 9, 1, 3].map(d => `                        <td>${d}</td>\n`).join('') + '  </tr>\n</table>', '482913'],
    ['non-breaking padding', '<table><tr><td>Your code</td>' + [4, 8, 2, 9, 1, 3].map(d => `<td>&nbsp;${d}&nbsp;</td>`).join('') + '</tr></table>', '482913'],
    ['double spaces', '<table><tr><td>Your code</td><td>4  8  2  9  1  3</td></tr></table>', '482913'],
    ['an 8-digit code split 4+4', '<table><tr><td>Your code</td><td>1234 5678</td></tr></table>', '12345678'],
    ['one digit per cell, indented 40', '<table><tr><td>Your code</td>' + digits.map(d => `\n${' '.repeat(40)}<td>${d}</td>`).join('') + '</tr></table>', '482913'],
    ['one digit per cell, CRLF and 30 spaces', '<table>\r\n<tr>\r\n<td>Your code</td>' + digits.map(d => `\r\n${' '.repeat(30)}<td>${d}</td>`).join('') + '\r\n</tr>\r\n</table>', '482913'],
    ['a template loop with blank lines between cells', '<table><tr><td>Your code</td>' + digits.map(d => `\n\n    \n      <td>\n        ${d}\n      </td>\n`).join('') + '</tr></table>', '482913'],
  ])('never reach read_thread when %s, and the whole code is relayed', async (_shape, markup, code) => {
    const { shown, relays } = await readThread(html(markup));
    const body = (JSON.parse(shown) as { data?: { messages: { body: string }[] }; messages?: { body: string }[] });
    expect((body.data ?? body).messages![0]!.body.replace(/\D/g, '')).toBe('');
    expect(relays).toEqual([[{ kind: 'otp', value: code }]]);
  });

  // Staged: until the gap narrows to a space after the connector-proxy redeploy, a code joins digits on the next
  // row. The code is still hidden; the relay carries the extra digits. The follow-up must flip these on purpose.
  it.each([
    ['a "2026 Acme" row', '<tr><td>Your code</td><td>4829</td></tr><tr><td>2026 Acme</td></tr>', '48292026', ''],
    ['a "10:00" row', '<tr><td>Your code</td><td>48 29 13</td></tr><tr><td>10:00</td></tr>', '48291310', '00'],
    ['a "5 minutes" row', '<tr><td>Your code</td>' + digits.map(d => `<td>${d}</td>`).join('') + '</tr><tr><td>5 minutes</td></tr>', '4829135', ''],
  ])('hide a code followed by %s, and relay the joined digits', async (_row, rows, relayed, left) => {
    const { shown, relays } = await readThread(html(`<table>${rows}</table>`));
    const result = JSON.parse(shown) as { data?: { messages: { body: string }[] }; messages?: { body: string }[] };
    expect((result.data ?? result).messages![0]!.body.replace(/\D/g, '')).toBe(left);
    expect(relays).toEqual([[{ kind: 'otp', value: relayed }]]);
  });

  it('render with a space between cells and a line between rows', async () => {
    const [message] = (await mail(html('<table><tr><td>Verification code</td><td>482913</td></tr><tr><th>Expires</th><td>10 minutes</td></tr></table>')).threadPage!('t', 10)).messages;
    expect(message!.body).toBe('Verification code 482913\nExpires 10 minutes');
    const [indented] = (await mail(html('<div>\n  Your\n      sign-in   code\n</div><p>Thanks,&nbsp; the team</p>')).threadPage!('t', 10)).messages;
    expect(indented!.body).toBe('Your sign-in code\nThanks, the team');
  });
});
