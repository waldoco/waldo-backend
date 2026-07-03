# Waldo Backend — Foundation Handover

> Final foundation audit + contract-spine handover for the Waldo agent harness, produced after
> PR #11 (scheduler/goal contracts) merged to `main`. This is the document the next builder — agent
> or human — reads first. It states exactly what is built, what is contract-only, what is tracer-only,
> what is unbuilt, which surfaces are safe to build against, and which must stay single-writer.
>
> Baseline commit audited: `0d4dd26` (`Add scheduler and goal contracts (#11)`).
> This handover PR adds the ADR-0074 Loop Governor contract (SLICE-1 of the governor/delivery/outbox seam).

---

## 1. Executive verdict

- **Baseline is green.** `pnpm verify` on `main@0d4dd26`: 1070 contract tests + 18 workerd tests + 8 guards, clean tree.
- **The contract spine is safe to build *contracts* against.** Every persisted/egress DTO is a strict Zod object; field-shaped raw-health injection is structurally unrepresentable and pinned by ~9 test files.
- **The runtime is essentially unbuilt.** Only the Phase-C scheduled tracer executes; the full harness loop, the DO scheduler multiplexer, the delivery flusher, and the sanitiser runtime do not exist. Do not read "contracts shipped" as "runtime built."
- **Three pre-existing findings surfaced (§6), none introduced by this PR, none blocking a contract-only PR.** The **HIGH** (Art-9) Scribe-sanitiser-vocabulary finding is **RESOLVED in PR #13** (widened to structured payloads on a precision model + guard flipped to block). Two **MEDIUM** remain open: the ADR-0049 taint-gate authority (§6.2, needs a founder call) and exactly-once *delivery* (§6.3, SLICE-3).
- **This PR (SLICE-1)** widens the Loop Governor from a two-field sliver to the full ADR-0074 manifest + arbiter precedence + fail-closed admission registry. Contract-only + a minimal tracer-compat patch. No DDL, no runtime, no new provider surface.

**When can other agents start building runtime logic?** Not yet, and not uniformly:
- **Contract waves** (SLICE-2 delivery-policy, telemetry, public DTO) — start now, single-writer per file (§7).
- **Runtime waves** (delivery flusher, scheduler multiplexer, sanitiser runtime, full run-FSM) — gated on (a) the HIGH sanitiser finding fixed, (b) a DO-runtime test substrate proving exactly-once *delivery* across real cross-instance eviction (today only an in-process fake sink corroborates it), (c) the ADR-0049 taint-gate authority decided.

---

## 2. Exact source set read (this audit)

**Primary (read directly, in-context):**
- `CLAUDE.md`, `AGENTS.md`, `.claude/rules/INDEX.md`
- `docs/foundation/`: `BUILD-PLAN.md`, `NEXT-SESSION-PLAN.md`, `PHASE-D-NEXT-AUDIT.md`, `CODEX-REVIEW-HANDOFF.md`, `LOCAL-DEV-TESTING-PIPELINE.md`, `accepted-adrs.json`
- ADR primary text: `waldo-brain/01-Waldo/Architecture Decision Records (ADR)/0074-loop-governor.md` (the seam being built)
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
| Delivery-policy table | 0068 | partial-contract | ❌ | ⚠️ | `fetch_alert`-literal slice; verdict `send\|hold\|degrade\|drop` ✓, exempt-cap invariant ✓. Needs 10-member push-class enum, `DeliveryPolicyRow`, tier budget, held-candidates, widened Admission → **SLICE-2**. |
| Routing + model policy | 0069 | partial-contract | ✅ | ✅ | Roster + routing rows present; shadow-eval + cost/escalation telemetry deferred. |
| **Loop Governor** | **0074** | **contract-only¹** | ❌ | ✅ | **This PR (SLICE-1)** ships the full manifest + arbiter + fail-closed registry. Runtime arbiter comparator, per-run budget/kill enforcement, dedup, no-progress guard (`loop_progress` table) → **SLICE-3**. |
| Tools / ACL / auth | 0008/0032/0033 | contract-only | ✅ | ⚠️ | ACL map + mint + consent solid. Taint→privileged-action gate ships two unreconciled functions; authority "OPEN, not decided" (finding §6.2). |
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
| **This PR** | **ADR-0074 Loop Governor contract (SLICE-1): full LoopPolicy manifest, arbiter precedence, disposition, fail-closed `LOOP_POLICIES` registry + `lookupLoopPolicy` + `admit(policy\|null)`; minimal tracer-compat patch** |

---

## 5. Remaining steps — the governor/delivery/outbox seam is 3 PRs, not 1

The critic confirmed MUST-SPLIT. Verified against ADR text: the manifest (11 fields + `loop_progress` table), the delivery table (10-member enum + rows + budget + held-candidates), and the durable outbox (PK change + retry lifecycle + cross-store mirror) each touch a different surface. Fusing them = the giant diff to avoid.

| Slice | Scope | DDL? | Runtime tests? |
|---|---|---|---|
| **SLICE-1 (this PR)** | Loop Governor contract — manifest, arbiter `priorityTierRank`, disposition, `LOOP_POLICIES` registry, fail-closed `admit`. **Breaking** shape-change to `loopPolicySchema` (removed `admit`, added 10 required fields) — safe only because contained: grep-verified the sole in-repo consumer is the `@waldo/runtime` tracer (patched here), it is not in the public OpenAPI surface, and no downstream repo depends on it. + tracer-compat. | No | No (contract-only; tracer behavior unchanged) |
| **SLICE-2 (next, contract-only)** | Delivery-policy expansion: grow `pushClassSchema` `fetch_alert`-literal → 10-member enum; add `deliveryPolicyRowSchema` + `DELIVERY_POLICY` + `TRIGGER_PUSH_CLASSES` + tier caps; widen `admissionSchema` → `channels[]`/`collapse_id`/`hold_until`. Encode the **correct** invariant "every agent-reachable exempt class carries a non-null cap" (NOT the stale `agent_invocable ∩ exempt = ∅` set). | No | No |
| **SLICE-3 (later, runtime)** | Durable outbox/journal DDL (PK = idempotency key, `status`/`attempts`/`next_retry_at`, `held_candidates` + `loop_progress` tables, Supabase `notification_log` UNIQUE mirror); run-FSM re-expansion; scheduler multiplexer; async retried flush; governor budget/kill/no-progress runtime. | **Yes** | **Yes — real `@cloudflare/vitest-pool-workers` cross-eviction; exactly-once *delivery* cannot be certified without them** |

Deferred from SLICE-1 into SLICE-3 (no caller in a contract-only PR): the arbiter comparator (`compareLoopAdmission`), within-run dedup (`dedupInput`), and the cross-run no-progress guard (`isStuck`) — all consume runtime tool-execution data / the `loop_progress` table. The ADR-0074 §Move1.4 DELIVER egress floor stays deferred (it is runtime); it will reuse the now-single-sourced `RAW_SENSOR_PATTERNS` (widened in PR #13, §6.1) rather than declaring a third hand-rolled copy.

After the seam: telemetry contracts → public DTOs + OpenAPI emitter + generated-client freshness → scenario/property/mutation lanes → live/dogfood lanes.

---

## 6. Security / adversarial findings (pre-existing; flagged, not fixed here)

All three are pre-existing on `main`, latent (no runtime executes them today), and outside this PR's diff. Per posture, they are logged for dedicated follow-ups, not fixed as a side effect of a governor PR.

### 6.1 [HIGH · Art-9] Scribe sanitiser vocabulary — RESOLVED in PR #13 (`foundation/sanitiser-art9-parity`, open → main)
- **Was:** `RAW_SENSOR_PATTERNS` covered only HRV / HR / SpO2 / sleep in a prose shape — narrower than the project's own `guard-health-leak.mjs` `HEALTH_TOKENS` superset (weight, blood pressure incl. systolic/diastolic, calorie burn, active energy) — and it missed the shape health data actually takes: structured payloads with snake_case / kebab / camelCase keys, unit-suffixed keys (`hrv_ms`, `weight_kg`, `systolicMmHg`), and quoted numeric / BP-ratio values. The compensating guard was `warn`/exit-0.
- **Fixed (PR #13):** `RAW_SENSOR_PATTERNS` rebuilt with unit-suffix + quoted-value + BP-ratio coverage and a precision model — specific tokens (hrv/spo2/systolic/blood pressure/body weight/…) match on any separator; **hr/weight take a bare number on a colon/equals key** (the real wearable-field shape) but need a unit on bare whitespace; bp needs a ratio or mmHg; sleep needs a duration unit — so whitespace prose (a duration, a graph edge weight, a basis-points delta, a backoff) is not over-redacted. **Art-9 fail-safe trade:** a colon-keyed non-health token (e.g. an HR-team count) is over-redacted rather than risk a missed reading — a rejected write is recoverable, a leaked body weight is not. `guard-health-leak` flipped `warn`→`block` + gained unit-suffix tolerance; `guards-selftest` proves quoted/snake/camel/unit-suffix leaks fail CI and zone prose passes. Derived via a 4-agent adversarial sweep + deterministic node verification; the bare-colon-key recall regression from the first cut was caught in review and fixed. Mutation-proven non-vacuous.
- **Remaining (cross-repo follow-up):** amend ADR-0024's canonical §Check-2 block in `waldo-brain` to match the widened set. **Residual** (deterministic-floor limits — the ADR-0074 §Move1.4 grader's job, not this floor): a value nested under an inner key (`hrv: { quantity: 42 }`), a word between key and number (`hrv: approx 42`), CSV commas, and health metrics outside these families (glucose / bmi / temperature / vo2max / respiratory rate) — the latter is the metric-vocabulary curation the ADR-0024 amendment should settle.

### 6.2 [MEDIUM] ADR-0049 taint→privileged-action gate ships two unreconciled authorities
- **Where:** `packages/contracts/src/core/hooks.ts:155-159` (gate slot `priority: null`, "OPEN, not decided"), `tools/handler.ts:70-72` (`taintGateBlocksDirectExecution`, tool-scoped) vs `hooks.ts:163` (`taintGateTrips`, tool-agnostic). `PRIVILEGED_ACTION_TOOLS` omits `delete_message`/`restore_message`/`archive_thread`/`update_thread_topics`/`call_mcp_tool`.
- **What:** a future dispatcher wiring the tool-scoped gate would let external-tainted content drive message-mutation/MCP-write without routing through `propose_action` — contradicting ADR-0049's own verification text.
- **Fix (own PR + founder call on the authority):** pick one of — add the omitted tools to `PRIVILEGED_ACTION_TOOLS`; or collapse to `taintGateTrips` as the single authority; or per-handler `autonomy_gated`. Add a hostile-fixture test. **Do not** bundle into a governor PR — it is a security-boundary design decision.

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

Continue the Waldo backend foundation from updated `main` after the Loop Governor contract
(SLICE-1) merges. Read first:
- .claude/rules/INDEX.md
- docs/foundation/BUILD-PLAN.md
- docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md
- docs/foundation/FOUNDATION-HANDOVER.md   (this file — §5 slices, §6 findings, §7 single-writer)
- primary ADR markdown for the touched seam under
  waldo-brain/01-Waldo/Architecture Decision Records (ADR)/  (read the .md, not only DeepWiki)

Baseline gate before any code:
  pnpm verify            # (pnpm 10.34.4 on PATH; or npx -y pnpm@10.34.4 verify)
  git diff --check
If red or the branch is unmergeable, stop and report the blocker.

Pick ONE of these, single-writer, contract-only unless noted, tests-first, its own small PR:

1. SLICE-2 — delivery-policy expansion (ADR-0068), contract-only. Grow pushClassSchema to the
   10-member enum; add deliveryPolicyRowSchema + DELIVERY_POLICY + TRIGGER_PUSH_CLASSES + tier
   caps; widen admissionSchema (channels[]/collapse_id/hold_until); encode "every agent-reachable
   exempt class carries a non-null cap" (NOT the stale ∅ invariant). Exact valid/invalid + golden
   trace tests. No DDL.

2. DONE in PR #13 — HIGH Art-9 sanitiser hardening: RAW_SENSOR_PATTERNS widened to structured
   payloads (unit-suffixed / snake / camel keys, quoted + BP-ratio values) on a specific/ambiguous
   precision model; guard-health-leak warn->block + unit-suffix tolerance; adversarial-swept +
   mutation-proven. Remaining sliver: amend ADR-0024's canonical §Check-2 block in waldo-brain
   (cross-repo). (Finding §6.1.)

3. ADR-0049 taint-gate reconciliation (ADR-0049/0032) — own PR + a founder call on the authority
   (add omitted tools to PRIVILEGED_ACTION_TOOLS | collapse to taintGateTrips | per-handler
   autonomy_gated). Hostile-fixture test. (Finding §6.2 — needs human-visible decision.)

Do NOT: start the DO runtime (SLICE-3, delivery flusher, scheduler multiplexer, sanitiser runtime,
full run-FSM) until (a) PR #13 (§6.1 sanitiser hardening) has merged, (b) a cross-eviction
@cloudflare/vitest-pool-workers substrate proves exactly-once DELIVERY (not just enqueue), (c) §6.2
authority is decided. Do NOT
broaden into telemetry, public DTOs, OpenAPI, or generated clients in the same PR as a contract seam.

Use dynamic workflows for research/review/attack/disjoint modules only; keep runtime + shared
contract files single-writer. Report: files changed, commands + exact results, intentional-break
evidence, residual risks, exact next slice.
```
