import { z } from 'zod';
import { numericHealthIn } from '../scribe/sanitiser';
import { localIso } from './reminders';
import type { Change } from './update-cards';

// The console Today view's held changes: what the update sweep recorded on the owner's day that never reached them, newest
// first. A console read, not an app contract. Every field is picked by name: times, the change kind, a calendar title, a mail's
// sender and subject; never a snippet, description, location or attendee. A field that carries a health value is withheld
// whole, as a machine brief drops one.
export const DASHBOARD_HELD_CHANGES_PATH = '/console/dashboard/api/v1/held-changes';
export const HELD_CHANGES_LIMIT = 50;

const text = z.string().max(1024).nullable();
const when = z.string().max(64);
const times = { start: when, end: when, all_day: z.boolean() };
const at = z.iso.datetime({ offset: true });
export const heldChangesSchema = z.strictObject({
  version: z.literal(1), as_of: at, timezone: z.string().min(1).max(64), day: z.iso.date(),
  changes: z.array(z.discriminatedUnion('source', [
    z.strictObject({ source: z.literal('calendar'), at, kind: z.enum(['added', 'changed', 'cancelled']), title: text,
      ...times, start: when.nullable(), end: when.nullable(), before: z.strictObject(times).optional() }),
    z.strictObject({ source: z.literal('mail'), at, kind: z.literal('new'), from: text, subject: text }),
  ])).max(HELD_CHANGES_LIMIT),
});
export type HeldChanges = z.infer<typeof heldChangesSchema>;

const kept = (value: unknown): string | null => typeof value === 'string' && value && !numericHealthIn(value) ? value.slice(0, 1024) : null;
const shown = (value: unknown): string | null => typeof value === 'string' && value ? value.slice(0, 64) : null;

const heldChange = (change: Change, recordedAt: string): HeldChanges['changes'][number] | null => {
  let detail: Record<string, unknown>;
  try { detail = JSON.parse(change.detail) as Record<string, unknown>; } catch { return null; }
  if (change.source === 'mail') return { source: 'mail', at: recordedAt, kind: 'new', from: kept(detail.from), subject: kept(detail.subject) };
  if (change.kind === 'new') return null;
  const before = change.before ? { start: change.before.start, end: change.before.end, all_day: change.before.all_day } : undefined;
  return { source: 'calendar', at: recordedAt, kind: change.kind, title: kept(detail.title), start: shown(detail.start), end: shown(detail.end),
    all_day: detail.all_day === true, ...(before ? { before } : {}) };
};

// Parsed before it is returned: a field added to a change later never reaches the console by accident.
export const readHeldChanges = (sql: Pick<SqlStorage, 'exec'>, now: number, timezone: string): HeldChanges => {
  const day = localIso(now, timezone).slice(0, 10);
  const recorded = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'update_cards'").toArray().length > 0;
  const rows = !recorded ? [] : sql.exec<{ at: number; changes: string }>(
    "SELECT at, changes FROM update_cards WHERE day = ? AND pushed = 0 AND changes != '[]' ORDER BY at DESC, id DESC LIMIT ?", day, HELD_CHANGES_LIMIT).toArray();
  const changes = rows.flatMap(row => (JSON.parse(row.changes) as Change[]).map(change => heldChange(change, new Date(row.at).toISOString())))
    .filter(change => change !== null).slice(0, HELD_CHANGES_LIMIT);
  return heldChangesSchema.parse({ version: 1, as_of: new Date(now).toISOString(), timezone, day, changes });
};
