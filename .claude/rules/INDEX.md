# waldo-backend — Rule Index

All canonical rules live in `waldo-brain/.claude/rules/`. This index points at the ones an agent working in this repo MUST read before generating code.

## Hard rules (read first, IN ORDER)

0. **`waldo-brain/.claude/rules/mental-model.md`** — **READ THIS FIRST. Always.** 4 non-negotiable disciplines: Problem-first · Product-first · First-principles · Test-heavy + thorough QA. Every other rule builds on these.
1. **`waldo-brain/.claude/rules/health-data-security.md`** — NON-NEGOTIABLE. Encryption, RLS, secrets, prompt injection, egress, audit. Health data is special-category under GDPR Art 9. Every line in this file is a P0 rule.
2. **`waldo-brain/.claude/rules/architecture.md`** — 10+ locked decisions. Tool ACL matrix (ADR-0008). Adapter pattern. Reliability patterns. Agent security hardening. Memory architecture.
3. **`waldo-brain/.claude/rules/coding-standards.md`** — TypeScript strict mode. Edge Function patterns. Worker + DO patterns. Adapter pattern code structure. NEVER list.
4. **`waldo-brain/.claude/rules/phase-orchestration.md`** — Which review agents to run per phase. Dev-QA loop. Handoff templates.
5. **`waldo-brain/.claude/rules/language.md`** — Architecture vocabulary (Module · Interface · Implementation · Depth · Seam · Adapter · Leverage · Locality).

## Specific ADRs by area

| Working on... | Required ADRs |
|---|---|
| Agent runtime (DO) | 0002, 0033, 0034, 0037 |
| Memory architecture | 0005, 0006, 0007, 0024, 0031, 0037 |
| LLM routing | 0003, 0004, 0035 |
| Tool ACL + skills | 0008, 0021, 0022, 0023, 0028 |
| Triggers | 0014, 0015, 0017, 0020, 0042 |
| Adjustment / autonomy | 0018, 0019 |
| Channels | 0012, 0035 (Telegram + APNs) |
| Threading | 0014, 0039 |
| Pricing + budget | 0009, 0016 |
| Verification + evolution | 0030, 0036, 0038 |
| Security gates | 0024, 0032, 0033 |
| Calendar adapter | 0040, 0042 |
| Voice memo | 0041 |
| CRS algorithm | 0011 |
| Episode log + pattern_id | 0037 |

## Skills active for this repo

- `/grill-me` — before any new design decision lands as ADR
- `/grill-with-docs` — when extending an existing ADR
- `/diagnose` — for any recurring bug (RCA discipline per memory rca_framework)
- `/tdd` — golden test FIRST for every tool handler
- `/zoom-out` — when a single-ticket fix risks cross-cutting impact

## Phase-specific review agents

See `waldo-brain/.claude/rules/phase-orchestration.md` for the full per-phase matrix. For Sprint 1-2 work in this repo:

- **`security-reviewer`** — every PR that touches: auth, RLS, JWT, secrets, egress, hooks, scribe
- **`health-data-reviewer`** — every PR that touches: CRS engine, baselines, health-data flow
- **`workflow-mapper`** — BEFORE writing any new trigger / agent loop logic
- **`crs-validator`** — every PR that touches CRS algorithm

## Pre-commit checks (skill-driven, not hook-blocked)

We rejected blocking pre-commit hooks. Hooks add friction; skills + review agents add discipline. Checks below run via skills / agents / CI — not as commit blockers.

- `pnpm typecheck` runs in CI; agent runs it before PR
- `pnpm test` runs in CI; `/tdd` skill enforces test-first locally
- Health-value lockout enforced by Scribe sanitiser (ADR-0024) at runtime, by `security-reviewer` agent at PR time
- `--no-verify` is forbidden by CLAUDE.md NEVER list (agent self-policed)
- Conventional commit prefix + `HEY-NN` reference checked by `/diagnose` if a PR title looks off

## Things NOT in scope for this repo

- Mobile UI code (belongs in waldo-app)
- iOS Swift modules (belongs in waldo-app)
- Android Kotlin modules (belongs in waldo-app)
- Marketing site (belongs in waldo-web, deferred)
- Type definitions consumed by 2+ repos (belongs in waldo-types)
- Research docs / ADRs themselves (belong in waldo-brain)

## Egress allowlist (`safeFetch` enforcement)

Currently allowed outbound hosts:
- `api.anthropic.com`
- `api.openai.com` (Whisper API — HEY-67)
- `api.telegram.org`
- `api.open-meteo.com`
- `gateway.ai.cloudflare.com` (AI Gateway)
- `<your-supabase-project-id>.supabase.co`
- `accounts.google.com` + `oauth2.googleapis.com` (Calendar OAuth — HEY-64)
- `www.googleapis.com` (Calendar API)

Adding a new host requires:
1. A code change to `_shared/safeFetch.ts`
2. PR review by Shivansh
3. An ADR if the new integration is structural (Phase-2-onwards)
