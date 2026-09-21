---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or types "grill me".
disable-model-invocation: true
---

# Grill Me

Interview the user relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one. For each question, provide your recommended answer.

Ask questions one at a time. Wait for the answer before moving on.

If a question can be answered by exploring the codebase, foundation docs,
accepted ADRs, or `packages/contracts`, explore instead of asking.

## Waldo-specific framing

Before grilling, anchor on:
- **Workstream context** — which capability, dependency, and proof gate owns this decision? See the September personal-agent build plan and `docs/foundation/NEXT-SESSION-PLAN.md`.
- **Vocabulary** — use the local rule language plus the relevant `packages/contracts` module and accepted ADR.
- **Ratified constraints** — don't silently contradict the current build plan, released contracts, or accepted ADRs. If implementation evidence conflicts with them, surface and resolve the conflict explicitly.
- **Identity and authority are stable** — no provider, model, surface, package, or executor may redefine Waldo identity, mint authority, or own Acceptance/closure.

## What to grill on

- Which Outcome/WorkUnit or user-visible capability this serves, and which aggregate writer owns it
- Which context, authority, credential, effect, evidence, acceptance, and deletion boundaries apply
- Which exact adapter/version/capability is required, and what conformance makes it eligible
- What invalid, hostile, concurrent, disconnected, cancellation, retry, restore, and rollback paths apply
- Which delivery status is being claimed: architecture, contract, module, adapter conformance, cross-surface acceptance, or operational proof
- Cost and latency per accepted Outcome, including verification and recovery—not only model-call price

End grilling when you and the user share a design concept clear enough to write a PRD-style summary. Then offer: "Want me to write a bounded workstream handoff or proceed with the agreed change?"
