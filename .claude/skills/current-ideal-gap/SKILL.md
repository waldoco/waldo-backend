---
name: current-ideal-gap
description: Use when the user wants to move from an unclear current state to a concrete desired state, define what done means, turn a vague goal into checkable criteria, or build a practical sequence of verifiable steps.
---

# Current Ideal Gap

Convert a vague aspiration into a verified path from current state to ideal state.

## Shape

```text
Current state -> Ideal state -> Criteria -> Gap -> Checkable steps -> Verification -> Learning
```

## Process

1. Write the current state in observable terms.
2. Write the ideal state in 1-3 hard-to-vary sentences.
3. Decompose the ideal into criteria with one yes/no probe each.
4. List the gaps: capability, information, decision, constraint, risk, tool, privacy/safety.
5. Convert gaps into steps with one verification check each.
6. Mark anything unverified as an assumption, not a fact.
7. Capture reusable learning when the gap analysis reveals a pattern.

## Criteria Rules

- Each criterion should have a falsifier: what result would prove it is not done?
- Include at least one `Anti:` criterion for what must not happen.
- For Waldo runtime/product work, name the affected data store, agent tool, privacy surface, user flow, or contract.
- For design work, include rendered evidence: desktop/mobile screenshot, reduced-motion result, and stress case when motion is involved.
- Use `waldo-isa-run-contract` when the request needs a durable artifact, multi-agent slices, or handoff-ready criteria.

## Output

```markdown
Current:
Ideal:
Criteria:
- [ ] ISC-1:
- [ ] ISC-2: Anti:

Gaps:
- ...

Steps:
1. ...

Verification:
- ...

Assumptions:
- ...

Learning:
- ...
```

## Waldo Boundary

For Waldo product/runtime work, do not treat this as a persistent user goal write. Runtime GoalRecords remain governed by ADR-0064 and must go through the approved Waldo tool path.

## References

Read `references/source-map.md` when applying this to Waldo goals, ISA-like artifacts, or LifeOS comparisons.
