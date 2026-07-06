# waldo-backend - Rule Index

This repo mirrors the six universal Waldo rule files from
[waldo-brain/.claude/rules](https://github.com/Pin4sf/waldo-brain/tree/main/.claude/rules).
In cloud sessions, read the mirrored local files in this directory. Do not depend
on a sibling `waldo-brain` checkout being present.

## Hard Rules - Read First, In Order

| # | File | What it governs |
|---|---|---|
| 0 | `posture.md` | Role, truthfulness, scope control, verification, destructive actions. |
| 1 | `mental-model.md` | Problem-first, product-first, first-principles, science loop, systems loop, every-line-earned discipline. |
| 2 | `language.md` | Architecture vocabulary: Module, Interface, Contract, Capability Manifest, Seam, Adapter, Drift, Conformance Rule. |
| 3 | `hey-109-workflow.md` | Multi-agent coordination, Claude/Codex split, Agent-Ready bar, review loop. |
| 4 | `work-modes.md` | Engineering, writing, strategy, ideation, evangelism mode discipline. |
| 5 | `security-checklist.md` | Always-check security invariants, conditional checks, health-data overlay. |

## Stable Operating Discipline

This index is a stable rule entrypoint, not a branch guide, phase-progress log,
or handoff document. Do not infer current implementation status from this file.
For current work, inspect the active PR, git state, and the task-specific docs
named by the user or latest handoff.

Every agent should carry the same engineering loop:

1. **Conceive** the problem: user outcome, system constraint, and acceptance bar.
2. **Design** the seam: the smallest contract that hides the right complexity.
3. **Implement** a tracer bullet: a production-quality vertical slice through the
   riskiest path, not a disposable demo.
4. **Operate** it: verify with the repo gate, name residual risk, and preserve a
   rollback path.

Prefer deep modules: small interface, large hidden implementation, high leverage,
and high locality. A shallow module that only forwards work should either deepen,
merge into its caller, or wait until a second real adapter makes the seam useful.

Keep DRY and orthogonal ownership: one owner for each vocabulary, policy constant,
contract shape, and runtime side effect. If two files must change for one concept,
consider whether the concept belongs behind a deeper module.

## Required Commands

Use pinned pnpm for the merge gate:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

`pnpm verify` is valid only when the shell's active pnpm is `10.34.4`. For
docs-only work, `git diff --check` is the minimum gate; run the full verify gate
when the docs change commands, rules, handoffs, CI behavior, or any code-adjacent
claim.

## Cloud / Ultracode Discipline

Claude Code cloud sessions only see committed repo files. Before launching a
cloud ultracode workflow, push the branch and ensure this `.claude/rules/`
mirror is committed.

Repo-required skills live under `.claude/skills/`. `.agents/skills/` may exist
as a compatibility mirror for local agent loaders; it is not a second source of
truth. The agent roster is declared in `AGENTS.md`.

Dynamic workflows are useful for parallel research, review, attack, and
independent module waves. They are risky for uncontrolled write-heavy work.
Use judge panels and adversarial reviewers in parallel. Keep runtime code
single-writer unless the files are disjoint and the wave has an explicit
barrier, owner, merge order, and fresh verification gate.
