# Waldo Backend — Agent Orchestration

## Universal Cross-Repo Rules (read before this file)

| File | What it governs |
|---|---|
| [`.claude/rules/posture.md`](.claude/rules/posture.md) | Role · truthfulness (`[inference]`/`[blocked]`) · communication · verification · destructive actions. |
| [`.claude/rules/mental-model.md`](.claude/rules/mental-model.md) | 6 disciplines + "every line earns its place" + no-cross-references-in-code. |
| [`.claude/rules/language.md`](.claude/rules/language.md) | Architecture vocabulary. |
| [`.claude/rules/hey-109-workflow.md`](.claude/rules/hey-109-workflow.md) | Multi-agent coordination — cluster split (waldo-backend is mostly Codex's; Claude owns Supabase schema · CRS · memory · GDPR runbook), Linear labels, Agent-Ready bar. |
| [`.claude/rules/work-modes.md`](.claude/rules/work-modes.md) | Five surfaces · trigger modes · writing block. |
| [`.claude/rules/security-checklist.md`](.claude/rules/security-checklist.md) | 5 Always-Check invariants · conditional checks · severity matrix · health-data overlay. |

Mirrored from canonical source in `waldo-brain` per [ADR-0063](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/Architecture%20Decision%20Records%20%28ADR%29/0063-canonical-rule-files-mirroring.md). Do not edit locally.

The agent roster + dev-QA loop below is repo-specific. It sits on top of the universal rules.

---

## Available Agents (invoke via Claude Code Agent tool)

### Planning
- **`planner`** — Phase planning, risk identification, task breakdown. Use before starting any sprint.
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

## Skills (invoke with /skill-name)

- `/grill-me` — stress-test a design decision before building
- `/grill-with-docs` — grill using plan docs as source of truth
- `/tdd` — red-green-refactor loop for any new core logic
- `/diagnose` — root cause analysis for bugs and unexpected behavior
- `/zoom-out` — step back and evaluate if approach is right
- `/break-feature` — adversarial feature break pass before marking a feature done
- `/review-all` — broad multi-surface review before merge
- `/phase-handoff` — write the next-session handoff after a phase/wave
- `/new-adapter` — scaffold a new adapter implementation
- `/check-contract` — verify implementation code matches `packages/contracts`
- `/run-eval` — run the agent eval suite (tools/eval/run-suite.ts)
- `/write-a-skill` — create a new skill for this repo
- `/session-bus` — cross-session state handoff; invoke at session start and end
