# Phase B — Cloudflare Workers Runtime Test Substrate (Handoff for a fresh Ultracode session)

> **Author cluster:** `agent:claude` · **Reviewer:** `review:codex`
> **Repo:** `waldo-backend` · **Branch:** `greenfield/harness-foundation`
> **Status when this was written:** Phase A committed at `cdea092` (CI/conformance wall, green under pinned pnpm@10.34.4). This doc is the authoritative Phase B plan — founder-verified. Start a NEW Ultracode session + dynamic workflow from here.
> **Refines:** `docs/foundation/NEXT-SESSION-PLAN.md` §"Phase B" (this supersedes it where they differ).

---

## 0. Prerequisite reading (in order)

1. `.claude/rules/INDEX.md` + the six rule files (posture, mental-model, language, hey-109, work-modes, security-checklist).
2. `docs/foundation/BUILD-PLAN.md`
3. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md` (Gate 5 = hermetic runtime; "Runtime Verification Spine").
4. `docs/foundation/PHASE-A-CONFORMANCE-WALL-REPORT.md` §0 (what the wall enforces + residual risks; esp. the pnpm-version release-age constraint and the `guard-setalarm` seam note).
5. This file.
6. Cloudflare docs (verify against these — do NOT assume APIs):
   - DO testing: https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/
   - Workers Vitest test APIs (`runDurableObjectAlarm`, `evictDurableObject`, `runInDurableObject`): https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
   - Known issues (coverage, dynamic imports, WebSockets, cleanup; await storage promises, consume response bodies): https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
   - Wrangler config (`new_sqlite_classes`, DO bindings, `compatibility_date`): https://developers.cloudflare.com/workers/wrangler/configuration/

---

## 1. Goal

Prove the local loop can execute **real** Workers/Durable-Object code inside the Workers runtime (workerd/Miniflare), not a Node approximation, before the harness runtime grows. This is Gate 5 (hermetic runtime) of the pipeline ladder.

Phase B is deliberately small: one test-only DO, one runtime test proving alarm + SQLite + eviction-survival, wired into `pnpm verify`. **No product logic, no scheduled tracer bullet (that is Phase C), no contract spine (Phase D).**

---

## 2. Founder-confirmed decisions (do not re-litigate)

1. **New package `packages/runtime`.** Do NOT put Worker/DO code in `packages/contracts` — contracts stay pure Zod/types. `packages/runtime` owns Worker/DO code, the Worker-pool Vitest config, and a package-local `wrangler.jsonc`.
2. **`guard-setalarm` seam (critical — Phase A blocks direct `setAlarm`).** Phase B needs to schedule an alarm, but `guard-setalarm` (block) forbids `.setAlarm(` outside the scheduler seam, and there is currently **no** scheduler exemption (the premature broad `scheduler/**` exemption was removed in Phase A). Therefore:
   - Add the smallest alarm-owner seam: a single narrow file `packages/runtime/src/scheduler/alarm-slot.ts` that owns the one raw `state.storage.setAlarm(...)` call.
   - Update `guard-setalarm` to exempt **only that exact file** (single-file allowlist by exact repo-relative path — `packages/runtime/src/scheduler/alarm-slot.ts`). **Do NOT add a broad `scheduler/**` directory exemption** (a dir glob is attacker-spoofable — that was the strongest Phase-A attack bypass).
   - The test-only DO (and everything else) calls the `alarm-slot` seam, never `setAlarm` directly.
   - Re-prove after the change: `guard-setalarm` still catches `.setAlarm(` everywhere else (RED), allows it only in `alarm-slot.ts` (GREEN), and the clean tree stays GREEN.
3. **Fold `verify:workers` into root `pnpm verify` once the Workers test is green.** That is the point of Phase B — the runtime gate must be part of the single wall.

---

## 3. Build steps

1. **Deps (aged pins — release-age gate applies at add-time under pnpm 10.34.4).** Latest Cloudflare packages are too new for the 14-day `minimumReleaseAge`. Use aged pins (verify each is ≥14 days old at the time you run; else add a justified `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml`). Confirmed pins:
   - `@cloudflare/vitest-pool-workers@0.16.20` — **corrected from `0.16.16`**. `0.16.16` does **not** expose `evictDurableObject`; the eviction test helpers this phase's done-criteria require shipped in `0.16.20` (CF changelog, 2026-06-25). `0.16.20` is ~6 days old, **below** the 14-day gate, so it **requires** an explicit, justified `minimumReleaseAgeExclude` entry (`'@cloudflare/vitest-pool-workers@0.16.20'`). Note also: the `defineWorkersConfig`/`defineWorkersProject` config helpers were removed across the whole `0.16.x`/`0.17.x` line — the config uses the `cloudflareTest()` Vite plugin (verified: `0.16.16`/`0.16.20`/`0.17.0` all export only `.`, `./types`, `./codemods/vitest-v3-to-v4`; no `./config`). Fallback if `0.16.20`'s installed types diverge from docs: `0.17.0` (also requires the exclude).
   - `wrangler@4.105.0` — **corrected from `4.101.0`**. `@cloudflare/vitest-pool-workers@0.16.20` exact-pins `wrangler@4.105.0`; a direct `4.101.0` dep would create a dual/duplicate resolution. Pin the direct dep to `4.105.0` to dedupe. `4.105.0` (2026-06-25) is <14d, so it also needs a `minimumReleaseAgeExclude` entry (see §2.1). Its peer wants `@cloudflare/workers-types ^4.20260625.1`; we deliberately keep the aged `4.20260616.1` (≥14d) — typecheck+tests pass on it.
   - `@cloudflare/workers-types@4.20260616.1` (≥14d)
   - Keep `vitest@4.1.9` (pool `0.16.20` peer is `vitest@^4.1.0` — compatible).
   - Adding deps rewrites `pnpm-lock.yaml` → do a non-frozen install to add, then commit the lockfile. `pnpm verify`'s frozen install must pass afterward under pinned pnpm@10.34.4.
2. **`packages/runtime/wrangler.jsonc`** — one Durable Object binding; migration key `new_sqlite_classes`; `compatibility_date ≥ 2026-02-24`.
3. **`packages/runtime/vitest.config.*`** — `@cloudflare/vitest-pool-workers` pool pointing at the `wrangler.jsonc`. This is a Workers-env project, separate from the Node-env contract tests.
4. **Minimal test-only Durable Object** in `packages/runtime/src/` — no product logic. It writes/reads DO SQLite state and arms its alarm **via the `alarm-slot` seam** (see §2.2).
5. **One Workers-runtime test** that: obtains a DO stub → writes+reads DO SQLite state → drives `alarm()` via `runDurableObjectAlarm` → `evictDurableObject` → asserts **state survives eviction** (resume-from-storage). Optionally `runInDurableObject` to seed/inspect internals.
6. **Wire `verify:workers`** into root `package.json` and **fold it into `pnpm verify`** once green (Workers pool runs as its own step; keep the Node-env contract tests as-is).
7. **Document pool limitations** in the test file header / a package README (coverage, dynamic imports, WebSockets, cleanup; await storage promises, consume response bodies).

---

## 4. Done criteria

- The runtime test runs in `@cloudflare/vitest-pool-workers` (real workerd/Miniflare), NOT plain Node — verified.
- It proves: alarm fires via `runDurableObjectAlarm`; state persists in DO SQLite; state survives `evictDurableObject` (resume-from-storage).
- `verify:workers` is folded into `pnpm verify`; the whole wall is **green under pinned pnpm@10.34.4**.
- `guard-setalarm` updated to a single-file `alarm-slot.ts` exemption + re-proven (RED elsewhere, GREEN in the seam, GREEN clean tree).
- Pool limitations documented.
- `git diff --check` clean; only intended files changed.
- Codex-review handoff note appended (files, commands+results, intentional-failure evidence, residual risks, Cloudflare runtime limits that affect confidence).

---

## 5. Execution shape (Ultracode / dynamic workflow)

Phase B is **single-writer runtime** work — keep it single-writer; use the workflow for research/verify/attack lanes only.

- **Ground (parallel, read-only):** verify against CF docs (context7 / the URLs in §0) the exact `@cloudflare/vitest-pool-workers` config, `wrangler.jsonc` DO shape, `new_sqlite_classes` usage, and the aged-pin release-age compatibility. Output a config spec + confirmed pins.
- **Implement (single writer):** one agent authors `packages/runtime` (package.json, wrangler.jsonc, vitest config, alarm-slot seam, test-only DO, the runtime test) + the `guard-setalarm` single-file exemption + the root `verify` wiring. No parallel writes to shared runtime files.
- **Verify (main session, independent):** run the Workers test in the pool; confirm it runs in workerd not Node; run `pnpm verify` (pinned pnpm@10.34.4) green; re-prove `guard-setalarm` (RED/GREEN); grep to confirm claimed changes landed.
- **Attack (parallel, optional):** try to defeat the single-file `alarm-slot` exemption (path spoof, homoglyph path) and confirm it holds.

Before running the workflow: show the phase plan + raw script, wait for approval (same discipline as Phase A). Reject the plan if it: puts Worker/DO code in `packages/contracts`; adds a broad `scheduler/**` exemption; uses live CF/Supabase/provider or secrets; skips the CF-docs grounding; skips folding `verify:workers` into `pnpm verify`; or starts Phase C/D.

---

## 6. Constraints / discipline

- **Hermetic only.** No live Workers AI, Vectorize, APNs, Telegram, Supabase, or provider calls. Miniflare-local. No production CF resources, no secrets.
- **Pinned pnpm@10.34.4** for all local verification (via corepack, `npx -y pnpm@10.34.4`, or a 10.34.4 default shell). Plain `pnpm` 11.x fails the release-age gate against the lockfile — see the Phase A report §0.6 #5.
- **Verify against Cloudflare docs**, do not assume APIs (they change).
- **No raw health values** anywhere (guards enforce). Use synthetic state in the DO.
- Single-writer runtime; disjoint-file parallel only for research/attack.

---

## 7. New-session preflight

1. `git checkout greenfield/harness-foundation` (Phase A is at `cdea092` or later).
2. Confirm clean tree + on branch.
3. `corepack enable && corepack prepare pnpm@10.34.4 --activate` (or ensure pnpm 10.34.4), then `pnpm install --frozen-lockfile && pnpm verify` → must be exit 0 before starting.
4. **If the new session is a cloud/web Ultracode session:** the branch must be pushed to origin first (cloud sessions clone committed remote state) — `git push -u origin greenfield/harness-foundation`. A local session does not need this.
5. Do NOT provide production CF/Supabase/Anthropic/OpenAI/Google secrets.

---

## 8. Out of scope for Phase B

- Phase C: scheduled tracer bullet (`DO alarm → Loop Governor → run journal → DeliveryGate → outbox → fake sink`), crash/resume exactly-once. Do NOT start.
- Phase D: contract-spine waves. Do NOT start.
- OpenAPI/contract-drift/generated-client walls. Do NOT start.

---

## 9. Ready Prompt (paste into a fresh Claude Code session)

> If the new session is cloud/web, push the branch first: `git push -u origin greenfield/harness-foundation`. A local session needs no push.

```text
ultracode

Build the next Waldo backend foundation phase — Phase B ONLY (Cloudflare Workers
runtime test substrate) — on branch greenfield/harness-foundation.

This is GDPR Art-9 health infrastructure: no real secrets, providers, or user
data. Fakes and hermetic Miniflare tests only.

Do not launch a dynamic workflow yet. First orient + preflight in the main
session. If the branch is wrong or the tree is dirty, stop and report — do not
clean, revert, or stash.

Orient first:
1. Confirm branch greenfield/harness-foundation and clean tree. Phase A is
   committed (cdea092); the CI/conformance wall is live.
2. Preflight with the PINNED toolchain (the wall is pnpm-version-sensitive):
     corepack enable
     corepack prepare pnpm@10.34.4 --activate
     pnpm install --frozen-lockfile
     pnpm verify        # must exit 0 under pnpm 10.34.4. Plain pnpm 11.x FAILS
                        # the release-age gate against the lockfile — use the pin
   If pnpm verify is not green under the pinned version, stop and report.
3. Read, in order:
   - .claude/rules/INDEX.md + the six rule files
   - docs/foundation/PHASE-B-PLAN.md   <- authoritative, founder-verified Phase B
     plan; follow it exactly
   - docs/foundation/PHASE-A-CONFORMANCE-WALL-REPORT.md section 0 (what the wall
     enforces; the guard-setalarm seam note)
   - docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md (Gate 5 + Runtime Verification
     Spine)
   - the Cloudflare docs linked in PHASE-B-PLAN section 0 (verify APIs, do not
     assume)

Phase B target (full detail in PHASE-B-PLAN.md — the two adjustments are
founder-locked):
- New package packages/runtime (NOT contracts) with Worker/DO code + a Worker-pool
  Vitest config + a package-local wrangler.jsonc (new_sqlite_classes,
  compatibility_date >= 2026-02-24).
- Add the smallest alarm-owner seam packages/runtime/src/scheduler/alarm-slot.ts;
  update guard-setalarm to exempt ONLY that exact file (single-file allowlist, NOT
  a broad scheduler/** glob); the test-only DO arms its alarm via that seam.
- One Workers-runtime test in @cloudflare/vitest-pool-workers (real workerd, not
  Node): DO stub -> write/read DO SQLite -> runDurableObjectAlarm ->
  evictDurableObject -> assert state survives eviction.
- Aged pins (release-age gate applies at add-time under pnpm 10.34.4; confirm >=14d
  or justify a minimumReleaseAgeExclude): @cloudflare/vitest-pool-workers@0.16.20
  (NOT 0.16.16 — 0.16.16 lacks evictDurableObject; 0.16.20 is <14d so it needs a
  justified minimumReleaseAgeExclude), wrangler@4.105.0 (NOT 4.101.0 — the pool
  exact-pins 4.105.0; also <14d so it needs an exclude too),
  @cloudflare/workers-types@4.20260616.1; keep vitest@4.1.9.
- Fold verify:workers into root pnpm verify once the Workers test is green.
- Document known Workers-pool limitations.

Discipline:
- Every agent obeys .claude/rules/* (posture, mental-model, language,
  security-checklist, work-modes, hey-109).
- Runtime implementation is single-writer. Use dynamic workflows for
  research/verify/attack lanes only.
- No live providers/secrets/production CF/Supabase resources. Hermetic only.
- No raw health values in code/logs/prompts/fixtures.
- Verify Cloudflare APIs against the docs — never assume.

Execution:
- One phase per workflow. Phase B only.
- Before running the workflow: show the phase plan AND the raw generated workflow
  script; wait for approval.
- Reject your own plan if it: puts Worker/DO code in packages/contracts; adds a
  broad scheduler/** exemption; uses live secrets/providers; skips the CF-docs
  grounding or the ADRs/rules; skips the verify gate; lacks an adversarial/verify
  lane; folds nothing into pnpm verify; or starts Phase C or the contract spine.

Done (report after):
- The runtime test runs in @cloudflare/vitest-pool-workers (workerd, not Node),
  proving alarm + DO SQLite + eviction-survival.
- verify:workers folded into pnpm verify; the whole wall is green under pinned
  pnpm 10.34.4.
- guard-setalarm single-file alarm-slot exemption added + re-proven RED/GREEN.
- git diff --check clean; a Codex-review handoff note appended.
- Report: files changed, commands + exact results, intentional-failure evidence,
  residual risks (incl. Cloudflare runtime limits), whether Phase B is green, and
  the exact Phase C recommendation.

Do not claim Phase B green unless the Workers-runtime test runs in the pool AND is
folded into a green pnpm verify. Do not start Phase C or the contract spine.
ultracode
```

