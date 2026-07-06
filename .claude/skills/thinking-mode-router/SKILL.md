---
name: thinking-mode-router
description: "Use when a request needs a specific thinking mode instead of a generic answer: first-principles decomposition, iterative-depth blind-spot search, systems analysis, root-cause analysis, scientific investigation, bias/source audit, adversarial red-team critique, council-style perspective debate, creative ideation, or world-model stress testing."
---

# Thinking Mode Router

Route ambiguous or high-stakes thinking work to the right cognitive mode before answering.

## Pick The Mode

| Need | Mode | Output |
|---|---|---|
| Strip inherited assumptions | First principles | Axioms, assumptions, reconstructed option |
| Surface hidden requirements or blind spots | Iterative depth | Lens passes, new/refined criteria, stop when yield repeats |
| Repeated pattern or cross-component behavior | Systems thinking | Event -> pattern -> structure -> mental model |
| Incident, recurring defect, or production failure | Root cause analysis | Timeline, contributing factors, deepest actionable causes |
| Unknown cause or disputed claim | Science | Goal, hypotheses, falsifier, experiment, result |
| Source, study, benchmark, or vendor claim may be distorted | Bias check | Data layer, source-organization layer, commentary layer, supported-vs-editorialized split |
| Weaknesses in a plan | Red team | Strongest version, attacks, fixes |
| Decision with multiple valid stakeholders | Council | Perspectives, disagreement, synthesis |
| More/better options | Creative | Diverse options, selection criteria |
| Strategy under external uncertainty | World model | Time horizons, assumptions, threats |

## Workflow

1. Name the selected mode and why it fits.
2. State the evidence threshold before analysis.
3. Run the mode; keep inference separate from observed facts.
4. Name the falsifier or decision rule.
5. End with one of: `adopt`, `adapt`, `reject`, `defer`, or `needs evidence`.

## Waldo Defaults

- For architecture, combine First principles + Systems thinking + Red team.
- For bugs, use Science when the cause is unknown; use Root cause analysis when a failure already happened; use Systems thinking when the failure class keeps recurring.
- For strategy, use Council first, then Red team the surviving option.
- For external claims, run Research for source truth and Bias check for distortion before adopting the lesson.
- For user-health or privacy surfaces, include a safety/privacy pass.
- For source-backed skill work, combine Science + Systems thinking + Red team, then route durable behavior changes through `waldo-builder-registry`.
- For design craft, use Creative only after the user job and verification artifact are clear.
- For LifeOS-derived builder work, read `[[lifeos-install-skills-deep-dive-2026-07-04]]` before claiming the skill corpus has been covered.

## Output Template

```markdown
Mode:
Why this mode:
Evidence threshold:
Observed facts:
Inferences:
Analysis:
Falsifier / decision rule:
Disposition:
```

## References

Read `references/source-map.md` when you need the source lineage or want to compare this to LifeOS Thinking modes.
