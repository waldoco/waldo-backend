import { describe, expect, it } from 'vitest';
import type { LLMToolTurn } from '@waldo/contracts';
import { FORGET_MARKER, forgetBarrier, resultOrigin, WITHHELD_OUTPUT, type BarrierTally } from '../src/context-composer/forget-barrier';

const tally = (): BarrierTally => ({ dropped: 0, redacted: 0 });
const turn = (name: string, output: string): LLMToolTurn => ({ call: { call_id: `c-${name}`, name, arguments: '{}' }, output });

describe('nothing held', () => {
  it('returns every input untouched and reports itself inactive', () => {
    const barrier = forgetBarrier([]);
    const turns = [turn('web_search', 'tea prices')];
    expect(barrier.active).toBe(false);
    expect(barrier.turns(turns)[0]!.output).toBe('tea prices');
    expect(barrier.text('tea', tally())).toBe('tea');
    const value = { data: { claims: [{ text: 'tea' }] } };
    expect(barrier.structured(value, 'owner_store', tally())).toEqual(value);
  });
});

describe('items mode, text from outside the owner', () => {
  const barrier = forgetBarrier(['tea']);

  it('replaces the forgotten word and keeps the rest of the text', () => {
    const counts = tally();
    expect(barrier.text('Green tea is grown on terraces.', counts)).toBe(`Green ${FORGET_MARKER} is grown on terraces.`);
    expect(counts).toEqual({ dropped: 0, redacted: 1 });
  });

  it('leaves words that only contain the topic, by the shared whole-word rule', () => {
    expect(barrier.text('The team was steady.', tally())).toBe('The team was steady.');
  });

  it('reads a topic spelled by escapes and removes it', () => {
    const out = barrier.text('menu: \\u0074ea and cake', tally());
    expect(out).toBe(`menu: ${FORGET_MARKER} and cake`);
  });

  it('does not treat an unknown escape as the topic, so a page with a path or a regex is kept whole', () => {
    expect(barrier.text('C:\\data\\d+ files', tally())).toBe('C:\\data\\d+ files');
    expect(barrier.output('see C:\\data\\d+ for the logs', 'external')).toBe('see C:\\data\\d+ for the logs');
  });

  it('reads every escape the storage test reads, so a topic spelled by an identity escape or a line continuation is removed', () => {
    expect(barrier.text('menu: t\\ea and cake', tally())).toBe(`menu: ${FORGET_MARKER} and cake`);
    expect(barrier.text('menu: te\\\na and cake', tally())).toBe(`menu: ${FORGET_MARKER} and cake`);
    expect(barrier.output('{"menu":"t\\\\ea and cake"}', 'external')).not.toMatch(/t\\+ea/);
    expect(forgetBarrier(['\u{1F375}tea']).text('\\\u{1F375}\\x74ea', tally())).toBe(FORGET_MARKER);
  });

  it('cuts a raw JSON output whose escapes are nested, which the storage test reads one layer of', () => {
    const out = barrier.output('{"body":"\\\\u0074ea time"}', 'external');
    expect(out).toContain(FORGET_MARKER);
    expect(out).not.toContain('u0074ea');
  });

  it('decodes nested escapes until the topic can be removed, so nothing is withheld whole', () => {
    expect(barrier.text('\\u005cu0074ea time', tally())).toBe(`${FORGET_MARKER} time`);
    const out = barrier.structured({ page: { title: 'Menu', body: '\\u005cu0074ea' } }, 'external', tally());
    expect(out).toEqual({ page: { title: 'Menu', body: FORGET_MARKER } });
  });

  it('keeps every item of an external list and replaces the words inside them', () => {
    const counts = tally();
    const out = barrier.structured({ messages: [{ subject: 'tea at 4' }, { subject: 'standup' }] }, 'external', counts);
    expect(out).toEqual({ messages: [{ subject: `${FORGET_MARKER} at 4` }, { subject: 'standup' }] });
    expect(counts).toEqual({ dropped: 0, redacted: 1 });
  });

  it('replaces a key that carries the topic rather than withholding the object', () => {
    expect(barrier.structured({ tea: 1, coffee: 2 }, 'external', tally())).toEqual({ [FORGET_MARKER]: 1, coffee: 2 });
  });
});

describe('items mode, the owner\'s memory', () => {
  const barrier = forgetBarrier(['tea']);

  it('drops the item that carries the topic and keeps the list and the other items', () => {
    const counts = tally();
    const out = barrier.structured({ data: { claims: [{ id: 1, text: 'likes tea' }, { id: 2, text: 'runs on Sundays' }], complete: true } }, 'owner_store', counts);
    expect(out).toEqual({ data: { claims: [{ id: 2, text: 'runs on Sundays' }], complete: true } });
    expect(counts).toEqual({ dropped: 1, redacted: 0 });
  });

  it('drops an item an escape spells the topic in, since memory is judged as the purge reads it back', () => {
    const out = barrier.structured({ claims: [{ text: 'likes t\\ea' }, { text: 'path C:\\x' }, { text: 'runs' }] }, 'owner_store', tally());
    expect(out).toEqual({ claims: [{ text: 'path C:\\x' }, { text: 'runs' }] });
  });

  it('replaces the words in a value outside a list instead of withholding the read', () => {
    expect(barrier.structured({ data: { summary: 'tea on Mondays' } }, 'owner_store', tally())).toEqual({ data: { summary: `${FORGET_MARKER} on Mondays` } });
  });
});

describe('tool turns', () => {
  const barrier = forgetBarrier(['tea']);

  it('never touches the forget receipt itself', () => {
    const turns = [turn('forget_memory', '{"ok":true,"data":{"topic":"tea"}}')];
    expect(barrier.turns(turns)).toEqual(turns);
  });

  it('cuts a memory read by item, keeps the loop notes after it, and says what was removed', () => {
    const raw = JSON.stringify({ ok: true, data: { claims: [{ text: 'tea' }, { text: 'runs' }] } }) + '\n[budget: 3 tool rounds left]';
    const [out] = barrier.turns([turn('read_memory', raw)]);
    expect(out!.output).toContain('"runs"');
    expect(out!.output).not.toMatch(/"tea"/);
    expect(out!.output).toContain('1 item mentioning a topic the owner asked to forget was removed');
    expect(out!.output).toContain('[budget: 3 tool rounds left]');
  });

  it('keeps a web page that mentions the topic, with the word removed and a note', () => {
    const [out] = barrier.turns([turn('web_search', 'Tea is popular. Prices rose.')]);
    expect(out!.output).toBe(`${FORGET_MARKER} is popular. Prices rose.\n[waldo: 1 passage mentioning a topic the owner asked to forget was removed; the rest is shown. Do not report the result as empty.]`);
  });


  it('classifies only the owner-memory reads as owner store', () => {
    expect(['read_memory', 'search_episodes'].map(resultOrigin)).toEqual(['owner_store', 'owner_store']);
    expect(['read_tool_output', 'web_search', 'get_communication', 'browse_page'].map(resultOrigin)).toEqual(['external', 'external', 'external', 'external']);
  });
});

describe('reads mode, the flag-off rule', () => {
  const barrier = forgetBarrier(['tea'], 'reads');

  it('withholds a whole read when a held string sits outside a list', () => {
    expect(barrier.structured({ data: { summary: 'tea on Mondays' } }, 'owner_store', tally())).toBeUndefined();
    expect(barrier.structured({ tea: 1 }, 'external', tally())).toBeUndefined();
  });

  it('drops list items in any read', () => {
    expect(barrier.structured({ messages: [{ s: 'tea' }, { s: 'x' }] }, 'external', tally())).toEqual({ messages: [{ s: 'x' }] });
  });

  it('withholds a page that cannot be cut by item, keeping the call in place so no function call goes unanswered', () => {
    const [out] = barrier.turns([turn('web_search', 'Tea is popular.')]);
    expect(out!.call.call_id).toBe('c-web_search');
    expect(out!.output).toBe(WITHHELD_OUTPUT);
    expect(barrier.text('Tea is popular.', tally())).toBeUndefined();
  });
});

// Vite replaces a literal import.meta.glob call at build time; this package carries no vite client types, hence the directive.
// @ts-expect-error vite-only API
const ownerTurnSources: Record<string, string> = import.meta.glob('../src/channels/owner-turn.ts', { query: '?raw', import: 'default', eager: true });
const ownerTurnSource = Object.values(ownerTurnSources)[0]!;

describe('one owner of the forget rules', () => {
  it('leaves the owner turn no forget matching of its own: every cut goes through the barrier module', () => {
    for (const name of ['carriesTopic', 'hidesTopic', 'holdsIn', 'literalTextPattern', 'HELD_TURN_OUTPUT']) expect(ownerTurnSource, name).not.toMatch(new RegExp(`\\b${name}\\b`));
    expect(ownerTurnSource.match(/applyForgetBarrier\(/g)).toHaveLength(1);
  });
});
