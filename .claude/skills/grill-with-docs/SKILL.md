---
name: grill-with-docs
description: Grilling session that challenges your plan against Waldo's domain model (Docs/CONTEXT.md), sharpens terminology, and updates docs/ADRs inline as decisions crystallise. Use when stress-testing a plan against Waldo's locked architecture and ubiquitous language.
disable-model-invocation: true
---

# Grill With Docs

Heavier sibling of `/grill-me`. Same relentless interview, but cross-references everything against `Docs/CONTEXT.md` and the 11 locked architecture decisions. Updates `Docs/CONTEXT.md` inline. Offers ADRs sparingly.

Interview the user relentlessly. Walk down each branch of the design tree, resolving dependencies one by one. For each question, provide your recommended answer.

Ask one at a time. Wait for answer.

If a question can be answered by exploring the codebase or reading `Docs/CONTEXT.md`, explore instead.

## Domain awareness

Waldo's vocabulary lives in `Docs/CONTEXT.md` (pointer index → canonical files). Architecture decisions live in `.claude/rules/architecture.md` and `.claude/rules/coding-standards.md`. There is no `docs/adr/` yet — create lazily when first ADR is needed.

## During the session

### Challenge against the glossary

When user uses a term that conflicts with `Docs/CONTEXT.md`, call it out. "CONTEXT.md says Spot is a single observation. You seem to mean a Constellation pattern — which is it?"

### Sharpen fuzzy language

When user uses vague terms, propose a precise canonical term from CONTEXT.md. "You said 'memory' — Tier 1 semantic, Tier 2 episodic, or Tier 3 procedural?"

### Stress-test scenarios

For domain relationships, invent edge cases. "If Morning Wag fires at 6 AM but DO is hibernating, who wakes it? What if user has 2 devices?"

### Cross-reference with code

When user states behavior, check the code. If contradiction, surface it. "Your code uses checkpoint key without targetDate, but you just said multi-day recovery works — which is right?"

### Update CONTEXT.md inline

When a term resolves, add a row to `Docs/CONTEXT.md` pointing to the canonical file. **Never inline content.** Use format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

Don't couple CONTEXT.md to implementation details. Only domain-meaningful terms.

### Offer ADRs sparingly

Offer only when ALL three are true:
1. **Hard to reverse** — cost of changing later is meaningful (e.g., schema migrations, identity files, channel ID format)
2. **Surprising without context** — future reader will wonder "why?"
3. **Real trade-off** — genuine alternatives existed; you picked one for specific reasons

Skip if any missing. The 11 locked decisions in `.claude/rules/architecture.md` already cover most of the load-bearing choices — don't duplicate.

If creating an ADR, place at `Docs/adr/NNNN-slug.md`. Use format in [ADR-FORMAT.md](./ADR-FORMAT.md).

### Waldo-specific anchors (don't re-litigate)

- 11 locked architecture decisions (`.claude/rules/architecture.md`)
- 9 Demo Day backend patterns (R1-R6, I1-I3) — built, locked
- 4 Demo Day pillars (Morning Wag, Fetch Alert, Spot, Chat)
- Hexagonal/adapter pattern as core architecture
- Soul files, safety rules, CRS algorithm = immutable
- iOS-first, Android second
- Cloudflare DO as agent runtime, Supabase as data layer

If a question conflicts with one of these, surface the conflict. Don't grill on changing them.
