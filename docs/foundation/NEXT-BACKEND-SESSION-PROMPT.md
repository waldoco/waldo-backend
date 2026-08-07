# Next Backend Session Prompt — consume Gate B, then add candidate Evidence and Verification

Start in a new clean worktree without touching saved or dirty checkouts. Read the
[Gate B handoff](./OUTCOME-BOUND-PLANNING-HARNESS-GATE-B-HANDOFF-2026-08-07.md), the repository
rules, architecture lock, responsibility phase handoff, current contracts, `RunLoopDO`,
provider-effect path, migrations, guards, and tests. Fetch and re-pin live `origin/main` before
claiming current state.

## Starting truth

Gate A merged in PR #76. The Gate B branch adds a version-pinned v0.3 contract and the minimum
Outcome-bound, no-tools planning harness. Do not begin integration or the next backend domain slice
unless Gate B's current head passes the full verification/review wall and is merged. Reverify the
live merge SHA rather than trusting this prompt.

Gate B's local deterministic proof covers WorkUnit planning authorization, atomic execution intent,
lease/fence/cancellation generation, one provider planning turn through the existing trusted path,
validated candidate-plan settlement, exact retry/restart handling, and public invocation/read. No
real provider, Kennel, hosted staging, or production request has been exercised. Candidate plans
are not Evidence, Verification, Acceptance, OpenLoop, ReEntry, or Outcome completion.

## Required next slices

Use `/waldo-isa-run-contract`, planner/workflow mapping, `/codebase-design`, `/tdd`, and
`/check-contract` before claiming the slice.

1. In Kennel, consume only the released v0.3 fixtures and public contract. Prove the same work and
   personal-assistance candidate-plan scenarios across the real local Worker/DO boundary without
   adding connectors or effects. Keep Waldo as the authority and Kennel as the requesting/rendering
   presence.
2. In the backend, design and implement the next Waldo-owned slice for candidate Evidence and
   independent Verification. Keep provider reports, local observations, accepted Evidence,
   Verification judgments, user Acceptance, OpenLoop, ReEntry, and Outcome closure separate.
3. Do not add effectful tools or connectors until a separate contract pins capability grant,
   authority ceiling, intent durability, idempotency/reconciliation owner, revocation, privacy,
   verification, and rollback.
4. Run a real provider turn only when a version-pinned non-production configuration and
   credentials are already authorized. Never solicit, print, persist, or commit secrets; record
   unavailable honestly.

Before delivery, run separate Standards and Spec reviews, mandatory security review, an
adversarial breaker pass, the exact package/full verification wall, and `git diff --check`.

Do not claim Kennel UI acceptance, connectors, live personal-assistance context, Evidence/
Verification, Acceptance/OpenLoop/ReEntry, staging, production, or operations unless each is
independently exercised.
