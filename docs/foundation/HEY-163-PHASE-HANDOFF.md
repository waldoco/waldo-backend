# Phase HEY-163 → HEY-14 Handoff

Status: contract-only slice independently reviewed and ready for draft-PR publication; HEY-166
blocks HEY-14 admission and every workspace writer until its bounded-read/admission policy lands.
Date: 2026-07-12 IST.
Merge base: `2fd798f818213b344e700d98def006e80e0d56ae`.

## What Was Built

- `packages/contracts/src/adapters/workspace.ts`: a typed, already-owner-bound `WorkspaceMount`
  seam for the HEY-14 SkillLoader.
- Strict logical workspace descriptors for `today`, `baselines`, `patterns`, and selected named
  `user_skill` files; the only list prefix is `user_skills`.
- Opaque version and staged-write identifiers, `WorkspaceBlob`, optimistic write options, and the
  five accepted ADR-0076 methods: `readFile`, `writeFile`, `list`, `commit`, and `discard`.
- A public contracts-barrel export and fake-first/adversarial contract tests.

## What Works (with evidence)

- [verified] Logical descriptors reject raw path strings, traversal-like skill names, unknown
  kinds, generic prefixes, storage-identity fields, blank opaque tokens, and non-byte blob values.
  The workspace-focused contracts run passed 49 files / 1,190 tests.
- [verified] A fake owner-bound mount implements every method and exercises `writeFile` with a
  versioned `WorkspaceBlob` plus `expected_version`; contracts typecheck passed.
- [verified] Independent contract review found and verified the ADR signature corrections; the
  source contract has no unresolved raw-R2/path/owner exposure.
- [verified] Fresh `npx -y pnpm@10.34.4 verify` passed: contracts 49 files / 1,190 tests; runtime
  20 files / 514 tests; all workspace typechecks and repository guards passed. `git diff --check`
  also passed.
- [blocked] `tools/eval/run-suite.ts` and an `eval` package command are absent. Per `/run-eval`,
  this records a missing standalone eval gate, not an inferred eval pass; the verification wall
  above is the available merge evidence.

## What Doesn't Work Yet (known issues)

- No concrete `R2Mount`, Worker binding, Wrangler configuration, provider I/O, deployment, or
  runtime integration exists. HEY-163 is a contract seam, not an R2 implementation.
- `workspace_file` remains deliberately rejected by the current sanitiser. A future staged writer
  must first add an accepted destination policy, size limits, Scribe/sanitiser evidence, deletion,
  export, and metadata-only logging; it must not use this interface as a bypass.
- HEY-166 owns a **proposed** reader/admission policy for per-file bytes, source-count/total-read
  bounds, decode failure, cache, and prompt-budget behavior. `WorkspaceBlob` is deliberately a
  strict materialized transport shape, not a universal numeric-cap policy: its allowed file classes
  need different future limits, and no accepted source supplies one shared byte value. ADR-0076
  requires numeric size enforcement only for the staged writer/commit path. HEY-14 must not
  read/cache/decode a blob until HEY-166 supplies its proposed bounded policy and tests.
- The initial vocabulary does not admit cold-archive manifests. This does not block HEY-14; a later
  `retrieve()` slice must define its manifest descriptor and conformance fixture rather than pass a
  generic string path.
- [known issue] HEY-165 tracks a recurring, unchanged `scribe:invalid_payload` tracer/outbox test
  intermittency. It did not recur in this fresh HEY-163 wall; no workaround or sanitizer weakening
  was introduced here.

## Architecture Decisions Made During This Phase

- [decision] Accepted ADR-0029 keeps the shared vocabulary in `packages/contracts`; the loader or
  runtime must not create a parallel raw-R2 contract.
- [decision] Accepted ADR-0076 wins over the derived implementation brief: `writeFile` accepts a
  versioned `WorkspaceBlob`, not bare `Uint8Array` bytes. A type-level RED check caught the mismatch
  before the interface, test, and design were corrected; `list` also returns the ADR-specified
  mutable `WorkspaceFile[]` rather than a readonly array.
- [decision] `WorkspaceMount` is already owner-bound. Its public types/methods expose neither a
  user identifier nor bucket, object key, raw prefix, or R2 client.
- [decision] The current closed set is deliberately limited to HEY-14's files. Cold retrieval must
  extend the descriptor union explicitly after it owns a typed manifest shape.
- [decision] Review-all surfaced a conflict: security correctly identified that a bare `Uint8Array`
  is not an application cap, while health-data review established that a universal mount cap would
  be a false policy for multiple file classes. ADR-0076 requires numeric size enforcement for the
  staged writer/commit path; it does not define a reader cap. HEY-166 therefore owns a proposed
  separate reader-admission policy for HEY-14 and the still-required writer policy; this branch does
  not invent a number or relax sanitisation.

## Hard-Won Lessons

- A derived task brief can drift from an accepted ADR even when its prose claims fidelity. Shared
  interface signatures need a direct ADR check and an invoked fake/typecheck proof.
- A fake that omits method parameters can satisfy TypeScript structurally while failing to prove the
  caller-facing contract. Invoke every critical method with its exact public values.

## Compound Learning Capture

- **Lesson:** accepted ADR signatures outrank derived task prose; shared adapter fakes must invoke
  every critical method to prove caller-facing types.
- **Mode / track:** lightweight knowledge-and-practice capture.
- **Overlap check:** no existing active foundation lesson covers ADR-to-derived-plan signature drift;
  this handoff is the narrowest durable home.
- **Source / applicability:** accepted
  `waldo-brain@75591543053dbdda6cf7c7f0210f8d16f36c3db8` ADR-0076; apply when implementing a
  shared contract from an ADR, not to ordinary private refactors.
- **Pressure scenario:** alter a fake's parameter or return type to the previous incorrect shape;
  contracts typecheck must fail before restoring the ADR signature.
- **Evidence trail / impact:** the `WorkspaceBlob` and mutable `WorkspaceFile[]` mismatches were
  caught by independent review, then verified by focused tests, typecheck, and the full merge wall.

## Prerequisites for Next Phase

1. Merge HEY-163, then complete HEY-166's proposed bounded reader/admission policy before
   starting HEY-14 implementation.
2. After that policy lands, HEY-14 receives only an already owner-bound `WorkspaceMount`; it may
   call `list({ kind: 'user_skills' })` and `readFile(file)` within the policy's count/byte/decode
   bounds and cache opaque blob versions.
3. HEY-14 must not construct a user prefix/key, access a bucket/binding, use generic filesystem
   paths, stage or commit a workspace write, or broaden `workspace_file` sanitation.
4. A later runtime adapter owns private descriptor-to-R2 mapping and must separately satisfy
   ADR-0076's sanitisation, logging, deletion, export, stable-snapshot, and writer-size obligations.

## Files Changed

- `packages/contracts/src/adapters/workspace.ts`
- `packages/contracts/src/adapters/workspace.test.ts`
- `packages/contracts/src/index.ts`
- `docs/superpowers/specs/2026-07-12-hey-163-workspace-mount-design.md`
- `docs/superpowers/plans/2026-07-12-hey-163-workspace-mount.md`
- `docs/foundation/HEY-163-PHASE-HANDOFF.md`
