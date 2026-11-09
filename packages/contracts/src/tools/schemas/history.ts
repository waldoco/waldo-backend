import { z } from 'zod';
import { iso8601Schema } from '../../core/error';

// search_history: the owner's past background runs, tasks, scheduled runs and decided approval cards, newest first, across
// the hot tables and the history archive. A read: summaries and statuses only, never a payload, a body or a health value.
export const HISTORY_KINDS = ['run', 'task', 'scheduled', 'approval'] as const;
export const historyKindSchema = z.enum(HISTORY_KINDS);
export type HistoryKind = z.infer<typeof historyKindSchema>;
export const SEARCH_HISTORY_LIMIT_MAX = 20;

const searchHistoryFields = {
  query: z.string().min(1).max(200).optional().describe('Words that must all appear in the summary, kind or status; omit to list everything.'),
  kinds: z.array(historyKindSchema).min(1).max(HISTORY_KINDS.length).optional()
    .refine(kinds => kinds === undefined || new Set(kinds).size === kinds.length, { error: 'kinds repeat' })
    .describe('Only these kinds; omit for all four.'),
  from: iso8601Schema.optional().describe('Earliest start, with seconds and a UTC offset.'),
  to: iso8601Schema.optional().describe('Latest start, exclusive, with seconds and a UTC offset.'),
  cursor: z.string().regex(/^\d{1,16}:[\x21-\x7e]{1,240}$/).optional().describe('next_cursor from the previous page; the other arguments must stay the same.'),
  limit: z.int().min(1).max(SEARCH_HISTORY_LIMIT_MAX).default(10),
};
const windowInOrder = (args: Readonly<{ from?: string; to?: string }>) => args.from === undefined || args.to === undefined || Date.parse(args.from) <= Date.parse(args.to);
export const searchHistoryArgsSchema = z
  .strictObject(searchHistoryFields)
  .refine(windowInOrder, { error: 'to must not be before from', path: ['to'] });
export type SearchHistoryArgs = z.infer<typeof searchHistoryArgsSchema>;

export type HistoryEntry = Readonly<{
  // type: the row's own kind (a run's 'reminder', a card's 'email_send'); status: its outcome word.
  ref: string; kind: HistoryKind; type: string; status: string; summary: string | null;
  started_at: string; ended_at: string | null; archived: boolean;
  // With the recall chain on: the rows next to this one, each by its ref.
  links?: readonly RecallLink[];
}>;
export type SearchHistoryResult = Readonly<{ entries: readonly HistoryEntry[]; total: number; next_cursor: string | null }>;

// The recall chain: every recalled row names the rows next to it, by a ref an existing read takes, with one line each, so the
// model can follow a thread hop by hop instead of searching again. A ref is a row that already exists; nothing is copied.
//   digits                                          a past message: search_episodes with ref
//   background_runs: task_jobs: schedule_runs: ledger:  search_history with ref
//   c<id>                                           a memory note: read_memory with ids
//   mail:<thread id>                                a mail thread: read_thread with thread_id
//   event:<event id>                                a calendar event: query_calendar around the time its line gives
export const RECALL_LINK_RELS = ['reply', 'reply_to', 'before', 'after', 'learned', 'started', 'from', 'card', 'acts_on', 'read'] as const;
export type RecallLinkRel = (typeof RECALL_LINK_RELS)[number];
export type RecallLink = Readonly<{ ref: string; rel: RecallLinkRel; line: string }>;

const HISTORY_REF = /^(?:background_runs|task_jobs|schedule_runs|ledger):[\x21-\x7e]{1,240}$/;
// search_history with the recall chain on: a ref reads that one entry with its links, and takes no other filter.
export const searchHistoryChainArgsSchema = z
  .strictObject({ ...searchHistoryFields, ref: z.string().regex(HISTORY_REF).optional().describe('A history ref (from an entry or a link) to read that one entry with the rows next to it; alone, with no other filter.') })
  .refine(windowInOrder, { error: 'to must not be before from', path: ['to'] })
  .refine(args => args.ref === undefined || (args.query === undefined && args.kinds === undefined && args.from === undefined && args.to === undefined && args.cursor === undefined), {
    error: 'a ref is read alone', path: ['ref'],
  });
export type SearchHistoryChainArgs = z.infer<typeof searchHistoryChainArgsSchema>;
