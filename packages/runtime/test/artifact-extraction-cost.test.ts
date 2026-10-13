import { describe, expect, it } from 'vitest';
import { extractArtifacts } from '../src/security/artifact-hygiene';

// Synthetic text only. Any sender controls a mail body, so extraction must stay linear in its length. The bound
// leaves room for a slow CI machine; a quadratic or worse pattern exceeds it by orders of magnitude at this size.
const N = 200_000;
const BOUND_MS = 250;

describe('artifact extraction on hostile text', () => {
  it.each([
    ['a keyword, then one long run of spaces', 'code' + ' '.repeat(N) + 'x'],
    ['an adjective form, then one long run of spaces', 'verification code' + ' '.repeat(N) + 'x'],
    ['a keyword, 100 spaces and a short code, repeated', ('code' + ' '.repeat(100) + '1 2 x').repeat(N / 109)],
    ['a keyword, 1,000 spaces and a short code, repeated', ('code' + ' '.repeat(1_000) + '1 2 x').repeat(N / 1_009)],
    ['"a-" repeated', 'a-'.repeat(N / 2)],
    ['"a-" repeated before an adjective', 'a-'.repeat(N / 2) + ' verification x'],
    ['"is your" before a long hyphenated word', '123456 is your ' + 'a-'.repeat(N / 2)],
    ['one run of "https://a"', 'https://a'.repeat(N / 9)],
    ['one run of almost-recovery links', 'https://a?type=recover'.repeat(N / 22)],
    ['one run of almost-verify links', 'https://a/auth/v1/verif'.repeat(N / 23)],
    ['a keyword, then digits between long CRLF runs', 'code ' + ('1' + ' \r\n'.repeat(50)).repeat(N / 151)],
    ['a keyword, then digits between newline-and-indentation runs', 'code' + ('\n' + ' '.repeat(40) + '1').repeat(N / 42)],
    ['a keyword, then digits between zero-width spaces', 'code ' + '1\u200b'.repeat(N / 2)],
    ['long digit runs between zero-width spaces', ('1'.repeat(50) + '\u200b').repeat(N / 51) + 'a'],
    ['digits and invisible characters in turn, then "is your"', '1\u200c'.repeat(N / 2) + ' is your code'],
    ['a keyword, then digits between soft hyphens and spaces', 'code ' + '1 \u00ad '.repeat(N / 4)],
    ['a keyword, then digits split by hyphens and spaces in turn', 'code ' + '1-1 '.repeat(N / 4)],
    ['uneven digit groups, then "is your"', '12 345 6789 '.repeat(N / 12) + 'is your code'],
    ['one digit run glued to "is your"', '1'.repeat(N) + 'is your code'],
    ['"code" glued to itself', 'code'.repeat(N / 4) + ' 1'],
    ['letters and digits in turn, then "is your"', 'a1'.repeat(N / 2) + ' is your code'],
    ['an adjective glued to itself', 'verification'.repeat(N / 12) + 'code 1'],
  ])('stays linear: %s', (_shape, text) => {
    const started = performance.now();
    extractArtifacts(text);
    expect(performance.now() - started).toBeLessThan(BOUND_MS);
  });
});

describe('links, tested once per run', () => {
  it('quarantines a whole run when the artifact follows another link in it', () => {
    const run = 'https://example.test/redirect?u=https://x.supabase.co/auth/v1/verify?token=synthetic';
    expect(extractArtifacts(`Open ${run} now`)).toEqual({ text: 'Open [quarantined: magic_link artifact - view in the source app] now', artifacts: [{ kind: 'magic_link', value: run }] });
  });

  it('leaves a separate ordinary link alone', () => {
    const reset = 'https://x.supabase.co/auth/v1/verify?token=synthetic&type=recovery';
    expect(extractArtifacts(`See https://example.test/help or ${reset}`)).toEqual({
      text: 'See https://example.test/help or [quarantined: magic_link artifact - view in the source app]', artifacts: [{ kind: 'magic_link', value: reset }],
    });
  });

  it('names a run by the first pattern that matches it, in the old order', () => {
    expect(extractArtifacts('https://app.example.test/login?type=recovery&token_hash=synthetic').artifacts).toEqual([{ kind: 'password_reset', value: 'https://app.example.test/login?type=recovery&token_hash=synthetic' }]);
    expect(extractArtifacts('https://app.example.test/x?token_hash=synthetic&reset_token=1').artifacts).toEqual([{ kind: 'magic_link', value: 'https://app.example.test/x?token_hash=synthetic&reset_token=1' }]);
  });
});
