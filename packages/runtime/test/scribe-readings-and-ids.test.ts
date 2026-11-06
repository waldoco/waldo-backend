// What the Scribe lets through that it should not (a reading written in a shape the patterns missed, a token or a phone number
// from outside the US) and what it hides that it should not (a build number read as a card). Every reading is synthetic.
import type { SanitiseDestination } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { HEALTH_SPAN_MARKER, numericHealthIn, sanitise } from '../src/scribe/sanitiser';

const CANARIES = ['a1b2c3d4e5f60718', '0f1e2d3c4b5a6978', '9a8b7c6d5e4f3021'];
const run = (text: string, destination: SanitiseDestination, taint: 'external' | null = 'external') =>
  sanitise({ payload: destination === 'send_message' ? text : { body: text }, destination, canary_tokens: [...CANARIES], source_taint: taint });
const run0 = (text: string) => run(text, 'send_message');
const bodyOf = (result: ReturnType<typeof run>): string => {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return typeof result.payload === 'string' ? result.payload : (result.payload as { body: string }).body;
};

const READINGS = [
  'sleep    7h',
  'sleep\t7h',
  'slept 7h',
  'deep sleep 1h 20m',
  'sleep 7h 22m',
  'wrist temperature +0.3',
  'wrist temperature deviation -0.2',
  'wrist temp up 0.4°C',
  'hrv (rmssd) 45 ms',
  'HRV (RMSSD): 45',
  'hrv ( sdnn ) 52 ms',
  'rmssd 38 ms',
];

describe('readings the free-text floor used to miss', () => {
  it.each(READINGS)('%s is refused where it would leave, and withheld where it reaches the model', reading => {
    for (const destination of ['send_message', 'memory_block'] as const) {
      expect(run(`last night: ${reading}.`, destination), destination).toMatchObject({ ok: false, reason: 'health_value_leak' });
    }
    const withheld = bodyOf(run(`last night: ${reading}.`, 'internal_context'));
    expect(withheld).toContain(HEALTH_SPAN_MARKER);
    expect(withheld.replace(/\[health value withheld\]/g, '')).not.toMatch(/\d/);
  });

  it.each(READINGS)('%s is still a reading for the floor that guards memory writes', reading => {
    expect(numericHealthIn(reading)).toBe(true);
  });

  // The owner's own words reach the model and the owner's channel as before.
  it('does not touch what the owner said at the destinations that are conversation', () => {
    for (const destination of ['internal_context', 'owner_reply'] as const) {
      expect(bodyOf(run('sleep    7h and hrv (rmssd) 45 ms', destination, null))).toBe('sleep    7h and hrv (rmssd) 45 ms');
    }
  });

  it.each([
    'sleep 10pm to 7am',
    'sleep in until 10h30',
    'a wrist watch 3 straps',
    'I could use sleep. 8 people are coming',
    'the sleep clinic opens at 9am',
    'rmssd is a measure of variation',
  ])('leaves %s alone', text => {
    expect(bodyOf(run(text, 'send_message'))).toBe(text);
    expect(bodyOf(run(text, 'internal_context'))).toBe(text);
  });
});

describe('phone numbers outside the US', () => {
  it.each([
    ['call +44 20 7946 0958 now', 'call [REDACTED_PHONE] now'],
    ['call +44 (0)20 7946 0958 now', 'call [REDACTED_PHONE] now'],
    ['call +447911123456 now', 'call [REDACTED_PHONE] now'],
    ['call +91 98765 43210 now', 'call [REDACTED_PHONE] now'],
    ['call +91-9876543210 now', 'call [REDACTED_PHONE] now'],
    ['call +91 98765-43210.', 'call [REDACTED_PHONE].'],
    ['call 98765 43210 now', 'call [REDACTED_PHONE] now'],
    ['call 98765-43210 now', 'call [REDACTED_PHONE] now'],
    ['tel:+49 151 23456789;', 'tel:[REDACTED_PHONE];'],
    ['wa.me/+971501234567', 'wa.me/[REDACTED_PHONE]'],
  ])('redacts the number in %j', (input, expected) => {
    expect(bodyOf(run(input, 'send_message'))).toBe(expected);
    expect(bodyOf(run(input, 'memory_block'))).toBe(expected);
  });

  it('keeps the US forms it already redacted', () => {
    expect(bodyOf(run('call (415) 555-0142 or +1 415 555 0142', 'send_message')).match(/\[REDACTED_PHONE\]/g)).toHaveLength(2);
  });

  it.each([
    'version +1.2.3 shipped',
    'it was +5 degrees',
    'up +3.5 percent',
    'on 2026-11-06 at 10:30',
    'order 98765',
    'items +12 and +34',
    'ref 98765 4321',
  ])('leaves %j alone', text => {
    expect(bodyOf(run(text, 'send_message'))).toBe(text);
  });

  it('the owner reads a number in their own words at the destinations that are conversation', () => {
    expect(bodyOf(run('call +91 98765 43210', 'internal_context', null))).toBe('call +91 98765 43210');
  });
});

describe('a token glued to a letter or an underscore', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk';
  it.each([['a'], ['_'], ['Zq9'], ['x-'], ['tok='], [' '], ['']])('is refused after %j', glue => {
    for (const destination of ['send_message', 'internal_context', 'memory_block'] as const) {
      expect(run(`token ${glue}${JWT} end`, destination), destination).toMatchObject({ ok: false, reason: 'secret_leak' });
    }
  });

  it('is not read into ordinary text', () => {
    expect(bodyOf(run('see eyJhbGci and eyJ1 later.x', 'send_message'))).toBe('see eyJhbGci and eyJ1 later.x');
  });
});

describe('a build number is not a card', () => {
  const body = (text: string) => bodyOf(run(text, 'send_message'));
  it('keeps a build number whose groups are written two ways', () => {
    expect(body('build 20261106-1234-5678-9012')).toBe('build 20261106-1234-5678-9012');
    expect(body('release 20261101-1234-5678 shipped')).toBe('release 20261101-1234-5678 shipped');
    expect(body('job 2026 1106-1234 5678')).toBe('job 2026 1106-1234 5678');
  });

  it('still redacts a card written with one separator, or none, whether or not its check digit holds', () => {
    for (const card of ['4111 1111 1111 1114', '4111-1111-1111-1114', '4111.1111.1111.1114', '4111111111111114', '4111 1111 1111 1111', '5555-5555-5555-4444']) {
      expect(body(`my card is ${card}.`), card).toBe('my card is [REDACTED_CREDIT_CARD].');
    }
  });

  it('still redacts a card whose groups are written two ways when its check digit holds', () => {
    expect(body('pay 4111 1111-1111 1111 now')).toBe('pay [REDACTED_CREDIT_CARD] now');
    expect(body('pay 41111111 11111111 now')).toBe('pay [REDACTED_CREDIT_CARD] now');
    expect(body('pay 4111 111111111111 now')).toBe('pay [REDACTED_CREDIT_CARD] now');
  });
});

// The patterns that changed are held to the ones they replaced, over random text built from the pieces each is made of.
describe('the changed patterns still find what the earlier ones found', () => {
  let state = 7;
  const pick = <T,>(items: readonly T[]): T => items[Math.floor((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296 * items.length)]!;
  const text = (pieces: readonly string[], most: number): string => Array.from({ length: 1 + Math.floor(pick([...Array(most).keys()].map(n => n / most)) * most) }, () => pick(pieces)).join('');
  const digitsIn = (value: string): number => (value.match(/\d/g) ?? []).length;

  it('a number the earlier phone pattern redacted is still redacted', () => {
    const BASE = /\+?\b(?:1?[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
    const pieces = ['+', '1', '4', '9', '5', '0', '7', ' ', ' ', '-', '.', '(', ')', 'a', 'x ', '415', '555', '0142', '98765', '43210'];
    let compared = 0;
    for (let run = 0; run < 20_000; run += 1) {
      const input = `n ${text(pieces, 16)} z`;
      const covered = [...input.matchAll(BASE)].reduce((sum, match) => sum + digitsIn(match[0]), 0);
      if (covered === 0) continue;
      compared += 1;
      const output = bodyOf(run0(input));
      expect(digitsIn(output), JSON.stringify(input)).toBeLessThanOrEqual(digitsIn(input) - covered);
    }
    expect(compared).toBeGreaterThan(1_000);
  });

  it('a token the earlier token pattern found is still refused', () => {
    const BASE = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\b)[A-Za-z0-9_-]*?(?<!\w)eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\b/;
    const chars = ['a', 'b', 'Z', '1', '_', '-', 'eyJ'];
    const word = (most: number): string => Array.from({ length: Math.floor(pick([0, 0.2, 0.4, 0.6, 0.8, 1]) * most) }, () => pick(chars)).join('');
    let compared = 0;
    for (let run = 0; run < 20_000; run += 1) {
      const input = `${pick(['', ' ', 'a', '_', 'x-', '.', '1', 'Zq'])}eyJ${word(10)}.${word(6)}.${word(10)}${pick(['', ' ', '-', 'x', '.', '_'])}`;
      if (!BASE.test(input)) continue;
      compared += 1;
      expect(run0(input), JSON.stringify(input)).toMatchObject({ ok: false, reason: 'secret_leak' });
    }
    expect(compared).toBeGreaterThan(300);
  });

  // The one narrowing is meant: candidates whose groups are written two ways and fail the check digit are not cards.
  it('a card candidate is redacted exactly when the earlier rule redacted it, unless it is written two ways and fails the check digit', () => {
    const luhn = (digits: string): boolean => [...digits].reverse().reduce((sum, ch, at) => { let d = Number(ch); if (at % 2 === 1) { d *= 2; if (d > 9) d -= 9; } return sum + d; }, 0) % 10 === 0;
    const seps = ['', '', ' ', '-', '.'];
    let narrowed = 0;
    for (let run = 0; run < 20_000; run += 1) {
      const digits = Array.from({ length: 16 }, () => pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).join('');
      const groups = [digits.slice(0, 4), digits.slice(4, 8), digits.slice(8, 12), digits.slice(12)];
      const gaps = [pick(seps), pick(seps), pick(seps)];
      const candidate = groups.map((group, at) => group + (gaps[at] ?? '')).join('');
      const same = gaps.every(gap => gap === gaps[0]);
      const redacted = bodyOf(run0(`pay ${candidate} now`)).includes('[REDACTED_CREDIT_CARD]');
      const expected = same || luhn(digits);
      if (!expected) narrowed += 1;
      expect(redacted, candidate).toBe(expected);
    }
    expect(narrowed).toBeGreaterThan(1_000);
  });
});
