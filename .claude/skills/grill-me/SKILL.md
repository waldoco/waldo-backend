---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or types "grill me".
disable-model-invocation: true
---

# Grill Me

Interview the user relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one. For each question, provide your recommended answer.

Ask questions one at a time. Wait for the answer before moving on.

If a question can be answered by exploring the codebase or reading `Docs/CONTEXT.md`, explore instead of asking.

## Waldo-specific framing

Before grilling, anchor on:
- **Phase context** — which build phase are we in (A-H or Phase 2/3)? See `.claude/rules/phase-orchestration.md`.
- **Vocabulary** — use Waldo's ubiquitous language. See `Docs/CONTEXT.md` for term → canonical location.
- **Locked architecture** — don't re-litigate the 11 locked decisions in `.claude/rules/architecture.md`. If a question conflicts with one, surface the conflict instead of asking.
- **Identity is immutable** — soul files, safety rules, CRS algorithm never auto-evolve. Don't grill on changing them.

## What to grill on

- Trigger type and tool permission scope (Morning Wag vs Fetch Alert vs user chat)
- Which adapters (10 total) does this touch? Does the change leak provider-specific logic into core?
- What memory tier (1-4) does new state belong in? Is this DO SQLite, Supabase, or R2?
- What error class (transient/model/user/crash) does this fail under? See `cloudflare/waldo-worker/src/errors.ts`.
- Quality gates: which of the 5 should this clear before delivery?
- Cost: does this fit the $0.01-0.03/user/day envelope?

End grilling when you and the user share a design concept clear enough to write a PRD-style summary. Then offer: "Want me to write this up as a phase-handoff doc or jump straight to code?"
