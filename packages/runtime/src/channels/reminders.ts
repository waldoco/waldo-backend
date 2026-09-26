import {
  cancelReminderArgsSchema, listRemindersArgsSchema, setReminderArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type CancelReminderArgs, type ListRemindersArgs, type ScheduleEntry, type SetReminderArgs, type ToolHandler, type ToolName,
} from '@waldo/contracts';
import type { Scheduler } from '../scheduler/multiplexer';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { OwnerClock } from '../tools/live/get-context';

type Reminder = Readonly<{ id: string; note: string; at: string; repeat: 'none' | 'daily' }>;

export type ReminderBook = Readonly<{
  set(args: SetReminderArgs): Promise<Reminder>;
  list(): readonly Reminder[];
  cancel(id: string): Promise<boolean>;
  note(id: string): string | null;
  fired(entry: ScheduleEntry): void;
}>;

// Owner reminders ride the DO scheduler (kind 'reminder'); the note text lives beside it
// because schedule payloads carry refs only.
export const reminderBook = (sql: SqlStorage, scheduler: Scheduler, clock: OwnerClock, newId: () => string): ReminderBook => {
  sql.exec('CREATE TABLE IF NOT EXISTS reminder_notes (id TEXT PRIMARY KEY, note TEXT NOT NULL, created_at INTEGER NOT NULL)');
  const local = (at: number) => localIso(at, clock.timezone);
  const toReminder = (row: { id: string; note: string; due_at: number; recurrence_json: string | null }): Reminder =>
    ({ id: row.id, note: row.note, at: local(row.due_at), repeat: row.recurrence_json === null ? 'none' : 'daily' });
  return {
    async set({ note, at, repeat }) {
      const now = clock.now().getTime();
      const due = localToEpoch(at, clock.timezone);
      if (repeat === 'none' && due <= now) throw new Error(`${at} is already past in ${clock.timezone}`);
      const id = `reminder:${newId()}`;
      sql.exec('INSERT INTO reminder_notes (id, note, created_at) VALUES (?, ?, ?)', id, note, now);
      const entry = await scheduler.schedule({
        id, kind: 'reminder', payloadRefs: { reminder_id: id },
        ...(repeat === 'daily'
          ? { occurrenceAt: nextAfter(due, now), dueAt: nextAfter(due, now), recurrence: { type: 'daily_local' as const, time: at.slice(11), timezone: clock.timezone } }
          : { occurrenceAt: due, dueAt: due }),
      });
      return { id, note, at: local(entry.due_at), repeat };
    },
    list() {
      return sql.exec<{ id: string; note: string; due_at: number; recurrence_json: string | null }>(
        "SELECT s.id, n.note, s.due_at, s.recurrence_json FROM schedule s JOIN reminder_notes n ON n.id = s.id WHERE s.kind = 'reminder' ORDER BY s.due_at",
      ).toArray().map(toReminder);
    },
    async cancel(id) {
      const known = scheduler.read(id)?.kind === 'reminder';
      if (known) await scheduler.cancel(id);
      sql.exec('DELETE FROM reminder_notes WHERE id = ?', id);
      return known;
    },
    note(id) {
      return sql.exec<{ note: string }>('SELECT note FROM reminder_notes WHERE id = ?', id).toArray()[0]?.note ?? null;
    },
    fired(entry) {
      if (entry.recurrence === null) sql.exec('DELETE FROM reminder_notes WHERE id = ?', entry.id);
    },
  };
};

const DAY_MS = 24 * 60 * 60_000;
export const nextAfter = (due: number, now: number) => (due > now ? due : due + Math.ceil((now - due + 1) / DAY_MS) * DAY_MS);

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

export const reminderHandlers = (book: ReminderBook) => [
  {
    name: 'set_reminder',
    description: "Set a reminder or daily routine for the owner. It fires at that local time and you message them then. Use get_context first if you need today's date.",
    schema: setReminderArgsSchema,
    trigger_allowlist: allowlist('set_reminder'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args) {
      try {
        return { ok: true, data: await book.set(args), source_taint: null };
      } catch (error) {
        return { ok: false, code: 'invalid_args', error: error instanceof Error ? error.message : String(error) };
      }
    },
  } satisfies ToolHandler<SetReminderArgs, Reminder, ToolDispatcherContext>,
  {
    name: 'list_reminders',
    description: "The owner's pending reminders and routines, soonest first.",
    schema: listRemindersArgsSchema,
    trigger_allowlist: allowlist('list_reminders'),
    autonomy_gated: false,
    async handle() {
      return { ok: true, data: { reminders: book.list() }, source_taint: null };
    },
  } satisfies ToolHandler<ListRemindersArgs, { reminders: readonly Reminder[] }, ToolDispatcherContext>,
  {
    name: 'cancel_reminder',
    description: 'Cancel a pending reminder or routine by id.',
    schema: cancelReminderArgsSchema,
    trigger_allowlist: allowlist('cancel_reminder'),
    autonomy_gated: false,
    mutates_state: true,
    async handle({ id }) {
      return { ok: true, data: { id, cancelled: await book.cancel(id) }, source_taint: null };
    },
  } satisfies ToolHandler<CancelReminderArgs, { id: string; cancelled: boolean }, ToolDispatcherContext>,
];

export function localIso(at: number, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function localToEpoch(local: string, timezone: string): number {
  const [date, time] = local.split('T') as [string, string];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, min] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, h, min);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const shown = localIso(guess, timezone);
    const [sd, st] = shown.split('T') as [string, string];
    const [sy, sm, sdd] = sd.split('-').map(Number) as [number, number, number];
    const [sh, smin] = st.split(':').map(Number) as [number, number];
    const drift = Date.UTC(sy, sm - 1, sdd, sh, smin) - wall;
    if (drift === 0) return guess;
    guess -= drift;
  }
  return guess;
}
