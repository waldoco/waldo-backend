// Everything that reaches a model or a person passes through sanitise(), and the owner's inbound text (WhatsApp, mail, web
// pages) is arbitrary: a pattern that backtracks super-linearly lets one hostile message stall the owner's Durable Object.
// The redactor scans a string of up to MODEL_CONTEXT_MAX_CHARS before it applies a destination's own cap.
// A fixed time budget is a poor test of that: a shared CI runner is three to five times slower than a laptop, and the
// inputs here are linear, not stalls. Each case is timed at one size and at four times that size, and the time may grow
// by less than eight times (linear is about four, a quadratic pattern sixteen, a cubic one sixty-four); a case that takes
// under a quarter of a second at the larger size is fast enough not to matter. Time is only measured in plain node (this
// file runs in the scenarios config); the workers pool does not advance its clock during synchronous work.
import type { SanitiseDestination } from '@waldo/contracts';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { numericHealthIn, redactNumericHealth, sanitise } from '../src/scribe/sanitiser';

// A canary is 16 hex characters. These hold letters, so a run of digits in a test input is never mistaken for one (sanitise
// refuses a canary before it runs the health patterns, which would let a slow pattern pass unread).
const CANARIES = ['a1b2c3d4e5f60718', '0f1e2d3c4b5a6978', '9a8b7c6d5e4f3021'];
// External text is the one that has every PII class redacted, including the ones the owner may read in their own words.
const scan = (text: string, destination: SanitiseDestination = 'send_message') =>
  sanitise({ payload: destination === 'send_message' ? text : { body: text }, destination, canary_tokens: [...CANARIES], source_taint: 'external' });
const millis = (run: () => unknown): number => { const start = performance.now(); run(); return performance.now() - start; };
const FAST_ENOUGH_MS = 250;
const GROWTH_LIMIT = 8;
// The best of two runs, unless the first is already slow (a stall would only be repeated).
const timeOf = (run: () => unknown): number => { const first = millis(run); return first < FAST_ENOUGH_MS ? Math.min(first, millis(run)) : first; };
// `at(n)` runs the case on an input of size n; the case is read at `size / 4` and at `size`. Other test files run in parallel
// and a pause in the middle of one reading would read as growth, so a case that looks slow is read again, up to three times
// in all: a pattern that squares its input stays slow every time.
const expectLinear = (label: string, size: number, at: (n: number) => unknown): void => {
  let lowest = Infinity;
  let shown = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const small = timeOf(() => at(size / 4));
    const large = timeOf(() => at(size));
    if (large < FAST_ENOUGH_MS) return;
    const growth = large / Math.max(small, 30);
    if (growth < GROWTH_LIMIT) return;
    if (growth < lowest) { lowest = growth; shown = `${Math.round(small)} ms, then ${Math.round(large)} ms for four times the input`; }
  }
  expect(lowest, `${label}: ${shown}`).toBeLessThan(GROWTH_LIMIT);
};

const NEAR_MISSES: Readonly<Record<string, (chars: number) => string>> = {
  'a uuid one character short, repeated': n => '7e2aa0c8-91b3-4c2e-8a11-f0e023af605 '.repeat(n / 37),
  'a uuid one character short, back to back': n => '7e2aa0c8-91b3-4c2e-8a11-f0e023af605'.repeat(n / 36),
  'uuid groups that never close': n => '7e2aa0c8-91b3-4c2e-8a11-'.repeat(n / 24),
  'words joined by hyphens': n => 'a-'.repeat(n / 2),
  'words joined by dots': n => 'a.'.repeat(n / 2),
  'digits and dots': n => '1.'.repeat(n / 2),
  'percent runs': n => 'a%'.repeat(n / 2),
  'a mail address that never ends': n => 'a.'.repeat(n / 2) + '@',
  'a local part, then an at sign, repeated': n => 'a.b@'.repeat(n / 4),
  'a domain that never has a top level': n => 'a@' + 'b.'.repeat(n / 2) + '1',
  'phone-shaped groups': n => '555-123-'.repeat(n / 8),
  'long hex': n => 'a1'.repeat(n / 2),
  'long hex with a tail': n => 'a1'.repeat(n / 2) + 'g',
  'a street address that never ends': n => '12 a '.repeat(n / 5),
  'a role tag opener with blanks': n => '<' + ' '.repeat(n),
  'role tag openers repeated': n => '< '.repeat(n / 2),
  'colon-separated hex': n => 'a1:'.repeat(n / 3),
  'a token header repeated': n => 'eyJ-'.repeat(n / 4),
  'a token header repeated, then a short second segment': n => 'eyJ-'.repeat(n / 4) + '.a.aaaaaaaa',
  'a token header repeated, then a third segment with no word edge': n => 'eyJ-'.repeat(n / 4) + '.aaaa.--------',
  'a token with its dots and a long header': n => 'eyJ' + 'a.'.repeat(n / 2),
  'a bearer word repeated': n => 'Bearer a '.repeat(n / 9),
  'an api key word repeated': n => 'api_key: '.repeat(n / 9),
  'a private key header repeated': n => '-----BEGIN PRIVATE KEY-----\n'.repeat(n / 28),
  'card-shaped digit groups': n => '1234 '.repeat(n / 5),
  'hex ids run together': n => 'deadbeef41111111 '.repeat(n / 17),
  'country-code phone groups that never end': n => '+4 4 '.repeat(n / 5),
  'plus signs and digits': n => '+1'.repeat(n / 2),
  'a plus sign, then a long run of digits': n => '+' + '1'.repeat(n),
  'a plus sign and digits with brackets': n => '+4 (('.repeat(n / 6),
  'five-digit phone groups': n => '98765 '.repeat(n / 6),
  'zero-led five-digit phone groups': n => '098765 '.repeat(n / 7),
  'a long run of zeros, then a national number': n => '0'.repeat(n) + '98765 43210',
  'five-digit phone groups with hyphens': n => '98765-'.repeat(n / 6),
  'a token header glued to a letter, repeated': n => 'aeyJ'.repeat(n / 4),
  'a token header glued to an underscore, then its segments': n => '_eyJ'.repeat(n / 4) + '.aaaa.aaaaaaaa',
  'a long word, then a token': n => 'a'.repeat(n) + 'eyJaaaaaa.aaaa.aaaaaaaa',
  'a long word, then a token with a short last segment': n => 'a'.repeat(n) + 'eyJaaaaaa.aaaa.aaa',
  'card groups written two ways': n => '2026 1106-1234 5678 '.repeat(n / 20),
  'four-digit groups with two separators, repeated': n => '1111-1111 '.repeat(n / 10),
  'sleep and a short unit, repeated': n => 'sleep 7h '.repeat(n / 9),
  'sleep and a number with no unit, repeated': n => 'sleep 7 '.repeat(n / 8),
  'sleep, hours and a stray number, repeated': n => 'sleep 7h 22 '.repeat(n / 12),
  'hrv and an open bracket, repeated': n => 'hrv ( rmssd '.repeat(n / 12),
  'hrv with its method in brackets, repeated': n => 'hrv (rmssd) '.repeat(n / 12),
  'a wrist temperature word repeated': n => 'wrist temperature '.repeat(n / 18),
  'a wrist temperature and filler words, repeated': n => 'wrist temp up up up up '.repeat(n / 23),
};

// A health word followed by a run of blanks, a word run or a colon run: the shapes where a pattern that lets two
// neighbouring repeats share a run of whitespace costs the square or the cube of its length.
const TRIGGERS = ['hrv', 'HRV', 'heart rate', 'resting heart rate', 'sleep', 'slept', 'deep sleep', 'REM', 'steps', 'weight', 'body weight', 'bp',
  'blood pressure', 'systolic', 'spo2', 'blood oxygen', 'glucose', 'calorie burn', 'active energy', 'wrist temperature', 'body temperature',
  'respiratory rate', 'breathing rate', 'body fat', 'stand hours', 'zone 2', 'awake', 'move', 'burned', 'fever', 'recovery', 'crs', 'form score',
  'vo2 max', 'rmssd', 'sdnn', 'hrv (rmssd)', 'wrist temp', 'sleep 7', 'Bearer', 'password', 'api_key', 'secret', 'sk-', 'eyJ', 'hr', 'pulse'];
const FILLERS: Readonly<Record<string, (n: number) => string>> = {
  spaces: n => ' '.repeat(n), newlines: n => '\n'.repeat(n), 'no-break spaces': n => '\u00a0'.repeat(n), tabs: n => '\t'.repeat(n),
  'colons and spaces': n => ': '.repeat(n / 2), 'a number and a space': n => '1 '.repeat(n / 2), 'a word and a space': n => 'a '.repeat(n / 2), 'for a an': n => 'for a an '.repeat(n / 9),
};

// A case reads its input at two sizes, twice or more, and the file shares a machine with the other test files, so the default five
// seconds is not room enough for the slowest of them.
describe('the patterns sanitise() runs stay linear on the near-miss and whitespace inputs tried here', { timeout: 120_000 }, () => {
  it.each(Object.keys(NEAR_MISSES))('%s, up to 80,000 characters', name => {
    for (const destination of ['send_message', 'internal_context'] as const) expectLinear(destination, 80_000, n => scan(NEAR_MISSES[name]!(n), destination));
  });

  it.each(['hrv', 'slept', 'wrist temperature'])('%s followed by a run of blanks of each kind', word => {
    for (const filler of ['spaces', 'newlines', 'no-break spaces']) expectLinear(filler, 500, n => scan(`${word}${FILLERS[filler]!(n)}`));
  });

  it('every health, secret and token word followed by a run of each filler', () => {
    for (const word of TRIGGERS) for (const [name, make] of Object.entries(FILLERS)) expectLinear(`${word} + ${name}`, 400, n => scan(`${word}${make(n)}`));
  });

  // The health patterns the Scribe also runs on task output, recalled memory and traces, outside sanitise().
  it.each(['hrv', 'hrv rmssd', 'hrv (', 'heart rate variability ( rmssd', 'tsh', 'vitamin d (', '25-oh vitamin d', 'psa', 'psa level', 'hb 12', 'ferritin 12', 'egfr >'])('numericHealthIn and redactNumericHealth read %s followed by a run of blanks', word => {
    expectLinear('numericHealthIn', 100_000, n => numericHealthIn(`${word}${' '.repeat(n)}`));
    expectLinear('redactNumericHealth', 100_000, n => redactNumericHealth(`${word}${' '.repeat(n)}`, '[health]'));
  });

  // A word between a health word and its number may not swallow the number's own digits and be tried at every split. The
  // free-text health patterns run only inside sanitise(), so this goes through it, to both a message and the model's context.
  it.each(['heart rate', 'glucose', 'hrv', 'steps', 'bp', 'blood pressure', 'sleep duration', 'form', 'body temperature'])('%s, a word, then a run of digits, with or without a letter after them', word => {
    for (const destination of ['send_message', 'internal_context'] as const) {
      for (const tail of ['z', '']) expectLinear(`${destination}, tail ${JSON.stringify(tail)}`, 80_000, n => scan(`${word} x ${'1'.repeat(n)}${tail}`, destination));
      expectLinear(`${destination}, a bare run of digits`, 200_000, n => scan(`${word} ${'1'.repeat(n)}`, destination));
      expectLinear(`${destination}, letters between digits`, 80_000, n => scan(`${word} ${'x1'.repeat(n / 2)}`, destination));
    }
  });

  // The canary check comes first: with a canary in the text, none of the health patterns is reached, so a test that
  // used one would pass without exercising them.
  it('the digits in these inputs are read by the health patterns, not refused as a canary', () => {
    const result = scan(`heart rate x 72 ${'1'.repeat(40)}z`, 'internal_context');
    expect(result.ok === false && result.check === 'canary_token').toBe(false);
    expect(scan(`heart rate: 72 bpm`, 'send_message')).toMatchObject({ ok: false, check: 'health_value' });
  });

  // A role tag is `<`, an optional `/`, a role and `>`, each with blanks allowed between: blanks after a lone `<` are read once.
  it.each([['<'], ['</'], ['< /'], ['<system']])('%s followed by a run of blanks', start => {
    for (const destination of ['send_message', 'internal_context'] as const) expectLinear(destination, 100_000, n => scan(`${start}${' '.repeat(n)}`, destination));
  });

  it('a hostile uuid-like string takes time in proportion to its length', () => {
    const tokens = ['7e2aa0c8', '91b3', '4c2e', '8a11', 'f0e023af605', '-', '-', '.', ' ', '1', 'a', '@', '%', ':', '4111', 'ms', 'eyJ', 'hrv', 'slept'];
    const nearMiss = fc.array(fc.constantFrom(...tokens), { minLength: 2, maxLength: 8 }).chain(pool =>
      fc.array(fc.constantFrom(...pool), { minLength: 48_000, maxLength: 64_000 }).map(parts => parts.join('')));
    fc.assert(fc.property(nearMiss, text => { expectLinear('a random near miss', text.length, n => scan(text.slice(0, n))); }), { numRuns: 25 });
  });
});
