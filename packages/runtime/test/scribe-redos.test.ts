// Everything that reaches a model or a person passes through sanitise(), and the owner's inbound text (WhatsApp, mail, web
// pages) is arbitrary: a pattern that backtracks super-linearly lets one hostile message stall the owner's Durable Object.
// The redactor scans a string of up to MODEL_CONTEXT_MAX_CHARS before it applies a destination's own cap, so each case is
// held to a time bound at a size where a quadratic pattern takes seconds. Time is only measured in plain node (this file
// runs in the scenarios config); the workers pool does not advance its clock during synchronous work.
import type { SanitiseDestination } from '@waldo/contracts';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { numericHealthIn, redactNumericHealth, sanitise } from '../src/scribe/sanitiser';

const CANARIES = ['1111111111111111', '2222222222222222', '3333333333333333'];
// External text is the one that has every PII class redacted, including the ones the owner may read in their own words.
const scan = (text: string, destination: SanitiseDestination = 'send_message') =>
  sanitise({ payload: destination === 'send_message' ? text : { body: text }, destination, canary_tokens: [...CANARIES], source_taint: 'external' });
const millis = (run: () => unknown): number => { const start = performance.now(); run(); return performance.now() - start; };

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
};

// A health word followed by a run of blanks, a word run or a colon run: the shapes where a pattern that lets two
// neighbouring repeats share a run of whitespace costs the square or the cube of its length.
const TRIGGERS = ['hrv', 'HRV', 'heart rate', 'resting heart rate', 'sleep', 'slept', 'deep sleep', 'REM', 'steps', 'weight', 'body weight', 'bp',
  'blood pressure', 'systolic', 'spo2', 'blood oxygen', 'glucose', 'calorie burn', 'active energy', 'wrist temperature', 'body temperature',
  'respiratory rate', 'breathing rate', 'body fat', 'stand hours', 'zone 2', 'awake', 'move', 'burned', 'fever', 'recovery', 'crs', 'form score',
  'vo2 max', 'Bearer', 'password', 'api_key', 'secret', 'sk-', 'eyJ', 'hr', 'pulse'];
const FILLERS: Readonly<Record<string, (n: number) => string>> = {
  spaces: n => ' '.repeat(n), newlines: n => '\n'.repeat(n), 'no-break spaces': n => '\u00a0'.repeat(n), tabs: n => '\t'.repeat(n),
  'colons and spaces': n => ': '.repeat(n / 2), 'a number and a space': n => '1 '.repeat(n / 2), 'a word and a space': n => 'a '.repeat(n / 2), 'for a an': n => 'for a an '.repeat(n / 9),
};

// 300 ms for 80,000 characters is several times what a linear pass takes on a slow runner and a fraction of what the
// patterns this file guards took before they were fixed (1 to 4 s), so a regression fails instead of passing by luck.
describe('the patterns sanitise() runs stay linear on the near-miss and whitespace inputs tried here', () => {
  // These take longer per character for a reason that is the same at every size (about 5 microseconds each, twice the size
  // is twice the time), so they are read at a quarter of the length.
  const HEAVY = new Set(['a bearer word repeated', 'an api key word repeated', 'a private key header repeated']);
  it.each(Object.keys(NEAR_MISSES))('%s, up to 80,000 characters', name => {
    const text = NEAR_MISSES[name]!(HEAVY.has(name) ? 20_000 : 80_000);
    for (const destination of ['send_message', 'internal_context'] as const) expect(millis(() => scan(text, destination)), destination).toBeLessThan(300);
  });

  it.each(['hrv', 'slept', 'wrist temperature'])('%s followed by 500 blanks of each kind is read in a moment', word => {
    for (const filler of ['spaces', 'newlines', 'no-break spaces']) expect(millis(() => scan(`${word}${FILLERS[filler]!(500)}`)), filler).toBeLessThan(100);
  });

  it('every health, secret and token word followed by 400 characters of each filler is read in a moment', () => {
    let slowest = 0;
    let total = 0;
    for (const word of TRIGGERS) for (const make of Object.values(FILLERS)) {
      const took = millis(() => scan(`${word}${make(400)}`));
      slowest = Math.max(slowest, took);
      total += took;
    }
    expect(slowest).toBeLessThan(100);
    expect(total).toBeLessThan(3_000);
  });

  // The health patterns the Scribe also runs on task output, recalled memory and traces, outside sanitise().
  it.each(['hrv', 'hrv rmssd', 'hrv (', 'heart rate variability ( rmssd'])('numericHealthIn and redactNumericHealth read %s followed by 100,000 blanks in a moment', word => {
    const text = `${word}${' '.repeat(100_000)}`;
    expect(millis(() => numericHealthIn(text))).toBeLessThan(300);
    expect(millis(() => redactNumericHealth(text, '[health]'))).toBeLessThan(300);
  });

  // A word between a health word and its number may not swallow the number's own digits and be tried at every split.
  it.each(['heart rate', 'glucose', 'hrv', 'steps', 'bp', 'blood pressure', 'sleep duration', 'form', 'body temperature'])('%s, a word, then 40,000 digits that end in a letter, is read in a moment', word => {
    const text = `${word} x ${'1'.repeat(40_000)}z`;
    expect(millis(() => scan(text)), 'sanitise').toBeLessThan(300);
    expect(millis(() => numericHealthIn(text)), 'numericHealthIn').toBeLessThan(300);
    expect(millis(() => redactNumericHealth(text, '[health]')), 'redactNumericHealth').toBeLessThan(300);
    expect(millis(() => scan(`${word} ${'1'.repeat(200_000)}`)), 'a bare run of digits').toBeLessThan(300);
  });

  // A role tag is `<`, an optional `/`, a role and `>`, each with blanks allowed between: blanks after a lone `<` are read once.
  it.each([['<'], ['</'], ['< /'], ['<system']])('%s followed by 100,000 blanks is read in a moment', start => {
    const text = `${start}${' '.repeat(100_000)}`;
    for (const destination of ['send_message', 'internal_context'] as const) expect(millis(() => scan(text, destination)), destination).toBeLessThan(300);
  });

  it('a hostile uuid-like string takes time in proportion to its length', () => {
    const tokens = ['7e2aa0c8', '91b3', '4c2e', '8a11', 'f0e023af605', '-', '-', '.', ' ', '1', 'a', '@', '%', ':', '4111', 'ms', 'eyJ', 'hrv', 'slept'];
    const nearMiss = fc.array(fc.constantFrom(...tokens), { minLength: 2, maxLength: 8 }).chain(pool =>
      fc.array(fc.constantFrom(...pool), { minLength: 12_000, maxLength: 16_000 }).map(parts => parts.join('')));
    let total = 0;
    fc.assert(fc.property(nearMiss, text => { total += millis(() => scan(text)); }), { numRuns: 40 });
    expect(total).toBeLessThan(3_000);
  });
});
