# Waldo Backend — Agent Orchestration

## Universal Cross-Repo Rules (read before this file)

| File | What it governs |
|---|---|
| [`.claude/rules/posture.md`](.claude/rules/posture.md) | Role · truthfulness (`[inference]`/`[blocked]`) · communication · verification · destructive actions. |
| [`.claude/rules/mental-model.md`](.claude/rules/mental-model.md) | 6 disciplines + "every line earns its place" + no-cross-references-in-code. |
| [`.claude/rules/language.md`](.claude/rules/language.md) | Architecture vocabulary. |
| [`.claude/rules/work-modes.md`](.claude/rules/work-modes.md) | Five surfaces · trigger modes · writing block. |
| [`.claude/rules/security-checklist.md`](.claude/rules/security-checklist.md) | 5 Always-Check invariants · conditional checks · severity matrix · health-data overlay. |

Mirrored from canonical source in `waldo-brain` per [ADR-0063](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/Architecture%20Decision%20Records%20%28ADR%29/0063-canonical-rule-files-mirroring.md). Do not edit locally.

The agent roster + dev-QA loop below is repo-specific. It sits on top of the universal rules. Start with the [`personal-agent product architecture and build plan`](docs/planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md), [`NEXT-SESSION-PLAN.md`](docs/foundation/NEXT-SESSION-PLAN.md), the [`execution ledger`](docs/foundation/EXECUTION-LEDGER.md), and [`CONTRIBUTOR-ONBOARDING.md`](docs/foundation/CONTRIBUTOR-ONBOARDING.md). Before the plan merges it is a candidate roadmap. After review/merge it governs backend roadmap, dependency order, and documentation cleanup; conflicting product-scope or architecture seams remain non-authoritative until the Brain launch contract/ADR dispositions are published, the plan/entrypoints are repinned, and `accepted-adrs.json` is regenerated. For the contributor loop, skill status, plugin boundaries, and verification wall, read [`AGENT-OPERATING-WORKFLOW.md`](docs/foundation/AGENT-OPERATING-WORKFLOW.md). GitHub issues, milestones, labels, PRs, and linked evidence are the current delivery workflow; Linear/HEY identifiers are historical only. Every write-capable session registers its issue, branch/worktree, base SHA, scope, file ownership, agent/subagent roster, and handoff evidence through [#116](https://github.com/Pin4sf/waldo-backend/issues/116). Retired plans remain available at their pinned Git history and are not current product or sequencing authority.

---

## Judgment belongs to the model

Judgment belongs to the model. Do not add regex or other fixed rules for anything that is a judgment call (tone, intent, topic, health vs clinical, what to remember). The harness gives the model context, reasoning room, tools and autonomy. Deterministic rejection is allowed only for hard security and safety boundaries where a reject must be guaranteed: auth, secrets, canaries, owner checks, egress, schema validation, and medication dosing. When you find a fixed rule making a judgment call, file it under `post-mvp-cleanup` or move it to model reasoning with scenario tests.

## Available Agents (invoke via Claude Code Agent tool)

### Planning
- **`planner`** — Workstream planning, risk identification, and task breakdown. Use before starting a bounded implementation change.
- **`workflow-mapper`** — Maps ALL data flow paths + failure modes BEFORE building. Run before any new EF or DO feature.

### Review (run before merging any PR)
- **`security-reviewer`** — Encryption, RLS, secrets, prompt injection, privacy. Run on any health data path change.
- **`health-data-reviewer`** — Null handling, personal baselines, Samsung HRV gap, edge cases.
- **`crs-validator`** — CRS algorithm validation against spec formulas. Run if touching `packages/contracts/src/health/crs.ts` or later CRS runtime code.
- **`soul-file-reviewer`** — Waldo's personality, conversation quality, medical claims. Run before any soul file deploy.

### Testing
- **`qa-breaker`** — Adversarial QA. Defaults to NEEDS WORK. Tries to break every feature.
- **`e2e-pipeline-tester`** — Full wearable → CRS → Claude → Channel Adapter pipeline.

## Dev-QA Loop (use for EVERY feature)

```
1. /waldo-isa-run-contract or /current-ideal-gap → define done
2. planner / workflow-mapper → task breakdown + failure paths
3. [build with /tdd or /diagnose as appropriate]
4. qa-breaker → tries to break it
   PASS → advance
   FAIL (< 3 attempts) → fix, re-run qa-breaker
   FAIL (≥ 3 attempts) → escalate: decompose or defer
5. /compound-learning-capture if the work produced a reusable lesson
```

## Security Review Triggers (mandatory)

Run `security-reviewer` when touching:
- JWT validation, auth flows
- Health data access paths
- Supabase RLS policies
- CF DO memory writes
- Any new EF

## Skills (invoke with /skill-name)

Canonical source: `.claude/skills/`. `.agents/skills/` is a compatibility mirror when present, not a second source of truth.

- `/grill-me` — stress-test a design decision before building
- `/grill-with-docs` — grill using plan docs as source of truth
- `/tdd` — red-green-refactor loop for any new core logic
- `/diagnose` — root cause analysis for bugs and unexpected behavior
- `/zoom-out` — step back and evaluate if approach is right
- `/break-feature` — adversarial feature break pass before marking a feature done
- `/review-all` — broad multi-surface review before merge
- `/phase-handoff` — write the next-session handoff at a bounded workstream boundary
- `/new-adapter` — scaffold a new adapter implementation
- `/check-contract` — verify implementation code matches `packages/contracts`
- `/run-eval` — run the eval suite when present; otherwise record the eval-suite gap and run the verify wall
- `/write-a-skill` — create a new skill for this repo
- `/waldo-isa-run-contract` — define current state, ideal state, criteria, test strategy, work slices, verification, and learning
- `/waldo-builder-registry` — design/audit source-backed builder skills, plugin records, tool manifests, and eval gates
- `/waldo-memory-proposal-review` — review persistent memory/goal/context updates before they become durable truth
- `/thinking-mode-router` — route high-stakes work into first-principles, systems, science, red-team, council, creative, or world-model mode
- `/current-ideal-gap` — lightweight current → ideal → gaps → verification pass
- `/codebase-design` — deep-module vocabulary and seam/interface design
- `/code-review` — two-axis Standards vs Spec review
- `/compound-learning-capture` — preserve reusable lessons from fixes, reviews, research, and repeated agent failures
- `/writing-great-skills` — reference for predictable, maintainable skill design
