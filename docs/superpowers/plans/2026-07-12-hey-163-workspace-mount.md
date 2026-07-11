# HEY-163 WorkspaceMount Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add the accepted typed WorkspaceMount contract and conformance tests that unblock HEY-14 without exposing R2 storage identity.

**Architecture:** adapters/workspace.ts is the sole deep contract module. It turns a small closed logical workspace vocabulary into a five-method, already owner-bound mount interface. It contains all boundary schemas; no provider adapter, owner routing, raw key, or R2 binding is introduced.

**Tech Stack:** TypeScript 5.9.3, Zod 4.4.3, Vitest 4.1.9.

## Global Constraints

- ADR-0029 makes packages/contracts the contract owner; ADR-0076 fixes the typed five-method mount and rejects raw R2/filesystem access.
- Create only packages/contracts/src/adapters/workspace.ts and packages/contracts/src/adapters/workspace.test.ts; modify only packages/contracts/src/index.ts plus HEY-163 planning/handoff evidence.
- A mount is already owner-bound. No public method/schema accepts or emits a user id, bucket name, object key, raw prefix, or R2Bucket.
- WorkspaceFile is a closed logical descriptor, never a string path: today, baselines, patterns, or user_skill with the existing SkillName schema.
- Retain staged write/commit/discard types only; do not add a writer, Scribe destination change, R2 adapter, Wrangler binding, deployment, public endpoint, or deletion flow.
- Use synthetic non-health bytes and opaque test tokens only. Preserve the deliberate rejection of workspace_file in memory/sanitise.ts.

---

### Task 1: Add closed file descriptors, opaque values, and barrel export

**Files:**

- Create: packages/contracts/src/adapters/workspace.ts
- Create: packages/contracts/src/adapters/workspace.test.ts
- Modify: packages/contracts/src/index.ts

**Interfaces:**

- Consumes: skillNameSchema and SkillName from packages/contracts/src/prompt/skill.ts.
- Produces: typed descriptors/opaque values and the five-method WorkspaceMount interface.

- [x] **Step 1: Write the first failing public-contract test**

    import { describe, expect, it } from 'vitest';
    import { workspaceFileSchema } from './workspace';

    it('admits only logical static files and a kebab-case user skill descriptor', () => {
      expect(workspaceFileSchema.parse({ kind: 'today' })).toEqual({ kind: 'today' });
      expect(workspaceFileSchema.parse({ kind: 'user_skill', name: 'weekly-review' })).toEqual({
        kind: 'user_skill',
        name: 'weekly-review',
      });
    });

- [x] **Step 2: Run RED**

Run: npx -y pnpm@10.34.4 --filter @waldo/contracts test -- workspace

Expected: FAIL because ./workspace does not exist.

- [x] **Step 3: Write the minimal public contract**

    import { z } from 'zod';
    import { skillNameSchema } from '../prompt/skill';

    export const workspaceFileSchema = z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('today') }),
      z.strictObject({ kind: z.literal('baselines') }),
      z.strictObject({ kind: z.literal('patterns') }),
      z.strictObject({ kind: z.literal('user_skill'), name: skillNameSchema }),
    ]);
    export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

    export const workspacePrefixSchema = z.strictObject({ kind: z.literal('user_skills') });
    export type WorkspacePrefix = z.infer<typeof workspacePrefixSchema>;

    export const workspaceVersionSchema = z.string().min(1).brand<'WorkspaceVersion'>();
    export type WorkspaceVersion = z.infer<typeof workspaceVersionSchema>;

    export const workspaceWriteIdSchema = z.string().min(1).brand<'WorkspaceWriteId'>();
    export type WorkspaceWriteId = z.infer<typeof workspaceWriteIdSchema>;

    export const workspaceBlobSchema = z.strictObject({
      bytes: z.instanceof(Uint8Array),
      version: workspaceVersionSchema,
    });
    export type WorkspaceBlob = z.infer<typeof workspaceBlobSchema>;

    export const workspaceWriteOptionsSchema = z.strictObject({
      expected_version: workspaceVersionSchema.optional(),
    });
    export type WorkspaceWriteOptions = z.infer<typeof workspaceWriteOptionsSchema>;

    export const stagedWorkspaceWriteSchema = z.strictObject({ write_id: workspaceWriteIdSchema });
    export type StagedWorkspaceWrite = z.infer<typeof stagedWorkspaceWriteSchema>;

    export interface WorkspaceMount {
      readFile(file: WorkspaceFile): Promise<WorkspaceBlob>;
      writeFile(
        file: WorkspaceFile,
        content: WorkspaceBlob,
        options?: WorkspaceWriteOptions,
      ): Promise<StagedWorkspaceWrite>;
      list(prefix: WorkspacePrefix): Promise<WorkspaceFile[]>;
      commit(writeId: WorkspaceWriteId): Promise<void>;
      discard(writeId: WorkspaceWriteId): Promise<void>;
    }

Use `WorkspaceBlob` in `writeFile` exactly as accepted ADR-0076 specifies. Its opaque version
travels with the content value; `expected_version` remains the optional optimistic-concurrency
guard. Do not add a path string, owner argument, storage metadata field, or provider dependency.

- [x] **Step 4: Export and run GREEN**

Append exactly this to packages/contracts/src/index.ts:

    export * from './adapters/workspace';

Run: npx -y pnpm@10.34.4 --filter @waldo/contracts test -- workspace

Expected: PASS.

- [x] **Step 5: Commit tracer slice**

Run: git add packages/contracts/src/adapters/workspace.ts packages/contracts/src/adapters/workspace.test.ts packages/contracts/src/index.ts && git commit -m "feat(contracts): add typed workspace mount seam"

### Task 2: Prove fake usability and reject generic storage identity

**Files:**

- Modify: packages/contracts/src/adapters/workspace.test.ts
- Modify only if a failing hardening test reveals a narrow schema omission: packages/contracts/src/adapters/workspace.ts

**Interfaces:**

- Consumes: the Task 1 public contract.
- Produces: fake-first usability evidence for HEY-14 and adversarial no-path/no-storage-identity proof.

- [x] **Step 1: Add fake-mount behavior test**

    import type { WorkspaceMount } from '../index';
    import {
      stagedWorkspaceWriteSchema,
      workspaceBlobSchema,
      workspacePrefixSchema,
      workspaceVersionSchema,
      workspaceWriteIdSchema,
      workspaceWriteOptionsSchema,
    } from './workspace';

    it('lets a fake owner-bound mount use opaque versions and staged ids', async () => {
      const version = workspaceVersionSchema.parse('v-test-1');
      const content = workspaceBlobSchema.parse({ bytes: Uint8Array.of(2), version });
      const fakeMount: WorkspaceMount = {
        readFile: async () => workspaceBlobSchema.parse({ bytes: Uint8Array.of(1), version }),
        writeFile: async (_file, receivedContent, options) => {
          expect(receivedContent).toEqual(content);
          expect(options).toEqual({ expected_version: version });
          return stagedWorkspaceWriteSchema.parse({ write_id: 'stage-1' });
        },
        list: async () => [{ kind: 'user_skill', name: 'weekly-review' }],
        commit: async () => undefined,
        discard: async () => undefined,
      };
      expect(await fakeMount.list({ kind: 'user_skills' })).toEqual([
        { kind: 'user_skill', name: 'weekly-review' },
      ]);
      expect(workspaceWriteOptionsSchema.parse({ expected_version: version })).toEqual({
        expected_version: version,
      });
      await expect(
        fakeMount.writeFile({ kind: 'today' }, content, { expected_version: version }),
      ).resolves.toEqual({ write_id: 'stage-1' });
    });

- [x] **Step 2: Add adversarial strict-schema tests**

    it('rejects raw paths, traversal-like names, unknown kinds, and hidden object keys', () => {
      expect(workspaceFileSchema.parse({ kind: 'baselines' })).toEqual({ kind: 'baselines' });
      expect(workspaceFileSchema.parse({ kind: 'patterns' })).toEqual({ kind: 'patterns' });
      expect(workspaceFileSchema.safeParse('skills/user/weekly-review.md').success).toBe(false);
      expect(workspaceFileSchema.safeParse({ kind: 'user_skill', name: '../weekly-review' }).success).toBe(false);
      expect(workspaceFileSchema.safeParse({ kind: 'archive', name: 'manifest' }).success).toBe(false);
      expect(workspaceFileSchema.safeParse({ kind: 'today', object_key: 'secret' }).success).toBe(false);
    });

    it('rejects generic prefixes and storage identity hidden in result objects', () => {
      expect(workspacePrefixSchema.parse({ kind: 'user_skills' })).toEqual({ kind: 'user_skills' });
      expect(workspacePrefixSchema.safeParse({ kind: 'archive' }).success).toBe(false);
      expect(workspaceVersionSchema.safeParse('').success).toBe(false);
      expect(workspaceWriteIdSchema.safeParse('').success).toBe(false);
      expect(workspaceBlobSchema.parse({ bytes: Uint8Array.of(1), version: 'v1' }).bytes).toEqual(
        Uint8Array.of(1),
      );
      expect(workspaceBlobSchema.safeParse({ bytes: [1], version: 'v1' }).success).toBe(false);
      expect(workspaceBlobSchema.safeParse({ bytes: Uint8Array.of(1), version: 'v1', bucket: 'r2' }).success).toBe(false);
      expect(workspaceWriteOptionsSchema.safeParse({ expected_version: '' }).success).toBe(false);
      expect(workspaceWriteOptionsSchema.safeParse({ owner_id: 'user-a' }).success).toBe(false);
      expect(stagedWorkspaceWriteSchema.parse({ write_id: 's1' })).toEqual({ write_id: 's1' });
      expect(stagedWorkspaceWriteSchema.safeParse({ write_id: '' }).success).toBe(false);
      expect(stagedWorkspaceWriteSchema.safeParse({ write_id: 's1', owner_id: 'user-a' }).success).toBe(false);
    });

- [x] **Step 3: Execute vertical RED/GREEN cycles**

After each new test, run npx -y pnpm@10.34.4 --filter @waldo/contracts test -- workspace. Each new Zod schema must have one valid and one invalid test before this task is complete. If an assertion unexpectedly passes, tighten only the precise strict schema; never blacklist storage-key spellings.

- [x] **Step 4: Prove non-vacuity**

Temporarily replace one relevant z.strictObject with z.object, run the matching extra-key test, confirm failure, then restore the strict schema before continuing. Do not commit the deliberate break.

- [x] **Step 5: Run walls and commit**

Run:

    npx -y pnpm@10.34.4 --filter @waldo/contracts test -- workspace
    npx -y pnpm@10.34.4 --filter @waldo/contracts typecheck
    npx -y pnpm@10.34.4 verify
    git diff --check
    git add packages/contracts/src/adapters/workspace.ts packages/contracts/src/adapters/workspace.test.ts docs/superpowers/specs/2026-07-12-hey-163-workspace-mount-design.md docs/superpowers/plans/2026-07-12-hey-163-workspace-mount.md
    git commit -m "test(contracts): harden workspace mount boundary"

**Task 2 evidence (2026-07-12):** A fake owner-bound mount typechecks with all five methods. The
focused workspace run passed 49 files / 1,190 tests after each added test slice; contracts
typecheck and the full `npx -y pnpm@10.34.4 verify` wall passed. Each new workspace Zod schema has
a valid and invalid fixture. For non-vacuity, temporarily replacing `workspaceBlobSchema`'s
`z.strictObject` with `z.object` made the hidden `bucket` rejection assertion fail; strictness was
restored before this commit. No schema correction was needed beyond the Task 1 implementation.

**ADR correction record (2026-07-12):** Independent review against the accepted ADR-0076 source
found that the original derived Task 1 brief had incorrectly narrowed `writeFile` content to bare
`Uint8Array`. A new fake-mount invocation first made contracts typecheck fail against that signature,
then the shared interface and design were corrected to the ADR-required `WorkspaceBlob` input.
The same field-by-field check changed `list` from a readonly array to ADR-0076's
`WorkspaceFile[]`; an invoked fake provides the compile-time proof. These corrections are recorded
before Task 3 and must receive a fresh full verification wall and review.

### Task 3: Review and handoff

**Files:**

- Create: docs/foundation/HEY-163-PHASE-HANDOFF.md
- Modify only if review finds a verified in-scope defect: Task 1–2 files.

**Interfaces:**

- Consumes: the complete contract.
- Produces: an auditable HEY-14 handoff.

- [x] **Step 1: Run the boundary scan**

Run: rg -n "WorkspaceMount|WorkspaceFile|WorkspacePrefix|R2Bucket|object_key|owner_id" packages/contracts/src && git diff --check

Expected: production contract code contains one workspace seam and no raw R2/bucket/object-key/owner field; test fixture names may mention forbidden fields only to prove rejection.

- [x] **Step 2: Independently review against ADR-0029/0076**

Confirm all five interface methods exist, no generic filesystem sneaks in, staged types do not imply a writer, workspace_file remains absent from sanitisation, and HEY-14 can only use list({ kind: 'user_skills' }) followed by readFile(file).

- [x] **Step 3: Write and commit the handoff**

Record merge base, exact exports, test commands/results, no-provider boundary, and the raw bucket/key/owner prohibition in docs/foundation/HEY-163-PHASE-HANDOFF.md.

Run: git add docs/foundation/HEY-163-PHASE-HANDOFF.md && git commit -m "docs(contracts): hand off workspace mount seam"

## Completion Criteria

- The contract/barrel export typecheck and pass adversarial schema tests.
- A fake owner-bound mount satisfies all five methods without a provider binding.
- HEY-14 can receive typed files and opaque blob versions but cannot construct or observe R2 identity.
- No production writer, R2 adapter, config change, deployment, or sanitiser-destination widening is introduced.

## Self-Review

- Spec coverage: Task 1 delivers every required type/method; Task 2 proves fake-first usability and security boundary; Task 3 delivers the HEY-14 handoff.
- Placeholder scan: no incomplete markers or undefined signature remains.
- Type consistency: readFile and writeFile use the ADR-required versioned WorkspaceBlob; writeFile
  also accepts WorkspaceWriteOptions, and list uses the sole WorkspacePrefix.
