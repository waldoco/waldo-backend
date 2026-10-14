import type { ScheduleEntry } from '@waldo/contracts';
import { BRIEF_SWEEP_ID } from '../../src/channels/event-briefs';

type Runtime = Readonly<{ ready: Promise<unknown>; briefs(entry: ScheduleEntry): Promise<void>; updateCheck(trace: string): Promise<void> }>;
type Owner = Readonly<{
  setup(channel?: string): Runtime;
  serial<T>(work: () => Promise<T>): Promise<T>;
  asOwnerJob<T>(job: string, occurrenceKey: string, work: () => Promise<T>): Promise<T>;
}>;

// Runs a job's executor now, as that owner job and in the object's serial queue, for a test about what the job does
// rather than when it wakes: the event-brief sweep, or the update check that ends it. Wakes and their gates are tested
// through the scheduler.
export const runOwnerJob = (instance: object, job: 'briefs' | 'update_check'): Promise<void> => {
  const owner = instance as unknown as Owner;
  return owner.serial(async () => {
    const runtime = owner.setup();
    await runtime.ready;
    const at = Date.now();
    if (job === 'briefs') await owner.asOwnerJob('pre_activity_spot', `${BRIEF_SWEEP_ID}:${at}`, () => runtime.briefs({ id: BRIEF_SWEEP_ID, occurrence_at: at, attempts: 0 } as unknown as ScheduleEntry));
    else await owner.asOwnerJob('heartbeat', `update:${at}`, () => runtime.updateCheck(`update:${at}`));
  });
};
