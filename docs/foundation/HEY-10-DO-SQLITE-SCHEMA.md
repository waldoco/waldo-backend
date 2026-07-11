# HEY-10 DO SQLite Schema

Status: implemented in `packages/runtime/src/do-schema.ts`; merged via PR #37 at `7980aad`.
Date: 2026-07-09.

## Positioning

HEY-10 provisions per-DO local working, semantic, procedural, thread-index, and audit-safe draft
state for proactive agent context. It is not raw health storage and not the run journal.

## Scope

Build in HEY-10:

- `memory_blocks`, `memory_inbox`, `episodes`
- `patrol_log`, `interventions`, `adjustments`
- `skills`
- `sheet_commits`, `thread_topic_index`, `drafts`
- `do_schema_migrations` as metadata only

Do not build in HEY-10:

- `goals`; not built in HEY-10. HEY-144's separate V2 storage foundation is now merged, while
  HEY-162 still gates full HEY-16 goal hydration
- `runs`, `outbox`, `schedules`, `daily_push_budget`
- `memory_edges`, `commitments`, `handoff_state`
- FTS virtual/shadow tables
- ADR-0056 compaction/archive columns

Follow-on order: HEY-144 added the V2 goals migration in PR #52; HEY-15 may own a later additive
internal FTS migration after rebasing on that storage seam. Neither ticket changes this V1 migration
or adds a Supabase/external migration. HEY-162 remains the durable admission prerequisite for full
goal hydration.

## DDL Plan

| Table | Flow enabled | Downstream unblocker | Owner | Hot access | DO SQLite reason | Retention/privacy note |
| --- | --- | --- | --- | --- | --- | --- |
| `memory_blocks` | brief/patrol recall-before-act | HEY-15, HEY-16 | Scribe merge | active rows by user/hall/pattern | single-writer committed memory with partial active-pattern invariant | bounded text only; no raw health |
| `memory_inbox` | Scribe proposal lifecycle | HEY-13, HEY-15 | Scribe inbox | open proposals by user | local staged proposals before merge | sanitised content + provenance ids |
| `episodes` | recent episode recall | HEY-15 | Scribe/context runtime | user/time range | DO-local recent context, FTS deferred | summaries only; archive/compaction deferred |
| `patrol_log` | Patrol observations | HEY-13, HEY-15 | Patrol/Scribe | user/time range | local append-only context observations | derived summaries only |
| `interventions` | intervention evidence and outcomes | HEY-15, HEY-16 | intervention runtime | user/proposed time | local append-only intervention memory | derived load/form, not sensor values |
| `adjustments` | reversible adjustment provenance | HEY-13, HEY-16 | adjustment runtime | user/time/idempotency | local proposal/execution provenance | no provider payloads or credentials |
| `skills` | skill/prompt hydration | HEY-14, HEY-16 | skill curator/loader | active skills by status/effectiveness | low-latency prompt selection state | skill bodies pass sanitiser contract |
| `sheet_commits` | sheet write idempotency/undo audit | HEY-13, HEY-16 | sheet adapter runtime | commit hash, user/expiry | 24h local LRU around confirmed writes | provider refs/value JSON only at adapter seam |
| `thread_topic_index` | chat/fetch thread continuity | HEY-16 | thread routing runtime | user/topic/active/time | local topic-to-thread index, not chat history | no raw message bodies |
| `drafts` | user-visible draft audit residue | HEY-13, HEY-16 | email adapter runtime | user/idempotency/time | local dedup/list residue | recipient count only; no body/recipients |

## Invariants

- Provisioning is idempotent.
- Migration application uses `DurableObjectStorage.transactionSync`; schema version updates only
  after DDL succeeds.
- `assertDoSchema` reports typed missing-table and missing-column drift.
- The product table set is exactly the HEY-10 list above.
- Raw-health-looking columns are absent.
- `memory_blocks` carries `pattern_id`, `rejection_count`, `decision_log`,
  `rolled_back_from`, `valid_from`, `valid_to`, and `superseded_by`.

## Deferred Map

The deferred items and their Linear owners live in
`docs/foundation/DEFERRED-DO-SCHEMA-COVERAGE.md`.
