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

---

# Phase C — Scheduled Tracer Bullet (2026-07-02)

Phase C landed the one path end-to-end on the Phase B substrate. This section is the Codex-review handoff for that slice. **This is the minimal tracer, not the contract spine** — the full DELIVERY_POLICY table, priority arbiter, recurrence-advance, quarantine, 7-schedule multiplexer, and cross-run guards are explicitly **deferred to Phase D**.

## The Module and its Interface (proven)

**Module:** `TracerDO` (`packages/runtime/src/tracer/tracer-do.ts`) — a Durable Object whose `alarm()` is the deep entry point. **Interface:** `schedule({userId, trigger, occurrenceAt}) → runId` opens the journal at `RUN_OPENED` and arms the one-shot alarm; `alarm()` is START-OR-RESUME and drives the path to terminal `DONE`. Everything behind that interface (governor admit, gate verdict, outbox insert, sink flush, ack, finalize) is Implementation.

**The one path proven:** a scheduled wake **starts** a journaled run (no open run) or **resumes** it (open run, enter at committed step); commits a delivery decision + an outbox row; **survives eviction/crash at every committed step**; and delivers to the fake sink **exactly once**. Reconstruction reads **DO SQLite only** — eviction wipes every in-memory field and `alarm()` rebuilds from the journal row. That is the durability thesis, asserted directly (`inMemory` state never load-bearing across a crash).

## Reduced run-journal FSM (ADR-0054 sliver)

Persisted step log in DO SQLite (`journal` table, `run_id` PK, one row per run). Transition table is the **contract** in `packages/contracts/src/runtime/journal.ts` (`runStateTransitions`), enforced by `Journal.advance()` (illegal transition throws):

```
RUN_OPENED → GOVERNOR_ADMITTED → GATED → SINK_SENT → ACK_RECORDED → DONE
                    ↓ (governor deny)
                  FAILED
```

**No `LLM_CALLED` / `TOOLS_DONE` states** — the tracer does no LLM/tools work. **Reconciliation note for Phase D:** the full ADR-0054 FSM is `PENDING → CONTEXT_BUILT → LLM_CALLED → TOOLS_DONE → GATED → DELIVERED → DONE`. The tracer's `RUN_OPENED` maps to `PENDING`/`CONTEXT_BUILT`; `GOVERNOR_ADMITTED` is a **new pre-context admit gate** (ADR-0074) that Phase D must slot before `CONTEXT_BUILT`; the tracer collapses `LLM_CALLED`/`TOOLS_DONE` (absent here); `GATED` matches; the tracer splits ADR-0054's single `DELIVERED` into `SINK_SENT → ACK_RECORDED` to make the sink-call/ack-record boundary a crash seam (points #5/#6). Phase D reconciles by inserting the context/LLM/tools states and mapping the delivery split — no name here contradicts the ADR.

## Gate atomicity — Reading A (ADR-0068 sliver), LOCKED

`admit() IS the GATED step` — one DO SQLite `transactionSync`. In `runGate()` the verdict is computed **pure** (`computeVerdict`, no I/O, `now` injected) and the idempotency key is hashed (async SHA-256) **before** the transaction opens (async/read work stays out of the synchronous closure). The transaction then does, atomically:

```
stampVerdict → incrementClassState → incrementExemptSend → outbox.insert → advance(GATED)
```

`transactionSync` rolls back the whole closure on throw. **fetch_alert budget_exempt semantics:** the DeliveryGate is the single writer of `daily_push_budget`, `class_state`, and `exempt_telemetry` — all keyed by `userId`, all DO-local. For `fetch_alert` the **daily push budget is NEVER touched**; admission gates only on the **per-class cap** (`count < daily_cap`, cap 3/day) **AND** the 2h cooldown (`gate.ts`). On send, `class_state.fetch_alert.count` and the `exempt_telemetry` (audit/WIS/push-pressure) counter each increment **exactly once**, inside the GATED transaction. The **current** block rule is encoded as a Conformance Rule in contracts — `agentReachableExemptHasCap`: *every agent-reachable exempt class has a non-null daily cap*. The stale, provably-false `agent_invocable ∩ budget:exempt = ∅` invariant is **not** encoded (fetch_alert is both agent-invocable AND budget-exempt — it falsifies that old invariant).

## 6-point crash matrix — results (all resume to terminal DONE)

Committed boundaries (#1/#2/#4) need **zero** production fault code: drive one committed step, `evictDurableObject`, re-drive `runDurableObjectAlarm`, assert resume-from-committed. The three genuinely mid-flight points (#3/#5/#6) use **one** crash-injection seam — a single `__crashAfter` field (undefined in production, poked only by tests via `runInDurableObject` before the alarm), with one guarded throw per point. That is the sole spot test-serving state touches the production handler.

| # | Crash point | Expected on resume | Result |
|---|---|---|---|
| 1 | after `RUN_OPENED` | start from scratch → DONE | ✅ |
| 2 | after `GOVERNOR_ADMITTED` | enter at admitted, run gate → DONE | ✅ |
| 3 | verdict computed, before/inside GATED commit | **full rollback** → state stays `GOVERNOR_ADMITTED`, no budget/class/telemetry change, no outbox row, no durable verdict; resume **re-evaluates** the gate from scratch (indistinguishable-on-resume from #2 — correct atomic-commit behavior) | ✅ |
| 4 | outbox insert / GATED committed, before sink | resume **reads the stamped verdict, SKIPS the gate**; class/telemetry each still exactly 1 | ✅ |
| 5 | after sink call, before ack recorded | idempotent sink re-send with the **same** idempotency key returns the prior ack, **no second delivery** → DONE | ✅ |
| 6 | after ack recorded, before handler returns | enter at `ACK_RECORDED`, skip the sink, finalize → DONE | ✅ |

## Exactly-once — asserted at the DURABLE layer (not just sink count)

The idempotent sink can mask a durable double-processing bug, so the load-bearing asserts read SQLite, not sink counters:

- journal terminal state `== DONE`
- `daily_push_budget` **UNCHANGED** (fetch_alert is budget_exempt)
- `class_state.fetch_alert.count` incremented **exactly once** across run+resume
- `exempt_telemetry` counter incremented **exactly once**
- **TOTAL** outbox rows for `(run_id, kind) == 1` (not just active rows), backed by `idempotency_key UNIQUE` **AND** unconditional `UNIQUE(run_id, kind)` (not a partial/active-only index — an already-acked row still blocks a second insert)
- fake sink observed **exactly one** successful send (corroborating, not sole proof)

Idempotency key = SHA-256 over `canonicalDeliverySerialization` (stable-ordered) of `{run_id, kind, payload}` (contracts). Fake sink is in-memory and **idempotent on the key** — a second call with the same key returns the prior ack without recording a second delivery.

## Determinism seams

Clock (`now`), IdGen (run/outbox ids), seeded PRNG injected via `packages/runtime/src/seams/deps.ts` with real production defaults (`productionDeps()`). **New Phase C tracer modules never call `Date.now()` / `Math.random()` / `new Date()` directly** — all go through the seam, so crash/resume replays deterministically. The Phase B `RuntimeProbeDO` `Date.now()` substrate probe is **out of scope and untouched**. `guard-determinism` (if wired) checks new Phase C modules only.

## Substrate reuse (no reinvention)

- Scheduler arms exclusively through the existing `packages/runtime/src/scheduler/alarm-slot.ts` `armAlarm()` seam (the sole raw `setAlarm` owner). **No new `setAlarm` anywhere.** `guard-setalarm` exemption unchanged (exact 5-segment path only).
- Tracer DO binding + SQLite migration added to `packages/runtime/wrangler.jsonc`.
- Test rig reuses the Phase B `runInDurableObject` / `runDurableObjectAlarm` / `evictDurableObject` pattern from `cloudflare:test` (workerd pool).

## guard-package-manager.mjs (deferred hardening, now landed)

Graduated the pnpm-version footgun from prose to a deterministic Conformance Rule (`disposition: block`). Reads the `packageManager` pin from `package.json` (resolved from the guard's own path, not `cwd`) and the running pnpm major from `npm_config_user_agent`. Fails loud if majors mismatch; passes with a notice when not run under pnpm (invoked directly via node). Wired into `verify:guards`.

## Files changed (Phase C)

- `packages/contracts/src/runtime/` (new): `delivery-policy.ts` (verdict domain `send|hold|degrade|drop`, `FETCH_ALERT_POLICY`, `agentReachableExemptHasCap` conformance rule), `class-state.ts`, `journal.ts` (`runStateTransitions` FSM contract), `loop-policy.ts`, `schedule.ts`, `outbox.ts` (incl. `canonicalDeliverySerialization`), `sink.ts` + colocated `.test.ts` for each
- `packages/contracts/src/index.ts` (modified): re-export the runtime contracts
- `packages/runtime/src/seams/deps.ts` (new): Clock/IdGen/PRNG seam + `productionDeps()`
- `packages/runtime/src/tracer/` (new): `tracer-do.ts`, `gate.ts`, `governor.ts`, `journal.ts`, `outbox.ts`, `store.ts`, `scheduler.ts`, `sink.ts`, `schema.ts`
- `packages/runtime/test/tracer.test.ts` (new): 16 tests — happy path, 6-point crash matrix, 4 edge lanes (null / hostile duplicate-after-DONE / concurrent / degraded no-ack-then-ack), 3 red proofs (UNIQUE(run_id,kind) refusal, class-state double-increment catch, forged-GATED-has-no-outbox)
- `packages/runtime/src/index.ts`, `packages/runtime/wrangler.jsonc`, `packages/runtime/package.json` (modified): TracerDO binding/migration + export
- `scripts/guards/guard-package-manager.mjs` (new): pnpm-major conformance guard
- `docs/foundation/CODEX-REVIEW-HANDOFF.md` (this section)

## Open risks for Codex

- **Cloudflare pool per-test-file storage isolation:** multiple `it()` in `tracer.test.ts` share DO state unless a fresh DO id is used per test. The suite uses distinct ids/`listDurableObjectIds` discipline; Codex should confirm no cross-test bleed masks a per-run assertion.
- **`transactionSync` rollback is the crash-#3 correctness pin.** The whole exactly-once story rests on `transactionSync` rolling back atomically on throw. Verified against the installed `cloudflare:workers` `.d.ts` and behaviorally (red proof #3), but it is a workerd runtime guarantee — Codex should keep an eye on it across compat-date bumps.
- **Crash #3 is indistinguishable-on-resume from #2** by construction (pre-commit rollback leaves state `GOVERNOR_ADMITTED`). This is correct atomic-commit behavior, not a weakened test — but it means #3 does not exercise a *distinct resume branch*, only that no partial commit leaked. Called out so Codex does not read it as redundant.
- **Idempotent sink can mask durable doubles** — mitigated by asserting at the SQLite layer (class-state/telemetry/outbox counts), not sink count. Red proof #2 confirms the durable assert is load-bearing. If Phase D adds a non-idempotent real ChannelAdapter, the durable asserts must stay primary.
- **`git diff --check` does not scan untracked files** — the new Phase C files are untracked, so whitespace was reviewed by content, not by the check.
- **Determinism caveat:** seams inject production defaults, so production still reads a real clock/RNG — determinism holds only because the crash/resume path re-reads persisted values, never a fresh `now` for a verdict. Phase D must preserve this when it adds LLM/tools states (those introduce real non-determinism that must sit behind seams before any trace assertion).
- **Reduced FSM ≠ full FSM.** The GOVERNOR_ADMITTED-before-context ordering and the DELIVERED split are tracer choices; Phase D must reconcile against ADR-0054/ADR-0068/ADR-0074 (mapping above) before the spine is authoritative.

## Phase D recommendation

Reconcile the reduced FSM with the full ADR-0054 chain (insert `CONTEXT_BUILT`/`LLM_CALLED`/`TOOLS_DONE`, formalize the `GOVERNOR_ADMITTED` pre-context gate per ADR-0074, map the `SINK_SENT`/`ACK_RECORDED` split back to `DELIVERED`). Then widen from the one path to the full contract spine: DELIVERY_POLICY table (all push classes + the daily-budget decrement path for non-exempt classes), priority arbiter, within-run dedup + cross-run no-progress guard, recurrence-advance + quarantine + the 7-schedule multiplexer. Keep the tracer's determinism-seam + durable-layer-assert discipline as the acceptance bar for every new slice.

## Post-review fixes (applied before commit)

An external review pass returned one P2 and two P3 findings; all three were addressed before this commit:

- **[P2] Package-manager guard wired too late** — `verify` ran `pnpm install --frozen-lockfile` before `verify:guards`, so a wrong local pnpm aborted before `guard-package-manager` could fire. Fixed: `node scripts/guards/guard-package-manager.mjs` now runs **first** in the `verify` chain (still also part of `verify:guards`). RED (`npm_config_user_agent=pnpm/11.x` → exit 1) / GREEN (pinned → ok) both re-proven.
- **[P3] "concurrent" test overstated** — it exercised a post-`DONE` re-drive, not a true interleave (the DO input gate serializes calls, so real interleaving is not expressible in this harness). Renamed to describe the input-gate serialization accurately; a true overlapping-alarm test is deferred to the runtime wave.
- **[P3] unused `random()` seam** — `Deps.random()` had no caller in Phase C. Removed from the interface and `productionDeps` (no speculative seams); re-add when the first jitter/sampling caller appears in Phase D.

Post-fix `pnpm verify` is green (exit 0; 55 contract tests, 16 runtime/workerd tests, 7 guards) under pinned pnpm@10.34.4.
