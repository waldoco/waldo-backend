import { SignInRequired } from './model';

// What Waldo saw change today and did not bring to you: times, the kind of change, a calendar title, a mail's sender and
// subject. A field Waldo withheld (it carried a health value) comes as null. The reader keeps only these fields and refuses any
// other shape.
export const HELD_CHANGES_URL = '/console/dashboard/api/v1/held-changes';

type Times = { start: string | null; end: string | null; all_day: boolean };
export type HeldChange =
  | ({ source: 'calendar'; at: string; kind: 'added' | 'changed' | 'cancelled'; title: string | null; before?: { start: string; end: string; all_day: boolean } } & Times)
  | { source: 'mail'; at: string; kind: 'new'; from: string | null; subject: string | null };

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const maybe = (v: unknown): v is string | null => v === null || str(v);
const instant = (v: unknown): v is string => str(v) && Number.isFinite(Date.parse(v));
const unsupported = () => new Error('Held changes came in an unsupported shape. Nothing was assumed.');

export function readHeldChanges(value: unknown): HeldChange[] {
  if (!obj(value) || value.version !== 1 || !Array.isArray(value.changes)) throw unsupported();
  return value.changes.map((row): HeldChange => {
    if (!obj(row) || !instant(row.at)) throw unsupported();
    if (row.source === 'mail' && row.kind === 'new' && maybe(row.from) && maybe(row.subject)) return { source: 'mail', at: row.at, kind: 'new', from: row.from, subject: row.subject };
    const before = row.before;
    if (row.source !== 'calendar' || !['added', 'changed', 'cancelled'].includes(row.kind as string) || !maybe(row.title) || !maybe(row.start) || !maybe(row.end) || typeof row.all_day !== 'boolean'
      || before !== undefined && !(obj(before) && str(before.start) && str(before.end) && typeof before.all_day === 'boolean')) throw unsupported();
    return { source: 'calendar', at: row.at, kind: row.kind as 'added' | 'changed' | 'cancelled', title: row.title, start: row.start, end: row.end, all_day: row.all_day,
      ...(before ? { before: { start: before.start as string, end: before.end as string, all_day: before.all_day as boolean } } : {}) };
  });
}

export async function fetchHeldChanges(signal?: AbortSignal): Promise<HeldChange[]> {
  const response = await fetch(HELD_CHANGES_URL, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, signal });
  if (response.status === 401) throw new SignInRequired();
  if (!response.ok) throw new Error('Couldn’t read today’s held changes.');
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error('Couldn’t read today’s held changes.'); }
  return readHeldChanges(value);
}
