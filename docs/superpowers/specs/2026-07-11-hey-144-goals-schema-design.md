# HEY-144 Goals DO Schema Design

Status: approved for implementation by the user's 2026-07-11 Wave 1 authorization.

## Current

- `GoalRecord` is already the strict contract in `packages/contracts/src/runtime/goal.ts`.
- `packages/runtime/src/do-schema.ts` provisions only V1. Its current single-migration design cannot
  safely advance to V2 by changing one version constant.
- `provisionDoSchema()` is currently a Workerd test seam, not a `RunLoopDO` constructor call. This
  slice cannot claim a live prompt or authenticated owner-routing integration.

## Decision

Adopt an ordered V1 -> V2 internal DO SQLite migration and one deep read-only `GoalStore` Module.

The Module interface is intentionally narrow:

```ts
class GoalStore {
  readActive(ownerId: string): GoalRecord[];
}
```

`readActive()` selects only the requested owner, converts SQLite `0 | 1` and `NULL` values into
contract values, parses every row with the existing strict `goalRecordSchema`, and omits malformed
rows. An empty array is the bounded typed absence.

No public writer is introduced in this slice. ADR-0064 requires goal text to enter through
Scribe/sanitisation, but the current accepted Scribe destination vocabulary has no durable-goal
destination or owner-bound ingestion seam. `internal_context` is explicitly volatile-run context,
not approval to persist a goal. Adding a direct `write()` method would create a bypass around that
missing boundary. A later, separately accepted ingress must perform strict pre-write parsing after
an approved Scribe decision and before calling a private persistence capability.

This is logical owner isolation within the storage Module. It is not a substitute for the later
authenticated subject-to-DO routing seam.

## Alternatives Considered

1. Add the table directly to `RunLoopDO`.
   Rejected: it expands this schema ticket into the run-loop owner and would falsely imply live
   prompt hydration.
2. Add V2 DDL without a storage Module.
   Rejected: it leaves the required strict post-read normalization scattered across future callers.
3. Add V2 DDL plus a public `GoalStore.write()` behind the existing contract.
   Rejected: no accepted durable Scribe destination or authenticated owner-bound ingress exists;
   this would bypass the required sanitisation decision.
4. Add V2 DDL plus a read-only `GoalStore` behind the existing contract.
   Adopted: it keeps migration, representation, strict post-read parsing, and owner filtering local
   without pretending the write boundary is solved.

## Data Shape

The V2 `goals` table contains only the existing `GoalRecord` fields:

```text
id, user_id, description, baseline, target, progress, deadline,
active, created_at, updated_at
```

`active` is stored as `0 | 1`; optional text fields are SQLite `NULL`. No raw health columns,
provider payloads, prompt bodies, Scribe output, source text, or autonomous-mutation state is added.

## ISA Run Contract

### Ideal

An empty or V1 per-user DO database deterministically reaches V2. Committed goal rows supplied by
a future approved ingress can be retrieved through the strict Module, while malformed, inactive,
or other-owner rows never become active-goal output.

### Criteria

- [x] ISC-1: Empty storage provisions V1 then V2 in order and reports version 2.
- [x] ISC-2: A V1 database preserves its existing rows while V2 adds only `goals`.
- [x] ISC-3: A failed V2 statement rolls back both V2 DDL and its metadata version.
- [x] ISC-4: No public raw-goal writer, Scribe bypass, or unauthenticated persistence interface is
  introduced. The missing strict pre-write ingress is explicitly recorded as follow-up work.
- [x] ISC-5: `GoalStore.readActive()` returns only valid active records for its owner in stable ID
  order; it excludes inactive, malformed, legacy, and another-owner rows.
- [x] ISC-6: Eviction/reconstruction retains committed V2 goal rows.
- [x] ISC-7 Anti: no contract, RunLoop, prompt, Scribe, Wrangler, Supabase, R2, live-provider, or
  cloud-mutation surface changes.
- [x] ISC-8 Anti: no raw health, provider payload, prompt text, or private content appears in schema,
  tests, telemetry, or documentation fixtures.

### Test Strategy

| Criterion | Evidence | Threshold |
| --- | --- | --- |
| ISC-1,2,3 | Workerd direct-storage migration tests | exact version/table/rollback assertions |
| ISC-4,5 | `GoalStore` public-interface and source-boundary tests | no writer exists; committed valid rows normalize while invalid rows are omitted |
| ISC-6 | Workerd eviction/reconstruction test | persisted goal survives, in-memory state is irrelevant |
| ISC-7,8 | diff/source scans, contract review, privacy review | no excluded files or unsafe schema fields |

### Work Slices

| Slice | Satisfies | Depends on | Parallelism |
| --- | --- | --- | --- |
| Ordered V2 migration | ISC-1,2,3 | V1 schema source | sole schema writer |
| GoalStore read Module | ISC-4,5 | V2 table, existing GoalRecord | after migration seam exists |
| Workerd proof and review | ISC-6,7,8 | both prior slices | independent reviewers only |

### Verification

- Baseline: `npx -y pnpm@10.34.4 verify` passed before edits: 1,188 contract tests and 485 runtime
  tests.
- Required closeout: focused runtime tests, complete verification wall, `git diff --check`, contract
  review, security/privacy review, and adversarial feature break pass.

### Closeout Evidence — 2026-07-11

- Commits `0c76742`, `8192dda`, `885449b`, `661d55e`, `6e2f2af`, and `954ff7f` implement the V2
  migration, transactional metadata bootstrap, read-only Module, populated two-owner isolation proof,
  and registry-derived schema-version authority.
- `npx -y pnpm@10.34.4 verify` passed: typechecks, 1,188 contract tests, 493 runtime tests, and all
  repository guards. `git diff --check` passed.
- Independent schema, contract, security/privacy, health-data, workflow-mapping, and adversarial QA
  passes found no remaining P0–P3 defect after the populated two-owner test was added.
- `tools/eval/run-suite.ts` is absent; per `/run-eval`, the verification wall is the recorded fallback,
  not an eval-suite pass.
- One unrelated `test/tracer.test.ts` `scribe:invalid_payload` failure occurred during a post-mutation
  focused-suite run; the GoalStore tests passed in that run, an explicit diagnostic rerun and the final
  full wall passed, and root cause remains unverified.

### Assumptions And Falsifier

The selected storage-only interface assumes no present caller needs a live `RunLoopDO` integration.
The original ticket also calls for strict pre-write parsing; that criterion cannot be safely met
until an accepted Scribe destination and owner-bound ingress exist. The decision is falsified if a
current accepted contract establishes either seam; in that case the work stops for an ownership
decision rather than expanding this branch.

## Lightweight Learning Capture

- **Lesson:** an absent Scribe destination is a hard persistence boundary. `internal_context` is
  volatile-run context, not an implicit authorization for durable goal writes.
- **Overlap check:** ADR-0064 and this design already own the goal-state and admission boundary;
  this capture updates that existing design rather than adding a new governance rule.
- **Applicability limit:** this does not forbid a future goal writer. It requires an accepted,
  provenance-aware Scribe/admission and owner-bound ingress design before one is added.
- **Pressure scenario:** a temporary removal of `user_id = ?` made the populated two-owner test fail;
  future readers must retain a comparable cross-owner non-vacuity proof.

## Source Grounding

- Accepted ADR-0002, ADR-0005, ADR-0006, and ADR-0064 at the pinned Brain baseline.
- DeepWiki store-ownership and prompt-context pages, treated as source maps rather than runtime proof.
- Cloudflare Durable Objects SQLite storage and migrations documentation, consulted 2026-07-11.
