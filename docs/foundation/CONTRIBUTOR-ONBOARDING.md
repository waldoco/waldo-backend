# Waldo Harness Contributor Onboarding

Status: active onboarding entrypoint for backend contributors.
Date: 2026-07-09.

## What You Are Joining

Waldo backend is building a Cloudflare Durable Object based agent harness. The current proof is
fake-first but durable: scheduler, governor, run journal, ToolDispatcher, hooks, fake LLM routing,
runtime driver hardening, context schema root, and local replay/evidence are merged.

The next honest runtime milestone is **HEY-142**: a governed multi-iteration
`plan -> act -> observe` loop. Do not describe the runtime as a real Pi/Hermes-style agent loop
until HEY-142 and the context lane are wired and verified.

## Read This First

1. `README.md`
2. `AGENTS.md`
3. `.claude/rules/INDEX.md` and the six referenced rule files
4. `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
5. `docs/foundation/NEXT-SESSION-PLAN.md`
6. `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
7. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
8. The accepted ADRs and Waldo Brain source files named by the seam you are touching

Use `docs/foundation/archive/` for archaeology only. Archived files may mention old branches,
closed tickets, retired package names, or pre-HEY-142 sequencing.

## Current Build Lanes

| Lane | Next work | Notes |
| --- | --- | --- |
| Runtime | HEY-142 governed multi-iteration loop | Single-writer over `packages/runtime/src/run-loop/*` and runtime evidence behavior. |
| Context | HEY-15 recall, HEY-14 skills, HEY-16 prompt builder | Starts from HEY-10's merged DO SQLite schema root. Full goal hydration waits for HEY-144. |
| Safety/Scribe | HEY-13 sanitiser runtime and Scribe proposal lifecycle | No direct committed-memory writes from the LLM. |
| Evidence | Extend HEY-111 evidence during HEY-142 | Reuse `readRunEvidence`, `replayFixture`, and `scoreRun`; do not create a parallel trace path. |
| Provider flip | HEY-143 after HEY-142 | No live provider calls before fake-first iteration is proven. |
| Product surfaces | Brief, Fetch, Chat, Spots after shared harness | Product loops should use the shared runtime spine, not bespoke paths. |

## Working Rules

- Keep raw health, secrets, provider bodies, prompts, and live channel payloads out of logs, DO
  SQLite, R2, traces, fixtures, and docs.
- Do not make live provider calls, use live credentials, trigger live channel delivery, or write to
  production Cloudflare/Supabase unless a ticket explicitly scopes that work and the user approves.
- Prefer contract-first changes in `packages/contracts` and strict Zod schemas for public or
  persisted shapes.
- Use TDD for runtime behavior. Prove happy, denial, malformed, retry/resume, and degraded paths.
- Keep single-writer files single-writer. Coordinate before touching shared runtime, contract,
  policy, trigger, schema barrel, or model roster files.

## Before Opening A PR

Run the commands appropriate to the change:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

For docs-only changes, `git diff --check` plus `npx -y pnpm@10.34.4 verify:guards` is enough.
For harness/runtime changes, include focused runtime or contract tests and evidence/replay checks.

## How To Pick Work

Start from Linear and the active docs, not from archived plans:

- Runtime builder: HEY-142 first.
- Context builder: HEY-15, then HEY-14 and HEY-16.
- Safety builder: HEY-13 / HEY-141 where scoped.
- Infra/provider builder: HEY-143 only after HEY-142.

When in doubt, post the current -> ideal -> gap and ask for the lane owner before editing shared
runtime files.
