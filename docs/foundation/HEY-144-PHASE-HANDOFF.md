# HEY-144 Goals DO Schema Handoff

Status: local implementation and verification complete on `codex/hey-144-goals-do-schema` at
`954ff7f` before publication; no deployment, credential use, or live cloud action has been performed.
Date: 2026-07-11 IST.

## What Was Built

- Ordered V1 -> V2 internal Durable Object SQLite provisioning.
- A V2 `goals` table containing only the existing `GoalRecord` storage fields.
- Atomic metadata bootstrap, DDL, and version bookkeeping inside `transactionSync`.
- A read-only `GoalStore.readActive(ownerId)` Module with explicit owner/active filtering, stable ID
  ordering, SQLite NULL/boolean normalization, and strict post-read `goalRecordSchema.safeParse`.
- Workerd proofs for empty/V1 provisioning, V1-row preservation, failed fresh/V2-like migration
  rollback, malformed/legacy/inactive omission, populated owner isolation, and eviction survival.

## What Works (with evidence)

- V1 remains migration version 1; empty and V1 storage reach V2 deterministically. Fresh failed
  migrations retain neither metadata nor probe DDL, and V2-like failures retain V1 only.
- The store returns only the requested logical owner's active, contract-valid rows. A populated
  second owner with `owner-b' OR 1=1 --` is returned only to its bound parameterized query.
- The final local verification wall passed:

  ```sh
  npx -y pnpm@10.34.4 verify
  git diff --check
  ```

  It reported 1,188 contract tests, 493 runtime tests, all workspace typechecks, and all guards.
- Independent schema/contract, security/privacy, health-data, workflow, and adversarial QA reviews
  passed after the owner-isolation proof was strengthened.

## What Does Not Work Yet (known limits)

- There is no production goal writer, Scribe goal destination/admission, authenticated subject-to-DO
  routing, RunLoop caller, prompt hydration, or live integration. `ownerId` is a logical SQL filter,
  not an authentication claim.
- `provisionDoSchema()` remains exercised through the hermetic DO storage seam; the current
  `RunLoopDO` is intentionally not changed in this slice.
- There is no goals FTS/index/query-optimization path and no standalone eval suite at
  `tools/eval/run-suite.ts`.
- An unrelated `test/tracer.test.ts` `scribe:invalid_payload` failure appeared once during a
  post-mutation focused-suite run. GoalStore tests passed in that invocation; an explicit diagnostic
  rerun and the final full wall passed. Root cause is unverified and no tracer code changed.

## Architecture Decisions Made

- Keep V1 immutable and add V2 as an ordered internal migration; no new DO class or Wrangler
  `new_sqlite_classes` migration is required for a table added to the existing SQLite-backed class.
- Do not expose a raw writer. ADR-0064 requires Scribe/sanitisation for goal text, and the accepted
  destination vocabulary has no durable-goal destination. `internal_context` is volatile-run and is
  not persistence authorization.
- Use strict post-read parsing to contain legacy/corrupt rows, but do not invent a read-time health
  keyword filter: ADR-0064 permits user-stated numeric aspirations, and admission belongs at the
  future Scribe-backed write boundary.
- Derive the exported current schema version from the tail of the ordered migration registry, so a
  later migration cannot leave a duplicate version literal stale.

## Review Record

- Standards review found and the branch resolved the duplicate schema-version authority in
  `6e2f2af`/`954ff7f`; the final follow-up review found no residual P0–P3 issue.
- Spec review passed for the explicitly bounded storage foundation and recorded the original
  end-to-end write criterion as intentionally incomplete.
- Security/privacy and health-data review passed after the populated two-owner proof; no reachable
  raw-health, provider, prompt, logging, or external-service path was introduced.
- Workflow mapping and adversarial QA found the populated-second-owner proof gap; `661d55e` adds the
  parameterized SQL-metacharacter fixture and a recorded predicate-removal failure.
- Tracker evidence and future boundary: [HEY-144](https://linear.app/heywaldo/issue/HEY-144/schema-do-sqlite-goals-table-adr-0064-goalrecord-state-home) remains In Progress, while
  [HEY-162](https://linear.app/heywaldo/issue/HEY-162/securitybackend-goal-ingress-scribe-admission-owner-bound-persistence) owns durable goal admission.

## Hard-Won Lessons

- Migration metadata creation belongs inside the same transaction as migration DDL and version
  updates; an independent review caught the otherwise surviving fresh-storage metadata table.
- An unpopulated second-owner assertion is weaker than a two-populated-owner test. The final test
  includes a SQL-metacharacter owner ID and a temporary predicate-removal proof.

## Prerequisites for Next Work

1. Review and merge this branch before an HEY-15 rebase that needs any later schema work.
2. Before adding a goal writer or HEY-16 goal hydration, accept a provenance-aware Scribe/admission
   design that separates user intent from measured/provider facts and binds the verified owner.
3. Keep all raw health values, provider payloads, prompt bodies, and credentials out of the DO.
4. Treat the missing standalone eval runner and the observed tracer intermittency as explicit
   verification/debt items, not silently resolved by a passing rerun.

## PR Packaging Prerequisite

GitHub currently reports `main` at `a257a175d0361df5c129d73144f95ff245cb63d1`. This isolated
branch descends from local `a886a1a`, a verified tree-equivalent Wave 0 baseline, but not from that
remote commit object. Local `git fetch origin main` is unavailable in this environment
(`Repository not found`). Before publishing, use authenticated Git or the GitHub connector to
materialize the branch from remote `main`, apply this branch's intended diff, rerun the wall/remote
CI, and open a **draft** PR. Do not let GitHub compare an unrelated local base and reintroduce Wave
0 documentation into the review.

## Files Changed

- `packages/runtime/src/do-schema.ts`
- `packages/runtime/test/do-schema.test.ts`
- `packages/runtime/src/goals/store.ts`
- `packages/runtime/test/goals-store.test.ts`
- `docs/superpowers/specs/2026-07-11-hey-144-goals-schema-design.md`
- `docs/superpowers/plans/2026-07-11-hey-144-goals-schema.md`
- `docs/foundation/HEY-144-PHASE-HANDOFF.md`
