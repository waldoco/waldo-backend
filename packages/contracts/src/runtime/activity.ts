import { z } from 'zod';

const openKinds = ['proposed', 'approved', 'dispatched', 'undo_requested'] as const;
const terminalKinds = ['declined', 'completed', 'failed', 'indeterminate', 'stopped'] as const;

export const activityInputSchema = z.strictObject({
  entryId: z.string().min(1),
  ownerId: z.string().min(1),
  subjectRef: z.string().min(1),
  kind: z.enum([...openKinds, ...terminalKinds]),
  at: z.int().nonnegative(),
  summary: z.string().min(1).max(500),
  evidenceRef: z.string().min(1).nullable(),
  undoable: z.boolean(),
});
export type ActivityInput = z.infer<typeof activityInputSchema>;
export type ActivityEntry = Readonly<ActivityInput & { seq: number }>;
export type ActivityControls = Readonly<{ subjectRef: string; canStop: boolean; canUndo: boolean }>;

const isOpen = (kind: ActivityInput['kind']) => (openKinds as readonly string[]).includes(kind);

export class ActivityLedgerModule {
  private readonly entries: ActivityEntry[] = [];

  append(authenticatedOwnerId: string, input: unknown): ActivityEntry {
    const next = activityInputSchema.parse(input);
    if (next.ownerId !== authenticatedOwnerId) throw new Error('activity owner mismatch');
    const prior = this.entries.find((item) => item.ownerId === next.ownerId && item.entryId === next.entryId);
    if (prior) {
      const { seq, ...recorded } = prior;
      if (JSON.stringify(recorded) !== JSON.stringify(next)) throw new Error('activity entry conflict');
      return prior;
    }
    const owned = this.feed(next.ownerId);
    const last = owned.at(-1);
    if (last && next.at < last.at) throw new Error('activity out of order');
    const latest = this.latest(next.ownerId, next.subjectRef);
    if (latest && !isOpen(latest.kind) && next.kind !== 'undo_requested') throw new Error('activity subject closed');
    if (next.kind === 'undo_requested' && !this.controls(next.ownerId, next.subjectRef).canUndo) throw new Error('activity undo not permitted');
    const stored = Object.freeze({ ...next, seq: owned.length + 1 });
    this.entries.push(stored);
    return stored;
  }

  feed(authenticatedOwnerId: string): readonly ActivityEntry[] {
    return Object.freeze(this.entries.filter((item) => item.ownerId === authenticatedOwnerId));
  }

  controls(authenticatedOwnerId: string, subjectRef: string): ActivityControls {
    const latest = this.latest(authenticatedOwnerId, subjectRef);
    return Object.freeze({
      subjectRef,
      canStop: !!latest && isOpen(latest.kind),
      canUndo: !!latest && latest.kind === 'completed' && latest.undoable,
    });
  }

  private latest(ownerId: string, subjectRef: string): ActivityEntry | undefined {
    return this.feed(ownerId).filter((item) => item.subjectRef === subjectRef).at(-1);
  }
}
