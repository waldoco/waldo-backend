# HEY-144 Goals DO Schema Design

Status: approved for implementation by the user's 2026-07-11 Wave 1 authorization.

## Current

- `GoalRecord` is already the strict contract in `packages/contracts/src/runtime/goal.ts`.
- `packages/runtime/src/do-schema.ts` provisions only V1. Its current single-migration design cannot
  safely advance to V2 by changing one version constant.
- `provisionDoSchema()` is currently a Workerd test seam, not a `RunLoopDO` constructor call. This
  slice cannot claim a live prompt or authenticated owner-routing integration.

## Decision

Adopt an ordered V1 -> V2 internal DO SQLite migration and one deep `GoalStore` Module.

The Module interface is intentionally narrow:

```ts
type GoalWrite = {
  ownerId: string;
  source: GoalWriteSource;
  goal: unknown;
};

class GoalStore {
  write(input: GoalWrite): GoalRecord;
  readActive(ownerId: string): GoalRecord[];
}
```

`write()` parses `goal` with the existing strict `goalRecordSchema`, rejects an owner mismatch, and
accepts only the existing onboarding or user-message source vocabulary. `readActive()` selects only
the requested owner, converts SQLite `0 | 1` and `NULL` values into contract values, parses every
row, and omits malformed rows. An empty array is the bounded typed absence.

This is logical owner isolation within the storage Module. It is not a substitute for the later
authenticated subject-to-DO routing seam.

## Alternatives Considered

1. Add the table directly to `RunLoopDO`.
   Rejected: it expands this schema ticket into the run-loop owner and would falsely imply live
   prompt hydration.
2. Add V2 DDL without a storage Module.
   Rejected: it cannot provide the required pre-write/post-read contract checks.
3. Add V2 DDL plus `GoalStore` behind the existing contract.
   Adopted: it keeps migration, parsing, SQLite representation, and owner filtering local.

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

An empty or V1 per-user DO database deterministically reaches V2. Valid goal rows can be stored and
retrieved through the strict Module, while malformed, inactive, or other-owner rows never become
active-goal output.

### Criteria

- [ ] ISC-1: Empty storage provisions V1 then V2 in order and reports version 2.
- [ ] ISC-2: A V1 database preserves its existing rows while V2 adds only `goals`.
- [ ] ISC-3: A failed V2 statement rolls back both V2 DDL and its metadata version.
- [ ] ISC-4: `GoalStore.write()` rejects invalid contract data, unapproved source values, and owner
  mismatch before a row is written.
- [ ] ISC-5: `GoalStore.readActive()` returns only valid active records for its owner in stable ID
  order; it excludes inactive, malformed, legacy, and another-owner rows.
- [ ] ISC-6: Eviction/reconstruction retains committed V2 goal rows.
- [ ] ISC-7 Anti: no contract, RunLoop, prompt, Scribe, Wrangler, Supabase, R2, live-provider, or
  cloud-mutation surface changes.
- [ ] ISC-8 Anti: no raw health, provider payload, prompt text, or private content appears in schema,
  tests, telemetry, or documentation fixtures.

### Test Strategy

| Criterion | Evidence | Threshold |
| --- | --- | --- |
| ISC-1,2,3 | Workerd direct-storage migration tests | exact version/table/rollback assertions |
| ISC-4,5 | `GoalStore` public-interface tests | invalid paths write zero rows; valid rows round-trip |
| ISC-6 | Workerd eviction/reconstruction test | persisted goal survives, in-memory state is irrelevant |
| ISC-7,8 | diff/source scans, contract review, privacy review | no excluded files or unsafe schema fields |

### Work Slices

| Slice | Satisfies | Depends on | Parallelism |
| --- | --- | --- | --- |
| Ordered V2 migration | ISC-1,2,3 | V1 schema source | sole schema writer |
| GoalStore Module | ISC-4,5 | V2 table, existing GoalRecord | after migration seam exists |
| Workerd proof and review | ISC-6,7,8 | both prior slices | independent reviewers only |

### Verification

- Baseline: `npx -y pnpm@10.34.4 verify` passed before edits: 1,188 contract tests and 485 runtime
  tests.
- Required closeout: focused runtime tests, complete verification wall, `git diff --check`, contract
  review, security/privacy review, and adversarial feature break pass.

### Assumptions And Falsifier

The selected storage-only interface assumes no present caller needs a live `RunLoopDO` integration.
The decision is falsified if a current accepted contract requires prompt hydration or authenticated
subject routing in this ticket; in that case the work stops for an ownership decision rather than
expanding this branch.

## Source Grounding

- Accepted ADR-0002, ADR-0005, ADR-0006, and ADR-0064 at the pinned Brain baseline.
- DeepWiki store-ownership and prompt-context pages, treated as source maps rather than runtime proof.
- Cloudflare Durable Objects SQLite storage and migrations documentation, consulted 2026-07-11.
