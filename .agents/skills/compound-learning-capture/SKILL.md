---
name: compound-learning-capture
description: Use after a non-trivial fix, research pass, review, architecture decision, workflow improvement, or repeated agent failure reveals a reusable lesson that future agents should not rediscover from scratch.
---

# Compound Learning Capture

Capture the reusable lesson while context is fresh.

## When To Use

- A bug was fixed and the root cause would be expensive to rediscover.
- A review found a pattern, not just a one-off issue.
- A research pass changed the recommended build path.
- A repeated agent mistake needs a reusable guardrail.

## Capture

First run an overlap check. Search for an existing source page, concept page, ADR, skill reference, or prior Evidence Trail that already owns the lesson. Update or link the existing home unless the new lesson has a different trigger, boundary, or source.

Classify the lesson before writing:

| Track | Use when | Extra fields |
|---|---|---|
| Bug/failure | A defect, incident, failed test, regression, or repeated agent mistake was fixed | Root cause, prevention rule, affected component, severity, verification command |
| Knowledge/practice | A source, review, design pass, architecture decision, or workflow improvement changed future behavior | Source path/URL, applicability limit, target skill/rule/page, eval pressure |

Write the smallest durable artifact that future agents can find:

| Lesson shape | Destination |
|---|---|
| External source extraction | `03-References/repos/` or `03-References/blogs/` |
| Waldo concept or reusable mental model | `02-Knowledge/concepts/` |
| Vault page update | Existing page + Evidence Trail |
| General agent behavior | `.claude/skills/` or `.claude/rules/` only when justified |
| Skill registry behavior | `waldo-builder-registry` record + source/eval reference |

## Modes

| Mode | Use when | Output |
| --- | --- | --- |
| Lightweight | The lesson is narrow and has an obvious home | One page/skill update, one Evidence Trail entry, no new abstraction |
| Full | The lesson changes agent behavior, tool use, or future planning | Source map, overlap check, registry/eval update, impact surface |
| Sweep | Repeated feedback or failures form a class | Cluster findings, affected skills/pages, refresh outcome, proposed consolidation |

## Refresh Outcomes

When auditing existing lessons, use the smallest evidence-backed outcome:

| Outcome | Meaning |
|---|---|
| Keep | Lesson still matches current source/repo state. |
| Update | Lesson is useful but has factual or boundary drift. |
| Consolidate | Multiple lessons overlap and should point to one stronger home. |
| Replace | Lesson is misleading and should be superseded by a clearer page or skill. |
| Stale / propose delete | Lesson no longer applies, but deletion requires explicit user approval under AGENTS.md. |

## Required Fields

- Symptom or opportunity
- Root cause or source insight
- What worked
- What did not work, if known
- Track: bug/failure or knowledge/practice
- Affected component or target skill/rule/page
- Where future agents should look first
- Source URL/path/commit when the lesson came from an external source
- Applicability limit: when this lesson should not fire
- Eval or pressure scenario when the lesson changes skill behavior
- Evidence Trail entry

## Guardrails

- Do not turn every session into a new doc.
- Prefer updating an existing page when overlap is high.
- Do not edit protected governance or agent-soul files without explicit approval.
- Do not write into ADRs except through explicit append/new-decision protocols.
- Do not capture raw user, health, financial, or private data as reusable knowledge.
- Do not promote a broad public skill just because it exists; record effectiveness and version fit first.
- For Waldo runtime skills, follow ADR-0022, ADR-0028, and ADR-0064 instead of writing directly into runtime skill surfaces.

## Output Contract

```markdown
Lesson:
Mode:
Track:
Overlap check:
Destination:
Source/provenance:
Applicability limit:
Eval/pressure scenario:
Refresh outcome:
Evidence Trail:
Impact surface:
```

## References

Read `references/source-map.md` for the EveryInc and Waldo source lineage.
