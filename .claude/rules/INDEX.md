# waldo-backend - Rule Index

This repo mirrors the six universal Waldo rule files from
`waldo-brain/.claude/rules/`. In cloud sessions, read the mirrored local files in
this directory. Do not depend on a sibling `waldo-brain` checkout being present.

## Hard Rules - Read First, In Order

| # | File | What it governs |
|---|---|---|
| 0 | `posture.md` | Role, truthfulness, scope control, verification, destructive actions. |
| 1 | `mental-model.md` | Problem-first, product-first, first-principles, science loop, systems loop, every-line-earned discipline. |
| 2 | `language.md` | Architecture vocabulary: Module, Interface, Contract, Capability Manifest, Seam, Adapter, Drift, Conformance Rule. |
| 3 | `hey-109-workflow.md` | Multi-agent coordination, Claude/Codex split, Agent-Ready bar, review loop. |
| 4 | `work-modes.md` | Engineering, writing, strategy, ideation, evangelism mode discipline. |
| 5 | `security-checklist.md` | Always-check security invariants, conditional checks, health-data overlay. |

## Foundation Branch Override

For `greenfield/harness-foundation`, also read these before any implementation:

1. `docs/foundation/BUILD-PLAN.md`
2. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
3. `docs/foundation/NEXT-SESSION-PLAN.md`
4. Relevant DeepWiki pages under `waldo-brain/01-Waldo/waldo-harness-deepwiki/`
5. Relevant accepted ADRs from `waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`

The active foundation source of truth is the accepted ADR corpus plus the
DeepWiki/build bible. Legacy backend code and old package snippets are evidence
only when the DeepWiki labels them that way.

## Current Foundation Gates

- Foundation Phases A/B/C are built on `greenfield/harness-foundation`.
- Root is built: `core/error`, `core/trigger`, `model/roster`.
- Phase A is built: SHA-pinned `.github/workflows/verify.yml`, `pnpm verify`,
  pinned-pnpm guard, and static conformance guards.
- Phase B is built: `@cloudflare/vitest-pool-workers` runtime substrate,
  Worker/Durable Object SQLite/alarm/eviction proof, and the `alarm-slot` seam.
- Phase C is built: scheduled DO alarm tracer bullet proving
  `alarm -> Loop Governor -> run journal -> DeliveryGate -> outbox -> fake sink`
  with crash/resume exactly-once evidence in workerd.
- Phase C is still a tracer, not the full runtime or contract spine. Do not
  overclaim full delivery policy, recurrence, priority arbitration, live
  providers, OpenAPI, generated clients, or full scenario/eval artifacts.
- Next work is Phase D contract-spine waves after PR #7 is mergeable/merged and
  a fresh gate passes. Do not replay A/B/C unless a regression forces it.
- `@waldo/types` is stale for this branch. The current contract source is
  `waldo-backend/packages/contracts`.
- Model IDs are owned by `model/roster` per ADR-0069.
- ADR-0068 must be read from its current 2026-06-27 block: no
  `defer_next_day`; `fetch_alert` is budget-exempt but class-capped and
  telemetry-counted.

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

Dynamic workflows are useful for parallel research, review, attack, and
independent module waves. They are risky for uncontrolled write-heavy work.
Use judge panels and adversarial reviewers in parallel; keep runtime code
single-writer unless the files are disjoint and the phase has an explicit
barrier.
