// Everything that reaches a model or a person passes through sanitise(), and the owner's inbound text (WhatsApp, mail, web
// pages) is arbitrary: a pattern that backtracks super-linearly lets one hostile message stall the owner's Durable Object.
// The redactor scans a string of up to MODEL_CONTEXT_MAX_CHARS before it applies a destination's own cap, so each case is
// held to a time bound at a size where a quadratic pattern takes seconds. Time is only measured in plain node (this file
// runs in the scenarios config); the workers pool does not advance its clock during synchronous work.
import type { SanitiseDestination } from '@waldo/contracts';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sanitise } from '../src/scribe/sanitiser';

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
  'colon-separated hex': n => 'a1:'.repeat(n / 3),
};

describe('no redaction pattern backtracks on near-miss input', () => {
  it.each(Object.keys(NEAR_MISSES))('%s, 80,000 characters', name => {
    const text = NEAR_MISSES[name]!(80_000);
    for (const destination of ['send_message', 'internal_context'] as const) expect(millis(() => scan(text, destination)), destination).toBeLessThan(1_000);
  });

  it('a hostile uuid-like string takes time in proportion to its length', () => {
    const tokens = ['7e2aa0c8', '91b3', '4c2e', '8a11', 'f0e023af605', '-', '-', '.', ' ', '1', 'a', '@', '%', ':', '4111', 'ms'];
    const nearMiss = fc.array(fc.constantFrom(...tokens), { minLength: 2, maxLength: 8 }).chain(pool =>
      fc.array(fc.constantFrom(...pool), { minLength: 12_000, maxLength: 16_000 }).map(parts => parts.join('')));
    let total = 0;
    fc.assert(fc.property(nearMiss, text => { total += millis(() => scan(text)); }), { numRuns: 40 });
    expect(total).toBeLessThan(3_000);
  });
});
