# Waldo Backend - Foundation Handover

> Final foundation audit + contract-spine handover for the Waldo agent harness. This is the
> durable map of what is built, what is contract-only, what is tracer-only, what is unbuilt,
> which surfaces are safe to build against, and which must stay single-writer.
>
> Current as of 2026-07-06: Phase D contract spine and agent operating workflow are merged
> to `main`. Use `NEXT-SESSION-PLAN.md` and `HARNESS-RUNTIME-BUILD-PLAN.md` for the next
> active grilling/planning session.

---

## 1. Executive verdict

- **The backend contract spine is ready for runtime build.** ADR-0068
  delivery policy, ADR-0070 engagement telemetry, ADR-0029 public DTO/OpenAPI freshness, evidence
  lanes, ADR-0074 loop policy helpers, PR #13 Art-9 hardening, and PR #14 taint-gate authority are
  represented in `packages/contracts` with tests/guards.
- **The runtime is essentially unbuilt.** Only the Phase-C scheduled tracer executes; the full harness loop, the DO scheduler multiplexer, the delivery flusher, and the sanitiser runtime do not exist. Do not read "contracts shipped" as "runtime built."
- **Three historical findings are resolved or moved to runtime proof.** The **HIGH** Art-9
  Scribe-sanitiser finding is resolved in PR #13; the **MEDIUM** ADR-0049 taint-gate authority is
  resolved in PR #14; exactly-once *delivery* remains the first runtime proof obligation (§6.3).
- **Current main is contract-only plus tracer compatibility.** No production DDL, no full
  DeliveryGate, no scheduler multiplexer, no dispatcher, and no provider surface are implemented.

**When can other agents start building runtime logic?** Now, but start with SLICE-3a runtime
tests. The first runtime PR must prove durable exactly-once *delivery* across real
`@cloudflare/vitest-pool-workers` eviction/resume. The Phase-C fake sink is not proof.

---

## 2. Exact source set read (this audit)

**Primary (read directly, in-context):**
- `CLAUDE.md`, `AGENTS.md`, `.claude/rules/INDEX.md`
- `docs/foundation/`: `BUILD-PLAN.md`, `NEXT-SESSION-PLAN.md`,
  `HARNESS-RUNTIME-BUILD-PLAN.md`, `AGENT-OPERATING-WORKFLOW.md`,
  `LOCAL-DEV-TESTING-PIPELINE.md`, `accepted-adrs.json`
- ADR primary text: [0074-loop-governor.md](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/Architecture%20Decision%20Records%20%28ADR%29/0074-loop-governor.md) (the seam being built)
- Contract source: `packages/contracts/src/index.ts`, `runtime/{loop-policy,delivery-policy,outbox,schedule}.ts`, `core/trigger.ts`, `memory/sanitise.ts`
- Runtime source: `packages/runtime/src/tracer/{governor,gate,tracer-do}.ts`, `test/tracer.test.ts`
- Conformance: `scripts/guards/guard-health-leak.mjs`, root `package.json`

**Fan-out (22 read-only `Plan`-type subagents, no writes):** 12 subsystem mappers + 9 adversarial skeptics + 1 completeness critic, each grounded on the module source + tests + the ADR/DeepWiki for its seam.

> **Audit coverage caveat (honest):** the fan-out mappers grounded on the DeepWiki HTML (which they flag as pre-PR#11 stale) + code; several did **not** read the primary ADR markdown (they looked only under `waldo-backend`). The critic spot-verified key ADR line-cites against the primary text and they matched, and the SLICE-1 seam (ADR-0074) was re-grounded directly against the ADR markdown. Surfaces not read by any mapper: `prompt/reasons.ts`, `prompt/skill.ts`, `health/crs.ts`, `adapters/{calendar,doc,sheet,email}.ts`, `tools/schemas/{reads,writes,threading}.ts`, `ui/{card,notification}.ts`, `core/hooks.ts` (read only by the auth-acl skeptic), `runtime/src/tracer/store.ts`. Treat those as un-audited this pass.

---

## 3. Current build map

Legend — **status**: `built` · `contract-only` (Zod shape + tests, no runtime) · `partial-contract` (some ADR surface pinned, rest deferred) · `tracer-only` (exists only inside the Phase-C tracer slice). **SW**: must stay single-writer. **Safe**: safe to build *contracts* against now.

| Module | ADR | Status | SW | Safe | Gap to full ADR |
|---|---|---|---|---|---|
| Run journal + FSM | 0054 | partial-contract | ✅ | ✅ | Full 8-state FSM (`run.ts`) is shape-only, **zero runtime consumers**. Tracer uses a distinct reduced 7-state FSM (`journal.ts`). `runs` table, tick/resume, watchdog on `next_expected_wake`, retry on `attempts` — unbuilt. |
| Transactional outbox + sink | 0054 | tracer-only | ✅ | ⚠️ | Single-kind `fetch_alert` slice. Exactly-once *enqueue* airtight (UNIQUE constraints); exactly-once *delivery* **unproven** (finding §6.3). Needs multi-kind, status/attempts/next_retry_at, cross-store `notification_log` mirror. |
| Session trust reset | 0033 | contract-only | ✅ | ✅ | Reset envelope pinned; the `session_reset` OnInvocationStart hook (priority 400) + the resume-rebuild obligation are runtime, unwired. |
| Working memory | 0057 | contract-only | ❌ | ✅ | Bucket shapes + caps pinned; threading-through-tool-calls + compaction-survival re-attach are runtime behavioral invariants, absent. |
| Persistent goals | 0064 | contract-only | ✅ | ✅ | `GoalRecord` shape complete + raw-health-rejecting. DO SQLite state home, onboarding/user-message write authority — unbuilt. |
| DO alarm multiplexer + schedule | 0065 | partial-contract | ❌ | ✅ | `ScheduleEntry`/`ScheduleKind` + `armAlarm` seam built. Multiplexer, recurrence advancement, fleet liveness, quarantine runtime — unbuilt. |
| Delivery-policy table | 0068 | contract-only | ❌ | ✅ | Current-decision table complete: 10 push classes, `DELIVERY_POLICY`, tier caps, trigger bindings, sub-kind-aware adjustment caps, `DeliveryCandidate`, `Admission`, held candidates, and stamp consistency. Runtime `DeliveryGate`, DDL, and transaction proof remain SLICE-3. |
| Routing + model policy | 0069 | partial-contract | ✅ | ✅ | Roster + routing rows present; shadow-eval + cost/escalation telemetry deferred. |
| **Loop Governor** | **0074** | **contract-only¹** | ❌ | ✅ | **This PR (SLICE-1)** ships the full manifest + arbiter + fail-closed registry. Runtime arbiter comparator, per-run budget/kill enforcement, dedup, no-progress guard (`loop_progress` table) → **SLICE-3**. |
| Engagement telemetry | 0070 | contract-only | ✅ | ✅ | `EngagementEvent`, four launch metric families, Telegram reply/callback open proxy, and low-cardinality label guard. Runtime writes + analytics mirrors are unbuilt. |
| Public DTO/OpenAPI | 0029 | contract-only | ✅ | ✅ | Independent public engagement DTOs plus committed OpenAPI JSON/SHA sentinel. App generated-client refresh is downstream of this backend artifact. |
| Evidence lanes | testing | contract-only | ✅ | ✅ | Scenario/property/mutation/live-dogfood evidence run shape; no scenario runner yet. |
| Tools / ACL / auth | 0008/0032/0033 | contract-only | ✅ | ✅ | ACL map + mint + consent solid. Taint→privileged-action gate authority **RESOLVED** in PR #14 (§6.2): single authority `taintGateBlocksDirectExecution` (external ∧ privileged), `PRIVILEGED_ACTION_TOOLS` widened 9→15, primitive single-owned in `memory/sanitise`. Runtime dispatcher wiring still deferred to the SLICE-3 wave. |
| Memory + Scribe sanitiser | 0024/0046 | contract-only | ❌ | ✅ | Contracts complete + consistent. Raw-sensor vocabulary widened to full Art-9 + structured payloads + precision, guard now blocks (§6.1 fixed, PR #13). `sanitise()` runtime still absent. |
| Contract SoT + tracer boundary | 0029 | built | ✅ | ✅ | Barrel exports + tracer clearly labelled + no HTTP path reaches `TracerDO` (404). Point-in-time safe; re-check when a product route lands. |

¹ Was `tracer-only` at audit time; this PR promotes it to `contract-only` (full manifest, no runtime).

---

## 4. What each PR built

| PR | Built |
|---|---|
| #2 | Supabase migrations — 16 canonical tables + RLS |
| #3 | Mirrored six universal rule files from waldo-brain |
| #4/#5 | Worker harness bootstrap + `WaldoAgent` DO shell |
| #7 | Foundation Phases A/B/C (CI/conformance wall, workerd runtime substrate, scheduled durable-execution tracer bullet) + Phase D Waves 1–4a (memory, CRS/prompt, routing/LLM, UI/provider-adapter contracts) |
| #8 | Channel adapters, tool union/ACL/schemas/handler, core hooks, memory-skill lifecycle, auth mint/consent contracts |
| #9 | Adversarial hardening: mint JWT timing, user-scoped consent lookup, channel-persona card filtering |
| #10 | Runtime run/session/working-memory contracts (ADR-0054/0033/0057) |
| #11 | Scheduler/goal contracts (ADR-0065/0064), `pre_brief_sweep` trigger/ACL/routing coverage, tracer schedule-row compat patch |
| #12 | ADR-0074 Loop Governor contract (SLICE-1): full LoopPolicy manifest, arbiter precedence, disposition, fail-closed `LOOP_POLICIES` registry + `lookupLoopPolicy` + `admit(policy\|null)`; minimal tracer-compat patch |
| #13 | Art-9 Scribe raw-sensor lockout widened to current security checklist coverage; health leak guard blocks |
| #14 | ADR-0049 taint-gate authority reconciled; privileged action set widened 9→15 |
| **#17** | **Phase-D contract closure: ADR-0068 delivery policy, ADR-0070 engagement telemetry, ADR-0029 public DTO/OpenAPI freshness, evidence lanes, and ADR-0074 helper contracts; preserves PR #13/#14 safety fixes** |

---

## 5. Remaining steps — contract closure is done; runtime is next

The critic confirmed MUST-SPLIT. Verified against ADR and DeepWiki text: the manifest, delivery
table, public/telemetry contracts, and durable runtime each touch a different surface. The contract
pieces are now represented; the next work is runtime implementation, not another contract slice.

| Slice | Scope | DDL? | Runtime tests? |
|---|---|---|---|
| **SLICE-1** | Loop Governor contract — manifest, arbiter `priorityTierRank`, disposition, `LOOP_POLICIES` registry, fail-closed `admit`, plus helper contracts. | No | Contract tests only |
| **SLICE-2** | Delivery-policy contract — 10-class `DELIVERY_POLICY`, tier caps, trigger bindings, admission/held candidates, sub-kind caps, stamp consistency. | No | Contract tests only |
| **SLICE-3 (next)** | Durable outbox/journal DDL (PK = idempotency key, `status`/`attempts`/`next_retry_at`, `held_candidates` + `loop_progress` tables, Supabase `notification_log` UNIQUE mirror); run-FSM re-expansion; scheduler multiplexer; async retried flush; governor budget/kill/no-progress runtime; dispatcher taint gate; sanitiser runtime. | **Yes** | **Yes — real `@cloudflare/vitest-pool-workers` cross-eviction; exactly-once *delivery* cannot be certified without them** |

Deferred from SLICE-1 into SLICE-3 (no caller in a contract-only PR): the arbiter comparator (`compareLoopAdmission`), within-run dedup (`dedupInput`), and the cross-run no-progress guard (`isStuck`) — all consume runtime tool-execution data / the `loop_progress` table. The ADR-0074 §Move1.4 DELIVER egress floor stays deferred (it is runtime); it will reuse the now-single-sourced `RAW_SENSOR_PATTERNS` (widened in PR #13, §6.1) rather than declaring a third hand-rolled copy.

Downstream app work: generate/refresh app clients from the committed OpenAPI artifact before app
code consumes the public endpoint. That is not a blocker for backend runtime implementation.

---

## 6. Security / adversarial findings (pre-existing; flagged, not fixed here)

All three were identified during the foundation audit. Two have since been fixed in contract PRs; the remaining exactly-once delivery proof is the first runtime harness slice.

### 6.1 [HIGH · Art-9] Scribe sanitiser vocabulary — RESOLVED in PR #13
- **Was:** `RAW_SENSOR_PATTERNS` covered only HRV / HR / SpO2 / sleep in a prose shape — narrower than the project's own `guard-health-leak.mjs` `HEALTH_TOKENS` superset (weight, blood pressure incl. systolic/diastolic, calorie burn, active energy) — and it missed the shape health data actually takes: structured payloads with snake_case / kebab / camelCase keys, unit-suffixed keys (`hrv_ms`, `weight_kg`, `systolicMmHg`), and quoted numeric / BP-ratio values. The compensating guard was `warn`/exit-0.
- **Fixed (PR #13):** `RAW_SENSOR_PATTERNS` rebuilt with unit-suffix + quoted-value + BP-ratio coverage and a precision model — specific tokens (hrv/spo2/systolic/blood pressure/body weight/…) match on any separator; **hr/weight take a bare number on a colon/equals key** (the real wearable-field shape) but need a unit on bare whitespace; bp needs a ratio or mmHg; sleep needs a duration unit — so whitespace prose (a duration, a graph edge weight, a basis-points delta, a backoff) is not over-redacted. **Art-9 fail-safe trade:** a colon-keyed non-health token (e.g. an HR-team count) is over-redacted rather than risk a missed reading — a rejected write is recoverable, a leaked body weight is not. `guard-health-leak` flipped `warn`→`block` + gained unit-suffix tolerance; `guards-selftest` proves quoted/snake/camel/unit-suffix leaks fail CI and zone prose passes. Derived via a 4-agent adversarial sweep + deterministic node verification; the bare-colon-key recall regression from the first cut was caught in review and fixed. Mutation-proven non-vacuous.
- **Remaining (cross-repo follow-up):** amend ADR-0024's canonical §Check-2 block in `waldo-brain` to match the widened set. **Residual** (deterministic-floor limits — the ADR-0074 §Move1.4 grader's job, not this floor): a value nested under an inner key (`hrv: { quantity: 42 }`), a word between key and number (`hrv: approx 42`), CSV commas, and health metrics outside these families (glucose / bmi / temperature / vo2max / respiratory rate) — the latter is the metric-vocabulary curation the ADR-0024 amendment should settle.

### 6.2 [MEDIUM · Art-9/injection] ADR-0049 taint→privileged-action gate authority — RESOLVED in PR #14
- **Was:** two unreconciled authorities — `tools/handler.ts` `taintGateBlocksDirectExecution` (tool-scoped, correct shape, but its list omitted `call_mcp_tool`/`create_thread`/`delete_message`/`restore_message`/`archive_thread`/`update_thread_topics`) vs `core/hooks.ts` `taintGateTrips` (tool-agnostic — would over-block reads). A dispatcher wiring the tool-scoped gate would let external-tainted content drive message/thread mutation + MCP writes without routing through `propose_action`, contradicting ADR-0049's own verification text.
- **Fixed:** the founder call (conservative single authority) landed. `taintGateBlocksDirectExecution` is now the **single** gate authority (`external ∧ privileged`); `PRIVILEGED_ACTION_TOOLS` widened 9→15 to cover every direct external mutation/send/MCP-write/thread-message mutation (in tool-union order); `propose_action` (human-confirm route) and `execute_code` (ADR-0050 zero-ACL, pinned by a coupling guard) stay excluded. The external-taint primitive relocated to `memory/sanitise` (`EXTERNAL_SOURCE_TAINT` + `isExternalSourceTaint`) as the single vocabulary owner — the three trust/laundering refines route through it, so a constant rename cannot fail open — and `taintGateTrips` was removed. Hostile fixtures for every newly-covered tool + tainted-read-allowed paths; mutation-proven non-vacuous. The `TAINT_PRIVILEGED_ACTION_GATE` registration slot (still `priority: null`) remains for the dispatcher to place.
- **Remaining (runtime, deferred — the SLICE-3 dispatcher wave):** the dispatcher must call `taintGateBlocksDirectExecution` at PreToolUse around every privileged dispatch, resolve the open slot ordering / merge-with-autonomy-gate question, and thread taint provenance from tool-result → privileged-action arguments end-to-end. The contract half is proven; the security guarantee is real only once that wiring lands and is itself tested.

### 6.3 [MEDIUM] Exactly-once *delivery* is unproven (enqueue is airtight)
- **Where:** `packages/runtime/src/tracer/tracer-do.ts:123-126` (`flushOutbox` calls `sink.send()` with no `ack_recorded` guard); `sink.ts:9-14` (sink contract imposes no dedupe duty; the only dedupe is a process-local `Map` in the fake).
- **What:** on crash #5 (post-send, pre-ack) a resume re-sends; today only the in-process `FakeSink` `Map` hides it. A real cross-instance DO reconstruction, or any compliant sink that ignores the idempotency key, double-delivers. The code itself concedes the sink dedupe "is deliberately NOT the exactly-once proof."
- **Fix:** SLICE-3 — add an `ack_recorded` guard before re-send, make the sink contract impose idempotency, and prove it under real cross-eviction Workers tests + the `notification_log` cross-store mirror.

Everything else the skeptics probed returned **safe**: mint forgery, consent escalation, `pre_brief_sweep` send/execute/mutate (read/precompute-only ACL), goals storing health values, scheduler payload smuggling, tracer-mistaken-for-runtime, and supply-chain/eval/injection. Note several "safe" verdicts are safe-**by-shape**, not safe-**by-enforcement** (the runtime that would enforce them is deferred) — re-run the relevant skeptic when each runtime lands.

---

## 7. Contribution rules · single-writer vs parallelizable

**Single-writer (one owner per file; a second concurrent writer corrupts the seam):**
- `runtime/loop-policy.ts` (this seam), `runtime/delivery-policy.ts` (SLICE-2), `runtime/outbox.ts` + `runtime/journal.ts` + `runtime/run.ts` (SLICE-3), `runtime/schedule.ts`, `runtime/routing.ts`, `model/roster.ts`, `core/trigger.ts`, `memory/sanitise.ts`, all of `packages/runtime/src/tracer/*`, `index.ts`.
- Rationale: these own a shared vocabulary (budget, delivery, outbox, model roster, trigger, health-value) — the LOCAL-DEV anti-pattern is "a second writer for budget/outbox/memory/model/trigger."

**Parallelizable (disjoint modules; safe for concurrent authoring in separate PRs):**
- Read-only review, adversarial attack cases, fixtures, and docs — always.
- Disjoint contract modules that do not share vocabulary: `ui/*`, `adapters/{calendar,doc,sheet,email}` (each its own ADR), `prompt/*`, `working-memory.ts`, `goal.ts` (contract half; the curator half `memory/skill.ts` is a separate sibling owner).

**Every contribution:**
- Name the owning ADR + the invariant in one sentence before editing (Gate 0).
- Contract change → exact valid/invalid tests first; anchor each test file with `// ADR-XXXX: <invariant>` (ADR refs are canonical — allowed; ticket/PR/date refs in code are not).
- Runtime change → hermetic Workers/DO test first; prove crash/resume + exactly-once at the durable layer, not the sink.
- Never derive public DTOs via `.pick()`/`.omit()` from internal schemas; re-declare in `src/public/`.
- Run `pnpm verify` + `git diff --check`; report skipped/target-only gates honestly.

---

## 8. Security / privacy checklist (every PR on this repo)

- [ ] No secrets in code/config/logs/CI; no live provider keys or production data in default gates.
- [ ] No raw health values (HRV, HR, SpO2, sleep, **weight, BP, systolic/diastolic, calorie, active-energy**) in DO SQLite, logs, prompts, traces, R2, or committed fixtures — synthetic only.
- [ ] Persisted/egress DTOs are `z.strictObject`; raw physiological *fields* structurally unrepresentable (assert `.success === false`).
- [ ] Free-text content bound for a health sink is covered by the sanitiser vocabulary (§6.1 — widened to structured payloads in PR #13; nested-object / word-interposed values remain the ADR-0074 grader's job).
- [ ] Auth/ACL claims backed by real verification; taint-gated tools route through `propose_action` or block (see §6.2).
- [ ] GitHub Actions SHA-pinned; `pnpm install --frozen-lockfile`; release-age gate active; no `eval`/shell-from-untrusted/unsafe-deserialization.
- [ ] Idempotency: exactly-once proven at the durable layer for any new side-effecting runtime (see §6.3).

---

## 9. Codex continuation prompt (next session)

```text
ultracode

Continue the Waldo backend harness runtime from updated `main`. Read first:
- .claude/rules/INDEX.md
- README.md
- docs/foundation/AGENT-OPERATING-WORKFLOW.md
- docs/foundation/NEXT-SESSION-PLAN.md
- docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md
- docs/foundation/BUILD-PLAN.md
- docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md
- docs/foundation/FOUNDATION-HANDOVER.md
- primary ADR markdown for the touched seam under
  [01-Waldo/Architecture Decision Records (ADR)](https://github.com/Pin4sf/waldo-brain/tree/main/01-Waldo/Architecture%20Decision%20Records%20%28ADR%29) (read the .md, not only DeepWiki)
- [01-Waldo/waldo-harness-deepwiki/delivery-governor.html](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/waldo-harness-deepwiki/delivery-governor.html)
- [01-Waldo/waldo-harness-deepwiki/conformance-build.html](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/waldo-harness-deepwiki/conformance-build.html)

Baseline gate before any code:
  pnpm verify            # (pnpm 10.34.4 on PATH; or npx -y pnpm@10.34.4 verify)
  git diff --check
If red or the branch is unmergeable, stop and report the blocker.

Grill the plan first, then pick ONE runtime slice, single-writer, tests-first, its own small PR:

1. SLICE-3a — durable DeliveryGate/outbox proof. Add the DO SQLite state needed for
   `daily_push_budget`, `held_candidates`, outbox retry state, and the notification-log mirror seam.
   Prove with real `@cloudflare/vitest-pool-workers` cross-eviction tests that post-send/pre-ack
   crash resume does not double-deliver. Exactly-once delivery, not just enqueue, is the gate.

2. SLICE-3b — Loop Governor runtime enforcement. Consume the existing ADR-0074 contracts:
   comparator, per-run token/iteration/subagent bounds, kill flags, within-run dedup, no-progress
   rows, and outbound Art-9 floor. Do not invent new governor verdict enums.

3. SLICE-3c — dispatcher/sanitiser wiring. Wire `taintGateBlocksDirectExecution` at PreToolUse,
   thread external taint from tool result to privileged args, and put the sanitiser runtime at the
   memory/prompt/egress boundaries using the single `RAW_SENSOR_PATTERNS` owner.

The contract closure is done: do not reopen delivery-policy/public DTO/telemetry/evidence
contracts unless an accepted ADR mismatch is found. App generated-client refresh is downstream
of the committed OpenAPI artifact and can run in parallel with backend runtime work.

Use dynamic workflows for research/review/attack/disjoint modules only; keep runtime + shared
contract files single-writer. Report: files changed, commands + exact results, intentional-break
evidence, residual risks, exact next slice.
```
