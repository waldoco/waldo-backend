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
  ])('%s', (_name, card) => {
    expect(textOf(`my card is ${card}.`)).toEqual({ text: 'my card is [REDACTED_CREDIT_CARD].', cards: 1 });
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
