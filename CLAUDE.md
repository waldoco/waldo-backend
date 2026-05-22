# Waldo Backend — Claude Code Instructions

## What This Repo Is

Supabase data layer + Cloudflare Durable Objects agent brain for Waldo.

**Brand:** Waldo (dalmatian). Tagline: "Already on it."  
**Stack:** Supabase Postgres (ap-south-1) + Cloudflare DO + CF AI Gateway + R2  
**Phase:** Phase 1 — Launch (June 2026)

## The Non-Negotiable Rules

1. **CF DO = the ONLY agent brain.** EFs = data sync + CRS computation ONLY. No LLM calls from EFs, ever.
2. **12 EFs max.** Adding a 13th requires a team discussion.
3. **Raw health values NEVER enter DO SQLite.** Only derived insights (zone, summary, pillar_drag). Raw values (HRV ms, RHR bpm, sleep_duration_min) stay in Supabase health_daily only.
4. **Every EF: `validateJWT()` in the first 10 lines.** Not line 50. First 10.
5. **Every tool result: `sanitizeToolReturn()` before the ReAct loop sees it.**
6. **CRS engine (`core/crs/`) has zero imports from adapters or providers.** Pure TypeScript math.
7. **`invoke-agent` EF does not exist.** If you see one being created, stop.

## Source-of-Truth Docs (read these before touching any file)

- `../waldo-brain/01-Waldo/planning/WALDO_V1_MASTER_PLAN.md` — shared decisions, DDL, phases
- `../waldo-brain/01-Waldo/planning/WALDO_BACKEND_PLAN.md` — build sequence, EF specs
- `../waldo-brain/01-Waldo/planning/WALDO_AGENT_HARNESS_PLAN.md` — harness, memory, tools

## Architecture

```
supabase/
  migrations/           ← 13 tables, each with rollback pair
  functions/
    _shared/            ← auth.ts, zod-schemas.ts, rate-limit.ts (imported by every EF)
    [12 EF directories]

cloudflare/waldo-agent/src/
  adapters/llm/         ← GemmaProvider, AnthropicProvider, FallbackChain
  adapters/channel/     ← TelegramAdapter, PushAdapter (APNs + FCM)
  adapters/health/      ← SupabaseHealthSource
  core/crs/             ← engine.ts, weights.ts (LOCKED — SAFTE-FAST grounded)
  core/memory/          ← scribe, bm25, temporal, fusion, decay, cara, fence, security, retrieve
  core/harness/         ← runAgentLoop, promptBuilder, preFilter, qualityGates, compaction
  core/dreaming/        ← orchestrator, consolidate, precompute
  tools/                ← 16 files, one tool per file
  agent.ts              ← DO class + HTTP routing ONLY (<300 lines)
```

## CRS Formula (LOCKED — do not change without team discussion)

```
Form     = Sleep×0.50 + HRV×0.35 + Circadian×0.075 + Motion×0.075
Recovery = Sleep×0.50 + CASS×0.25 + RHRTS×0.15 + RRS×0.10
Weight   = Load×0.20 + Stack×0.25 + Signal×0.20 + Task×0.20 + Mind×0.15
```

## Waldo Brand Naming (use in all agent output, logs, code comments)

| Code name | User-facing name |
|---|---|
| CRS / Form score | **Form** |
| Fetch Alert | **The Fetch** |
| Morning Brief | **Morning Wag** |
| Day Strain | **Load** (0-21) |
| Activity Score | **Motion** |
| Recovery Score | **Recovery** |
| Nap Score | **Form** (never "Nap Score") |

## Health Data Security (NON-NEGOTIABLE)

- Raw health values never in logs, never in DO SQLite, never in agent context
- JWT validated on every EF before any data access
- RLS on every Supabase table from day 0
- Samsung HRV proxy: DO NOT implement without validated formula from physiological research

## Waldo Agent AI Gateway

```
Base URL: https://gateway.ai.cloudflare.com/v1/31680869a0e27d263df99818ceca94fb/waldo
Primary model: @cf/google/gemma-4-27b-a4b (~95% calls)
Reasoning model: claude-sonnet-4-6 (~5% — pattern analysis only)
OTel: → Langfuse OTLP endpoint (automatic, zero code needed)
```

## CI Hooks (enforced — not aspirational)

- `file-size-check.sh` — any .ts > 800 lines = fail
- `health-value-lockout.sh` — raw HRV/RHR in DO code = fail
- `no-invoke-agent.sh` — invoke-agent reference = fail
- `no-verify-check.sh` — --no-verify attempt = blocked
