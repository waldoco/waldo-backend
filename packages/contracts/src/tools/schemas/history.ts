import { z } from 'zod';
import { iso8601Schema } from '../../core/error';

// search_history: the owner's past background runs, tasks, scheduled runs and decided approval cards, newest first, across
// the hot tables and the history archive. A read: summaries and statuses only, never a payload, a body or a health value.
export const HISTORY_KINDS = ['run', 'task', 'scheduled', 'approval'] as const;
export const historyKindSchema = z.enum(HISTORY_KINDS);
export type HistoryKind = z.infer<typeof historyKindSchema>;
export const SEARCH_HISTORY_LIMIT_MAX = 20;

export const searchHistoryArgsSchema = z
  .strictObject({
    query: z.string().min(1).max(200).optional().describe('Words that must all appear in the summary, kind or status; omit to list everything.'),
    kinds: z.array(historyKindSchema).min(1).max(HISTORY_KINDS.length).optional()
      .refine(kinds => kinds === undefined || new Set(kinds).size === kinds.length, { error: 'kinds repeat' })
      .describe('Only these kinds; omit for all four.'),
    from: iso8601Schema.optional().describe('Earliest start, with seconds and a UTC offset.'),
    to: iso8601Schema.optional().describe('Latest start, exclusive, with seconds and a UTC offset.'),
    cursor: z.string().regex(/^\d{1,16}:[\x21-\x7e]{1,240}$/).optional().describe('next_cursor from the previous page; the other arguments must stay the same.'),
    limit: z.int().min(1).max(SEARCH_HISTORY_LIMIT_MAX).default(10),
  })
  .refine(args => args.from === undefined || args.to === undefined || Date.parse(args.from) <= Date.parse(args.to), {
    error: 'to must not be before from',
    path: ['to'],
  });
export type SearchHistoryArgs = z.infer<typeof searchHistoryArgsSchema>;

export type HistoryEntry = Readonly<{
  // type: the row's own kind (a run's 'reminder', a card's 'email_send'); status: its outcome word.
  ref: string; kind: HistoryKind; type: string; status: string; summary: string | null;
  started_at: string; ended_at: string | null; archived: boolean;
}>;
export type SearchHistoryResult = Readonly<{ entries: readonly HistoryEntry[]; total: number; next_cursor: string | null }>;
