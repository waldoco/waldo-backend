import type { Scheduler } from '../scheduler/multiplexer';
import { produceHealthScores, type ProducerDeps, type ProducerOutcome } from './producer';

// The owner's derived rows are recomputed in the owner's own object, one recompute at a time. Every upload that changed a
// reading, and every wearable sync, asks for one; the asks inside one window are one recompute, which reads the month once
// and writes through the database's read fence. The entry is infrastructure work: no model turn and no message, so it is
// not held by quiet hours or an unconfirmed zone. Only the health trigger it may arm decides whether to speak, and that
// keeps its own holds.
export const HEALTH_RECOMPUTE_ID = 'health-recompute';
// Long enough to take one sync's run of upload batches, short enough that a change reaches the trigger within a minute.
export const HEALTH_RECOMPUTE_WINDOW_MS = 60_000;

export type HealthRecomputeDeps = Readonly<{
  scheduler: Pick<Scheduler, 'lookup' | 'schedule'>;
  now(): number;
  // The owner's own zone, read when the recompute runs. It names the owner's local today, whichever zone a reading came from.
  ownerZone(): string;
  producer: ProducerDeps;
}>;

export const healthRecompute = (deps: HealthRecomputeDeps) => ({
  async ask(): Promise<void> {
    const now = deps.now(), found = deps.scheduler.lookup(HEALTH_RECOMPUTE_ID);
    // One already waiting takes this upload too. One that is due or running may have read before this batch committed, and
    // a paused one is retried by new readings, so each of those is armed for a fresh window. A row this Worker cannot read
    // is left as the Worker that wrote it set it.
    if (found.state === 'unreadable' || (found.state === 'entry' && found.entry.status === 'armed' && found.entry.due_at > now)) return;
    const at = now + HEALTH_RECOMPUTE_WINDOW_MS;
    await deps.scheduler.schedule({ id: HEALTH_RECOMPUTE_ID, kind: 'provider_sync', occurrenceAt: at, dueAt: at, payloadRefs: { id: HEALTH_RECOMPUTE_ID } });
  },
  // A recompute that failed throws, so the scheduler retries it and then pauses it; the next upload asks again.
  async run(): Promise<ProducerOutcome> {
    const outcome = await produceHealthScores(deps.producer, { now: deps.now(), timezone: deps.ownerZone() });
    if (outcome === 'failed') throw new Error('health recompute failed');
    return outcome;
  },
});
export type HealthRecompute = ReturnType<typeof healthRecompute>;
