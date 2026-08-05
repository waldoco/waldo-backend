# waldo-backend — Claude Code Instructions

## Current build authority

Before implementation:

1. Read `.claude/rules/INDEX.md` and `AGENTS.md`.
2. Read `docs/foundation/NEXT-SESSION-PLAN.md`.
3. Read `docs/planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md`.
4. Read the relevant sections of `docs/planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md` and the product capability matrix.
5. Inspect fresh source/tests and the current issue/PR; pin the SHA behind implementation claims.
6. Read accepted ADRs and Waldo Brain sources for the exact seam. Report conflicts rather than silently applying stale wording.

`HARNESS-RUNTIME-BUILD-PLAN.md`, `HARNESS-WAVE-COORDINATION.md`, July phase handoffs, and the old health-first Alpha plan are historical evidence only. They do not define current product scope, assignment, sequence, or public claims.

## Stable constraints

- Build one Waldo across personal assistance, work orchestration, and their bridge.
- There are no product phases or slices. Use parallel, dependency-aware workstreams and shared proof gates.
- Keep one per-owner backend authority root and one durable writer per aggregate.
- Host `WaldoCoordinator` with the trusted `RunLoopEngine` in the owner Durable Object until measured evidence earns another placement.
- Kennel proposes; the owner backend admits. Providers and executors return untrusted observations.
- Preserve intent-before-I/O, frozen digests, keyed reconciliation, one retry owner, bounded retries, cancellation fencing, and terminal ambiguity.
- Keep activity, Evidence, Verification, Acceptance, Outcome state, and Open Loop closure separate.
- Compile minimum purpose-bound context. Memory is not permission; credentials stay outside model-visible context.
- Health is optional passive context inside a user-grounded purpose, never product category, agenda, or authority.
- Protocol 0.1 uses `offlineCommands: "none"`; disconnected presences are stale read-only projections only.
- Do not infer shipped capability from plans, schemas, tickets, local fakes, or provider claims.

## Repository responsibilities

- `packages/contracts`: versioned DTOs, schemas, commands/events, adapter contracts, public payloads, fixtures.
- `packages/runtime`: Durable Object runtime, trusted RunLoop/effect foundations, persistence, adapters.
- `scripts/guards`: static architecture and agent-surface invariants.
- `docs/planning`: target architecture and capability/source evidence.
- `docs/foundation`: current contributor/verification guidance plus clearly marked historical evidence.
- `supabase`: migrations/RLS/Vault; no hosted mutation without explicit authority.

No mobile or marketing implementation belongs in this repository.

## Working discipline

- Inspect `git status` and preserve unrelated work.
- Define observable done, affected contracts/stores/trust boundaries, invalid paths, and rollback before editing.
- Use tests first for behavior changes where practical.
- Keep shared runtime/contract writer surfaces coordinated and single-writer.
- Never use credentials, private content, raw health, full transcripts, or production data in fixtures/logs.
- Never describe configuration, schema, local tests, or fake adapters as staging/production/product proof.
- Use issue/PR evidence and bounded workstream handoffs; do not resurrect old wave ownership from historical docs.

## Commands

```bash
pnpm install
npx -y pnpm@10.34.4 typecheck
npx -y pnpm@10.34.4 test

# Documentation/instruction changes
git diff --check
npx -y pnpm@10.34.4 verify:guards

# Merge wall for source or integration changes
npx -y pnpm@10.34.4 verify
git diff --check
```

Cloudflare, Supabase, provider, staging, production, or other external mutations require explicit user authority. Local fake bindings and hermetic tests do not grant that authority.
