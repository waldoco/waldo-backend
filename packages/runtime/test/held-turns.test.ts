import { describe, expect, it } from 'vitest';
import { HELD_TURN_OUTPUT, withholdHeldTurns } from '../src/conversation/held-turns';

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
});
