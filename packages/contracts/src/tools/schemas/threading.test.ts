import { describe, expect, it } from 'vitest';
import {
  archiveThreadArgsSchema,
  contextPinSpecSchema,
  createThreadArgsSchema,
  deleteMessageArgsSchema,
  pinIncludePolicySchema,
  pinInheritanceSchema,
  pinSourceTypeSchema,
  restoreMessageArgsSchema,
  subthreadRefSchema,
  threadReplayRefSchema,
  updateThreadTopicsArgsSchema,
} from './threading';

// Owning ADRs: ADR-0039 (five threading tools, soft delete + recovery, topic grouping) and
// ADR-0077 (subthreads anchored to messages, context pins as references + policy, replay
// from the committed record). Invariants under test: all-optional thread creation, the
// tag-set bounds, the ttl↔expires_at coupling, and half-anchored subthreads being
// unrepresentable. Failure modes caught: pin-vocabulary enum drift, a loosened tag bound,
// a hard-delete slipping in as an extra arg, and a card payload bypassing the ui/card owner.

describe('pin vocabulary (ADR-0077)', () => {
  it('source types are exactly the eight, in order', () => {
    expect(pinSourceTypeSchema.options).toEqual([
      'health_metric',
      'health_card',
      'gmail',
      'calendar',
      'document',
      'task',
      'waldo_card',
      'file',
    ]);
  });

  it('include policies are exactly the four, in order', () => {
    expect(pinIncludePolicySchema.options).toEqual([
      'next_turn',
      'until_unpinned',
      'ttl',
      'local_only',
    ]);
  });

  it('inheritance is exactly none | descendants', () => {
    expect(pinInheritanceSchema.options).toEqual(['none', 'descendants']);
  });
});

describe('contextPinSpec', () => {
  const base = {
    source_type: 'health_card',
    source_ref: 'card-1',
    include_policy: 'until_unpinned',
    inheritance: 'none',
    expires_at: null,
  } as const;

  it('accepts a reference-only pin', () => {
    expect(contextPinSpecSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a 'ttl' pin that names its expiry", () => {
    expect(
      contextPinSpecSchema.safeParse({
        ...base,
        include_policy: 'ttl',
        expires_at: '2026-01-02T00:00:00Z',
      }).success,
    ).toBe(true);
  });

  it("rejects a 'ttl' pin without an expiry", () => {
    expect(contextPinSpecSchema.safeParse({ ...base, include_policy: 'ttl' }).success).toBe(false);
  });

  it("rejects an expiry on a non-'ttl' pin", () => {
    expect(
      contextPinSpecSchema.safeParse({ ...base, expires_at: '2026-01-02T00:00:00Z' }).success,
    ).toBe(false);
  });

  it('rejects an empty source_ref — a pin is a reference, never inline data', () => {
    expect(contextPinSpecSchema.safeParse({ ...base, source_ref: '' }).success).toBe(false);
  });
});

describe('subthreadRef', () => {
  it('accepts a parent anchored at a message', () => {
    expect(
      subthreadRefSchema.safeParse({ parent_thread_id: 'thr-1', anchor_message_id: 'msg-1' })
        .success,
    ).toBe(true);
  });

  it('rejects a half-anchored ref missing the anchor message', () => {
    expect(subthreadRefSchema.safeParse({ parent_thread_id: 'thr-1' }).success).toBe(false);
  });
});

describe('createThreadArgs', () => {
  it('accepts an empty call — every field is optional', () => {
    expect(createThreadArgsSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a full deep-dive: tags, entry context, card, parent anchor, and pins', () => {
    expect(
      createThreadArgsSchema.safeParse({
        topic_tags: ['recovery'],
        entry_context: 'from the flipped recovery card',
        initial_card: { kind: 'context_card', card_id: 'card-1', data: { source_refs: ['evt-1'] } },
        parent: { parent_thread_id: 'thr-1', anchor_message_id: 'msg-1' },
        context_pins: [
          {
            source_type: 'calendar',
            source_ref: 'evt-1',
            include_policy: 'next_turn',
            inheritance: 'none',
            expires_at: null,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects a sixth topic tag and a tag over 50 chars', () => {
    expect(
      createThreadArgsSchema.safeParse({ topic_tags: ['a', 'b', 'c', 'd', 'e', 'f'] }).success,
    ).toBe(false);
    expect(createThreadArgsSchema.safeParse({ topic_tags: ['x'.repeat(51)] }).success).toBe(false);
  });

  it("rejects a card kind outside the ui/card owner union", () => {
    expect(
      createThreadArgsSchema.safeParse({
        initial_card: { kind: 'confetti_card', card_id: 'card-1', data: { source_refs: [] } },
      }).success,
    ).toBe(false);
  });

  it('rejects a smuggled extra argument', () => {
    expect(createThreadArgsSchema.safeParse({ pinned: true }).success).toBe(false);
  });
});

describe('delete/restore message — the soft-delete + recovery pair (ADR-0039 rule 3)', () => {
  const ref = { message_id: 'msg-1', thread_id: 'thr-1' };

  it('accepts the same message ref on both tools', () => {
    expect(deleteMessageArgsSchema.safeParse(ref).success).toBe(true);
    expect(restoreMessageArgsSchema.safeParse(ref).success).toBe(true);
  });

  it('rejects a delete missing thread_id and a restore missing message_id', () => {
    expect(deleteMessageArgsSchema.safeParse({ message_id: 'msg-1' }).success).toBe(false);
    expect(restoreMessageArgsSchema.safeParse({ thread_id: 'thr-1' }).success).toBe(false);
  });

  it('rejects a hard-delete flag smuggled past the soft-delete contract', () => {
    expect(deleteMessageArgsSchema.safeParse({ ...ref, hard: true }).success).toBe(false);
  });
});

describe('archiveThreadArgs', () => {
  it('accepts a thread id and rejects an empty one', () => {
    expect(archiveThreadArgsSchema.safeParse({ thread_id: 'thr-1' }).success).toBe(true);
    expect(archiveThreadArgsSchema.safeParse({ thread_id: '' }).success).toBe(false);
  });
});

describe('updateThreadTopicsArgs', () => {
  it('accepts one to five tags', () => {
    expect(
      updateThreadTopicsArgsSchema.safeParse({ thread_id: 'thr-1', topic_tags: ['recovery'] })
        .success,
    ).toBe(true);
    expect(
      updateThreadTopicsArgsSchema.safeParse({
        thread_id: 'thr-1',
        topic_tags: ['a', 'b', 'c', 'd', 'e'],
      }).success,
    ).toBe(true);
  });

  it('rejects an empty tag set — re-categorising never strips the list grouping', () => {
    expect(
      updateThreadTopicsArgsSchema.safeParse({ thread_id: 'thr-1', topic_tags: [] }).success,
    ).toBe(false);
  });

  it('rejects a sixth tag', () => {
    expect(
      updateThreadTopicsArgsSchema.safeParse({
        thread_id: 'thr-1',
        topic_tags: ['a', 'b', 'c', 'd', 'e', 'f'],
      }).success,
    ).toBe(false);
  });
});

describe('threadReplayRef (ADR-0077)', () => {
  const base = { thread_id: 'thr-1', run_id: null, last_event_seq: 0 };

  it('accepts a reconnect with no run and a fresh sequence', () => {
    expect(threadReplayRefSchema.safeParse(base).success).toBe(true);
    expect(
      threadReplayRefSchema.safeParse({ ...base, run_id: 'run-1', last_event_seq: 12 }).success,
    ).toBe(true);
  });

  it('rejects a negative or fractional sequence', () => {
    expect(threadReplayRefSchema.safeParse({ ...base, last_event_seq: -1 }).success).toBe(false);
    expect(threadReplayRefSchema.safeParse({ ...base, last_event_seq: 1.5 }).success).toBe(false);
  });

  it('rejects a replay ref without its thread', () => {
    expect(threadReplayRefSchema.safeParse({ run_id: 'run-1', last_event_seq: 0 }).success).toBe(
      false,
    );
  });
});
