# waldo-backend — Rule Index

Universal rules are mirrored from `waldo-brain` (canonical source, see [ADR-0063](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/Architecture%20Decision%20Records%20%28ADR%29/0063-canonical-rule-files-mirroring.md)). They live locally in `.claude/rules/` and are mirrored verbatim with banner SHA — do not edit locally.

## Universal rules (read first, in order)

0. **[`posture.md`](posture.md)** — **READ FIRST. Always.** Senior-peer posture · priorities (correctness > bravery > momentum > politeness) · truthfulness contract (`[inference]` / `[blocked]` / no fake success) · verification · destructive actions · communication. RFC2119 keywords apply across rule files.
1. **[`mental-model.md`](mental-model.md)** — The 6 non-negotiable disciplines: Problem-first · Product-first · First-principles · Test-heavy + thorough QA · NO AI SLOP · Architecture-first.
2. **[`language.md`](language.md)** — Architecture vocabulary: Module · Interface · Implementation · Depth · Seam · Adapter · Leverage · Locality. Use these terms verbatim in PR reviews, ADRs, and ticket bodies.
3. **[`hey-109-workflow.md`](hey-109-workflow.md)** — Multi-agent coordination (waldo-backend = mostly Codex cluster; Claude owns Supabase schema HEY-9, CRS engine HEY-102, memory/Scribe/recall, GDPR runbook HEY-101). Cluster split · Linear labels · lifecycle · Agent-Ready bar (10 items) · fix-pass-then-verify loop.

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
| Durable agent execution (run journal + outbox) | 0054 |
| GDPR deletion runbook | 0055 |
| DO SQLite compaction + lifecycle | 0056 |
| Working-memory carryover buckets | 0057 |
| Supabase production readiness | 0058 · 0059 · 0060 · 0061 · 0062 |
| **Canonical rules mirroring (this file's pattern)** | **0063** |

ADRs themselves live in `waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`. They are decision documents (append-only), not rule files. The cross-repo reference is intentional — ADRs are versioned in waldo-brain, the team's single decision log. If you cloned only this repo, browse ADRs at https://github.com/Pin4sf/waldo-brain/tree/main/01-Waldo.

## Repo-specific NEVER list

See the `## NEVER` section in [`CLAUDE.md`](../../CLAUDE.md) — this is the canonical NEVER list for waldo-backend. Not a cross-repo concern.

Highlights:
- Health values **NEVER** in `agent_logs`, DO SQLite, or R2.
- Append-only on 10 audit tables — UPDATE/DELETE blocked via `AuditedDB` wrapper (HEY-11).
- JWT validation on every EF first 10 lines via `_shared/auth.ts`.
- RLS `auth.uid() = user_id` on every Postgres table.
- Tool ACL enforcement per trigger via `enforceACL()` — see ADR-0008.
- LLM provider calls routed through `LLMProvider` adapter + CF AI Gateway — never direct.
- Service-role key never outside `build-intelligence` + audit writes.

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

## Skills active for this repo

- `/session-bus` — **MANDATORY at session start AND end.** Cross-session bus, see ADR-0043.
- `/grill-me` — before any new design decision lands as ADR
- `/grill-with-docs` — when extending an existing ADR
- `/diagnose` — for any recurring bug (RCA discipline)
- `/tdd` — golden test FIRST for every tool handler
- `/zoom-out` — when a single-ticket fix risks cross-cutting impact

## Phase-specific review agents

See `AGENTS.md` for the full agent roster. For Sprint 1-2:
- **`security-reviewer`** — every PR that touches auth, RLS, JWT, secrets, egress, hooks, scribe
- **`health-data-reviewer`** — every PR that touches CRS engine, baselines, health-data flow
- **`workflow-mapper`** — BEFORE writing any new trigger / agent loop logic
- **`crs-validator`** — every PR that touches CRS algorithm

## Pre-commit checks (skill-driven, not hook-blocked)

We rejected blocking pre-commit hooks. Hooks add friction; skills + review agents add discipline. Checks below run via skills / agents / CI — not as commit blockers.

- `pnpm typecheck` runs in CI; agent runs it before PR
- `pnpm test` runs in CI; `/tdd` skill enforces test-first locally
- Health-value lockout enforced by Scribe sanitiser (ADR-0024) at runtime, by `security-reviewer` agent at PR time
- `--no-verify` is forbidden by `CLAUDE.md` NEVER list (agent self-policed)
- Conventional commit prefix + `HEY-NN` reference checked by `/diagnose` if a PR title looks off

## Things NOT in scope for this repo

- Mobile UI code (belongs in waldo-app)
- iOS Swift modules (belongs in waldo-app)
- Android Kotlin modules (belongs in waldo-app)
- Marketing site (belongs in waldo-web, deferred)
- Type definitions consumed by 2+ repos (belongs in waldo-types)
- Research docs / ADRs themselves (belong in waldo-brain)
