// The database's closed lists of health names, each read from the newest migration that defines it, so a test compares the
// list the database will actually run with the one the code uses.

// Vite replaces a literal import.meta.glob call at build time; this package carries no vite client types, hence the directive.
// @ts-expect-error import.meta.glob is provided by vite at test time
const migrations: Record<string, string> = import.meta.glob('../../../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true });

// The newest migration whose text matches `defines`, and its text from that match on.
export const newestDefinition = (defines: RegExp): Readonly<{ file: string; text: string }> => {
  const [file, sql] = Object.entries(migrations).filter(([, text]) => defines.test(text)).sort(([a], [b]) => a.localeCompare(b)).at(-1) ?? ['', ''];
  const at = sql.search(defines);
  return { file: file.slice(file.lastIndexOf('/') + 1), text: at < 0 ? '' : sql.slice(at) };
};

export const quotedNames = (list: string): string[] => [...list.matchAll(/'([a-z_0-9]+)'/g)].map(match => match[1]!);

const writer = newestDefinition(/create or replace function waldo\.health_context_write\(/);
// The names a pillar's used.signals may hold.
export const WRITER_USED_SIGNALS = Object.assign(quotedNames(/\(s #>> '\{\}'\) not in \(([^)]+)\)/.exec(writer.text)?.[1] ?? ''), { file: writer.file });

const sampleCheck = newestDefinition(/add constraint health_samples_signal_check check \(signal in \(/);
// The kinds health_samples may hold.
export const SAMPLE_CHECK_SIGNALS = Object.assign(quotedNames(/check \(signal in \(([^)]+)\)\)/.exec(sampleCheck.text)?.[1] ?? ''), { file: sampleCheck.file });

const ingest = newestDefinition(/create or replace function waldo\.health_ingest\(/);
const ingestBody = ingest.text.slice(0, ingest.text.indexOf('end $$;'));
// The kinds the ingest accepts, and each one's unit and whether it is a one-hour window, from its bounds table.
export const INGEST_SIGNALS = Object.assign(quotedNames(/v_signals constant text\[\] := array\[([^\]]+)\]/.exec(ingestBody)?.[1] ?? ''), { file: ingest.file });
export const INGEST_UNITS: ReadonlyMap<string, Readonly<{ unit: string; windowed: boolean }>> = new Map(
  [...ingestBody.matchAll(/\('([a-z_0-9]+)','([a-z_]+)',[-0-9.]+,[-0-9.]+,(true|false)\)/g)].map(([, signal, unit, windowed]) => [signal!, { unit: unit!, windowed: windowed === 'true' }]),
);

const seriesRead = newestDefinition(/create or replace function waldo\.health_series_read\(/);
// The kinds the series read returns.
export const SERIES_READ_SIGNALS = Object.assign(quotedNames(/v_all constant text\[\] := array\[([^\]]+)\]/.exec(seriesRead.text)?.[1] ?? ''), { file: seriesRead.file });

// The names the owner's usual may carry, in each function that checks a stored row's parts and usual bands.
const usualList = (fn: string) => {
  const found = newestDefinition(new RegExp(`create (?:or replace )?function waldo\\.${fn}\\(`));
  const body = found.text.slice(0, found.text.indexOf('end $$;'));
  return Object.assign(quotedNames(/v_signals constant text\[\] := array\[([^\]]+)\]/.exec(body)?.[1] ?? ''), { file: found.file });
};
export const PARTS_USUAL_SIGNALS = usualList('health_parts_valid');
export const USUAL_BAND_SIGNALS = usualList('health_usual_valid');
