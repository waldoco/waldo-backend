import { expect, it } from 'vitest';
import { HELD_ROW_TABLES, heldRowShapes } from '../src/memory/held-rows';

// Plain in-memory fake of the one SQL surface heldRowShapes uses, so the test needs no Durable Object.
type Row = Record<string, string | number | null>;
const fakeSql = (table: string, columns: string[], rows: Row[]) => ({
  exec: (query: string, ...bindings: unknown[]) => ({
    toArray: () => {
      if (query.startsWith('SELECT 1 FROM sqlite_master')) return bindings[0] === table ? [{ 1: 1 }] : [];
      if (query.startsWith('SELECT name FROM pragma_table_info')) return columns.includes(String(bindings[1])) ? [{ name: bindings[1] }] : [];
      return rows.map((row, index) => ({ rid: index + 1, ...row }));
    },
  }),
}) as never;

it('HELDROWS reports shape only: lengths, JSON validity, escape classes and topic hits, never the row text', () => {
  const secret = 'SECRETNOTE contact Priya';
  const topic = 'SYNTHTOPIC';
  const rows: Row[] = [
    { changes: JSON.stringify([{ note: `Meeting moved \u2013 ${secret}` }]).replace('\u2013', '\\u2013'), text: 'plain card' },
    { changes: '[{"note":"clean"}]', text: 'clean' },
    { changes: JSON.stringify([{ [topic]: 'x' }]), text: null },
    { changes: '{"bad": \\q', text: 'a\0b' },
  ];
  const out = heldRowShapes(fakeSql('update_cards', ['changes', 'text'], rows), 'update_cards', [topic], 25);
  expect(out).toContain('update_cards: 4 rows, 3 flagged');
  expect(out).toContain('#1 changes len=');
  expect(out).toMatch(/#1 changes .*json=ok .*esc\[u=1 /);
  expect(out).toMatch(/#3 changes .*t1\[raw=1 val=0 key=1\]/);
  expect(out).toMatch(/#4 changes .*json=bad/);
  expect(out).toMatch(/#4 .*\| text .*nul=1/);
  expect(out).not.toContain('#2');
  for (const leak of [secret, 'Priya', 'Meeting moved', topic]) expect(out).not.toContain(leak);
});

it('HELDROWS refuses a table outside the allowlist and does not interpolate it', () => {
  const out = heldRowShapes(fakeSql('x', [], []), 'sqlite_master; DROP TABLE claims', [], 25);
  expect(out).toMatch(/^Usage: \/heldrows </);
  expect(Object.keys(HELD_ROW_TABLES)).toContain('update_cards');
});

it('HELDROWS caps the printed rows but still counts every flagged row', () => {
  const rows: Row[] = Array.from({ length: 30 }, () => ({ reason: 'a \\u2013 b' }));
  const out = heldRowShapes(fakeSql('day_plan', ['reason'], rows), 'day_plan', [], 25);
  expect(out.split('\n')).toHaveLength(1 + 25);
  expect(out).toContain('30 flagged');
});
