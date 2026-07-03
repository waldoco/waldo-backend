// Owning ADRs: ADR-0031 (episode hit + search interface), ADR-0037 (episodes append-only),
// ADR-0007 (90-day R2 JSONL archive boundary).
// Invariant under test: the hit element shape is verbatim RecallResult.episode_hits — one
// representation shared with the recall module; the search window is instant-ordered; the
// archive boundary is pinned.
// Failure mode caught: renaming or retyping fts_rank/date/summary silently breaking the
// recall contract, a time_range compared as strings instead of instants, or archive-boundary
// drift away from the ADR-0007 value.
// Note: the append-only rule itself (UPDATE/DELETE on episodes throws) lives at the
// AuditedDB seam and is tested in the runtime wave — a Zod shape cannot express it.
import { describe, expect, it } from 'vitest';
import { EPISODE_ARCHIVE_AFTER_DAYS, episodeHitSchema, episodeSearchArgsSchema } from './episode';

const baseHit = {
  date: '2026-06-01T00:00:00Z',
  summary: 'long afternoon focus block after a light meeting day',
  fts_rank: -2.5,
} as const;

const baseArgs = {
  query: 'afternoon focus',
  limit: 3,
  time_range: { from: '2026-05-25T00:00:00Z', to: '2026-06-01T00:00:00Z' },
} as const;

describe('EPISODE_ARCHIVE_AFTER_DAYS — ADR-0007 drift guard', () => {
  it('pins the hot-store boundary to 90 days', () => {
    expect(EPISODE_ARCHIVE_AFTER_DAYS).toBe(90);
  });
});

describe('episodeHitSchema — the shared recall element shape', () => {
  it('carries exactly date, summary, fts_rank — the recall module reuses this shape', () => {
    expect(Object.keys(episodeHitSchema.shape)).toEqual(['date', 'summary', 'fts_rank']);
  });

  it('accepts a well-formed hit', () => {
    expect(episodeHitSchema.safeParse(baseHit).success).toBe(true);
  });

  it('accepts a negative fts_rank — FTS5 bm25 emits negatives', () => {
    expect(episodeHitSchema.safeParse({ ...baseHit, fts_rank: -0.001 }).success).toBe(true);
  });

  it('rejects a stringified fts_rank', () => {
    expect(episodeHitSchema.safeParse({ ...baseHit, fts_rank: '-2.5' }).success).toBe(false);
  });

  it('rejects an epoch-ms date — the contract-level datetime is ISO-8601', () => {
    expect(episodeHitSchema.safeParse({ ...baseHit, date: 1_770_000_000_000 }).success).toBe(
      false,
    );
  });

  it('rejects a numeric-string date', () => {
    expect(episodeHitSchema.safeParse({ ...baseHit, date: '1770000000000' }).success).toBe(
      false,
    );
  });

  it('rejects an empty summary', () => {
    expect(episodeHitSchema.safeParse({ ...baseHit, summary: '' }).success).toBe(false);
  });

  it('rejects extra fields — strict object', () => {
    expect(episodeHitSchema.safeParse({ ...baseHit, episode_id: 'ep-1' }).success).toBe(false);
  });
});

describe('episodeSearchArgsSchema', () => {
  it('accepts the ADR-0031 fan-out shape', () => {
    expect(episodeSearchArgsSchema.safeParse(baseArgs).success).toBe(true);
  });

  it('rejects a window that ends before it starts', () => {
    expect(
      episodeSearchArgsSchema.safeParse({
        ...baseArgs,
        time_range: { from: '2026-06-01T00:00:00Z', to: '2026-05-25T00:00:00Z' },
      }).success,
    ).toBe(false);
  });

  it('accepts a zero-length window — equal instants are a valid degenerate range', () => {
    expect(
      episodeSearchArgsSchema.safeParse({
        ...baseArgs,
        time_range: { from: '2026-06-01T00:00:00Z', to: '2026-06-01T00:00:00Z' },
      }).success,
    ).toBe(true);
  });

  it('compares instants, not strings: a lexicographically-ordered window whose from is the later instant is rejected', () => {
    // from 05:00:00-05:00 is 10:00:00Z — after to 08:00:00Z, even though the from string
    // sorts before the to string. Naive string comparison would accept this window.
    expect(
      episodeSearchArgsSchema.safeParse({
        ...baseArgs,
        time_range: { from: '2026-06-01T05:00:00-05:00', to: '2026-06-01T08:00:00Z' },
      }).success,
    ).toBe(false);
  });

  it('compares instants, not strings: a lexicographically-reversed window whose from is the earlier instant is accepted', () => {
    // from 12:00:00+05:00 is 07:00:00Z — before to 10:00:00Z, even though the from string
    // sorts after the to string. Naive string comparison would reject this valid window.
    expect(
      episodeSearchArgsSchema.safeParse({
        ...baseArgs,
        time_range: { from: '2026-06-01T12:00:00+05:00', to: '2026-06-01T10:00:00Z' },
      }).success,
    ).toBe(true);
  });

  it('rejects a zero limit', () => {
    expect(episodeSearchArgsSchema.safeParse({ ...baseArgs, limit: 0 }).success).toBe(false);
  });

  it('rejects a negative limit', () => {
    expect(episodeSearchArgsSchema.safeParse({ ...baseArgs, limit: -1 }).success).toBe(false);
  });

  it('rejects a fractional limit', () => {
    expect(episodeSearchArgsSchema.safeParse({ ...baseArgs, limit: 1.5 }).success).toBe(false);
  });

  it('rejects an empty query', () => {
    expect(episodeSearchArgsSchema.safeParse({ ...baseArgs, query: '' }).success).toBe(false);
  });

  it('rejects a missing time_range', () => {
    expect(
      episodeSearchArgsSchema.safeParse({ query: 'afternoon focus', limit: 3 }).success,
    ).toBe(false);
  });

  it('rejects extra fields — strict at both levels', () => {
    expect(episodeSearchArgsSchema.safeParse({ ...baseArgs, halls: [] }).success).toBe(false);
    expect(
      episodeSearchArgsSchema.safeParse({
        ...baseArgs,
        time_range: { ...baseArgs.time_range, tz: 'UTC' },
      }).success,
    ).toBe(false);
  });
});
