# Current Waldo agent build entrypoint

29 September 2026. This is a routing map, not a new permission source or a replacement for current tests and runtime receipts.

## First read only what the job touches

Start with the owner request, current issue and branch, and the source and tests for that seam. Use the backend `AGENTS.md` invariants for truth, one-owner isolation and effect proof. Consult the accepted ADRs for the touched seam; older dated plans are background until checked against current source. A contradictory accepted contract needs an explicit disposition before that implementation lands, not an indefinite block on unrelated source reading, tests or private preparation.

| Work | Current starting evidence | Additional check |
|---|---|---|
| Chat, Waldo voice and tool list | `packages/runtime/src/prompt/messaging-behavior.ts`, `channels/telegram-turn.ts`, `conversation/tool-loop.ts` | Brand vocabulary `VOCABULARY_AND_BRAND_2026-09-24.md`, fixture/eval and live owner-turn outcome. Waldo has its own voice, not a copied assistant persona. |
| Owner memory | `packages/runtime/src/memory/claims.ts`, `context-composer/recall.ts`, `test/memory-golden-eval.test.ts` | Owner-stated versus inferred, corrections and forget; use task-relevant retrieval, not full account contents or stale external facts. Current connected state needs a live read. |
| Search/browser | `packages/runtime/src/tools/live/web-search.ts`, `browser.ts`, `channels/approvals.ts` | Brave hits are snippets, not read pages. Browserbase session currently ends per call; verify actual navigated URL, authenticated context, taint and final effect. Do not infer a capability from a schema name. |
| Files/code workspace | `packages/runtime/src/channels/console.ts`, `artifactBook` and R2 binding, current ADR-0076 | Text artifacts and prompt mount are not an owner filesystem or a sandbox. Owner/workspace ID, manifest, storage isolation, restart, quotas and effect broker need code and tests before a feature claim. |
| Release | `.github/workflows/verify.yml`, `scripts/deploy-runtime.sh`, staging `/healthz` and Activity | Match commit, Workers build, version, percent traffic and health twice; run separate scenario harness and feature-level readback. Staging is not production. |

Use `docs/planning/waldo-agent-mvp/ADR_RECONCILIATION.md` as an inventory of still-unpublished dispositions, not proof that they landed. Canonical rule edits begin in waldo-brain and are mirrored only after a reviewed canonical merge. ADR-0085 is proposed pending review; it does not silently override current accepted ADRs. For each feature report the baseline, exact head, adverse/benign cases, observed staging outcome, current limitation and rollback.

## Current release status

Backend #346 and #348 landed and were staged at 131b88a. #347 exact-session canary change landed at b2fb5a4 and staging version 8772f0de reached 100% on September 29. `/healthz` returned b2fb5a4. These are deployment facts, not proof that a populated mail/card turn succeeds. Feature-level synthetic owner-turn and Activity receipts are outstanding. No production cut is authorized by this page.

## Decision record

- 2026-09-29 · Instinct · Added a task-specific read map instead of a mandatory long-plan read sequence (why: keep current evidence and relevant ADRs visible without treating old plans as current implementation proof).
