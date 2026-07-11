# Phase HEY-163 → HEY-14 Handoff

Status: contract-only slice independently reviewed and ready for draft-PR publication.
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
  final combined diff has no P0/P1 finding.
- [verified] Fresh `npx -y pnpm@10.34.4 verify` passed: contracts 49 files / 1,190 tests; runtime
  20 files / 514 tests; all workspace typechecks and repository guards passed. `git diff --check`
  also passed.

## What Doesn't Work Yet (known issues)

- No concrete `R2Mount`, Worker binding, Wrangler configuration, provider I/O, deployment, or
  runtime integration exists. HEY-163 is a contract seam, not an R2 implementation.
- `workspace_file` remains deliberately rejected by the current sanitiser. A future staged writer
  must first add an accepted destination policy, size limits, Scribe/sanitiser evidence, deletion,
  export, and metadata-only logging; it must not use this interface as a bypass.
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

## Hard-Won Lessons

- A derived task brief can drift from an accepted ADR even when its prose claims fidelity. Shared
  interface signatures need a direct ADR check and an invoked fake/typecheck proof.
- A fake that omits method parameters can satisfy TypeScript structurally while failing to prove the
  caller-facing contract. Invoke every critical method with its exact public values.

## Prerequisites for Next Phase

1. Merge HEY-163, then rebase HEY-14 on the merged contract.
2. HEY-14 receives only an already owner-bound `WorkspaceMount`; it may call
   `list({ kind: 'user_skills' })` and `readFile(file)` and cache opaque blob versions.
3. HEY-14 must not construct a user prefix/key, access a bucket/binding, use generic filesystem
   paths, stage or commit a workspace write, or broaden `workspace_file` sanitation.
4. A later runtime adapter owns private descriptor-to-R2 mapping and must separately satisfy
   ADR-0076's sanitisation, logging, deletion, export, and stable-snapshot obligations.

## Files Changed

- `packages/contracts/src/adapters/workspace.ts`
- `packages/contracts/src/adapters/workspace.test.ts`
- `packages/contracts/src/index.ts`
- `docs/superpowers/specs/2026-07-12-hey-163-workspace-mount-design.md`
- `docs/superpowers/plans/2026-07-12-hey-163-workspace-mount.md`
- `docs/foundation/HEY-163-PHASE-HANDOFF.md`
