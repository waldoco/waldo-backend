import { endRunCards, taskAskCard, withdrawRunCards, type ApprovalDesk } from '../channels/approvals';
import type { JobBook } from './jobs';

// The cards a background task raises for its own steps (WALDO_TASK_ASK), between the owner's approval desk and the job book.
// An approval resumes the task, whose next attempt runs the step under the task's own scope: no card a task asked on ever
// becomes a replay job, and the task, not the replay lane, settles it.
export const taskAsks = (sql: SqlStorage, book: () => JobBook) => ({
  // An approved card a task asked on resumes the task now; one approved while the task was still raising it stays running
  // until the jobs lane sees the task waiting. Answers whether the card was a task's.
  approved(approvalId: string): boolean {
    if (!taskAskCard(sql, approvalId)) return false;
    book().resume(approvalId, 'approved');
    return true;
  },
  // The desk's running cards whose call a replay job runs.
  replays: (desk: Pick<ApprovalDesk, 'replays'>): readonly string[] => desk.replays().filter(id => !taskAskCard(sql, id)),
  // How a card a task asked on stands.
  card: (desk: Pick<ApprovalDesk, 'waiting'>, approvalId: string): 'waiting' | 'approved' | 'declined' =>
    desk.waiting().some(card => card.approval_id === approvalId) ? 'waiting' : taskAskCard(sql, approvalId)?.status === 'running' ? 'approved' : 'declined',
  // A task that stopped (cancelled, forgotten, parked): its waiting cards are withdrawn, and one approved whose step it will
  // not now answer leaves running, as unknown if the step was in flight.
  end(runRef: string, now: number): void {
    withdrawRunCards(sql, runRef, now);
    const job = book().get(runRef.slice('task:'.length));
    endRunCards(sql, runRef, job?.inflight_json != null ? 'uncertain' : 'skipped', now);
  },
});
export type TaskAsks = ReturnType<typeof taskAsks>;
