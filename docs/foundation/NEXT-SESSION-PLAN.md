# Next Session — Waldo Personal Agent

Updated: 2026-09-17. This is the sole backend execution entrypoint, not another live task tracker.

**Product/build contract:** [Waldo Personal Agent — Reconciled Launch Contract](https://github.com/Pin4sf/waldo-brain/blob/be08c4afa6f356c66600e73ae0bf54e5d7a3a158/01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md).

**Coordination:** [#116](https://github.com/Pin4sf/waldo-backend/issues/116), the owning issue/PR, and [ledger protocol](EXECUTION-LEDGER.md). Earlier #78/B0-B6 issue wording is retained evidence; the master contract reconciles current personal-agent scope. Do not close or relabel existing issues merely because a new scope document exists.

## Scope and authorization

Build toward one health-aware, memory-rich, personality-led general personal agent in the existing app and WhatsApp. Keep the owner runtime and app shell. Desktop/local-memory attachment follows later; the separate Kennel roadmap is unchanged. Built-in capabilities require explicit data/action grants. WhatsApp live eligibility is a named external gate, not a technical impossibility or permission to use an unofficial workaround.

This documentation pass does not authorize implementation or deployment. After documentation review, the next user-authorized build should take one M1 slice through tests and review, rather than generate another entire-product architecture plan.

## Source baseline, not fresh test proof

Freshly read September 17:

- backend `main@e91bee017b0c36759cbfda1353fc11c73e3afe0a`, including the merged v0.6 contract release;
- app `main@7218c18fed8b874492e3831bbb5bd1e1c58abe58`;
- Brain `main@9d3e491e06760c1b2a8828f66607ffc389cf8f8a` before the reconciliation branch;
- [PR #137](https://github.com/Pin4sf/waldo-backend/pull/137) draft at `dd122c0f26290f7eade405673c1dc22daf7cbbae`; do not merge, retarget, rewrite or conflate it with hosted-agent delivery.

The source contains real authority, execution, context and recovery foundations. Production `run-loop/adapters.ts` still supplies fail-closed/unavailable delivery/spend/safety dependencies; `run-loop/do.ts` constructs the execution bridge only for local proof; `identity-presence-module.ts` rejects a second presence. These are completion work, not reasons to disable guards. PR #137's closure sequencing/persistence code does not establish public ingress or full integration. Historical planning text is older than the current contract/branch state.

No full test wall, native/device, live adapter, staging or production test was executed by this documentation reconciliation. Do not inherit old green counts as current proof. Re-pin all source and feature heads before writing.

## First execution frontier

M0 execution baseline: use real clean checkouts; preserve unrelated work; inspect package scripts and run documented guards/tests. Distinguish environment failures from source failures. Define the first bounded test/implementation plan from the current code, with concrete signatures and fixtures.

M1 first slice: remove production false-success/prototype replies from app `src/chat/useChat.ts` and prove honest pending/error/receipt UI. Account/consent isolation is the next coordinated security slice: explicit cloud-health consent, per-account/key/epoch caches, cancellation and stale-callback rejection. Do not connect real health data before that floor passes.

Backend lanes beneath this frontier: source-map the presence/identity and sensitive conversation-body contracts; retain existing verified subject-to-owner routing instead of inventing a parallel auth issuer. App docs contain older Woof-only assumptions; M1 must align the generated public client with the actually supported issuer/session contract. Any issuer change requires its own reviewed migration, not a token-shape workaround.

After those contracts stabilize, production conversation/context (M2), canonical health (M3), memory (M4), and WhatsApp adapter/eligibility work may progress in disjoint lanes. M5 joins health-aware planning and calendar/mail effects; M6 proves cross-surface continuity; M7 proves proactive/browser jobs; M8 is real cohort/operational acceptance. Full milestone details live only in the master contract.

## Invariants and bounded decision gates

Keep one authority root/writer, existing RunLoop/ContextComposer, intent-before-I/O, exact grants, source-of-record receipts, one retry owner, cancellation fencing, and explicit unknown states. Conversation is not a formal Outcome by default; consequential work cannot skip canonical closure.

Before affected implementations: review additive standing-grant contracts; sensitive conversation storage/retention; email body scope and provider egress; protected pattern records/destinations under ADR-0081. These decisions do not reopen accepted privacy floors or block unrelated app-honesty work. Never treat a friendly score, source connection, remembered preference or model plan as permission.

Do not delete app `supabase/**`, `runtime/**`, legacy clients or migration history wholesale. Require caller/build/deployment inventory, generated replacements, parity, rollback and tests before decommission.

## Verification and handoff

```bash
git diff --check
npx -y pnpm@10.34.4 verify:guards
# Runtime/contract/integration work:
npx -y pnpm@10.34.4 verify
```

Run app checks in its own repository (`pnpm run check`, `pnpm test`) and native-device checks for native claims. Each PR records base/head, scope, writer ownership, changed schemas, passed/failed/unavailable/not-run evidence, rollback and consumer actions. Register/handoff on #116. Do not bypass guards, create competing state docs, use production credentials, or deploy without separate authorization.

[Pre-reconciliation next-session evidence](https://github.com/Pin4sf/waldo-backend/blob/e91bee017b0c36759cbfda1353fc11c73e3afe0a/docs/foundation/NEXT-SESSION-PLAN.md) remains in Git history; unique dated handoffs stay in `docs/ledger/`.
