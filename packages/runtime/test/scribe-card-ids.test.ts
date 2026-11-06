// The card rule redacts card numbers and leaves identifiers alone: an id the model or a tool hands back must reach its next
// call byte for byte, and a real card number must never get through.
import type { SanitiseDestination } from '@waldo/contracts';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sanitise } from '../src/scribe/sanitiser';

const clean = (payload: string | Record<string, unknown>, destination: SanitiseDestination) =>
  sanitise({ payload: payload as never, destination, canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], source_taint: null });
// Free text goes out as a message; the model's own context and the owner's reply take structured data, so the text rides in a field.
const textOf = (text: string, destination: SanitiseDestination = 'send_message') => {
  const result = clean(destination === 'send_message' ? text : { body: text }, destination);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return { text: (destination === 'send_message' ? result.payload : (result.payload as { body: string }).body) as string, cards: result.redactions.find(entry => entry.kind === 'credit_card')?.count ?? 0 };
};

// A uuid whose first three groups are all digits: the shape that holds sixteen digits in a row once its hyphens go.
const digitHeavyUuid = fc.stringMatching(/^[0-9]{8}-[0-9]{4}-[0-9]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const PREFIXES = ['', 'med-', 'med_', 'file_', 'appr_', 'run:', 'task-', 'urn:waldo:'];

describe('identifiers survive the card rule', () => {
  it('keeps the uuid the redactor used to mangle, alone and in a sentence', () => {
    const id = '19043673-2379-4309-be95-0123456789ab';
    expect(textOf(id)).toEqual({ text: id, cards: 0 });
    expect(textOf(`Stop medication ${id} now.`)).toEqual({ text: `Stop medication ${id} now.`, cards: 0 });
    for (const destination of ['internal_context', 'owner_reply', 'send_message'] as const) expect(textOf(id, destination).text).toBe(id);
  });

  // A dashless id, a git SHA or a 0x hash is a run of hex characters; digits inside it are not a card.
  it('keeps random hex ids of 20, 24, 32, 40 and 64 characters, with or without 0x, digit-heavy ones included', () => {
    const hex = (length: number) => fc.array(fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...'0123456789') }, { weight: 1, arbitrary: fc.constantFrom(...'abcdef') }), { minLength: length, maxLength: length })
      .filter(chars => chars.some(char => char >= 'a')).map(chars => chars.join(''))
      // A run of 13 to 19 digits that passes the check digit is a card number even inside a hex run, and is redacted.
      .filter(id => !(id.match(/\d{13,19}/g) ?? []).some(run => [...run].reverse().reduce((sum, char, at) => { const digit = Number(char) * (at % 2 ? 2 : 1); return sum + (digit > 9 ? digit - 9 : digit); }, 0) % 10 === 0));
    fc.assert(fc.property(fc.constantFrom(20, 24, 32, 40, 64).chain(hex), fc.constantFrom('', '0x', 'sha:', 'id_', 'commit ', '0X'), (id, prefix) => {
      expect(textOf(`${prefix}${id}`).text).toBe(`${prefix}${id}`);
      expect(textOf(`see ${prefix}${id}, then ${prefix}${id}.`).text).toBe(`see ${prefix}${id}, then ${prefix}${id}.`);
    }), { numRuns: 800 });
  });

  it('keeps an id held in a field of a tool result', () => {
    const id = '19043673-2379-4309-be95-0123456789ab';
    const result = clean({ medication_id: id, note: `id ${id}` }, 'internal_context');
    expect(result).toMatchObject({ ok: true, payload: { medication_id: id, note: `id ${id}` } });
  });

  it('keeps random uuids and digit-heavy uuids, with and without the prefixes ids carry', () => {
    fc.assert(fc.property(fc.oneof(fc.uuid(), digitHeavyUuid), fc.constantFrom(...PREFIXES), (uuid, prefix) => {
      const id = `${prefix}${uuid}`;
      expect(textOf(id).text).toBe(id);
      expect(textOf(`open ${id}, then ${id}.`).text).toBe(`open ${id}, then ${id}.`);
    }), { numRuns: 500 });
  });
});

describe('card numbers are still redacted', () => {
  it.each([
    ['4-4-4-4 with spaces', '4111 1111 1111 1111'],
    ['4-4-4-4 with hyphens', '4111-1111-1111-1111'],
    ['sixteen digits in a row', '4111111111111111'],
    ['4-4-4-4 that fails the check digit', '4111 1111 1111 1114'],
    ['Amex 4-6-5', '3782 822463 10005'],
    ['Amex 4-6-5 with hyphens', '3782-822463-10005'],
    ['fifteen Amex digits in a row', '378282246310005'],
    ['4-4-4-4 with dots', '4111.1111.1111.1111'],
    ['8-8 grouping', '41111111 11111111'],
    ['4-12 grouping', '4111 111111111111'],
  ])('%s', (_name, card) => {
    expect(textOf(`my card is ${card}.`)).toEqual({ text: 'my card is [REDACTED_CREDIT_CARD].', cards: 1 });
  });

  // A hyphen or a letter beside a card is not an identifier: only a uuid is.
  it.each([
    ['CC-4111111111111111', 'CC-[REDACTED_CREDIT_CARD]'],
    ['Visa-4111 1111 1111 1111', 'Visa-[REDACTED_CREDIT_CARD]'],
    ['4111111111111111-12/27', '[REDACTED_CREDIT_CARD]-12/27'],
    ['4111 1111 1111 1111-exp', '[REDACTED_CREDIT_CARD]-exp'],
    ['card_4111111111111111', 'card_[REDACTED_CREDIT_CARD]'],
    ['card4111111111111111', 'card[REDACTED_CREDIT_CARD]'],
    ['CC4111111111111111', 'CC[REDACTED_CREDIT_CARD]'],
    ['4111111111111111abcd', '[REDACTED_CREDIT_CARD]abcd'],
    ['abcd4111111111111111', 'abcd[REDACTED_CREDIT_CARD]'],
    ['deadbeef4111111111111111', 'deadbeef[REDACTED_CREDIT_CARD]'],
    ['4111111111111111deadbeef', '[REDACTED_CREDIT_CARD]deadbeef'],
    ['x4111111111111111', 'x[REDACTED_CREDIT_CARD]'],
    ['pay:4111-1111-1111-1111;', 'pay:[REDACTED_CREDIT_CARD];'],
  ])('redacts the card in %s', (input, expected) => {
    expect(textOf(input).text).toBe(expected);
    expect(textOf(input, 'owner_reply').text).toBe(expected);
  });

  // A uuid that ends in four digits looks like the first group of a card to the scan; the card after it is still a card.
  it.each([[' '], ['-'], ['\n'], ['\t'], [': ']])('redacts a card that follows a uuid ending in four digits, after %j', sep => {
    const id = '7e2aa0c8-91b3-4c2e-8a11-f0e023af6052';
    expect(textOf(`task ${id}${sep}5555 5555 5555 4444`)).toEqual({ text: `task ${id}${sep}[REDACTED_CREDIT_CARD]`, cards: 1 });
    expect(textOf(`task ${id}${sep}4111111111111111 done`)).toEqual({ text: `task ${id}${sep}[REDACTED_CREDIT_CARD] done`, cards: 1 });
  });

  it('redacts a card after any uuid, and keeps the uuid', () => {
    fc.assert(fc.property(fc.oneof(fc.uuid(), digitHeavyUuid), fc.constantFrom(' ', '-', '\n'), (uuid, sep) => {
      expect(textOf(`ref ${uuid}${sep}4111 1111 1111 1111`)).toEqual({ text: `ref ${uuid}${sep}[REDACTED_CREDIT_CARD]`, cards: 1 });
    }), { numRuns: 500 });
  });

  it('redacts a card written against an id with a hyphen, and keeps the id', () => {
    const id = '19043673-2379-4309-be95-0123456789ab';
    expect(textOf(`4111111111111111-${id}`)).toEqual({ text: `[REDACTED_CREDIT_CARD]-${id}`, cards: 1 });
  });

  it('redacts a card beside an id and keeps the id', () => {
    const id = '19043673-2379-4309-be95-0123456789ab';
    expect(textOf(`card 4111 1111 1111 1111 for ${id}`)).toEqual({ text: `card [REDACTED_CREDIT_CARD] for ${id}`, cards: 1 });
  });

  it('redacts any card-shaped number of sixteen digits in four groups', () => {
    fc.assert(fc.property(fc.stringMatching(/^[0-9]{16}$/), fc.constantFrom(' ', '-', ''), (digits, sep) => {
      const card = [0, 4, 8, 12].map(at => digits.slice(at, at + 4)).join(sep);
      expect(textOf(`pay with ${card} today`)).toEqual({ text: 'pay with [REDACTED_CREDIT_CARD] today', cards: 1 });
    }), { numRuns: 500 });
  });
});
