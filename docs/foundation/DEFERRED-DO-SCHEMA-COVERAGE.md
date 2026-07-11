# Deferred DO Schema Coverage

Status: HEY-10 scope map.
Date: 2026-07-09.

Purpose: map the DO SQLite tables deferred from HEY-10 to their owning ADRs and Linear
implementation tickets, so future work is tracked without expanding the HEY-10 base schema by
accident.

## Coverage Matrix

| Item | Why not HEY-10 | ADR/source owner | Linear owner |
| --- | --- | --- | --- |
| `runs` | Runtime execution journal, explicitly excluded from HEY-10. | ADR-0054 | HEY-110, HEY-120, HEY-121, HEY-136, HEY-139 |
| `outbox` | Delivery side-effect journal, explicitly excluded from HEY-10. | ADR-0054 | HEY-110, HEY-120, HEY-121, HEY-124, HEY-136 |
| `schedules` | Alarm multiplexer/runtime wake state, explicitly excluded from HEY-10. | ADR-0065 | HEY-123, HEY-135 |
| `daily_push_budget` | DeliveryGate policy state, not context/memory base schema. | ADR-0068 | HEY-124, HEY-137, HEY-138 |
| FTS virtual/shadow tables | Retrieval implementation detail; excluded from HEY-10's exact ten-table V1. | ADR-0031, ADR-0007 | HEY-15 |
| `goals` | Coordinator scope decision: HEY-10 stays exact 10 tables; goals land separately. | ADR-0064 | HEY-144; blocks HEY-16 |
| `memory_edges` | Future graph/activation retrieval, not needed for HEY-15 base recall. | ADR-0078 proposed | HEY-145 |
| `handoff_state` | Future Handoff plan/progress state, not current context lane. | ADR-0080 proposed | HEY-147 |
| `commitments` | Future prospective-intent state, not current context lane. | ADR-0079 proposed | HEY-146 |
| ADR-0056 retention/archive columns | Lifecycle/compaction phase, not base table provisioning. | ADR-0056 proposed | HEY-148 |

## HEY-10 Rule

HEY-10 creates exactly these 10 product tables:

1. `memory_blocks`
2. `memory_inbox`
3. `episodes`
4. `patrol_log`
5. `interventions`
6. `adjustments`
7. `skills`
8. `sheet_commits`
9. `thread_topic_index`
10. `drafts`

The schema metadata table is allowed by local migration convention and is not an owned product
table.

HEY-10 should create only source-backed tables that directly unblock HEY-15 recall, HEY-14 skill
loader, HEY-16 prompt hydration, or HEY-13 Scribe proposal lifecycle. HEY-16 can start partial
prompt hydration from the HEY-10 tables, but full goal hydration remains blocked by HEY-144.

If a table is source-backed but not needed by those flows, it should have an ADR/ticket and stay out
of HEY-10. If a table is needed by those flows but omitted from HEY-10, treat that as a scope
conflict and rescope before DDL.

## Resolved Scope Conflict

`goals` was the active conflict:

- ADR-0064 says `GoalRecord` is per-user DO SQLite state.
- `packages/contracts/src/runtime/goal.ts` defines the contract.
- `packages/contracts/src/prompt/narrative.ts` exposes `active_goals` to prompt hydration.
- HEY-10's exact table list excludes `goals`.

Coordinator resolution: keep HEY-10 as the exact 10-table base schema and make HEY-144 the
dedicated goals DDL slice. HEY-144 blocks full HEY-16 goal hydration before prompt-builder work
claims complete `active_goals` support.

Migration order: HEY-144 adds the ordered V2 internal goals migration without mutating V1. If HEY-15
still needs BM25/FTS5 after rebasing on that merge, it owns the next additive internal DO SQLite
migration. Supabase and external migrations remain out of scope for both tickets.

## Privacy Boundary

None of the deferred tables may store raw health values, provider payloads, prompt text, email
bodies, raw channel messages, OAuth tokens, cookies, or credentials. Rows should store ids,
bounded summaries, derived state, timestamps, and references to owning stores only.
