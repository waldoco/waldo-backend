---
name: codify-craft-judgment
description: Use when turning expert taste, critique, repeated review feedback, design rules, writing standards, product judgment, UI polish guidance, or domain-specific craft knowledge into reusable agent skills, checklists, eval prompts, or source-backed team guidelines.
---

# Codify Craft Judgment

## Overview

Convert tacit expert judgment into reusable agent behavior. A good craft skill does not say "make it tasteful"; it names the situation, the failure mode, the rule, the exception, and how another agent should verify it.

Use `references/skill-research.md` for the research basis behind skill design, reuse, and evaluation.

## Judgment Capture Loop

1. Gather source material.
   - Expert critiques, before/after examples, product docs, design reviews, code reviews, bug reports, and shipped components.
   - Preserve source links or local file paths. Do not turn unsourced preference into canon.

2. Extract repeated decisions.
   - Situation: when does this judgment apply?
   - Symptom: what does bad output look like?
   - Rule: what should the agent do?
   - Reason: why does this matter to the user or system?
   - Exception: when should the rule not apply?
   - Verification: how can an agent check it?

3. Split by trigger, not by author.
   - Build skill: helps create or edit.
   - Review skill: flags regressions.
   - Vocabulary skill: names things precisely.
   - Reference file: holds long catalogs.

4. Keep the skill small.
   - Put only the core workflow in `SKILL.md`.
   - Put long standards, glossaries, source maps, and examples under `references/`.
   - Avoid project-specific facts in a general-purpose skill unless clearly labelled.

5. Add tests or pressure scenarios.
   - Baseline: how does an agent fail without the skill?
   - With skill: does it change behavior?
   - Regression: what loophole might it rationalize?
   - Version fit: when does the source stop applying?
   - Tool proof: which rendered artifact, command, source citation, or eval proves the skill helped?

6. Deploy with provenance.
   - For Waldo Brain, add Evidence Trail entries to source-backed pages.
   - Do not edit protected governance, ADR, or agent-soul files without explicit approval.
   - For runtime Waldo skills, respect ADR-0022 and ADR-0028 provenance, ACL, and loader constraints.

7. Register when behavior changes.
   - Use `waldo-builder-registry` when the judgment creates a new skill, changes a skill's trigger, adds required tools, or should be promoted beyond local advice.
   - Record source URI/commit/path, required tools, privacy tier, eval scenarios, and known failure modes.
   - Keep broad or untested judgments `provisional`.

## Skill Design Checklist

| Check | Standard |
| --- | --- |
| Trigger | The description says when to use it, not just what it contains |
| Scope | One responsibility; split build/review/vocabulary if needed |
| Source | Key rules trace to sources or repeated observed failures |
| Actionability | Rules have concrete moves, not abstract adjectives |
| Exceptions | The skill says when not to apply itself |
| Output | Required response format is explicit |
| Verification | Agent can test or inspect the outcome |
| Maintenance | Long material lives in references, not the always-loaded body |
| Registry | Behavior-changing skills have source, tool, lifecycle, and eval metadata |

## Rule Template

```markdown
### [Rule name]

- Situation:
- Symptom:
- Do:
- Avoid:
- Why:
- Exception:
- Verify:
```

## Anti-Patterns

| Anti-pattern | Fix |
| --- | --- |
| "Use good taste" | Name the observable failure and the preferred correction |
| One giant omnibus skill | Split by trigger and load only what is needed |
| Copying a blog into a skill | Distill rules and cite the source |
| Skill conflicts with local codebase | Bind the rule to local patterns or make it conditional |
| No eval or baseline | Add pressure scenarios before trusting the skill |
| General rule edits protected files | Propose an append-only doc or ask for explicit approval |
| Good source, wrong runtime | Adapt the principle and reject the mechanism |
| Tool need hidden in prose | Add a tool manifest entry or registry field |

## Waldo Adaptation

For Waldo, craft skills must reinforce the existing source-of-truth model:

- Source-backed wiki page first for external research.
- Repo-local `.claude/skills/` for agent-operating skills.
- Runtime skill architecture only when the backend contracts are ready.
- Registry-backed promotion through `waldo-builder-registry` when the skill affects future tool use, ACL, privacy, or loader behavior.
- Canonical terms stay intact: session, run, thread, episode, memory block, working memory, Brief, Fetch, Patrol, Handoff, Close, Spots, Constellation.
