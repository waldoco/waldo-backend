import { describe, expect, it } from 'vitest';
import { HELD_TURN_OUTPUT, narrowHeldJson, withholdHeldTurns } from '../src/conversation/held-turns';

const turn = (id: string, name: string, output: string, prior?: Record<string, unknown>[]) => ({ call: { call_id: id, name, arguments: '{}' }, output, ...(prior ? { prior_items: prior } : {}) });

describe('withholdHeldTurns', () => {
  it('keeps every call and replaces only the held output with a receipt', () => {
    const prior = [{ type: 'function_call', call_id: 'c1', name: 'get_communication', arguments: '{}' }];
    const turns = [turn('c1', 'get_communication', '{"messages":["my coffee order"]}', prior), turn('c2', 'get_tasks', '{"tasks":[]}')];
    const out = withholdHeldTurns(turns, (text) => text.includes('coffee'));
    expect(out.map((t) => t.call.call_id)).toEqual(['c1', 'c2']);
    expect(out[0]!.output).toBe(HELD_TURN_OUTPUT);
    expect(out[0]!.prior_items).toEqual(prior);
    expect(out[1]!.output).toBe('{"tasks":[]}');
  });

  it('never withholds the forget_memory receipt itself', () => {
    const turns = [turn('c1', 'forget_memory', 'forgot coffee')];
    expect(withholdHeldTurns(turns, () => true)).toEqual(turns);
  });

  it('a page with one held item keeps the other items and says one was withheld', () => {
    const output = JSON.stringify({ ok: true, data: { messages: [{ id: 'a', subject: 'my coffee order' }, { id: 'b', subject: 'standup' }] } }) + '\n[budget: 3 tool rounds left]';
    const drop = (value: unknown, tally: { dropped: number }): unknown => {
      const data = (value as { data: { messages: { subject: string }[] } });
      const kept = data.data.messages.filter((m) => !m.subject.includes('coffee'));
      tally.dropped += data.data.messages.length - kept.length;
      return { ...(value as object), data: { messages: kept } };
    };
    const out = withholdHeldTurns([turn('c1', 'get_communication', output)], (text) => text.includes('coffee'), (text) => narrowHeldJson(text, drop));
    expect(out[0]!.output).toContain('standup');
    expect(out[0]!.output).not.toContain('coffee order');
    expect(out[0]!.output).toContain('1 item mentioning a topic the owner asked to forget was withheld');
    expect(out[0]!.output).toContain('[budget: 3 tool rounds left]');
  });

  it('falls back to the receipt when the output cannot be narrowed', () => {
    const out = withholdHeldTurns([turn('c1', 'web_search', 'plain text about coffee')], (text) => text.includes('coffee'), (text) => narrowHeldJson(text, () => undefined));
    expect(out[0]!.output).toBe(HELD_TURN_OUTPUT);
  });
});
