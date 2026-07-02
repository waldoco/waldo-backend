import { z } from 'zod';
import { iso8601Schema } from '../core/error';

// Episodes are strictly append-only records of what happened (ADR-0037): no UPDATE or
// DELETE ever — corrections append, and supersedence never touches them (ADR-0046). Rows
// older than this boundary move to the R2 JSONL archive — archived, never deleted
// (ADR-0007). The full row shape is deliberately not locked here: the wave's accepted canon
// pins only the recall-facing hit + search interface below.
export const EPISODE_ARCHIVE_AFTER_DAYS = 90;

// Verbatim element shape of RecallResult.episode_hits (ADR-0031) — one representation
// shared with the recall module. Summaries are prompt-destined content: stable references
// only, never raw physiological values (ADR-0024 destination rules).
export const episodeHitSchema = z.strictObject({
  date: iso8601Schema,
  summary: z.string().min(1),
  // FTS5 relevance rank — bm25() emits negative floats, so the domain is any number.
  fts_rank: z.number(),
});
export type EpisodeHit = z.infer<typeof episodeHitSchema>;

// Args of the recall fan-out's episode FTS5 leg (ADR-0031).
export const episodeSearchArgsSchema = z.strictObject({
  query: z.string().min(1),
  limit: z.int().positive(),
  time_range: z
    .strictObject({
      from: iso8601Schema,
      to: iso8601Schema,
    })
    // Instants, not strings: iso8601 admits non-UTC offsets, so lexicographic order can lie.
    .refine((r) => Date.parse(r.from) <= Date.parse(r.to), {
      error: 'time_range must not end before it starts',
      path: ['to'],
    }),
});
export type EpisodeSearchArgs = z.infer<typeof episodeSearchArgsSchema>;
