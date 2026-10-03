# Curated Active Skills Implementation Plan

> **For agentic workers:** Use native execution with independent final review.

**Goal:** One owner-installable, invocation-selected, revocable document/email preparation skill
**Architecture:** Code-owned reviewed catalog and existing SQLite skills rows; existing RuntimeSkillLoader and serializer load selected enabled procedures at each step, with no bodies in history
**Tech Stack:** TypeScript, Zod, Cloudflare DO SQLite, Vitest
**Spec:** docs/superpowers/specs/2026-10-03-curated-active-skills-design.md

## Global Constraints
No remote installs, scripts, new grants, uploads autoactivation, source publication or deployment. Ordinary canonical empty-skill invariant stays intact.

## Review Focus
Owner isolation; explicit lifecycle permission; forged storage; disable between awaits; bounded prompt and no tool grants.

### Task 1: Lifecycle and loader
- [x] Write red tests for catalog list, explicit install, fresh instance persistence, selected procedure, disable and tampering
- [x] Implement reviewed catalog, SQLite lifecycle, invocation selection and conservative budget under existing loader
- [x] Run focused tests and worker typecheck

### Task 2: Strict runtime tools and typed host
- [x] Write red tool ACL/schema/taint/background tests and fake-provider task flow
- [x] Add strict tool schemas, registry/ACL/effect mapping and tools without body-return
- [x] Add typed host step procedure loading under safeguards, currentness checked before and after loads
- [x] Run affected contracts/runtime tests and verify no ordinary canonical activation

### Task 3: Independent review and handoff
- [x] Review boundaries and adversarial cases, fix demonstrated defects
- [x] Record exact candidate SHA and local commands, actual-model/live acceptance separately
