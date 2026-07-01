# Codex Review Handoff — Waldo Backend Greenfield Foundation Root

> Authored by Claude (builder). Codex is the independent auditor per `hey-109-workflow.md`
> (Claude builds, Codex adversarially reviews — comment, don't rewrite). This is the review
> prompt for a fresh Codex session; it is self-contained.

## Background — what Waldo is, and the build model

- Waldo is a per-user **Cloudflare Durable Object** agent for **GDPR Art-9 special-category
  health data**. Three-repo topology; the contract spine folds into
  `waldo-backend/packages/contracts` (ADR-0029, 2026-06-29 amendment); the app consumes a
  generated OpenAPI artifact, not TS imports.
- **Canonical build source:** `WALDO_HARNESS_DEEPWIKI` (the build bible) + the accepted ADR
  corpus (`waldo-brain/agent-rules/adrs.json`, 73 accepted). Old code is non-authoritative
  unless the bible promotes it (greenfield rewrite boundary).
- **This session (Claude):** greenfield clean slate. (1) Removed legacy `waldo-backend` code
  (stashed, recoverable); prior Codex spine branches left untouched, not used as base. (2) Ran a
  13-agent docs-grounding workflow → a build spec: exact toolchain pins, a 34-step dependency
  DAG, single-owner vocabulary, a verified OpenAPI-from-Zod-4 recipe, and 6 HIGH flags. (3)
  Authored the **foundation root**: monorepo wiring + 3 leaf contract modules + tests.
  **15 tests green, strict `tsc --noEmit` clean.**

## What to review — branch `greenfield/harness-foundation`

Hand-written files (all under `waldo-backend/`):
- Wiring: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`,
  `packages/contracts/{package.json,tsconfig.json}`, `packages/contracts/vitest.config.ts`
- Contracts: `packages/contracts/src/core/error.ts`, `.../core/trigger.ts`,
  `.../model/roster.ts`, `.../index.ts`
- Tests: `.../core/error.test.ts`, `.../core/trigger.test.ts`, `.../model/roster.test.ts`
- Docs: `docs/foundation/BUILD-PLAN.md` (decision record), this file.

Key decisions + why (challenge any of these):
- **Zod 4.4.3 as single source of truth**, types via `z.infer`; native `z.toJSONSchema` is the
  OpenAPI path (no codegen dependency). One Zod major across the seam (ADR-0029).
- **TS strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` OFF** (it fights
  `z.infer` optional inference).
- **Internal-package-consume-source**: `@waldo/contracts` exports point at `./src`, no build/dist.
- **`model/roster.ts` is the single owner of `modelName`** = the 3 canonical ADR-0069 ids
  (`@cf/google/gemma-4-26b-a4b-it`, `claude-sonnet-4-6`, `claude-haiku-4-5`); phantom
  `gemma-4-9b`/`gemma-4-27b` deleted. Note: the bible's illustrative test used the bare id
  `gemma-4-26b-a4b-it`; I used ADR-0069's real Workers-AI id `@cf/google/...` (ADR is canonical
  for ids) — confirm you agree.
- **`invocationContext` deferred**: legacy imports `zoneSchema` + `userSchema`, so it is not a
  leaf; it lands after `core/user` + `health/crs`, not in the root.

## Your review tasks (be adversarial — this is the moat against AI slop)

1. **Correctness vs ADRs.** Read ADR-0069 (roster), 0029 (contract package), 0032 (canary
   tokens), 0015/0042 (triggers) and confirm the encoded contracts match. Flag any drift.
2. **Test quality — the founder's explicit concern.** Are the 15 tests *real* or
   vacuous/library-testing? Name which ones would NOT catch a real bug. Do a mutation check:
   break the production code (e.g., add a 4th model id, flip the canary uniqueness check) and
   confirm a test actually fails. Recommend which tests to strengthen or cut.
3. **Run everything and report actual output:** `pnpm install`; `pnpm -r typecheck`;
   `pnpm -r test`.
4. **Approach/exemplar quality.** Is this the pattern to replicate across the remaining ~30
   modules? Any structural issue (barrel, `exports`, tsconfig strictness, Zod-4 idioms) that
   rots at scale?
5. **Toolchain.** Verify the pins against current docs (zod 4.4.3, typescript 5.9.3, vitest
   4.1.9, wrangler jsonc + `new_sqlite_classes`). Anything wrong or risky.
6. **Grounding spec + flags.** Read `docs/foundation/BUILD-PLAN.md`. Validate the build order and
   the single-owner vocabulary. Assess the 6 HIGH flags — especially: is the **ADR-0068
   invariant defect** real (`agent_invocable ∩ budget:exempt = ∅` fails on `fetch_alert`)? Is the
   **memory-predates-ADR-0046** handling correct? Any HIGH flag that must be resolved before
   scaling?

Verdict format: per-area pass/block + specific `file:line` findings + your independent
recommendation on the next step below.

## Exact next step (proposed) — validate feasibility

**Complete the contract spine (DAG steps 4–33) via a wave-based parallel workflow** — parallel
within each dependency layer, a `tsc`+`vitest` barrier + fix-loop between layers, each module
authored from the grounding spec + its ADRs with valid/invalid conformance tests — **then stand
up the hermetic test substrate (`@cloudflare/vitest-pool-workers`)** for the runtime phase.

Feasibility questions for you:
- **(a)** Is the spine buildable in parallel waves as specced, without integration breakage —
  any hidden cross-module dependencies or missing ADR reconciliations the DAG omits?
- **(b)** Should a **vertical tracer-bullet slice + the test harness come BEFORE** finishing all
  contracts, to de-risk the runtime early (CF Agents SDK `runFiber` spike, ES256 mint, DO SQLite
  crash-resume)? Challenge contracts-first vs tracer-first sequencing.
- **(c)** For the test strategy, do you agree the runtime phase needs **deterministic-simulation
  testing** of the run-journal (crash-inject + assert exactly-once) + **property/fuzz testing**
  of the Scribe sanitiser + **mutation testing** on the deterministic core — or is that
  over-engineering for the beta?
