---
name: new-adapter
description: Design or add a Waldo adapter contract/module behind the current packages/contracts seam. Use when adding provider-facing contracts, adapter schemas, or future runtime adapter implementation notes.
user-invocable: true
model: sonnet
allowed-tools: ["Read", "Write", "Edit", "Grep", "Glob"]
---

Design or add a new adapter contract/module for $ARGUMENTS.

This backend branch is currently contract-spine first. Do not invent a runtime
adapter tree if the repo only has `packages/contracts` coverage for that seam.

## Current Shipped Adapter Contract Modules

- `packages/contracts/src/adapters/channel.ts`
- `packages/contracts/src/adapters/llm.ts`
- `packages/contracts/src/adapters/health.ts`
- `packages/contracts/src/adapters/calendar.ts`
- `packages/contracts/src/adapters/email.ts`
- `packages/contracts/src/adapters/doc.ts`
- `packages/contracts/src/adapters/sheet.ts`

Planned product interfaces such as task, transcription, music, screen-time,
weather, and location require a source-of-truth ADR or foundation doc before
adding contracts.

**Steps:**

1. Read `.claude/rules/INDEX.md`, `docs/foundation/FOUNDATION-HANDOVER.md`, and the accepted ADR/foundation source for the adapter seam.
2. Use `/waldo-isa-run-contract` for a non-trivial adapter addition: current state, ideal state, criteria, anti-criteria, test strategy.
3. Name the Module, Interface, Contract, Seam, Adapter, and Impact Surface.
4. Add or update the contract module under `packages/contracts/src/adapters/`.
5. Export the contract from `packages/contracts/src/index.ts` if it is public.
6. Add exact valid and invalid tests beside the module.
7. Run:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

**Rules:**

- Agent/runtime logic never references a provider directly; it crosses the adapter seam.
- Email stays metadata-only unless an accepted ADR says otherwise.
- Health adapters must not move raw health values into DO SQLite, logs, prompts, traces, R2, or committed fixtures.
- LLM adapters must preserve provider route, cost, latency, error-class, and privacy observability.
- Runtime implementation belongs in a later runtime PR with fake providers and Workers tests; contract PRs should not smuggle live providers.
