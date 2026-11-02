import type { Scheduler } from '../scheduler/multiplexer';
import { localIso } from '../channels/reminders';
import { produceHealthScores, statedNeedOf, type ProducerDeps, type ProducerOutcome } from './producer';
import { detectHealthWakes, healthSnapshot, type HealthSnapshot, type HealthWakeReason } from './wakes';

// The owner's derived rows are recomputed in the owner's own object, one recompute at a time. Every upload that changed a
// reading, every wearable sync, and every calendar change on the owner's today asks for one; the asks inside one window
// are one recompute, which reads the month once and writes through the database's read fence. The entry is
// infrastructure work: no model turn and no message, so it is not held by quiet hours or an unconfirmed zone. Only the
// health trigger it may arm decides whether to speak, and that keeps its own holds.
export const HEALTH_RECOMPUTE_ID = 'health-recompute';
// Long enough to take one sync's run of upload batches, short enough that a change reaches the trigger within a minute.
export const HEALTH_RECOMPUTE_WINDOW_MS = 60_000;

export type HealthRecomputeDeps = Readonly<{
  scheduler: Pick<Scheduler, 'lookup' | 'schedule'>;
  now(): number;
  // The owner's own zone, read when the recompute runs. It names the owner's local today, whichever zone a reading came from.
  ownerZone(): string;
  producer: ProducerDeps;
  // Drops the cached calendar demand for one local day, so the next recompute reads that day's busy minutes again.
  forgetDemand?(day: string): void;
  // After a run that wrote rows, the stored rows are read back and compared with the newest row before the run, so a wake
  // beyond a zone change reaches the trigger. The read is the model-use consented one: with that consent withdrawn it
  // returns nothing and nothing wakes. It is skipped while the owner has health proposals off.
  wakes?: Readonly<{
    enabled(): boolean;
    readContext(): Promise<unknown>;
    woken(day: string, reasons: readonly HealthWakeReason[]): Promise<void>;
  }>;
}>;

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);

const read = async (readContext: () => Promise<unknown>): Promise<HealthSnapshot | null> => healthSnapshot(await readContext());

export const healthRecompute = (deps: HealthRecomputeDeps) => {
  // A wake that cannot be read or noted never fails the recompute: a retry would only run the producer again.
  const wake = async (wakes: NonNullable<HealthRecomputeDeps['wakes']>, before: HealthSnapshot | null, today: string): Promise<void> => {
    try {
      const after = await read(wakes.readContext);
      if (!after || after.day !== today) return;
      const { readSettings } = deps.producer;
      const stated = readSettings ? statedNeedOf(await readSettings().catch(() => null)) : null;
      const needChangedAt = readSettings ? stated?.changedAt ?? (stated ? null : 'unknown') : null;
      const reasons = await detectHealthWakes({ before, after, today, readDebt: async day => deps.producer.readScores?.(day), needChangedAt });
      if (reasons.length) await wakes.woken(today, reasons);
    } catch { console.error('health wake check failed'); }
  };
  const ask = async (): Promise<void> => {
    const now = deps.now(), found = deps.scheduler.lookup(HEALTH_RECOMPUTE_ID);
    // One already waiting takes this upload too. One that is due or running may have read before this batch committed, and
    // a paused one is retried by new readings, so each of those is armed for a fresh window. A row this Worker cannot read
    // is left as the Worker that wrote it set it.
    if (found.state === 'unreadable' || (found.state === 'entry' && found.entry.status === 'armed' && found.entry.due_at > now)) return;
    const at = now + HEALTH_RECOMPUTE_WINDOW_MS;
    await deps.scheduler.schedule({ id: HEALTH_RECOMPUTE_ID, kind: 'provider_sync', occurrenceAt: at, dueAt: at, payloadRefs: { id: HEALTH_RECOMPUTE_ID } });
  };
  return {
    ask,
    // A calendar change on the owner's today can move Weight. It asks only when the owner's shared health already holds a
    // row for today, read under the storage consent the recompute writes under: an owner who never shared or withdrew costs
    // nothing, and no row is begun from the calendar alone. Today's busy minutes are cached, so they are dropped first.
    async calendarChanged(): Promise<'asked' | 'no_row'> {
      const today = localIso(deps.now(), deps.ownerZone()).slice(0, 10);
      if (record(record(await deps.producer.readScores?.(today))?.scores)?.day !== today) return 'no_row';
      deps.forgetDemand?.(today);
      await ask();
      return 'asked';
    },
    // A recompute that failed throws, so the scheduler retries it and then pauses it; the next upload asks again.
    async run(): Promise<ProducerOutcome> {
      const now = deps.now(), timezone = deps.ownerZone(), today = localIso(now, timezone).slice(0, 10), wakes = deps.wakes?.enabled() ? deps.wakes : null;
      const before = wakes ? await read(wakes.readContext).catch((): null => null) : null;
      const outcome = await produceHealthScores(deps.producer, { now, timezone });
      if (outcome === 'failed') throw new Error('health recompute failed');
      if (outcome === 'written' && wakes) await wake(wakes, before, today);
      return outcome;
    },
  };
};
export type HealthRecompute = ReturnType<typeof healthRecompute>;
