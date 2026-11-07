import { describe, expect, it } from 'vitest';
import { b64url, googleClient } from '../src/connectors/google';
import { extractArtifacts } from '../src/security/artifact-hygiene';
import { googleHandlers } from '../src/tools/live/google';

// Synthetic mail only: 482913 stands for a verification code.
const encode = (text: string) => b64url(new TextEncoder().encode(text));
const html = (markup: string) => ({ mimeType: 'text/html', headers: [{ name: 'From', value: 'noreply@example.com' }, { name: 'Subject', value: 'Your sign-in' }], body: { data: encode(markup) } });
const readThread = async (payload: unknown) => {
  const relays: unknown[] = [];
  const client = googleClient({ clientId: 'c', clientSecret: 's', redirectUri: 'https://example.invalid' }, { refresh_token: 'r' }, (async (input: RequestInfo | URL) =>
    String(input).includes('oauth2') ? Response.json({ access_token: 'a' }) : Response.json({ messages: [{ id: 'm1', internalDate: '1791417600000', payload }] })) as typeof fetch);
  const handler = googleHandlers({ client: async () => client }, { propose: async () => '', proposeSendEmail: async () => '', record: () => {} } as never,
    { timezone: 'UTC', now: () => new Date() }, async (_from, artifacts) => { relays.push(artifacts); return true; }).find(h => h.name === 'read_thread')!;
  const result = JSON.parse(JSON.stringify(await handler.handle({ thread_id: 't', limit: 10 } as never))) as { data?: { messages: { body: string }[] }; messages?: { body: string }[] };
  return { body: (result.data ?? result).messages![0]!.body, relays };
};
const hidden = (text: string, code: string) => {
  const found = extractArtifacts(text);
  expect(found.artifacts).toEqual([{ kind: 'otp', value: code }]);
  expect(found.text).not.toMatch(/[0-9٠-٩۰-۹０-９]|\ud835/);
};

describe('a code on its own line, a few lines after a line that names one', () => {
  it.each([
    ['Use this code to sign in:\n482913', '482913'],
    ['Your verification code is below.\n482913', '482913'],
    ['Enter the following code in the app\n4 8 2 9 1 3', '482913'],
    ['Your one-time password\n482913', '482913'],
    ['Here is your sign-in code.\n\n482913', '482913'],
    ['Enter this OTP on the next screen\n48 29 13', '482913'],
  ])('is quarantined: %s', (text, code) => hidden(text, code));

  it.each([
    'Use this code to sign in:\n482913 (expires in 10 minutes)',
    'Your code is below\n482913 - it expires in 10 minutes',
  ])('is quarantined with a note after it on its line, which stays: %s', (text) => {
    const found = extractArtifacts(text);
    expect(found.artifacts).toEqual([{ kind: 'otp', value: '482913' }]);
    expect(found.text).not.toContain('482913');
    expect(found.text).toContain('10 minutes');
  });

  it.each([
    ['a label row, then the code row', '<table><tr><td>Use this code to sign in:</td></tr><tr><td>482913</td></tr></table>'],
    ['a sentence, then the code row', '<p>Your verification code is below.</p><table><tr><td>482913</td></tr></table>'],
    ['a one-time password cell, then the code row', '<table><tr><td>Your one-time password</td></tr><tr><td>482913</td></tr></table>'],
    ['one digit per cell in the next row', '<table><tr><td>Enter the following code in the app</td></tr><tr><td>4</td><td>8</td><td>2</td><td>9</td><td>1</td><td>3</td></tr></table>'],
  ])('never reaches read_thread after %s, and is relayed', async (_shape, markup) => {
    const { body, relays } = await readThread(html(markup));
    expect(body.replace(/\D/g, '')).toBe('');
    expect(relays).toEqual([[{ kind: 'otp', value: '482913' }]]);
  });

  it.each([
    'Order summary\n2026',
    'Your code is ready to review\nSee section\n12',
    'We changed our code of conduct.\nRead it here.\nAcme Ltd\nUnit 7\n4821 Main Street',
    // Codes that are not one-time codes, and "code" inside another word.
    'Promo code applied\nTotal\n1499',
    'Dress code: smart casual\nDate\n2026',
    'Scan the QR code at the gate\nDeparture\n0745',
    'Barcode label\nItem\n48291301',
    'Pincode lookup\nArea\n560001',
    'Unicode table\nCount\n4096',
    // A code-naming line reaches only the next line, and not when it already shows its code.
    'Here is your sign-in code.\nIt expires soon.\nDo not share it.\n482913',
    'Use this code at checkout: SAVE20\nSubtotal\n1499',
    'Use this code at checkout: SAVE20\n1499',
    'Your code: WELCOME10\nValid till\n2026',
    'Your code review is ready\nPR\n2009',
    'Show this code at the counter\nToken\n0042',
  ])('leaves a line alone that is not a code by itself, or is too far from the naming line: %s', (text) => {
    expect(extractArtifacts(text).artifacts).toEqual([]);
  });

  it('keeps a price under a promo code row in read_thread, and relays nothing', async () => {
    const { body, relays } = await readThread(html('<table><tr><td>Promo code applied</td></tr><tr><td>Total</td></tr><tr><td>1499</td></tr></table>'));
    expect(body).toContain('1499');
    expect(relays).toEqual([]);
  });

  it('takes no second code from a line after one that already showed its code', () => {
    expect(extractArtifacts('Your code is 482913\n2026').artifacts).toEqual([{ kind: 'otp', value: '482913' }]);
  });
});

describe('digits that are not ASCII', () => {
  it.each([
    ['fullwidth', 'Your code is ４８２９１３'],
    ['Arabic-Indic', 'Your code is ٤٨٢٩١٣'],
    ['extended Arabic-Indic, before "is your"', '۴۸۲۹۱۳ is your code'],
    ['mathematical bold', 'Your code is \u{1d7d2}\u{1d7d6}\u{1d7d0}\u{1d7d7}\u{1d7cf}\u{1d7d1}'],
  ])('are read as the digits they are: %s', (_shape, text) => hidden(text, '482913'));

  it('never reach read_thread as fullwidth numeric references', async () => {
    const { body, relays } = await readThread(html('<p>Your code is &#65300;&#65304;&#65298;&#65305;&#65297;&#65299;</p>'));
    expect(body).not.toMatch(/[０-９]/);
    expect(relays).toEqual([[{ kind: 'otp', value: '482913' }]]);
  });

  it('leave text with no artifact untouched', () => {
    const text = 'Invoice ١٢٣ paid on １２/１０';
    expect(extractArtifacts(text)).toEqual({ text, artifacts: [] });
  });
});

describe('separators inside a code', () => {
  it.each([
    ['Your code is 482–913', '482–913'],
    ['Your code is 482.913', '482.913'],
    ['Your code is 482·913', '482·913'],
    ['Your code is 482 - 913', '482-913'],
    ['48-29-13 is your verification code', '48-29-13'],
    ['482–913 is your code', '482–913'],
    ['Your code is 482－913', '482－913'],
    ['Your code is 482‑913', '482‑913'],
    ['Your code is 482−913', '482−913'],
    ['Your code is 482•913', '482•913'],
    ['Your code is 482・913', '482・913'],
  ])('relay the code as written: %s', (text, code) => hidden(text, code));

  it.each(['Version 4.8.2 is out', 'Score 3–1 at halftime', 'Population 1·2 million', 'Room 482–913', 'Promo code: 12.50 off', 'Discount code: 12·50 applied'])('leave ordinary text alone: %s', (text) => {
    expect(extractArtifacts(text).artifacts).toEqual([]);
  });
});

describe('a code before "is your"', () => {
  it.each([
    ['(482913) is your verification code', '482913'],
    ['"482913" is your code', '482913'],
    ['“482913” is your sign-in code', '482913'],
    ['482913 is your Acme Cloud Platform verification code', '482913'],
  ])('is quarantined: %s', (text, code) => hidden(text, code));

  it.each(['48291301 is your referral code', '4821 is your gift card code', '12345678 is your order number and promo code'])('leaves a number named as something else alone: %s', (text) => {
    expect(extractArtifacts(text).artifacts).toEqual([]);
  });

  it.each([
    ['4829 is your order OTP. Share it with the delivery partner', '4829'],
    ['482913 is your card OTP', '482913'],
    ['482913 is your credit card OTP for txn of Rs 1499', '482913'],
    ['482913 is your booking OTP for IRCTC', '482913'],
    ['482913 is your gift card verification code', '482913'],
    ['482913 is your booking verification code', '482913'],
    ['482913 is your account and login code', '482913'],
  ])('takes a one-time code whatever words come before its noun: %s', (text, code) => {
    const found = extractArtifacts(text);
    expect(found.artifacts).toEqual([{ kind: 'otp', value: code }]);
    expect(found.text).not.toContain(code);
  });
});

describe('a postal or product number named by a compound', () => {
  it.each(['Pincode: 560001', 'Barcode 48291301', 'Postcode: 4000', 'Zipcode 94107', 'Zip code: 94107', 'Postal code 560001', 'Unicode 4096'])('is left alone: %s', (text) => {
    expect(extractArtifacts(text).artifacts).toEqual([]);
  });
  it.each([['Enter thiscode: 482913', '482913'], ['Your PIN code is 4821', '4821']])('a glued or PIN code is still taken: %s', (text, code) => hidden(text, code));
});

describe('a code in a plain link', () => {
  it('is quarantined with the link', () => {
    const link = 'https://example.com/verify?code=482913&user=me';
    expect(extractArtifacts(`Or open ${link} to finish`)).toEqual({ text: 'Or open [quarantined: magic_link artifact - view in the source app] to finish', artifacts: [{ kind: 'magic_link', value: link }] });
  });

  it('leaves a link whose code is not digits alone', () => {
    expect(extractArtifacts('Docs: https://example.com/help?code=intro').artifacts).toEqual([]);
  });

  it.each(['https://shop.example.com/product?code=4821', 'https://shop.example.com/sale?code=482913&utm=mail'])('leaves a shop link whose path says nothing of signing in: %s', (link) => {
    expect(extractArtifacts(`See ${link}`).artifacts).toEqual([]);
  });

  it.each(['https://example.com/login?code=482913', 'https://example.com/auth/callback?code=482913', 'https://id.example.com/sign-in/confirm?otp=482913'])('takes a sign-in link with its code: %s', (link) => {
    expect(extractArtifacts(`Open ${link}`).artifacts).toEqual([{ kind: 'magic_link', value: link }]);
  });
});

describe('more invisible characters between digits', () => {
  it.each([['the Hangul filler', 'ㅤ'], ['a musical format character', '\u{1d173}']])('%s joins a split code', (_name, invisible) => {
    hidden(`Your code is 482${invisible}913`, '482913');
  });
});
