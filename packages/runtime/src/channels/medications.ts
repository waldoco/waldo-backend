import {
  listMedicationsArgsSchema, logMedicationArgsSchema, stopMedicationArgsSchema, TOOL_PERMISSIONS, trackMedicationArgsSchema, triggerTypeSchema,
  type ListMedicationsArgs, type LogMedicationArgs, type StopMedicationArgs, type ToolHandler, type ToolName, type TrackMedicationArgs,
} from '@waldo/contracts';
import { z } from 'zod';
import { nextOccurrence, type Scheduler } from '../scheduler/multiplexer';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { OwnerClock } from '../tools/live/get-context';
import { localIso, localToEpoch } from './reminders';

// The owner's medicines (ADR-0081 amendment of 1 November 2026). The list and the doses live on the health plane
// (waldo.health_medications_read / _write); this book holds no copy. Each daily time is a reminder on the scheduler whose id
// carries only the medicine's opaque id and the time, with the name-free note "Medication reminder". At fire time the book reads
// the medicine and composes the words itself from the stored label, the time and the count, never through a model, so a
// medicine reminder cannot carry advice about the medicine. A dose's status is what the owner said, or, once MISSED_AFTER_MS
// past with nothing said, missed; missed is never stored.
export const MEDICATION_REMINDER_PREFIX = 'reminder:med:';
export const MEDICATION_REMINDER_NOTE = 'Medication reminder';
export const MISSED_AFTER_MS = 6 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const LOG_REACH_MS = 12 * 60 * 60_000;

export type MedicationRpc = (operation: 'medications_read' | 'medications_write', payload: string) => Promise<unknown>;

const storedSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(80),
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(6),
  supply: z.int().min(0).nullable(),
  refill_at: z.int().min(1).nullable(),
  created_at: z.iso.datetime(),
  doses: z.array(z.object({ due_at: z.iso.datetime(), slot: z.string(), status: z.enum(['taken', 'skipped']) })),
});
type Stored = z.infer<typeof storedSchema>;
const listSchema = z.object({ medications: z.array(storedSchema) });
const stopSchema = z.object({ stopped: z.boolean() });

export type DoseStatus = 'taken' | 'skipped' | 'missed' | 'due' | 'upcoming';
export type Medication = Readonly<{
  id: string; name: string; times: readonly string[];
  // Times whose reminder is still set: the owner can cancel one as a reminder and keep the medicine tracked.
  reminders: readonly string[];
  today: readonly Readonly<{ at: string; status: DoseStatus }>[];
  last_7_days: Readonly<{ taken: number; skipped: number; missed: number }>;
  supply_left?: number; refill_due?: boolean;
}>;
export type MedicationFailure = Readonly<{ failed: 'not_found' | 'limit_reached' | 'unavailable' }>;
export type MedicationReminder = Readonly<{ state: 'text'; text: string } | { state: 'gone' } | { state: 'unavailable' }>;

const reminderId = (medicationId: string, time: string) => `${MEDICATION_REMINDER_PREFIX}${medicationId}:${time.replace(':', '')}`;
const failure = (answer: unknown): MedicationFailure => {
  const error = typeof answer === 'object' && answer !== null && 'error' in answer ? answer.error : null;
  return { failed: error === 'not_found' || error === 'limit_reached' ? error : 'unavailable' };
};
const refillDue = (med: Stored) => med.supply !== null && med.supply <= (med.refill_at ?? med.times.length * 7);

export const medicationBook = (sql: SqlStorage, scheduler: Scheduler, clock: OwnerClock, rpc: MedicationRpc) => {
  sql.exec('CREATE TABLE IF NOT EXISTS reminder_notes (id TEXT PRIMARY KEY, note TEXT NOT NULL, created_at INTEGER NOT NULL)');
  const read = async (): Promise<readonly Stored[] | null> => {
    const parsed = listSchema.safeParse(await rpc('medications_read', '{}'));
    return parsed.success ? parsed.data.medications : null;
  };
  const write = async (body: object): Promise<Stored | MedicationFailure> => {
    const answer = await rpc('medications_write', JSON.stringify(body));
    const parsed = storedSchema.safeParse(answer);
    return parsed.success ? parsed.data : failure(answer);
  };
  // Every scheduled dose of a medicine between two instants, in the owner's zone.
  const dosesBetween = (med: Stored, from: number, to: number): { at: number; slot: string }[] => {
    const out: { at: number; slot: string }[] = [];
    for (let day = from - DAY_MS; day <= to + DAY_MS; day += DAY_MS) {
      const date = localIso(day, clock.timezone).slice(0, 10);
      for (const slot of med.times) {
        const at = localToEpoch(`${date}T${slot}`, clock.timezone);
        if (at >= from && at <= to && !out.some(dose => dose.at === at)) out.push({ at, slot });
      }
    }
    return out.sort((a, b) => a.at - b.at);
  };
  const statusOf = (at: number, said: 'taken' | 'skipped' | undefined, now: number): DoseStatus =>
    said ?? (at > now ? 'upcoming' : now - at > MISSED_AFTER_MS ? 'missed' : 'due');
  // The owner object's SQLite refuses a LIKE pattern this long, so the prefix is compared directly.
  const scheduled = (medicationId: string) => {
    const prefix = `${MEDICATION_REMINDER_PREFIX}${medicationId}:`;
    return sql.exec<{ id: string }>('SELECT id FROM reminder_notes WHERE substr(id, 1, ?) = ?', prefix.length, prefix).toArray().map(row => row.id);
  };
  const unschedule = async (medicationId: string) => {
    for (const id of scheduled(medicationId)) {
      await scheduler.cancel(id);
      sql.exec('DELETE FROM reminder_notes WHERE id = ?', id);
    }
  };
  const view = (med: Stored): Medication => {
    const now = clock.now().getTime();
    const said = new Map(med.doses.map(dose => [Date.parse(dose.due_at), dose.status]));
    const created = Date.parse(med.created_at);
    const dayStart = localToEpoch(`${localIso(now, clock.timezone).slice(0, 10)}T00:00`, clock.timezone);
    // A dose from before tracking began counts only once the owner said something about it.
    const counted = ({ at }: { at: number }) => at >= created || said.has(at);
    const week = dosesBetween(med, now - 7 * DAY_MS, now).filter(counted).map(({ at }) => statusOf(at, said.get(at), now));
    return {
      id: med.id, name: med.name, times: med.times,
      reminders: med.times.filter(time => scheduler.read(reminderId(med.id, time)) !== null),
      today: dosesBetween(med, dayStart, dayStart + DAY_MS - 1).filter(counted).map(({ at }) => ({ at: localIso(at, clock.timezone), status: statusOf(at, said.get(at), now) })),
      last_7_days: { taken: week.filter(s => s === 'taken').length, skipped: week.filter(s => s === 'skipped').length, missed: week.filter(s => s === 'missed').length },
      ...(med.supply === null ? {} : { supply_left: med.supply, refill_due: refillDue(med) }),
    };
  };
  return {
    async track(args: TrackMedicationArgs): Promise<Medication | MedicationFailure> {
      const stored = await write({ op: 'track', ...args });
      if ('failed' in stored) return stored;
      await unschedule(stored.id);
      const now = clock.now().getTime();
      for (const time of stored.times) {
        const id = reminderId(stored.id, time);
        const recurrence = { type: 'daily_local' as const, time, timezone: clock.timezone };
        const first = nextOccurrence(recurrence, now);
        sql.exec('INSERT OR REPLACE INTO reminder_notes (id, note, created_at) VALUES (?, ?, ?)', id, MEDICATION_REMINDER_NOTE, now);
        await scheduler.schedule({ id, kind: 'reminder', payloadRefs: { reminder_id: id }, occurrenceAt: first, dueAt: first, recurrence });
      }
      return view(stored);
    },
    async log(args: LogMedicationArgs): Promise<Medication | MedicationFailure | Readonly<{ refused: string }>> {
      const med = (await read())?.find(item => item.id === args.medication_id);
      if (med === undefined) return { failed: 'not_found' };
      const target = args.at === undefined ? clock.now().getTime() : localToEpoch(args.at, clock.timezone);
      if (!Number.isFinite(target)) return { refused: `could not place ${args.at} on the timeline` };
      const dose = dosesBetween(med, target - LOG_REACH_MS, target + LOG_REACH_MS).sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target))[0];
      if (dose === undefined) return { refused: 'no dose of it is scheduled within 12 hours of that time' };
      const stored = await write({ op: 'dose', medication_id: med.id, slot: dose.slot, due_at: new Date(dose.at).toISOString().replace(/\.\d{3}Z$/, 'Z'), status: args.status });
      return 'failed' in stored ? stored : view(stored);
    },
    async list(): Promise<readonly Medication[] | null> {
      const meds = await read();
      return meds === null ? null : meds.map(view);
    },
    async stop(medicationId: string): Promise<boolean | null> {
      const parsed = stopSchema.safeParse(await rpc('medications_write', JSON.stringify({ op: 'stop', medication_id: medicationId })));
      if (!parsed.success) return null;
      await unschedule(medicationId);
      return parsed.data.stopped;
    },
    owns: (entryId: string) => entryId.startsWith(MEDICATION_REMINDER_PREFIX),
    // The words for one of this book's reminders, from a fresh read. A medicine that is gone has its reminders removed.
    async reminder(entryId: string): Promise<MedicationReminder> {
      const [medicationId = '', hhmm = ''] = entryId.slice(MEDICATION_REMINDER_PREFIX.length).split(':');
      const meds = await read();
      if (meds === null) return { state: 'unavailable' };
      const med = meds.find(item => item.id === medicationId);
      const time = `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
      if (med === undefined || !med.times.includes(time)) {
        if (med === undefined) await unschedule(medicationId);
        else { await scheduler.cancel(entryId); sql.exec('DELETE FROM reminder_notes WHERE id = ?', entryId); }
        return { state: 'gone' };
      }
      const reorder = !refillDue(med) ? ''
        : med.supply === 0 ? ' By my count you have none left, so it\'s time to reorder.' : ` By my count ${med.supply} are left, so it's time to reorder.`;
      return { state: 'text', text: `Time for your ${med.name} (${time}). Reply "taken" when you've had it, or "skip".${reorder}` };
    },
  };
};
export type MedicationBook = ReturnType<typeof medicationBook>;

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const failed = (outcome: MedicationFailure) => outcome.failed === 'not_found'
  ? { ok: false as const, code: 'invalid_args' as const, error: 'no tracked medicine has that id; call list_medications' }
  : outcome.failed === 'limit_reached'
    ? { ok: false as const, code: 'invalid_args' as const, error: 'the owner already tracks 20 medicines; stop one first' }
    : { ok: false as const, code: 'transient' as const, error: 'the medicine list could not be reached, so nothing was saved' };

export const medicationHandlers = (book: MedicationBook) => [
  {
    name: 'track_medication',
    description: 'Track a medicine the owner takes: its daily reminder times and, when they say, how many they have so you remind them to reorder. Pass medication_id to change one. Keep the name exactly as they say it. Never record, suggest or change a dose: the reminder names the medicine and the time only, and how much to take is their doctor or pharmacist\'s call.',
    schema: trackMedicationArgsSchema,
    trigger_allowlist: allowlist('track_medication'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args) {
      const outcome = await book.track(args);
      return 'failed' in outcome ? failed(outcome) : { ok: true, data: outcome, source_taint: null };
    },
  } satisfies ToolHandler<TrackMedicationArgs, Medication, ToolDispatcherContext>,
  {
    name: 'log_medication',
    description: 'Record that the owner took or skipped a dose when they tell you ("taken", "skipped my evening one"). It goes on the scheduled dose nearest the time.',
    schema: logMedicationArgsSchema,
    trigger_allowlist: allowlist('log_medication'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args) {
      const outcome = await book.log(args);
      if ('refused' in outcome) return { ok: false, code: 'invalid_args', error: outcome.refused };
      return 'failed' in outcome ? failed(outcome) : { ok: true, data: outcome, source_taint: null };
    },
  } satisfies ToolHandler<LogMedicationArgs, Medication, ToolDispatcherContext>,
  {
    name: 'list_medications',
    description: "The owner's tracked medicines: reminder times, today's doses (taken, skipped, missed, due or upcoming), the last 7 days, and how many are left.",
    schema: listMedicationsArgsSchema,
    trigger_allowlist: allowlist('list_medications'),
    autonomy_gated: false,
    async handle() {
      const medications = await book.list();
      return medications === null ? failed({ failed: 'unavailable' }) : { ok: true, data: { medications }, source_taint: null };
    },
  } satisfies ToolHandler<ListMedicationsArgs, { medications: readonly Medication[] }, ToolDispatcherContext>,
  {
    name: 'stop_medication',
    description: 'Stop tracking a medicine when the owner asks: its reminders and its dose record are deleted.',
    schema: stopMedicationArgsSchema,
    trigger_allowlist: allowlist('stop_medication'),
    autonomy_gated: false,
    mutates_state: true,
    async handle({ medication_id }) {
      const stopped = await book.stop(medication_id);
      return stopped === null ? failed({ failed: 'unavailable' }) : { ok: true, data: { medication_id, stopped }, source_taint: null };
    },
  } satisfies ToolHandler<StopMedicationArgs, { medication_id: string; stopped: boolean }, ToolDispatcherContext>,
];
