import { describe, expect, it } from 'vitest';
import { EXTERNAL_ORIGIN_TOOLS } from '@waldo/contracts';
import { HELD_TOPIC_MARKER, HELD_TOPIC_REDACTED_NOTE, HELD_TURN_OUTPUT, PUBLIC_WEB_TOOLS, narrowHeldJson, withholdHeldTurns } from '../src/conversation/held-turns';
import { carriesTopic, hidesTopic, redactTopics } from '../src/memory/forget-guard';

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

// The same detector and redactor owner-turn wires in, over synthetic topics.
const guard = (topics: readonly string[]) => ({
  holds: (text: string) => topics.some(topic => carriesTopic(text, topic) || hidesTopic(text, topic)),
  redact: (text: string) => redactTopics(text, topics, HELD_TOPIC_MARKER),
});
const page = JSON.stringify({ ok: true, data: { url: 'https://shop.example/search?q=lamp', text: 'Results: Zebra-Topic lamp 1,299. Walnut desk 4,999. A zebra-topic rug 799.' } }) + '\n[budget: 3 tool rounds left]';

describe('a held topic in public web output', () => {
  it('is cut from a public page; the rest of the page, its notes and a typed note come back', () => {
    const { holds, redact } = guard(['zebra-topic']);
    const [out] = withholdHeldTurns([turn('c1', 'browse_page', page)], holds, undefined, redact);
    expect(out!.output).not.toMatch(/zebra-topic/i);
    expect(out!.output).toContain(`${HELD_TOPIC_MARKER} lamp 1,299. Walnut desk 4,999. A ${HELD_TOPIC_MARKER} rug 799.`);
    expect(out!.output).toContain('[budget: 3 tool rounds left]');
    expect(out!.output.endsWith(`\n${HELD_TOPIC_REDACTED_NOTE}`)).toBe(true);
    expect(holds(out!.output)).toBe(false);
  });

  it('cuts an escaped spelling of the topic too', () => {
    const { holds, redact } = guard(['zebra-topic']);
    const search = '{"ok":true,"data":{"hits":[{"title":"Z\\u0065bra-topic lamp","snippet":"walnut desk in stock"}]}}';
    expect(carriesTopic(search, 'zebra-topic')).toBe(false);
    expect(holds(search)).toBe(true);
    const [out] = withholdHeldTurns([turn('c1', 'web_search', search)], holds, undefined, redact);
    expect(out!.output.startsWith(`{"ok":true,"data":{"hits":[{"title":"${HELD_TOPIC_MARKER} lamp","snippet":"walnut desk in stock"}]}}`)).toBe(true);
    expect(holds(out!.output)).toBe(false);
  });

  it('cuts a topic spread across a JSON simple escape', () => {
    const { holds, redact } = guard(['zebra\ttopic']);
    const [out] = withholdHeldTurns([turn('c1', 'browse_act', JSON.stringify({ ok: true, data: { text: 'see ZEBRA\tTOPIC here' } }))], holds, undefined, redact);
    expect(out!.output).toContain(`see ${HELD_TOPIC_MARKER} here`);
    expect(holds(out!.output)).toBe(false);
  });

  it('owner-origin output with the topic is still withheld whole', () => {
    const { holds, redact } = guard(['zebra-topic']);
    for (const name of ['get_communication', 'search_communication', 'read_thread', 'read_drive', 'query_calendar', 'search_contacts', 'read_memory', 'search_episodes', 'workspace_read'])
      expect(withholdHeldTurns([turn('c1', name, page)], holds, undefined, redact)[0]!.output).toBe(HELD_TURN_OUTPUT);
  });

  it('a tool missing from the public table is withheld whole, however external it is', () => {
    const { holds, redact } = guard(['zebra-topic']);
    for (const name of ['delegate_task', 'read_tool_output', 'call_mcp_tool', 'read_mcp_tool', 'read_document', 'a_tool_added_later'])
      expect(withholdHeldTurns([turn('c1', name, page)], holds, undefined, redact)[0]!.output).toBe(HELD_TURN_OUTPUT);
  });

  it('fails closed to whole withholding when the detector still holds after the cut', () => {
    // An identity escape is held whatever it spells; nothing is cut, so the detector still holds.
    const escape = guard(['zebra-topic']);
    const escaped = '{"ok":true,"data":{"text":"zebra\\-topic sale"}}';
    expect(escape.holds(escaped)).toBe(true);
    expect(escape.redact(escaped)).toBe(escaped);
    expect(withholdHeldTurns([turn('c1', 'browse_page', escaped)], escape.holds, undefined, escape.redact)[0]!.output).toBe(HELD_TURN_OUTPUT);
    // A final sigma folds by context in the detector and per character in the redactor, so the cut misses it.
    const sigma = guard(['ΟΔΟΣ']);
    const greek = JSON.stringify({ ok: true, data: { text: 'ΟΔΟΣ map and walnut desk' } });
    expect(sigma.redact(greek)).toBe(greek);
    expect(withholdHeldTurns([turn('c1', 'browse_page', greek)], sigma.holds, undefined, sigma.redact)[0]!.output).toBe(HELD_TURN_OUTPUT);
    // A held topic that the marker or note itself spells holds again after the cut.
    const word = guard(['forget']);
    const forgetPage = JSON.stringify({ ok: true, data: { text: 'forget-me-not seeds' } });
    expect(withholdHeldTurns([turn('c1', 'browse_page', forgetPage)], word.holds, undefined, word.redact)[0]!.output).toBe(HELD_TURN_OUTPUT);
  });

  it('the public table holds only public web reads', () => {
    expect([...PUBLIC_WEB_TOOLS].sort()).toEqual(['browse_act', 'browse_page', 'web_search']);
    for (const name of PUBLIC_WEB_TOOLS) expect(EXTERNAL_ORIGIN_TOOLS).toContain(name);
  });
});

describe('redactTopics', () => {
  it('merges adjacent and overlapping hits into one marker and folds case', () => {
    expect(redactTopics('aa ZEBRA-TOPICzebra-topic bb', ['zebra-topic'], '[x]')).toBe('aa [x] bb');
    expect(redactTopics('one two three', ['ONE TWO', 'two three'], '[x]')).toBe('[x]');
  });

  it('cuts the whole escape when the topic names its literal text, not just its decoded form', () => {
    expect(redactTopics('see \\u0041 here', ['u0041'], '[x]')).toBe('see [x] here');
  });

  it('leaves text without the topic, and an empty topic, untouched', () => {
    expect(redactTopics('walnut desk \\u00e9 "q"', ['zebra-topic', ''], '[x]')).toBe('walnut desk \\u00e9 "q"');
  });
});
