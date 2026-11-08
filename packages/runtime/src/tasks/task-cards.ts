import type { AppTaskCardV1 } from '../../../contracts/src/app/threads';
import { APP_TASK_CARDS_MAX_V1 } from '../../../contracts/src/app/threads';
import type { AppApprovalPart } from '../channels/surfaces/app';
import { threadOfChain } from '../channels/app-threads';
import { isMachine, jobCheckpoint, taskBrief, type JobBook } from './jobs';

// The cards the owner's background tasks started in one app thread wait on, as the thread's read carries them (chat revision 9).
// A task waits on at most one card, named by its checkpoint; the part comes from the approval desk, so a decided or retired card
// is gone here as it is everywhere. A title written after outside content is not shown as Waldo's words.
export const taskCardsIn = (book: Pick<JobBook, 'open'>, part: (approvalId: string) => AppApprovalPart | null, thread: string): AppTaskCardV1[] =>
  book.open()
    .filter((row) => row.kind === 'task' && !isMachine(row) && row.status === 'awaiting_owner')
    .flatMap((row) => {
      const brief = taskBrief(row), asked = jobCheckpoint(row).asked;
      if (!asked || !brief.conversation_ref || threadOfChain(brief.conversation_ref) !== thread) return [];
      const approval = part(asked.approval_id);
      return approval ? [{ job_id: row.id, title: brief.outside_text ? null : brief.title.slice(0, 80), approval }] : [];
    })
    .slice(0, APP_TASK_CARDS_MAX_V1);
