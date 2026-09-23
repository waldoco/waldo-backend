---
name: waldo-memory-proposal-review
description: Use when reviewing, designing, accepting, rejecting, or safely applying proposed Waldo memory, preference, goal, user-context, learning, or skill-curator updates. Especially useful for LifeOS-style memory proposal ideas, ADR-0064 GoalRecord changes, user profile updates, health-adjacent facts, and agent-authored persistent learnings.
---

# Waldo Memory Proposal Review

## Overview

Review persistent-memory changes before they become durable truth. A good proposal says what changed, why it is justified, where it may be stored, who can see it, how it can be reversed, and what evidence would make it wrong.

Use this skill for proposed memory/goal/context updates. Use `compound-learning-capture` for repo-local lessons that belong in the vault.

## Review Flow

1. **Classify the proposal.**
   - Types: `goal`, `preference`, `identity`, `relationship`, `project-state`, `skill-learning`, `health-adjacent`, `raw-health-forbidden`, `temporary-state`.
   - Completion: the storage and approval path are implied by the type.

2. **Check evidence and source.**
   - Identify whether the source is user-stated, inferred from behavior, imported from an external file, produced by an agent, or derived from health/device data.
   - Mark inference as inference.
   - Completion: the proposal can be audited back to a source.

3. **Check privacy and boundary.**
   - Name tenant/user/session scope.
   - Raw health values do not enter general memory or skill prose.
   - Agent-authored identity or intervention changes need elevated review.
   - Completion: the proposal cannot leak across scope boundaries.

4. **Choose disposition.**
   - `accept`: evidence is strong, storage path is approved, rollback exists.
   - `edit`: meaning is useful but wording/scope is too broad.
   - `reject`: unsupported, unsafe, stale, duplicative, or protected.
   - `defer`: needs user confirmation or runtime path not ready.
   - Completion: the disposition includes the reason and next action.

5. **Plan application and rollback.**
   - Name the approved write path, snapshot/backup, audit event, and undo route.
   - For Waldo runtime, follow GoalRecord/memory APIs and ADR-0064 lifecycle. Do not edit DB-like state through markdown shortcuts.
   - Completion: applying the memory is reversible or explicitly non-reversible with consent.

## Output Contract

```markdown
Proposal:
Type:
Source:
Evidence:
Privacy tier:
Allowed storage:
Disposition:
Reason:
Apply path:
Rollback:
Audit event:
Open questions:
```

## Guardrails

- Do not silently turn inferred behavior into identity truth.
- Do not store raw health measurements in general memory.
- Do not auto-accept agent-authored skills or memory that touch protected surfaces.
- Do not overwrite a broader memory set when a small append/edit is enough.
- Do not delete memory without explicit approval and rollback.

## Required Tools

| Need | Tool capability |
| --- | --- |
| Source trace | Read source artifact, episode, user message, import file, or run log |
| Scope check | Tenant/user/session metadata, ACL, data-class classifier |
| Duplicate check | Search existing memory, goals, vault pages, and skill registry |
| Apply path | Approved GoalRecord/memory proposal API or vault Evidence Trail |
| Rollback | Snapshot, prior value, audit event, restore command or UI |
