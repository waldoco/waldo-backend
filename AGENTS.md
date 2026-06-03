# Waldo Backend — Agent Orchestration

## Available Agents (invoke via Claude Code Agent tool)

### Planning
- **`planner`** — Phase planning, risk identification, task breakdown. Use before starting any sprint.
- **`workflow-mapper`** — Maps ALL data flow paths + failure modes BEFORE building. Run before any new EF or DO feature.

### Review (run before merging any PR)
- **`security-reviewer`** — Encryption, RLS, secrets, prompt injection, privacy. Run on any health data path change.
- **`health-data-reviewer`** — Null handling, personal baselines, Samsung HRV gap, edge cases.
- **`crs-validator`** — CRS algorithm validation against spec formulas. Run if touching `core/crs/`.
- **`soul-file-reviewer`** — Waldo's personality, conversation quality, medical claims. Run before any soul file deploy.

### Testing
- **`qa-breaker`** — Adversarial QA. Defaults to NEEDS WORK. Tries to break every feature.
- **`e2e-pipeline-tester`** — Full wearable → CRS → Claude → Channel Adapter pipeline.

## Dev-QA Loop (use for EVERY feature)

```
1. planner → task breakdown
2. [build]
3. qa-breaker → tries to break it
   PASS → advance
   FAIL (< 3 attempts) → fix, re-run qa-breaker
   FAIL (≥ 3 attempts) → escalate: decompose or defer
```

## Security Review Triggers (mandatory)

Run `security-reviewer` when touching:
- JWT validation, auth flows
- Health data access paths
- Supabase RLS policies
- CF DO memory writes
- Any new EF

## Multi-agent workflow (Claude Code × Codex) — HEY-109

Two AI coding agents work on Waldo in parallel — **Claude Code** and **Codex** — coordinated through Linear **HEY-109** (the session bus, ADR-0043). Read HEY-109 at session start; update at session end.

### Cluster split — single writer per cluster

Only the cluster owner edits that cluster's ticket bodies. Cross-review = COMMENT on the ticket / PR (reviewer posts verdict; writer applies). The reviewer never edits the body directly.

- **Claude writes:** `@pin4sf/waldo-types` contracts · memory / Scribe / recall · CRS / body-context · GDPR / consent / privacy · product-gap classification · global dependency graph · HEY-109 itself.
- **Codex writes:** DO loop · run-journal / outbox · hooks · tool dispatcher / ACL · Telegram ChannelAdapter inbound + threading · LLMProvider · eval / observability · internal infra (wrangler, AuditedDB).

Most of `waldo-backend` is in Codex's cluster. Claude owns the Supabase schema (HEY-9), CRS engine (HEY-102), memory/Scribe/recall modules, and the GDPR erasure runbook (HEY-101).

### Linear labels

| Label | Meaning |
|---|---|
| `agent:claude` | Claude Code owns the body + grabs to implement |
| `agent:codex` | Codex owns the body + grabs to implement |
| `review:claude` | Cross-review state — waiting on Claude to review (typically state `In Review`) |
| `review:codex` | Cross-review state — waiting on Codex to review |

### Lifecycle

1. Owner adds `agent:X` while writing body to the Agent-Ready bar.
2. Bar met → add `ready-for-agent`.
3. Agent grabs → branch → PR. Flip `agent:X` → `review:Y` (the *other* cluster), state → `In Review`.
4. Reviewer posts P0 verdict comments on PR; author iterates fix-pass cycles via subagents + independent verification (re-run validations, confirm tests non-vacuous, grep source for the claimed change). Label stays `review:Y` until reviewer approves.
5. Approved → squash-merge with `--delete-branch` → state `Done`.

**Filters:** `ready-for-agent + agent:me + state:Todo` = my next pickup; `review:me` = my review queue.

### Agent-Ready bar (10 items)

Promote to `ready-for-agent` only if ALL present: SoT links · Module/Interface/Seam · deps · acceptance (golden test) · validation commands · 5-bucket failure paths (null / permission-revoked / network / hostile / concurrent) · reversibility · security/privacy · out-of-scope · zero open founder/legal questions. Missing any → `needs-info` or `ready-for-human`.

## Skills (invoke with /skill-name)

- `/grill-me` — stress-test a design decision before building
- `/grill-with-docs` — grill using plan docs as source of truth
- `/tdd` — red-green-refactor loop for any new core logic
- `/diagnose` — root cause analysis for bugs and unexpected behavior
- `/zoom-out` — step back and evaluate if approach is right
- `/new-adapter` — scaffold a new adapter implementation
- `/check-contract` — verify code matches @waldo/types contract
- `/run-eval` — run the agent eval suite (tools/eval/run-suite.ts)
- `/write-a-skill` — create a new skill for this repo
