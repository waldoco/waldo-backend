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

---

# Phase B — Codex Review Handoff (Workers-runtime test substrate)

> **Author cluster:** `agent:claude` · **Reviewer:** `review:codex` · **Branch:** `greenfield/harness-foundation` · builds on Phase A `cdea092`.
> **Verdict up front (main-session Opus verified, not the workflow's self-report):** Phase B is **GREEN** — `pnpm verify` exit 0 under pinned pnpm@10.34.4, the runtime test runs in **workerd** (not Node), and the `guard-setalarm` single-file exemption holds against 8 spoof attempts. **Uncommitted**, pending human review. Nothing pushed.
> **Discipline note (why you can trust this line):** the Phase A report §0.1 documents a workflow that self-reported "GREEN" while `pnpm verify` was actually RED. So this phase's green was re-derived **independently in the main session** (own `pnpm verify`, own real-tree intentional break, own workerd negative-control, own greps), treating the workflow output as a lead only.

## Files changed (6)

| File | Kind | What |
|---|---|---|
| `packages/runtime/` (8 files) | new | Worker/DO test substrate: `package.json`, `tsconfig.json`, `vitest.config.ts` (cloudflareTest plugin), `wrangler.jsonc` (DO binding + `new_sqlite_classes`, `compatibility_date 2026-06-16`), `src/index.ts` (test-only `RuntimeProbeDO` + default 404 fetch), `src/scheduler/alarm-slot.ts` (the sole `setAlarm` owner), `test/runtime-probe.test.ts`, `README.md` (pool limitations). |
| `scripts/guards/guard-setalarm.mjs` | M | Added exact single-file exemption for `packages/runtime/src/scheduler/alarm-slot.ts` via `segmentsEqual` on a 5-segment array (NOT a `scheduler/**` glob). Updated the stale doc comment + finding message to name the real seam. |
| `package.json` | M | `verify` chain now `install --frozen-lockfile && -r typecheck && verify:node && verify:workers && verify:guards`; added `verify:node` (contracts) + `verify:workers` (runtime). `verify:workers` folds in **exactly once** — `pnpm -r test` removed from `verify` to avoid double-running the pool. Top-level `test` kept for ad-hoc use. |
| `pnpm-workspace.yaml` | M | 5 justified `minimumReleaseAgeExclude` entries (see Deviations). |
| `pnpm-lock.yaml` | M | +43 deps from the non-frozen add; frozen install clean afterward. |
| `docs/foundation/PHASE-B-PLAN.md` | M | Pin note corrected: 0.16.16 → 0.16.20 with reason (its §3.1 + §9). |

## Deviations from the founder-locked plan (all forced by installed reality — challenge these)

1. **`@cloudflare/vitest-pool-workers` 0.16.16 → 0.16.20** (founder-approved). 0.16.16 does not expose `evictDurableObject`; the helper the acceptance bar requires shipped in 0.16.20 (CF changelog 2026-06-25). Verified against the **installed** `types/cloudflare-test.d.ts` (`evictDurableObject(stub, options?): Promise<void>` present). Config form is the `cloudflareTest()` plugin (no `./config`/`defineWorkersConfig` in any of 0.16.16/0.16.20/0.17.0).
2. **`wrangler` 4.101.0 → 4.105.0** (forced). pool@0.16.20 exact-pins `wrangler@4.105.0`; the plan's 4.101.0 would create a dual resolution. Direct devDep set to 4.105.0 to dedupe.
3. **5 release-age excludes, not 1** (forced). pnpm's `minimumReleaseAge` (14d) gates **every** resolved dep. pool@0.16.20 exact-pins `miniflare@4.20260625.0` + `wrangler@4.105.0`, which pull `workerd@1.20260625.1` and its per-platform `@cloudflare/workerd-*` binaries — all 2026-06-25 (<14d). Excludes: `@cloudflare/vitest-pool-workers@0.16.20`, `miniflare@4.20260625.0`, `wrangler@4.105.0`, `workerd@1.20260625.1`, and the **name glob** `@cloudflare/workerd-*`.
   - **⚡ Review tradeoff (LOW, flagged not buried):** the `@cloudflare/workerd-*` glob is unversioned (pnpm rejects a version-union on a name pattern), so it permanently exempts all future workerd platform binaries from the freshness gate — looser than 5 enumerated `@cloudflare/workerd-<platform>@1.20260625.1` entries. Kept for cross-platform robustness (a missed variant breaks a teammate on another OS at their next non-frozen install) and because the gate only fires on non-frozen resolution (frozen CI ignores it) and these are first-party Cloudflare binaries. Swap to the 5 exact entries if you prefer tightness.
4. **`navigator.userAgent` read via a narrow cast** — workers-types@4.20260616.1 doesn't declare the `navigator` global (runtime-only), so `(globalThis as { navigator: { userAgent: string } })`. Kept only as a **secondary** workerd signal; primary proof is functional (below).
5. **Peer warning (non-blocking):** `wrangler@4.105.0` wants `@cloudflare/workers-types@^4.20260625.1`; we pin the aged `4.20260616.1` (≥14d). Typecheck + test both pass on it.

## Verification evidence (main session, independent, 2026-07-02)

- **Pinned invocation (use this):** `npx -y pnpm@10.34.4 verify` → **exit 0**: frozen install → `-r typecheck` both packages → `verify:node` contracts 15/15 → `verify:workers` runtime 2/2 (pool) → all 6 guards ok. **Do NOT run a bare `pnpm verify` unless the shell's default `pnpm` is 10.34.4** — a pnpm 11.x default purges the pnpm-10 modules dir and fails before tests (Codex hit this; `pnpm --version` was 11.7.0 in that shell). Reliable options: `npx -y pnpm@10.34.4 …`, `corepack prepare pnpm@10.34.4 --activate`, or a 10.34.4-default shell. Phase A report §0.6 #5 documents the same version sensitivity.
- **Ran in workerd, not Node (first-hand):** negative control `node --input-type=module -e "await import('cloudflare:workers')"` → `ERR_UNSUPPORTED_ESM_URL_SCHEME` (Node cannot resolve the `cloudflare:` scheme). The test imports `cloudflare:workers` + `cloudflare:test` and passed → it executed in workerd. `navigator.userAgent === 'Cloudflare-Workers'` assertion also passed.
- **Non-vacuous eviction proof:** test asserts, after `evictDurableObject`, reconstructed `readTick() === 2` (durable SQLite survived) **AND** `inMemoryTouched === false` (in-memory flag reset → eviction genuinely tore down the instance, not a no-op read). Alarm fired via `runDurableObjectAlarm(stub) === true`.
- **Intentional-failure (RED/GREEN), real tree:** injected `this.ctx.storage.setAlarm(Date.now())` into the DO `alarm()` → `guard-setalarm` exit **1**, flagged `packages/runtime/src/index.ts:46` with the seam message. Reverted → `guard-setalarm: ok` (exit 0). Runtime test re-run 2/2 post-revert.
- **Adversarial (workflow Attack lane, temp fixtures via `--root`):** 8/8 spoofs CAUGHT (nested-under-seam, sibling-suffix, prefix, case-variant, `.tsx`/`.mts` ext-swap, wrong-package, extra-leading-segment) and the exact seam ALLOWED. Exact segment-equality is not spoofable.
- **`git diff --check` clean.** `.setAlarm(` appears as a **call** only in `alarm-slot.ts:7`. No health identifiers in `packages/runtime`.

## Residual risks / limits that affect confidence

- **Cloudflare pool limitations (documented in `packages/runtime/README.md`):** per-test-file storage isolation (multiple `it()` in one file share DO state — a footgun when Phase C adds more runtime tests; use `reset()`/separate files); must `await` all storage promises; must consume response bodies; no native V8 coverage (use Istanbul); fake timers don't drive alarms (use `runDurableObjectAlarm`); dynamic `import()` unsupported in handlers; WebSockets+DO need `--no-isolate`.
- **No pool stdout banner** in 0.16.20 (routed through the `debug` package). The functional negative-control is the workerd proof, not a banner.
- **`git diff --check` does not scan untracked files**, so the new `packages/runtime/*` isn't whitespace-scanned by it (content was reviewed directly instead).
- The `@cloudflare/workerd-*` exclude glob tradeoff (above).
- **Package-manager version footgun (Codex-found, doc-mitigated).** The wall is only green under pnpm 10.34.4; a shell defaulting to pnpm 11.x fails bare `pnpm verify` before tests. Mitigated in docs (pinned invocation above). **Recommended future hardening (deferred, not blocking Phase B):** a `scripts/guards/guard-package-manager.mjs` that fails fast if the running pnpm major ≠ the `packageManager` pin — graduates this from prose to a deterministic conformance check. Suggest folding it in at Phase C.

## Exact Phase C recommendation (NOT started — do not start without a fresh session)

Phase B proves the substrate (workerd + DO SQLite + alarm + eviction-survival), **not** any product logic. Phase C = the **scheduled tracer bullet**: `DO alarm → Loop Governor → run journal → DeliveryGate → outbox → fake channel sink`, with crash/resume exactly-once (deterministic-simulation: crash-inject after each journal step, assert no double-send). Build it on this same `packages/runtime` substrate, reusing the `alarm-slot` seam as the real Scheduler's single alarm owner. Keep contracts-spine (Phase D) after. Recommend a fresh Ultracode session with the same ground→implement→verify→attack shape.
