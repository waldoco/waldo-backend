import { describe, expect, it } from 'vitest';
import { healthSignalV1Schema, healthSourceV1Schema } from '../../contracts/src/app/health-ingest';

// Every reading kind and source the health contract declares must still be taken after the last migration: by the samples
// table's checks, by the ingest function's lists, and by the series read. A migration that re-creates one of these from an
// older copy silently drops whatever was added since, and no test of the new feature notices. This reads the newest
// definition of each from the migrations, as a database migrated from zero holds it; supabase/tests/waldo_health_contract_kinds.sql
// checks the same lists on the migrated database itself, and the last test here keeps its lists equal to the contract.

// Vite replaces a literal import.meta.glob call at build time; this package carries no vite client types, hence the directive.
// @ts-expect-error import.meta.glob is provided by vite at test time
const migrations: Record<string, string> = import.meta.glob('../../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true });
// @ts-expect-error import.meta.glob is provided by vite at test time
const pgtap: Record<string, string> = import.meta.glob('../../../supabase/tests/waldo_health_contract_kinds.sql', { query: '?raw', import: 'default', eager: true });
const ordered = Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b));

const quoted = (list: string): string[] => [...list.matchAll(/'([a-z_0-9]+)'/g)].map(match => match[1]!);

// The list in the newest `add constraint <name> check (<column> in (...))`.
const constraintList = (name: string): { file: string; values: string[] } => {
  const pattern = new RegExp(`add constraint ${name} check \\(\\w+ in \\(([^)]*)\\)\\)`, 'g');
  const found = ordered.flatMap(([file, sql]) => [...sql.matchAll(pattern)].map(match => ({ file, values: quoted(match[1]!) })));
  return found.at(-1) ?? { file: 'none', values: [] };
};

// The body of the newest migration that (re)defines waldo.<name>, cut at the end of that function.
const newestBody = (name: string): { file: string; body: string } => {
  const pattern = new RegExp(`create (or replace )?function waldo\\.${name}\\(`);
  const [file, sql] = ordered.filter(([, text]) => pattern.test(text)).at(-1) ?? ['none', ''];
  const start = sql.search(pattern), tag = /as (\$[a-z_]*\$)/.exec(sql.slice(start))?.[1] ?? '$$';
  const open = sql.indexOf(tag, start) + tag.length;
  return { file, body: sql.slice(start, sql.indexOf(tag, open)) };
};

const signals = [...healthSignalV1Schema.options];
const sources = [...healthSourceV1Schema.options];
const missing = (declared: readonly string[], accepted: readonly string[]) => declared.filter(kind => !accepted.includes(kind));

describe('every health kind and source in the contract is still accepted after the last migration', () => {
  it('reads a contract that has nutrition, so the guard covers the kind it was written for', () => {
    expect(signals).toContain('nutrition');
    expect(sources).toEqual(expect.arrayContaining(['apple', 'samsung', 'health_connect']));
  });

  it('keeps every signal in the samples table\'s check', () => {
    const { file, values } = constraintList('health_samples_signal_check');
    expect(missing(signals, values), file).toEqual([]);
  });

  it('keeps every source in the samples table\'s check', () => {
    const { file, values } = constraintList('health_samples_source_check');
    expect(missing(sources, values), file).toEqual([]);
  });

  it('keeps every signal and source in the newest health_ingest', () => {
    const { file, body } = newestBody('health_ingest');
    const known = quoted(/v_signals constant text\[\] := array\[([^\]]+)\]/.exec(body)?.[1] ?? '');
    const from = quoted(/v_source not in \(([^)]+)\)/.exec(body)?.[1] ?? '');
    expect(missing(signals, known), `${file} v_signals`).toEqual([]);
    expect(missing(sources, from), `${file} source list`).toEqual([]);
  });

  it('keeps every signal in the newest health_series_read', () => {
    const { file, body } = newestBody('health_series_read');
    const known = quoted(/v_all constant text\[\] := array\[([^\]]+)\]/.exec(body)?.[1] ?? '');
    expect(missing(signals, known), file).toEqual([]);
  });

  it('keeps the database-side pgTAP lists equal to the contract, so they cannot go stale when the contract grows', () => {
    const sql = Object.values(pgtap)[0] ?? '';
    const list = (name: string) => quoted(new RegExp(`${name} constant text\\[\\] := array\\[([^\\]]+)\\]`).exec(sql)?.[1] ?? '');
    expect(list('v_signals')).toEqual(signals);
    expect(list('v_sources')).toEqual(sources);
  });
});
