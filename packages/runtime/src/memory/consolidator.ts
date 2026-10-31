import { consolidateSources, type SourcesDeps } from '../channels/nightly-sources';
import { localIso } from '../channels/reminders';
import type { ObservedEvent } from '../channels/update-sweep';
import type { Scheduler } from '../scheduler/multiplexer';

// The daytime consolidator: the mail and calendar changes the update sweep records reach memory the same day, through the
// nightly source pass, so every claim they add is untrusted, a candidate until the owner confirms it. The sweep's hint only
// arms one scheduled pass. The pass reads by the source pass's own mark, so a lost hint costs latency and the nightly run
// reads whatever is left. Promotion and the weave stay nightly.
export const MEMORY_DAYTIME_ID = 'memory:daytime';
export const DAYTIME_GAP_MS = 15 * 60_000;
export const DAYTIME_CALLS_PER_DAY = 6;
const LAST_KEY = 'memory_daytime_last_v1';
// The model calls made on one local date: the owner's date when the pass ran.
const CALLS_KEY = 'memory_daytime_calls_v1';

export type DaytimeOutcome = Awaited<ReturnType<typeof consolidateSources>> | 'off' | 'spend_capped' | 'day_spent';

export const daytimeMemory = (deps: Readonly<{
  kv: Pick<SyncKvStorage, 'get' | 'put'>;
  scheduler: Pick<Scheduler, 'lookup' | 'schedule'>;
  now: () => number;
  timezone: () => string;
  // Both flags on and the owner's nightly memory pass not turned off.
  enabled: () => boolean;
  // The owner's month has reached the spend ceiling.
  capped: () => boolean;
  // What the nightly source pass is built with, for this pass's trace.
  sources: (trace: string) => SourcesDeps;
}>) => {
  const today = () => localIso(deps.now(), deps.timezone()).slice(0, 10);
  const callsToday = () => {
    const kept = deps.kv.get<Readonly<{ day: string; calls: number }>>(CALLS_KEY);
    return kept?.day === today() ? kept.calls : 0;
  };
  return {
    // The hint only arms the pass: one schedule row, no read of the changes and no model call. A pass already armed stays where
    // it is, so hints every few minutes cannot keep pushing it later.
    observed(event: ObservedEvent): Promise<unknown> | undefined {
      if ((event.kind !== 'mail' && event.kind !== 'calendar') || !deps.enabled() || callsToday() >= DAYTIME_CALLS_PER_DAY) return undefined;
      if (deps.scheduler.lookup(MEMORY_DAYTIME_ID).state !== 'absent') return undefined;
      const at = Math.max(deps.now(), (deps.kv.get<number>(LAST_KEY) ?? 0) + DAYTIME_GAP_MS);
      return deps.scheduler.schedule({ id: MEMORY_DAYTIME_ID, kind: 'dreaming', payloadRefs: { id: MEMORY_DAYTIME_ID }, occurrenceAt: at, dueAt: at, recurrence: null });
    },
    // Never throws, so the scheduler never retries it and no failure notice goes out: a failed pass leaves the mark where it was,
    // and the next pass or the nightly run reads the same rows.
    async run(entry: Readonly<{ id: string; occurrence_at: number }>): Promise<DaytimeOutcome> {
      if (!deps.enabled()) return 'off';
      if (deps.capped()) return 'spend_capped';
      if (callsToday() >= DAYTIME_CALLS_PER_DAY) return 'day_spent';
      try {
        deps.kv.put(LAST_KEY, deps.now());
        const trace = `${entry.id}:${entry.occurrence_at}`;
        const sources = deps.sources(trace);
        // A call is counted before it is made, so one that fails still counts.
        return await consolidateSources({ ...sources, ask: (updates) => {
          deps.kv.put(CALLS_KEY, { day: today(), calls: callsToday() + 1 });
          return sources.ask(updates);
        } }, trace, 1);
      } catch {
        return 'failed';
      }
    },
  };
};
