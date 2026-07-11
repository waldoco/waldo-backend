# HEY-144 Goals DO Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a transactional V2 DO SQLite goals schema and strict storage Module without widening the runtime beyond the accepted `GoalRecord` contract.

**Architecture:** `do-schema.ts` owns ordered migration and schema assertions. `GoalStore` owns the SQLite representation, strict contract parsing, and logical owner filtering behind two methods. The existing contract remains the only goal vocabulary; no prompt, Scribe, or RunLoop caller is added.

**Tech Stack:** TypeScript 5.9.3, Zod 4.4.3, Vitest 4.1.9, `@cloudflare/vitest-pool-workers` 0.16.20, Workers SQLite `SqlStorage`.

## Global Constraints

- Work from the verified Wave 0 merged-equivalent baseline; local `main` is stale.
- Own `packages/runtime/src/do-schema.ts`, `packages/runtime/test/do-schema.test.ts`, `packages/runtime/src/goals/store.ts`, `packages/runtime/test/goals-store.test.ts`, and these ticket-local planning artifacts only.
- Preserve `GoalRecord` exactly; do not edit contracts, barrels, prompt code, RunLoop, Scribe, Wrangler, bindings, manifests, lockfiles, Supabase, R2, or generated files.
- Preserve V1 verbatim. V2 DDL and its metadata record must succeed or fail together.
- No new Durable Object class or Wrangler `new_sqlite_classes` migration.
- Treat `ownerId` as logical storage filtering, never as authentication or owner-to-DO routing proof.
- Use synthetic, non-health fixtures. User-stated aspirations are allowed as bounded text; measured health fields are not.
- No live credentials, cloud mutation, deployment, provider call, or production/staging operation.

---

### Task 1: Make DO schema provisioning ordered and add V2 `goals`

**Files:**

- Modify: `packages/runtime/src/do-schema.ts`
- Modify: `packages/runtime/test/do-schema.test.ts`

**Interfaces:**

- Consumes: `DoMigration`, `DurableObjectStorage`, and V1 schema metadata.
- Produces: `DO_SCHEMA_VERSION === 2`, `DO_SCHEMA_MIGRATIONS`, V2 `goals` schema assertions, and deterministic V1 -> V2 provisioning.

- [ ] **Step 1: Write the failing V2 migration tests**

```ts
it('migrates an existing V1 database to V2 without changing a V1 row', async () => {
  // Apply V1, seed a valid V1 row, then call provisionDoSchema.
  // Assert the seed survives, version is 2, and goals exists.
});

it('rolls back a failed V2-like migration with its metadata version', async () => {
  // Start at V1 and apply a migration that creates a table then throws on a missing table.
  // Assert version remains 1 and the created table is absent.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx -y pnpm@10.34.4 --filter @waldo/runtime test -- do-schema`

Expected: FAIL because current provisioning stops at V1 and `goals` remains deferred.

- [ ] **Step 3: Write minimal ordered migration implementation**

```ts
export const HEY10_BASE_SCHEMA_MIGRATION: DoMigration = { version: 1, /* unchanged V1 */ };
export const HEY144_GOALS_SCHEMA_MIGRATION: DoMigration = { version: 2, /* goals DDL only */ };
export const DO_SCHEMA_MIGRATIONS = [
  HEY10_BASE_SCHEMA_MIGRATION,
  HEY144_GOALS_SCHEMA_MIGRATION,
] as const;

for (const migration of DO_SCHEMA_MIGRATIONS) {
  if (getSchemaVersion(storage.sql) < migration.version) applyDoMigration(storage, migration);
}
```

Keep V1 text unchanged. Add only `goals` to V2 product-table and required-column checks, remove it from the deferred table list, and run all DDL plus metadata insertion inside `transactionSync`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx -y pnpm@10.34.4 --filter @waldo/runtime test -- do-schema`

Expected: PASS, including V1 preservation, repeated provisioning, and transaction rollback.

- [ ] **Step 5: Commit**

Run: `git add packages/runtime/src/do-schema.ts packages/runtime/test/do-schema.test.ts && git commit -m "feat(runtime): add V2 goals schema"`

### Task 2: Add strict `GoalStore` persistence Module

**Files:**

- Create: `packages/runtime/src/goals/store.ts`
- Create: `packages/runtime/test/goals-store.test.ts`

**Interfaces:**

- Consumes: `GoalRecord`, `GoalWriteSource`, `goalRecordSchema`, and the V2 `goals` table.
- Produces: `GoalStore.write({ ownerId, source, goal })` and `GoalStore.readActive(ownerId)`.

- [ ] **Step 1: Write the first failing public-interface test**

```ts
it('writes a contract-valid goal and reads it only for its owner', () => {
  const store = new GoalStore(sql);
  store.write({ ownerId: 'owner-a', source: 'user_message', goal: validGoal('owner-a') });
  expect(store.readActive('owner-a')).toEqual([validGoal('owner-a')]);
  expect(store.readActive('owner-b')).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx -y pnpm@10.34.4 --filter @waldo/runtime test -- goals-store`

Expected: FAIL because `GoalStore` does not exist.

- [ ] **Step 3: Write the smallest strict storage Module**

```ts
export class GoalStore {
  constructor(private readonly sql: SqlStorage) {}

  write(input: GoalWrite): GoalRecord {
    const goal = goalRecordSchema.parse(input.goal);
    if (goal.user_id !== input.ownerId) throw new Error('Goal owner mismatch');
    // Store booleans as 0/1 and optional values as NULL using parameterized SQL.
    return goal;
  }

  readActive(ownerId: string): GoalRecord[] {
    // SELECT explicit columns WHERE user_id = ? AND active = 1 ORDER BY id.
    // Map SQLite values to contract values, safe-parse, and omit invalid rows.
  }
}
```

Validate the source with existing `goalWriteSourceSchema`; do not create source vocabulary, telemetry, an autonomous mutation path, or an external caller.

- [ ] **Step 4: Add one behavior at a time**

```ts
it('writes zero rows for an invalid or owner-mismatched candidate', () => {});
it('omits malformed, legacy, and inactive storage rows without returning their content', () => {});
it('keeps a user-stated aspiration but rejects extra measured-health fields through the strict contract', () => {});
it('survives eviction and reconstructs the same active owner rows', async () => {});
```

After each test, run the focused command and add only the implementation required for that behavior.

- [ ] **Step 5: Commit**

Run: `git add packages/runtime/src/goals/store.ts packages/runtime/test/goals-store.test.ts && git commit -m "feat(runtime): add strict goal store"`

### Task 3: Contract, adversarial, and merge-wall proof

**Files:**

- Modify only when an observed test/report correction is required: the four runtime files above and ticket-local plan/design artifacts.

**Interfaces:**

- Consumes: the V2 migration and `GoalStore` public interface.
- Produces: auditable proof that this is a storage foundation, not a live routing or prompt feature.

- [ ] **Step 1: Perform non-vacuity checks**

Temporarily demonstrate that a malformed active SQLite row and a removed owner predicate make the focused tests fail; revert the deliberate local break before continuing.

- [ ] **Step 2: Run contract and security review inputs**

Run: `rg -n "goalRecordSchema|GoalStore|goals" packages/contracts packages/runtime`

Expected: one existing contract vocabulary and one runtime storage Module; no duplicate schema or caller bypass.

- [ ] **Step 3: Run the verification wall**

Run: `npx -y pnpm@10.34.4 --filter @waldo/runtime test -- do-schema goals-store`

Run: `npx -y pnpm@10.34.4 verify`

Run: `git diff --check`

Expected: focused tests and the full wall pass. If the known unrelated runtime-suite intermittency recurs, classify and record it; do not retry silently.

- [ ] **Step 4: Run adversarial feature review**

Map empty, V1, malformed, owner-mismatch, repeated-provisioning, eviction, and failed-DDL paths; then run an independent QA break pass against those paths.

- [ ] **Step 5: Commit any test-only correction and write the handoff**

Run: `git add packages/runtime/src packages/runtime/test docs/superpowers && git commit -m "test(runtime): harden goals schema proof"`

Record final verification evidence and the explicit no-live-integration limit in the HEY-144 handoff before opening its draft PR.
