// Owning ADRs: ADR-0031 (recall-before-act: RecallResult, per-trigger fan-out config, query
// construction, <recall> rendering) extended by ADR-0046 (union read: source_trust on every
// hit, dominates()-computed conflict pairs, MAX_RENDERED_CONFLICTS cap).
// Invariant under test: recall is a deterministic contract — pinned config/signal tables,
// pinned renderer literals, and a renderer that consults the same dominates() as the Scribe
// merge, so it can never promise a supersede the merge would refuse.
// Failure mode caught: config/signal/literal drift from the ADR-pinned values, a hit shape
// losing source_trust (silently reverting to the pre-union-read contract), rank fields
// drifting back to the legacy vector channel, conflict ordering the authority arm does not
// gate, or an unbounded conflict section accreting into every prompt.
import { describe, expect, it } from 'vitest';
import { briefVariantSchema, triggerTypeSchema } from '../core/trigger';
import { hallAdmits } from './hall';
import { MAX_RENDERED_CONFLICTS } from './trust';
import type { DominanceAuthority } from './trust';
import {
  buildRecallQuery,
  conflictCommittedSchema,
  conflictPairSchema,
  evolutionHitSchema,
  RECALL_CONFIG,
  RECALL_QUERY_MAX_CHARS,
  recallConfigSchema,
  recallKeySchema,
  recallMemoryHitSchema,
  recallResultSchema,
  recallStatusSchema,
  renderRecall,
  retrieveArgsSchema,
  retrieveHitSchema,
  TRIGGER_SIGNAL,
} from './recall';

const permissive: DominanceAuthority = { inDomain: () => true, hallAdmits: () => true };
// The authority the Scribe merge injects: real hall-ACL arm, in-domain source.
const mergeAuthority: DominanceAuthority = { inDomain: () => true, hallAdmits };

const baseHit = {
  hall_type: 'facts',
  content: 'user wakes early on weekdays',
  confidence: 0.8,
  valid_from: '2026-06-20T07:00:00Z',
  source_trust: 'memory_committed',
} as const;

const baseArgs = { query: 'afternoon focus', halls: ['facts'], limit: 5 } as const;

const baseRetrieveHit = { ...baseHit, bm25_rank: 1, temporal_rank: 3, rrf_score: 0.03 } as const;

const emptyResult = recallResultSchema.parse({
  memory_hits: [],
  episode_hits: [],
  evolution_hits: [],
  query_used: 'user-initiated conversation',
  duration_ms: 0,
});

const basePair = {
  pending: {
    source_trust: 'system_of_record',
    observed_at: '2026-07-01T09:00:00Z',
    source: 'calendar',
    content: 'standup moved to 10:00',
  },
  committed: {
    source_trust: 'memory_committed',
    valid_from: '2026-06-28T08:00:00Z',
    pattern_id: 'f3a92c4b18e7',
    hall_type: 'events',
    content: 'standup is at 09:30',
    source: 'calendar',
    last_synced_at: '2026-06-30T22:00:00Z',
  },
} as const;

describe('recallKey', () => {
  it('is exactly the thirteen ADR-0031 table rows, in order', () => {
    expect(recallKeySchema.options).toEqual([
      'brief_morning',
      'brief_midday',
      'brief_evening',
      'brief_event',
      'fetch_alert',
      'patrol',
      'intervention',
      'user_message',
      'handoff_explore',
      'handoff_plan',
      'handoff_act',
      'handoff_replan',
      'dreaming_mode',
    ]);
  });

  it('rejects pre_activity_spot — no ratified recall row exists for it', () => {
    expect(recallKeySchema.safeParse('pre_activity_spot').success).toBe(false);
  });

  it('brief keys cover exactly the brief variants; every other key is a canonical trigger', () => {
    const keys = recallKeySchema.options;
    expect(keys.filter((k) => k.startsWith('brief_'))).toEqual(
      briefVariantSchema.options.map((v) => `brief_${v}`),
    );
    for (const k of keys.filter((k) => !k.startsWith('brief_'))) {
      expect(triggerTypeSchema.options).toContain(k);
    }
  });
});

describe('recallStatus', () => {
  it('is exactly failed | partial | ok, in order', () => {
    expect(recallStatusSchema.options).toEqual(['failed', 'partial', 'ok']);
  });

  it('rejects an out-of-domain status', () => {
    expect(recallStatusSchema.safeParse('skipped').success).toBe(false);
  });
});

describe('recallMemoryHit — the union-read hit shape', () => {
  it('accepts a well-formed hit', () => {
    expect(recallMemoryHitSchema.safeParse(baseHit).success).toBe(true);
  });

  it('rejects the pre-union-read shape missing source_trust (ADR-0046 requires it on every hit)', () => {
    const legacyHit = {
      hall_type: 'facts',
      content: 'user wakes early on weekdays',
      confidence: 0.8,
      valid_from: '2026-06-20T07:00:00Z',
    };
    expect(recallMemoryHitSchema.safeParse(legacyHit).success).toBe(false);
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(recallMemoryHitSchema.safeParse({ ...baseHit, confidence: 1.2 }).success).toBe(false);
  });

  it('rejects a non-datetime valid_from', () => {
    expect(recallMemoryHitSchema.safeParse({ ...baseHit, valid_from: '2026-06-20' }).success).toBe(
      false,
    );
  });

  it('rejects rank fields — ranks are gateway-internal, hits are prompt-destined', () => {
    expect(recallMemoryHitSchema.safeParse({ ...baseHit, rrf_score: 0.03 }).success).toBe(false);
  });
});

describe('evolutionHit', () => {
  it('accepts a hit with a structured change_value', () => {
    expect(
      evolutionHitSchema.safeParse({
        change_type: 'tone_shift',
        change_value: { direction: 'more direct' },
        source: 'dreaming_mode',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty change_type', () => {
    expect(
      evolutionHitSchema.safeParse({ change_type: '', change_value: 1, source: 's' }).success,
    ).toBe(false);
  });

  it('rejects an unknown extra key', () => {
    expect(
      evolutionHitSchema.safeParse({
        change_type: 'tone_shift',
        change_value: 1,
        source: 's',
        applied: true,
      }).success,
    ).toBe(false);
  });
});

describe('recallResult', () => {
  const populated = {
    memory_hits: [baseHit],
    episode_hits: [{ date: '2026-06-01T00:00:00Z', summary: 'long focus block', fts_rank: -2.5 }],
    evolution_hits: [{ change_type: 'tone_shift', change_value: 1, source: 's' }],
    query_used: 'user-initiated conversation',
    duration_ms: 12,
  };

  it('accepts a populated result', () => {
    expect(recallResultSchema.safeParse(populated).success).toBe(true);
  });

  it('fail-open: empty hits with a populated query_used are a valid result, not an error shape', () => {
    expect(recallResultSchema.safeParse(emptyResult).success).toBe(true);
  });

  it('rejects an empty query_used — the trigger signal always contributes', () => {
    expect(recallResultSchema.safeParse({ ...populated, query_used: '' }).success).toBe(false);
  });

  it('rejects a negative duration_ms', () => {
    expect(recallResultSchema.safeParse({ ...populated, duration_ms: -1 }).success).toBe(false);
  });

  it('rejects a fractional duration_ms', () => {
    expect(recallResultSchema.safeParse({ ...populated, duration_ms: 1.5 }).success).toBe(false);
  });

  it('episode_hits share the ./episode element shape — a hit missing fts_rank is rejected', () => {
    expect(
      recallResultSchema.safeParse({
        ...populated,
        episode_hits: [{ date: '2026-06-01T00:00:00Z', summary: 'long focus block' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown extra key', () => {
    expect(recallResultSchema.safeParse({ ...populated, recall_status: 'ok' }).success).toBe(false);
  });
});

describe('retrieveArgs', () => {
  it('accepts the default active-rows read', () => {
    expect(retrieveArgsSchema.safeParse(baseArgs).success).toBe(true);
  });

  it('accepts a point-in-time full-chain read (as_of + include_superseded)', () => {
    expect(
      retrieveArgsSchema.safeParse({
        ...baseArgs,
        as_of: '2026-06-15T09:00:00Z',
        include_superseded: true,
      }).success,
    ).toBe(true);
  });

  it('rejects empty halls — the fan-out never calls retrieve hall-less', () => {
    expect(retrieveArgsSchema.safeParse({ ...baseArgs, halls: [] }).success).toBe(false);
  });

  it('rejects a hall outside the five (goals is not a hall)', () => {
    expect(retrieveArgsSchema.safeParse({ ...baseArgs, halls: ['goals'] }).success).toBe(false);
  });

  it('rejects include_superseded false — the exclusion default has one representation: key absent', () => {
    expect(
      retrieveArgsSchema.safeParse({ ...baseArgs, include_superseded: false }).success,
    ).toBe(false);
  });

  it('rejects a non-positive limit', () => {
    expect(retrieveArgsSchema.safeParse({ ...baseArgs, limit: 0 }).success).toBe(false);
  });
});

describe('retrieveHit — BM25 + temporal + RRF rank fields', () => {
  it('accepts a ranked hit', () => {
    expect(retrieveHitSchema.safeParse(baseRetrieveHit).success).toBe(true);
  });

  it('rejects the legacy vector channel — fusion is BM25 + temporal + RRF (ADR-0031)', () => {
    expect(retrieveHitSchema.safeParse({ ...baseRetrieveHit, vector_rank: 2 }).success).toBe(
      false,
    );
  });

  it('rejects a missing temporal_rank', () => {
    const { temporal_rank: _temporal, ...withoutTemporal } = baseRetrieveHit;
    expect(retrieveHitSchema.safeParse(withoutTemporal).success).toBe(false);
  });

  it('rejects rank 0 — channel ranks are 1-based positions', () => {
    expect(retrieveHitSchema.safeParse({ ...baseRetrieveHit, bm25_rank: 0 }).success).toBe(false);
  });

  it('rejects a non-positive rrf_score', () => {
    expect(retrieveHitSchema.safeParse({ ...baseRetrieveHit, rrf_score: 0 }).success).toBe(false);
  });
});

describe('recallConfig', () => {
  it('accepts a fan-out row', () => {
    expect(
      recallConfigSchema.safeParse({
        skip: false,
        halls: ['events'],
        episodes_days: 1,
        evolutions: false,
      }).success,
    ).toBe(true);
  });

  it('rejects a skip row that still selects halls — skip-yet-query is unrepresentable', () => {
    expect(
      recallConfigSchema.safeParse({
        skip: true,
        halls: ['events'],
        episodes_days: 0,
        evolutions: false,
      }).success,
    ).toBe(false);
  });

  it('rejects a skip row that still selects episodes', () => {
    expect(
      recallConfigSchema.safeParse({ skip: true, halls: [], episodes_days: 1, evolutions: false })
        .success,
    ).toBe(false);
  });
});

describe('RECALL_CONFIG — ADR-0031 hall-selection table drift guard', () => {
  it('every row parses its own schema', () => {
    for (const key of recallKeySchema.options) {
      expect(recallConfigSchema.safeParse(RECALL_CONFIG[key]).success).toBe(true);
    }
  });

  it('matches the pinned table exactly', () => {
    expect(RECALL_CONFIG).toEqual({
      brief_morning: {
        skip: false,
        halls: ['facts', 'events', 'preferences', 'advice'],
        episodes_days: 7,
        evolutions: true,
      },
      brief_midday: {
        skip: false,
        halls: ['events', 'preferences'],
        episodes_days: 1,
        evolutions: false,
      },
      brief_evening: {
        skip: false,
        halls: ['events', 'discoveries', 'advice'],
        episodes_days: 1,
        evolutions: false,
      },
      brief_event: { skip: false, halls: ['events', 'advice'], episodes_days: 7, evolutions: false },
      fetch_alert: { skip: false, halls: ['facts', 'advice'], episodes_days: 14, evolutions: true },
      patrol: { skip: false, halls: ['events'], episodes_days: 1, evolutions: false },
      intervention: { skip: false, halls: ['facts', 'advice'], episodes_days: 14, evolutions: true },
      user_message: {
        skip: false,
        halls: ['facts', 'events', 'discoveries', 'preferences', 'advice'],
        episodes_days: 30,
        evolutions: true,
      },
      handoff_explore: {
        skip: false,
        halls: ['facts', 'preferences', 'advice'],
        episodes_days: 14,
        evolutions: true,
      },
      handoff_plan: {
        skip: false,
        halls: ['preferences', 'advice'],
        episodes_days: 7,
        evolutions: false,
      },
      handoff_act: { skip: true, halls: [], episodes_days: 0, evolutions: false },
      handoff_replan: {
        skip: false,
        halls: ['events', 'preferences'],
        episodes_days: 1,
        evolutions: true,
      },
      dreaming_mode: { skip: true, halls: [], episodes_days: 0, evolutions: false },
    });
  });
});

describe('TRIGGER_SIGNAL — ADR-0031 query-signal drift guard', () => {
  it('matches the pinned strings exactly', () => {
    expect(TRIGGER_SIGNAL).toEqual({
      brief_morning: 'morning briefing waking-up',
      brief_midday: 'midday brief',
      brief_evening: 'evening close day-review',
      brief_event: 'event brief',
      fetch_alert: 'acute stress alert intervention needed',
      patrol: 'background analysis observation',
      intervention: 'overload check-in user-pushing-too-hard',
      user_message: 'user-initiated conversation',
      handoff_explore: 'exploring options for day plan',
      handoff_plan: 'proposing day plan',
      handoff_act: 'executing approved actions',
      handoff_replan: 'mid-day plan adjustment',
      dreaming_mode: 'nightly consolidation reflection',
    });
  });
});

describe('buildRecallQuery', () => {
  it('joins trigger signal, zone signal, and hint with the pinned separator', () => {
    expect(buildRecallQuery('fetch_alert', 'flagging form', 'breathing exercise')).toBe(
      'acute stress alert intervention needed · flagging form · breathing exercise',
    );
  });

  it('drops an empty zone signal and an absent hint — no dangling separators', () => {
    expect(buildRecallQuery('patrol', '')).toBe('background analysis observation');
  });

  it('caps the query at RECALL_QUERY_MAX_CHARS (the ~200-token bound)', () => {
    expect(RECALL_QUERY_MAX_CHARS).toBe(800);
    expect(buildRecallQuery('user_message', '', 'x'.repeat(2_000))).toHaveLength(800);
  });

  it('a skip trigger still yields a query — query_used is populated even without fan-out', () => {
    expect(buildRecallQuery('handoff_act', '')).toBe('executing approved actions');
  });
});

describe('conflictPair', () => {
  it('accepts a well-formed pair', () => {
    expect(conflictPairSchema.safeParse(basePair).success).toBe(true);
  });

  it('rejects a committed leg missing last_synced_at — freshness needs an explicit null', () => {
    const { last_synced_at: _sync, ...withoutSync } = basePair.committed;
    expect(conflictCommittedSchema.safeParse(withoutSync).success).toBe(false);
  });

  it('rejects an unknown extra key on a leg', () => {
    expect(
      conflictPairSchema.safeParse({
        ...basePair,
        pending: { ...basePair.pending, winner: true },
      }).success,
    ).toBe(false);
  });
});

describe('renderRecall — ADR-0031 fencing + ADR-0046 conflict pairs', () => {
  it('renders the pinned empty block verbatim', () => {
    expect(renderRecall(emptyResult, [], mergeAuthority)).toBe(
      '<recall>\n[Consulted memory before acting]\nNo relevant memory or history surfaced for this context.\n</recall>',
    );
  });

  it('renders memory, episode, and evolution sections in the pinned format', () => {
    const result = recallResultSchema.parse({
      memory_hits: [baseHit],
      episode_hits: [{ date: '2026-06-01T00:00:00Z', summary: 'long focus block', fts_rank: -2.5 }],
      evolution_hits: [
        { change_type: 'tone_shift', change_value: { direction: 'more direct' }, source: 's' },
      ],
      query_used: 'user-initiated conversation',
      duration_ms: 12,
    });
    expect(renderRecall(result, [], mergeAuthority)).toBe(
      '<recall>\n' +
        '[Consulted memory before acting]\n' +
        '\nMemory blocks (1):\n' +
        '  - [facts] (conf: 0.80) user wakes early on weekdays\n' +
        '\nEpisodes (1):\n' +
        '  - [2026-06-01T00:00:00Z] long focus block\n' +
        '\nUnapplied behavioral evolutions (1):\n' +
        '  - tone_shift: {"direction":"more direct"}\n' +
        '</recall>',
    );
  });

  it('a merge-admissible pending renders first, committed tagged stale', () => {
    const pair = conflictPairSchema.parse(basePair);
    expect(renderRecall(emptyResult, [pair], mergeAuthority)).toBe(
      '<recall>\n' +
        '[Consulted memory before acting]\n' +
        '\nOpen conflicts (1):\n' +
        '  - standup moved to 10:00\n' +
        '  - [stale — superseding update pending] standup is at 09:30\n' +
        '</recall>',
    );
  });

  it('never emits the stale tag for a proposal the merge would refuse (comparator unity, hall-ACL arm)', () => {
    // user_stated outranks memory_committed and is newer — but the discoveries hall admits
    // no user_stated writer, so the merge would refuse the supersede. Same pair, permissive
    // authority: stale. Real hall ACL: provisional. The renderer consults the authority arm.
    const pair = conflictPairSchema.parse({
      pending: {
        source_trust: 'user_stated',
        observed_at: '2026-07-01T09:00:00Z',
        source: 'chat',
        content: 'mondays are actually fine',
      },
      committed: {
        source_trust: 'memory_committed',
        valid_from: '2026-06-20T00:00:00Z',
        pattern_id: 'f3a92c4b18e7',
        hall_type: 'discoveries',
        content: 'form dips on mondays',
        source: 'dreaming_mode',
        last_synced_at: null,
      },
    });
    expect(renderRecall(emptyResult, [pair], permissive)).toContain('[stale');
    const rendered = renderRecall(emptyResult, [pair], mergeAuthority);
    expect(rendered).not.toContain('[stale');
    expect(rendered).toContain('  - form dips on mondays\n  - [provisional] mondays are actually fine');
  });

  it('user statement newer than the last SoR sync renders the freshness-annotated pair', () => {
    const pair = conflictPairSchema.parse({
      ...basePair,
      pending: {
        source_trust: 'user_stated',
        observed_at: '2026-07-01T09:00:00Z',
        source: 'chat',
        content: 'that standup just got cancelled',
      },
      committed: { ...basePair.committed, source_trust: 'system_of_record' },
    });
    expect(renderRecall(emptyResult, [pair], mergeAuthority)).toBe(
      '<recall>\n' +
        '[Consulted memory before acting]\n' +
        '\nOpen conflicts (1):\n' +
        '  - [user-reported — awaiting calendar sync] that standup just got cancelled\n' +
        '  - [last synced 2026-06-30T22:00:00Z] standup is at 09:30\n' +
        '</recall>',
    );
  });

  it('a user statement older than the last sync gets no freshness overlay — provisional instead', () => {
    const pair = conflictPairSchema.parse({
      ...basePair,
      pending: {
        source_trust: 'user_stated',
        observed_at: '2026-06-30T08:00:00Z',
        source: 'chat',
        content: 'that standup just got cancelled',
      },
      committed: { ...basePair.committed, source_trust: 'system_of_record' },
    });
    const rendered = renderRecall(emptyResult, [pair], mergeAuthority);
    expect(rendered).not.toContain('[user-reported');
    expect(rendered).toContain('[provisional] that standup just got cancelled');
  });

  it('caps open conflict pairs at MAX_RENDERED_CONFLICTS, keeping the most recent', () => {
    const pairAt = (observedAt: string, content: string) =>
      conflictPairSchema.parse({
        ...basePair,
        pending: { ...basePair.pending, observed_at: observedAt, content },
      });
    const rendered = renderRecall(
      emptyResult,
      [
        pairAt('2026-07-01T07:00:00Z', 'oldest correction'),
        pairAt('2026-07-01T09:00:00Z', 'newest correction'),
        pairAt('2026-07-01T08:00:00Z', 'middle correction'),
      ],
      mergeAuthority,
    );
    expect(MAX_RENDERED_CONFLICTS).toBe(2);
    expect(rendered).toContain(`\nOpen conflicts (${MAX_RENDERED_CONFLICTS}):\n`);
    expect(rendered).toContain('newest correction');
    expect(rendered).toContain('middle correction');
    expect(rendered).not.toContain('oldest correction');
  });
});
