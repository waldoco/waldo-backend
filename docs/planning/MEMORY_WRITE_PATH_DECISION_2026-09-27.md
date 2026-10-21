# Single memory write path - decision

27 September 2026 - owner-ratified (WhatsApp, this date, replying to the gap-4 design choice from the Instinct-pattern audit).

## Decision

Chat-surface memory writes flow exclusively through the post-reply claim_ops settle
(packages/runtime/src/channels/telegram-turn.ts, `settling = ask(..., 'claim_ops', ...)` ->
`applyClaimOps`). The `update_memory` tool stays scoped to dreaming_mode, its only ACL grant
(packages/contracts/src/tools/permissions.ts). One write path per surface.

## Why

- Claims carry provenance (stated/inferred/confirmed + evidence quotes), corrections that
  dismiss+add, and a forget barrier against relearning (packages/runtime/src/memory/claims.ts
  CLAIM_RULES). memory_blocks staged via Scribe carry none of that semantics.
- The September 27 staging incident (nano hallucinated forget_claims and wiped claims 1-6) came
  from the write path; it is mitigated by the memory-writer escalation to mini
  (telegram-turn.ts memoryModel). The owner affirmed the escalation path stays open: if the
  writer needs a better model than the current pin, escalate the pin rather than adding a
  second write surface.
- Field check (owner asked what the best agent systems do): in-turn self-editing (Letta/MemGPT)
  is the elegant outlier; production systems (Hindsight, Instinct, curated-file patterns) write
  durable memory in a post-turn pass with provenance, because writes stay auditable and the
  reply model cannot quietly rewrite its own memory.

## Consequence

- No new chat wiring for update_memory. If a future surface wants in-turn recording, it must
  adopt the claim_ops semantics, not the raw tool.
- The MEMORY_MANNERS prompt line now matches actual ordering: the settle runs after the reply,
  automatically; the reply model never breaks the reply to record.
