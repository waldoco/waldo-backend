# waldo-backend — Claude Code Instructions

## Current Foundation Status (2026-07-12)

Current work is governed by the local rule index, active foundation docs, accepted ADRs, and
Waldo Brain source pages. Archived foundation docs are archaeology, not onboarding.

Before any implementation:

1. Read `.claude/rules/INDEX.md`.
2. Read `docs/foundation/CONTRIBUTOR-ONBOARDING.md`.
3. Read `docs/foundation/AGENT-OPERATING-WORKFLOW.md`.
4. Read `docs/foundation/NEXT-SESSION-PLAN.md`.
5. Read `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`.
6. Read `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`.
7. Read `docs/planning/WALDO_APP_BACKEND_INTEGRATION_PLAN.md` for app/backend path or cutover work.
8. Read the relevant Waldo Brain source pages and accepted ADRs.

Current facts:

- Temporary harness-wave override: Codex coordinates and builds HEY-14, HEY-15, HEY-144, HEY-16,
  HEY-100, HEY-75, and HEY-141. Review remains independent; this does not amend the mirrored
  universal rules.
- Runtime foundation through HEY-142 is merged: scheduler, Loop Governor, journal/outbox,
  DeliveryGate, hooks, ToolDispatcher/ACL, fake-first LLM provider, fake-first `RunLoopDO`,
  ingress/idempotency/gate/failure hardening, governed multi-iteration looping, and local replay.
- HEY-10 is merged: DO SQLite context schema root.
- HEY-111 is merged: typed local runtime evidence, replay fixtures, and local rule-based eval.
- PR #44 merged bounded provider-readiness/fail-closed hardening; HEY-143 remains In Progress because
  real context/provider/sink/staging/Alpha proof is absent.
- HEY-13 structured Scribe/sanitizer runtime is merged and Done at `82f582b5`; its final local
  evidence is 1,188 contract tests, 485 runtime tests, 235 property tests, and a 351-mutant lane
  with 342 killed, 9 timed out, and no survivors, uncovered mutants, or errors.
- Wave 0 reconciliation merged in PR #49 (`a257a175`). The verified subsequent merge order was
  PR #50 (`7d02b173`, HEY-100) -> PR #52 (`4e1cac30`, HEY-144) -> PR #51 (`2fd798f8`, HEY-75).
- HEY-14's fresh preflight passed the `2fd798f8` baseline but found no typed WorkspaceMount/R2 seam.
  HEY-163 is the contract-only ADR-0029/0076 fulfillment; HEY-166 now owns the proposed bounded
  blob/admission policy; HEY-167 owns the required canonical reader-Scribe/token-budget decision.
  All three block HEY-14 implementation.
- HEY-150 matrix review and HEY-151/152 contract/cutover work can proceed alongside HEY-125;
  HEY-157 and HEY-159 are parallel roots, not children of HEY-150.
- HEY-144's V2 goals storage foundation is merged. The remaining context sequence is HEY-163 ->
  HEY-166 -> HEY-167 -> HEY-14 -> HEY-15 -> HEY-16; HEY-15 retains its admission/rebase discipline.
  Full goal hydration still awaits HEY-162's Scribe-backed admission boundary.
- Do not call the harness a complete Pi/Hermes-style agent loop until real context/recall/provider,
  Scribe, delivery, staging, and Alpha proof are wired and verified.
- The 16-table Supabase/RLS data plane is intended/contracted, not merged or staging-proven.
  HEY-134 owns the canonical migration/RLS/Vault re-land; HEY-114 owns environment and rollback
  proof.
- Brain PR #17 merged at `75591543053dbdda6cf7c7f0210f8d16f36c3db8`. Its ADR-0001/0071/0077
  amendments and new accepted ADR-0081/0082 govern architecture, ownership, and destination rules;
  they do not constitute runtime, device, staging, or production proof.
- Retired external contract package references are stale for this branch.
  Current contracts live in `waldo-backend/packages/contracts`.
- ADR-0069 owns the model roster. Do not use stale ADR-0003 model IDs.
- ADR-0068 current block owns DeliveryGate: no `defer_next_day`; `fetch_alert`
  is budget-exempt but class-capped and telemetry-counted.
- Current merge gate: `npx -y pnpm@10.34.4 verify` plus `git diff --check`.
  Bare `pnpm verify` is acceptable only when the active pnpm is `10.34.4`.

## What this repo is

**Supabase + Cloudflare** is Waldo's intended production brain. The current repo contains a broad
local contract/runtime spine, not the complete deployed data plane below.

- Supabase Postgres (intended 16 tables with RLS on every one; not merged/staging-proven) — health
  data layer; HEY-134/114 own canonical migration/environment proof
- Supabase Edge Functions (Deno) — webhook ingestion, OAuth, cron triggers
- Cloudflare Worker — agent runtime entry router
- Cloudflare Durable Object — per-user agent brain with built-in SQLite (HEY-10's 10-table V1 plus
  the merged V2 goals storage foundation)
- Cloudflare R2 — cold archive (episodes 90d+)
- Cloudflare AI Gateway — single key, all LLM calls routed through

No mobile code. No marketing site. Just data + agent.

## Tech stack

- Deno 1.46+ (Supabase Edge Functions runtime)
- TypeScript 5.4+ strict mode
- Wrangler 4.x (CF Workers + Durable Objects)
- Postgres 16 + pgvector + pg_cron
- `@anthropic-ai/sdk` for Claude calls (Haiku 4.5 default, Sonnet 4.6 for ~5%)
- `@google/genai` + Workers AI for Gemma 4 27B/9B
- grammY for Telegram (ADR-0012)
- Local workspace contracts in `packages/contracts`
- OpenTelemetry SDK (OTLP export to CF AI Gateway)
- Node 22 LTS for local dev (`tsx`)

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test                              # vitest

# Supabase
supabase functions serve               # local only; fake/empty test inputs
# supabase db push                      # PROHIBITED in Waves 0-3 without explicit human authority
# supabase functions deploy <name>      # PROHIBITED in Waves 0-3 without explicit human authority

# Cloudflare
wrangler dev --local                   # local Worker with fake bindings
# wrangler deploy --env staging         # PROHIBITED in Waves 0-3 without explicit human authority
# wrangler tail --env staging           # PROHIBITED in Waves 0-3 without explicit human authority
# wrangler durable-objects:list         # requires separately authorized remote-read scope

# Eval
# No pnpm eval script exists in this checkout yet.
# Use /run-eval to probe the eval gate, record the gap, and run verify.
```

## Issue tracker

**Linear team HeyWaldo** → [linear.app/heywaldo](https://linear.app/heywaldo)

- PR title MUST include `HEY-NN`
- Branch name: `hey-NN-<slug>`
- PR description: `Closes HEY-NN`
- Active tickets here: filter `repo:waldo-backend`

## Triage labels (Matt Pocock state machine)

Same set as the other repos (P0-P3 · ready-for-agent/human · type:* · repo:*). See [waldo-brain/01-Waldo/repo-bootstraps/README.md](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/repo-bootstraps/README.md).

## Domain docs (waldo-brain)

- **[01-Waldo/planning/WALDO_V1_MASTER_PLAN.md](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/planning/WALDO_V1_MASTER_PLAN.md)** — build plan
- **[01-Waldo/Architecture Decision Records (ADR)](https://github.com/Pin4sf/waldo-brain/tree/main/01-Waldo/Architecture%20Decision%20Records%20%28ADR%29)** — accepted ADRs, including Brain PR #17's merged amendments
- **[04-Agent-Harness](https://github.com/Pin4sf/waldo-brain/tree/main/04-Agent-Harness)** — agent runtime master notes
- **[03-References/ADL](https://github.com/Pin4sf/waldo-brain/tree/main/03-References/ADL)** — research grounding (Hermes, Cursor, MemPalace, Cognee, agentic-stack, Fowler SPDD, squad, federated learning)
- **[05-Team/suyash/app-task-flows](https://github.com/Pin4sf/waldo-brain/tree/main/05-Team/suyash/app-task-flows)** — UX flow specs (read these BEFORE building any tool that affects user-facing surface)
- **Soul files (immutable)** — [01-Waldo/agent](https://github.com/Pin4sf/waldo-brain/tree/main/01-Waldo/agent). NEVER edit at runtime. Git PR + review only.

Critical ADRs for this repo:
- ADR-0002 Agent in CF DO, health in Supabase
- ADR-0003 Historical initial model-routing context; ADR-0069 owns the current model roster
- ADR-0004 CF AI Gateway single LLM gateway
- ADR-0005 5 typed memory halls
- ADR-0006 Scribe inbox-merge
- ADR-0008 Per-trigger tool ACL
- ADR-0017 Patrol cadence (15 min + pre-Brief sweep)
- ADR-0020 Intervention triggers + cooldown + learning
- ADR-0022 Skill system architecture
- ADR-0024 Scribe sanitiser canonical spec (5 checks)
- ADR-0030 Verification layer (LLM-judge + WIS + trace eval)
- ADR-0031 Recall-before-act explicit wiring
- ADR-0032 Hooks-based safety layers (7 events)
- ADR-0033 Session trust reset on DO alarm wake
- ADR-0034 Tool output compression + search_tools lazy discovery
- ADR-0037 Append-only event log + stable pattern_id
- ADR-0040/41/42 — Calendar + voice memo + pre_activity_spot

## Rules

See `.claude/rules/INDEX.md`. Highlights:

- JWT validation on EVERY EF (first 10 lines) via `_shared/auth.ts`
- RLS policy `auth.uid() = user_id` on every Postgres table
- `safeFetch()` wrapper for all outbound HTTP (URL allowlist)
- Secrets in CF Secrets Store ONLY — never env vars, never code
- Health values NEVER in agent_logs, DO SQLite, or R2
- Append-only on agent_logs / episodes / patrol_log / interventions / trace_evaluations / sheet_commits / outcome_signals / crs_history / agent_evolutions / waldo_experiments — UPDATE/DELETE blocked via `AuditedDB` wrapper (HEY-11)
- Tool ACL enforcement at tool-handler entry (per trigger) via `enforceACL()` — see ADR-0008

## Conventional commits

`feat(agent): ...` · `fix(scribe): ...` · `feat(adapter): ...` · `chore(deps): ...` · `docs: ...` · `test: ...` · `refactor: ...`

## NEVER

- Never log raw health values (HRV, HR, sleep hours, SpO2, weight, blood pressure)
- Never write to memory_blocks directly — use Scribe inbox-merge (ADR-0006)
- Never UPDATE or DELETE on append-only tables (use AuditedDB)
- Never bypass `_shared/auth.ts` JWT validation
- Never use service-role key outside of `build-intelligence` + audit writes
- Never call LLM provider directly — route through `LLMProvider` adapter + CF AI Gateway
- Never `eval()` or `new Function()` — execute_code must go through CF Sandbox SDK (ADR-0023)
- Never include user PII (emails, phones, names) in prompts unless sandwich-defended and template-wrapped
- Never use `--no-verify` on commits
- Never auto-modify soul files (SOUL_BASE, SOUL_STRESS, SOUL_MORNING) — they are read-only at runtime

## Mental model (the 5 non-negotiable disciplines)

Before any work, read **[waldo-brain/.claude/rules/mental-model.md](https://github.com/Pin4sf/waldo-brain/blob/main/.claude/rules/mental-model.md)**. Summary:

1. **Problem-first** — find ROOT CAUSE at system + library level. Never patch symptoms. `/diagnose`.
2. **Product-first** — every line traces to a JTBD. If you can't name the user problem, delete it. `/grill-me`.
3. **First-principles** — decompose every claim. Cite primary sources. `/grill-with-docs`.
4. **Test-heavy + thorough QA** — E2E is the only truth. 40/40/20 inverted pyramid. 5-step adversarial QA per feature. `/tdd` + `qa-breaker`.
5. **NO AI SLOP** — every line earns its place. Slop = correct-but-bad: verbose where tight wins, generic where specific is needed, hedged where opinion was asked, format-drift, unrequested disclaimers, junk that fills context windows for the next session. Each line of code answers: WHY is it here, is it solving the requested purpose, is it the real fix not a patch, would a thoughtful reviewer ship it without changes. Delete anything that fails the test. See [mental-model.md §5](https://github.com/Pin4sf/waldo-brain/blob/main/.claude/rules/mental-model.md).

## Build → Break → Fix philosophy (for THIS repo)

1. Read the Linear ticket
2. Read the linked ADR(s)
3. **First-principles check** — does the ADR fit the actual constraints? Push back BEFORE coding if not.
4. Read the relevant `.claude/rules/INDEX.md` ADR-by-area entries
5. **Test-first** — golden test from the Acceptance section. Failing first. `/tdd`.
6. Implement until green
7. In Waves 0-3, integration test hermetically with Miniflare, fake bindings, fake provider, and
   fake sink. Real Supabase/Cloudflare/staging validation needs separate explicit human authority.
8. **5-step QA pass** — happy · null · hostile · concurrent · degraded. `/break-feature` or `qa-breaker` agent.
9. Run `/diagnose` on any recurring failure — ROOT CAUSE, never quick patch
10. Run `/grill-with-docs` for any decision that drifts from existing ADRs
11. Open PR with `Closes HEY-NN` + reference linked ADR in description
12. After merge: if production telemetry flags anomaly — `/diagnose` ROOT CAUSE before any hotfix

## Source of truth

When in doubt, in order:
1. Mirrored universal rules and accepted ADRs for architecture, safety, and ownership.
2. Verified current source and command output for implementation truth.
3. Active foundation docs for the current build order.
4. Linear tickets, the coordinator ledger, and handoffs for mutable scope/state only.
5. [WALDO_V1_MASTER_PLAN.md](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/planning/WALDO_V1_MASTER_PLAN.md) for cross-cutting context.
6. The ADR's "Grounded in" references.

Anything in `Docs/archive/` is superseded.

## Cross-session bus

Use HEY-109, Linear issue comments, the coordinator ledger, and repo-local phase handoffs at session
start and end. The legacy `/session-bus` markdown is not a loadable skill package and contains stale
tool identifiers; record the packaging repair gap rather than invoking or repairing it inside a
feature ticket.
