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

When user uses vague terms, propose a precise canonical term from CONTEXT.md. "You said 'memory' — Tier 1 semantic, Tier 2 episodic, or Tier 3 procedural?"

### Stress-test scenarios

For domain relationships, invent edge cases. "If Morning Wag fires at 6 AM but DO is hibernating, who wakes it? What if user has 2 devices?"

### Cross-reference with code

When user states behavior, check the code. If contradiction, surface it. "Your code uses checkpoint key without targetDate, but you just said multi-day recovery works — which is right?"

### Update CONTEXT.md inline

When a term resolves, prefer updating the owning foundation doc, accepted ADR, or
contract comment/test name. Do not create a glossary file just to have one.

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

- Accepted ADRs and `docs/foundation/FOUNDATION-HANDOVER.md`
- 9 Demo Day backend patterns (R1-R6, I1-I3) — built, locked
- 4 Demo Day pillars (Morning Wag, Fetch Alert, Spot, Chat)
- Hexagonal/adapter pattern as core architecture
- Soul files, safety rules, CRS algorithm = immutable
- iOS-first, Android second
- Cloudflare DO as agent runtime, Supabase as data layer

If a question conflicts with one of these, surface the conflict. Don't grill on changing them.
