// HEY-151: this is the public app seam for an already committed morning-Brief projection.
// It catches internal identifier leakage, state/nullability drift, unsafe card expansion, and
// cross-subject ETag reuse without implementing the HEY-154 route or projection.
import { describe, expect, it } from 'vitest';
import {
  canReturnMorningBriefNotModified,
  publicMorningBriefResponseSchema,
  subjectBoundEtagSchema,
  waldoProblemV1Schema,
} from './morning-brief';

const ready = {
  status: 'ready',
  brief_id: 'brief_01ABCDEFGHijklmnop',
  revision: 7,
  variant: 'morning',
  cards: [
    {
      id: 'card_01ABCDEFGHijklmnop',
      kind: 'brief_card',
      title: 'Your morning Brief',
      body: 'A calm, structured start is ready.',
      evidence: [{ ref: 'evref_01ABCDEFGHijklmnop' }],
    },
  ],
  generated_at: '2026-07-12T05:30:00.000Z',
  source_updated_at: '2026-07-12T05:25:00.000Z',
  stale_at: '2026-07-12T08:30:00.000Z',
  as_of: '2026-07-12T05:30:01.000Z',
  freshness: 'fresh',
} as const;

describe('public current morning-Brief response', () => {
  it('accepts the strict ready, pending, and empty states', () => {
    expect(publicMorningBriefResponseSchema.safeParse(ready).success).toBe(true);
    expect(
      publicMorningBriefResponseSchema.safeParse({
        status: 'pending',
        as_of: '2026-07-12T05:30:00.000Z',
        retry_after_seconds: 30,
      }).success,
    ).toBe(true);
    expect(
      publicMorningBriefResponseSchema.safeParse({
        status: 'empty',
        as_of: '2026-07-12T05:30:00.000Z',
        reason: 'no_eligible_content',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields and internal identifiers at every public layer', () => {
    for (const candidate of [
      { ...ready, user_id: 'user-internal' },
      { ...ready, durable_object_id: 'do-internal' },
      { ...ready, run_id: 'run-internal' },
      { ...ready, cards: [{ ...ready.cards[0], journal_id: 'journal-internal' }] },
      {
        ...ready,
        cards: [{ ...ready.cards[0], evidence: [{ ...ready.cards[0].evidence[0], trace_id: 'trace-internal' }] }],
      },
    ]) {
      expect(publicMorningBriefResponseSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('rejects invalid enums, invalid nullability, and database UUID identifiers', () => {
    for (const candidate of [
      { ...ready, status: 'complete' },
      { ...ready, variant: 'evening' },
      { ...ready, freshness: 'unknown' },
      { ...ready, cards: [{ ...ready.cards[0], kind: 'action_confirmation' }] },
      { ...ready, generated_at: null },
      { ...ready, generated_at: '2026-07-12T11:00:00.000+05:30' },
      { ...ready, cards: null },
      { ...ready, brief_id: '10000000-0000-4000-8000-000000000001' },
      { ...ready, brief_id: 'run_internal_identifier_001' },
      { ...ready, cards: [{ ...ready.cards[0], id: 'journal_internal_identifier_001' }] },
      { ...ready, cards: [{ ...ready.cards[0], evidence: [{ ref: 'provider_internal_ref_001' }] }] },
      { ...ready, source_updated_at: '2026-07-12T05:31:00.000Z' },
      { ...ready, stale_at: '2026-07-12T05:30:00.000Z' },
      { ...ready, as_of: '2026-07-12T05:29:59.000Z' },
      { ...ready, as_of: '2026-07-12T09:00:00.000Z', freshness: 'fresh' },
      { ...ready, revision: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(publicMorningBriefResponseSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('keeps WaldoProblemV1 strict and content-free', () => {
    const problem = {
      type: 'https://api.heywaldo.com/problems/temporarily-unavailable',
      title: 'Temporarily unavailable',
      status: 503,
      code: 'temporarily_unavailable',
      retry_after_seconds: 30,
    } as const;

    expect(waldoProblemV1Schema.safeParse(problem).success).toBe(true);
    for (const candidate of [
      { ...problem, detail: 'provider response failed' },
      { ...problem, trace_id: 'trace-internal' },
      { ...problem, code: 'provider_error' },
      { ...problem, title: 'SQL connection failed' },
      { ...problem, type: 'https://provider.example/error' },
      { ...problem, status: 500 },
      { ...problem, retry_after_seconds: null },
    ]) {
      expect(waldoProblemV1Schema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe('subject-bound morning-Brief ETag semantics', () => {
  const subjectA = subjectBoundEtagSchema.parse('"abcdefghijklmnopqrstuvwxyz_012345"');
  const subjectB = subjectBoundEtagSchema.parse('"abcdefghijklmnopqrstuvwxyz_012346"');

  it('returns 304 eligibility only for the same verified subject and exact opaque ETag', () => {
    expect(
      canReturnMorningBriefNotModified({
        request_subject: 'subject-a',
        representation_subject: 'subject-a',
        if_none_match: subjectA,
        current_etag: subjectA,
      }),
    ).toBe(true);

    expect(
      canReturnMorningBriefNotModified({
        request_subject: 'subject-b',
        representation_subject: 'subject-a',
        if_none_match: subjectA,
        current_etag: subjectA,
      }),
    ).toBe(false);
  });

  it('treats a missing or stale validator as a cache miss', () => {
    expect(
      canReturnMorningBriefNotModified({
        request_subject: 'subject-a',
        if_none_match: null,
        representation_subject: 'subject-a',
        current_etag: subjectA,
      }),
    ).toBe(false);
    expect(
      canReturnMorningBriefNotModified({
        request_subject: 'subject-a',
        representation_subject: 'subject-a',
        if_none_match: subjectB,
        current_etag: subjectA,
      }),
    ).toBe(false);
    expect(
      canReturnMorningBriefNotModified({
        request_subject: 'subject-a',
        representation_subject: 'subject-a',
        if_none_match: 'malformed',
        current_etag: 'malformed',
      }),
    ).toBe(false);
  });

  it('requires distinct opaque fixtures for the same projection revision across subjects', () => {
    expect(subjectB).not.toBe(subjectA);
    expect(
      canReturnMorningBriefNotModified({
        request_subject: 'subject-b',
        representation_subject: 'subject-b',
        if_none_match: subjectA,
        current_etag: subjectB,
      }),
    ).toBe(false);
  });
});
