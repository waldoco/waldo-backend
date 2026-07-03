# waldo-backend — Claude Code Instructions

## Current Foundation Status (2026-07-03)

The legacy guidance below is kept for repo background, but current foundation
work is governed by the local rule index, foundation docs, accepted ADRs, and
Waldo Brain DeepWiki pages.

Before any implementation:

1. Read `.claude/rules/INDEX.md`.
2. Read `docs/foundation/BUILD-PLAN.md`.
3. Read `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`.
4. Read `docs/foundation/NEXT-SESSION-PLAN.md`.
5. Read the relevant Waldo Brain DeepWiki pages and accepted ADRs.

Current facts:

- Collaboration model: Claude Code builds; Codex audits adversarially.
- Foundation Phases A/B/C and Phase D Waves 1-4a are on `main` via PR #7:
  root contracts, CI/conformance wall, Cloudflare Workers/Durable Object test
  substrate, the scheduled durable-execution tracer bullet, memory/CRS/prompt,
  routing/LLM, UI cards/notifications, and provider adapter contracts.
- Phase C is still a tracer, not the full contract spine. It proves one
  scheduled path in workerd: `DO alarm -> Loop Governor -> run journal ->
  DeliveryGate -> outbox -> fake sink`, including crash/resume exactly-once.
- The post-PR7 contract branch adds channel adapters, tool union/ACL/schemas/handler,
  core hooks, memory-skill lifecycle, and auth minting/consent contracts. Once
  that branch lands, the next work is runtime run/session/working-memory and
  scheduler/goal contracts. Do not replay A/B/C or Waves 1-4a unless a regression
  forces it.
- `@waldo/types` and legacy `waldo-types` references are stale for this branch.
  Current contracts live in `waldo-backend/packages/contracts`.
- ADR-0069 owns the model roster. Do not use stale ADR-0003 model IDs.
- ADR-0068 current block owns DeliveryGate: no `defer_next_day`; `fetch_alert`
  is budget-exempt but class-capped and telemetry-counted.
- Current merge gate: `npx -y pnpm@10.34.4 verify` plus `git diff --check`.
  Bare `pnpm verify` is acceptable only when the active pnpm is `10.34.4`.

## What this repo is

**Supabase + Cloudflare** = Waldo's brain.

- Supabase Postgres (16 tables · RLS on every one) — health data layer
- Supabase Edge Functions (Deno) — webhook ingestion, OAuth, cron triggers
- Cloudflare Worker — agent runtime entry router
- Cloudflare Durable Object — per-user agent brain with built-in SQLite (10 tables: memory_blocks, episodes, procedures, ...)
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
- `@waldo/types` from private npm (HEY-7 + HEY-63)
- OpenTelemetry SDK (OTLP export to CF AI Gateway)
- Node 22 LTS for local dev (`tsx`)

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test                              # vitest

# Supabase
supabase functions serve               # local EF
supabase db push                       # apply migrations
supabase functions deploy <name>

# Cloudflare
wrangler dev --local                   # local Worker
wrangler deploy --env staging
wrangler tail --env staging            # live logs
wrangler durable-objects:list

# Eval
pnpm eval                              # 30-case golden test set
```

## Issue tracker

**Linear team HeyWaldo** → [linear.app/heywaldo](https://linear.app/heywaldo)

- PR title MUST include `HEY-NN`
- Branch name: `hey-NN-<slug>`
- PR description: `Closes HEY-NN`
- Active tickets here: filter `repo:waldo-backend`

## Triage labels (Matt Pocock state machine)

Same set as the other repos (P0-P3 · ready-for-agent/human · type:* · repo:*). See `waldo-brain/01-Waldo/repo-bootstraps/README.md`.

## Domain docs (waldo-brain)

- **`waldo-brain/01-Waldo/planning/WALDO_V1_MASTER_PLAN.md`** — build plan
- **`waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`** — 42 ADRs
- **`waldo-brain/04-Agent-Harness/`** — agent runtime master notes
- **`waldo-brain/03-References/ADL/`** — research grounding (Hermes, Cursor, MemPalace, Cognee, agentic-stack, Fowler SPDD, squad, federated learning)
- **`waldo-brain/05-Team/suyash/app-task-flows/`** — UX flow specs (read these BEFORE building any tool that affects user-facing surface)
- **Soul files (immutable)** — `waldo-brain/01-Waldo/agent/SOUL_*.md`. NEVER edit at runtime. Git PR + review only.

Critical ADRs for this repo:
- ADR-0002 Agent in CF DO, health in Supabase
- ADR-0003 Gemma 4 27B primary
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

Before any work, read **`waldo-brain/.claude/rules/mental-model.md`**. Summary:

1. **Problem-first** — find ROOT CAUSE at system + library level. Never patch symptoms. `/diagnose`.
2. **Product-first** — every line traces to a JTBD. If you can't name the user problem, delete it. `/grill-me`.
3. **First-principles** — decompose every claim. Cite primary sources. `/grill-with-docs`.
4. **Test-heavy + thorough QA** — E2E is the only truth. 40/40/20 inverted pyramid. 5-step adversarial QA per feature. `/tdd` + `qa-breaker`.
5. **NO AI SLOP** — every line earns its place. Slop = correct-but-bad: verbose where tight wins, generic where specific is needed, hedged where opinion was asked, format-drift, unrequested disclaimers, junk that fills context windows for the next session. Each line of code answers: WHY is it here, is it solving the requested purpose, is it the real fix not a patch, would a thoughtful reviewer ship it without changes. Delete anything that fails the test. See `waldo-brain/.claude/rules/mental-model.md` §5.

## Build → Break → Fix philosophy (for THIS repo)

1. Read the Linear ticket
2. Read the linked ADR(s)
3. **First-principles check** — does the ADR fit the actual constraints? Push back BEFORE coding if not.
4. Read the relevant `.claude/rules/INDEX.md` ADR-by-area entries
5. **Test-first** — golden test from the Acceptance section. Failing first. `/tdd`.
6. Implement until green
7. Integration test against real Supabase + CF Worker (not mocks alone)
8. **5-step QA pass** — happy · null · hostile · concurrent · degraded. `/break-feature` or `qa-breaker` agent.
9. Run `/diagnose` on any recurring failure — ROOT CAUSE, never quick patch
10. Run `/grill-with-docs` for any decision that drifts from existing ADRs
11. Open PR with `Closes HEY-NN` + reference linked ADR in description
12. After merge: if production telemetry flags anomaly — `/diagnose` ROOT CAUSE before any hotfix

## Source of truth

When in doubt, in order:
1. The Linear ticket description (it links the ADR)
2. The ADR (it links research + grounding docs)
3. `WALDO_V1_MASTER_PLAN.md` for cross-cutting context
4. The ADR's "Grounded in" references

Anything in `Docs/archive/` is superseded.

## Cross-session bus

**[MUST]** Invoke `/session-bus` at session START and END. Reads/writes Linear `State — waldo-backend` doc + Linear Session Log issue + `waldo-brain/04-Sessions/handoffs/waldo-backend/`. See ADR-0043. This is how Shivansh, Pranav, Aachi avoid divergence across machines.
