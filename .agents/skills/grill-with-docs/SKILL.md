---
name: grill-with-docs
description: Grilling session that challenges your plan against Waldo foundation docs, accepted ADRs, contracts, and source-of-truth planning material. Use when stress-testing a plan against Waldo's locked architecture and ubiquitous language.
disable-model-invocation: true
---

# Grill With Docs

Heavier sibling of `/grill-me`. Same relentless interview, but cross-references
everything against backend foundation docs, accepted ADRs, and
`packages/contracts`. Offers docs or ADR updates sparingly.

Interview the user relentlessly. Walk down each branch of the design tree, resolving dependencies one by one. For each question, provide your recommended answer.

Ask one at a time. Wait for answer.

If a question can be answered by exploring the codebase, foundation docs,
accepted ADRs, or current contracts, explore instead.

## Domain awareness

Waldo backend vocabulary lives across `.claude/rules/language.md`,
`packages/contracts`, `docs/foundation`, and accepted Waldo Brain ADRs. Do not
create repo-local ADRs for universal architecture without explicit user approval;
Brain remains the ADR source of truth unless the user says otherwise.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with current contracts or accepted ADRs,
call it out. "The contract calls this a Run, but you seem to mean a Session.
Which one owns the state?"

### Sharpen fuzzy language

When the user uses vague terms, propose the precise term from the current build plan, language rules, or owning contract. “You said memory—do you mean a Profile Claim, an episode, a commitment/Open Loop, or a rebuildable search projection?”

### Stress-test scenarios

For domain relationships, invent edge cases. “If a scheduled WorkUnit wakes while its grant is expired and Kennel is disconnected, which state survives and who may resume it?”

### Cross-reference with code

When user states behavior, check the code. If contradiction, surface it. "Your code uses checkpoint key without targetDate, but you just said multi-day recovery works — which is right?"

### Update the owning source inline

When a term resolves, prefer updating the current build plan, owning foundation document, accepted ADR, or contract comment/test name. Do not create a glossary file just to have one.

Keep vocabulary updates domain-meaningful; avoid implementation-only churn.

### Offer ADRs sparingly

Offer only when ALL three are true:
1. **Hard to reverse** — cost of changing later is meaningful (e.g., schema migrations, identity files, channel ID format)
2. **Surprising without context** — future reader will wonder "why?"
3. **Real trade-off** — genuine alternatives existed; you picked one for specific reasons

Skip if any missing. Accepted ADRs and foundation docs already cover most
load-bearing choices; don't duplicate them.

If creating or amending an ADR, stop and ask because the canonical ADR surface is
in Waldo Brain.

### Waldo-specific anchors (don't re-litigate)

- The September personal-agent build plan, current session entrypoint, accepted ADRs, and freshly inspected source/tests
- One Waldo identity and one per-owner backend authority root across Home and Work
- One named durable writer per aggregate; the Coordinator sequences but does not bypass reducers
- The trusted RunLoop remains the physical execution/effect path during additive migration
- Kennel proposes; the owner backend admits
- Purpose-bound context, exact revocable authority, credential brokering, and fail-closed capability admission
- Agent activity, Evidence, Verification, Acceptance, and Open Loop closure remain distinct
- Protocol v0.1 uses `offlineCommands: "none"`
- Parallel dependency-aware workstreams integrate continuously through shared contracts and golden fixtures

If a question conflicts with one of these, surface the conflict. Don't grill on changing them.
