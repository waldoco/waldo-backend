---
name: waldo-isa-run-contract
description: Use when turning a Waldo engineering, product, design, agent-harness, or research request into a durable run contract with current state, ideal state, criteria, test strategy, work slices, verification evidence, and learning capture. Especially useful for ambiguous goals, multi-agent work, future handoffs, acceptance criteria, or "what does done mean?" conversations.
---

# Waldo ISA Run Contract

## Overview

Adapt LifeOS's ISA idea into a Waldo builder contract. The contract is not a new runtime source of truth; it is a disciplined way to define "done" for one project, run, issue, handoff, or agent-harness change.

Use this when the work would suffer from fuzzy done-ness, multi-agent drift, or unverifiable acceptance criteria. Use `current-ideal-gap` for a lighter current -> ideal pass.

## Contract Shape

```text
Current -> Ideal -> Criteria -> Test Strategy -> Work Slices -> Verification -> Learning
```

## Process

1. **Current**
   - State what exists now using observed evidence: files, diffs, failing tests, user quote, source snapshot, or runtime behavior.
   - Mark inference explicitly.
   - Completion: a future agent can tell what was known before the change.

2. **Ideal**
   - Write 1-3 sentences describing the desired state.
   - Preserve the user's literal goal when it contains a clear completion signal.
   - Completion: the ideal cannot be weakened without changing the goal.

3. **Criteria**
   - Write atomic criteria: one criterion, one yes/no probe.
   - Include at least one `Anti:` criterion for what must not happen.
   - Use stable ids (`ISC-1`, `ISC-2`, etc.); split as `ISC-2.1`, not by renumbering.
   - Completion: each criterion has a named falsifier.

4. **Test Strategy**
   - For each criterion, name the evidence type and tool: test, build, typecheck, browser screenshot, curl, database query, source citation, git diff, manual review, or eval.
   - For UI/design work, include desktop/mobile viewport proof and reduced-motion/accessibility checks.
   - For important code or skill contracts, add a hardening angle: property-test candidate, mutation-test candidate, adversarial criterion, source verification, or real-browser proof.
   - For criteria imported from external sources, include a claim-verification or bias-check path.
   - Completion: every criterion has a plausible verification path.

5. **Work Slices**
   - Slice vertically: each slice should produce a verifiable increment.
   - Add dependencies and parallelization notes for multi-agent work.
   - For delegated slices, include role, source packet, allowed surface, output contract, and the spotcheck the main agent will perform.
   - Completion: no slice is only "data layer" or "UI layer" unless that layer is independently verifiable.

6. **Verification**
   - Record actual command output, screenshot path, source citation, or file path.
   - Do not mark a criterion passed on "should work."
   - For high-blast-radius work, include at least one adversarial check: red-team critique, "how would this fail again?", source-bias audit, or observer/verifier review.
   - For loop/optimization work, record the baseline, mutation/iteration, score or evidence, and keep/revert decision.
   - Completion: done means evidence exists, not just edits exist.

7. **Learning**
   - Capture reusable lessons with `compound-learning-capture` when the run reveals a pattern.
   - Update the registry with `waldo-builder-registry` when a new or changed skill behavior is justified.
   - Completion: the next run starts with less ambient context.

## Output Template

```markdown
Current:

Ideal:

Criteria:
- [ ] ISC-1:
- [ ] ISC-2: Anti:

Test Strategy:
| ISC | Evidence | Tool | Threshold |
| --- | --- | --- | --- |

Work Slices:
| Slice | Satisfies | Depends on | Parallel? |
| --- | --- | --- | --- |

Verification:
- ISC-1:

Learning:
- ...

Assumptions:
- ...
```

## Waldo Boundaries

- Do not mutate runtime `GoalRecord`s directly. ADR-0064 governs approved goal write paths.
- Do not write into protected governance, ADR, or agent-soul files without explicit approval.
- Do not store raw health data in a run contract. Health-adjacent aspirations can be criteria; raw measurements stay in approved data stores.
- Do not create parallel acceptance specs when an existing PRD, issue, or ADR already owns the contract. Update or link it instead.

## Required Tools

| Work type | Required evidence tools |
| --- | --- |
| Code | `git diff`, test runner, typecheck/build, targeted source reads |
| UI/design | Browser/simulator, screenshots, viewport matrix, reduced-motion check |
| Runtime/agent harness | Loader/ACL probe, logs/journal check, sanitizer/tenant-scope check |
| Research | Source URLs, commits/tags, citations, local reference page |
| Vault docs | Wikilinks/backlinks, Evidence Trail, protected-file check |
| Hardening | Property-test candidate, mutation-test candidate, adversarial criteria, source-bias check, real-browser proof |
| Multi-agent | Source packet, role/scope prompt, raw cited paths, main-agent spotcheck |
| Loop/optimize | Baseline, metric/eval rubric, iteration ledger, keep/revert record |

## LifeOS Skill-Corpus Lessons

Read [[lifeos-install-skills-deep-dive-2026-07-04]] when defining a high-value Waldo run contract from external skill sources. The core import is:

- `ISA`: stable criteria IDs, anti-criteria, test strategy, decisions, changelog, verification.
- `Hardening`: test the tests and the criteria, not just the implementation.
- `RedTeam`: attack plans and criteria before reality does.
- `IterativeDepth`: run multiple lenses before freezing criteria.
- `SystemsThinking` and `RootCauseAnalysis`: distinguish recurring structures from one incident's contributing factors.
- `Agents` and `Prompting`: subagents need role, scope, source packet, output contract, and post-run spotcheck.
- `Loop` and `Optimize`: bounded iteration is allowed only when criteria, halt policy, and keep/revert evidence exist.
