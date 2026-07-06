# Source Map

## Primary Sources

- `danielmiessler/LifeOS` at `1405445344b61d228d4e3c0eef635708368fe31b`, release `v6.0.3`, checked 2026-07-04.
- Current paths: `LifeOS/install/skills/{FirstPrinciples,IterativeDepth,SystemsThinking,RootCauseAnalysis,BiasCheck,RedTeam,WorldThreatModel,BeCreative,Ideate,Research}/`.
- Historical lineage: older `Packs/Thinking/README.md` and `Packs/Thinking/src/*` files.
- Waldo `.claude/rules/mental-model.md` doctrine: science loop, systems loop, AI-native operating loop.
- Waldo corpus note: `[[lifeos-install-skills-deep-dive-2026-07-04]]`.

## Mode Mapping

| Router mode | LifeOS source | Waldo adaptation |
| --- | --- | --- |
| First principles | `FirstPrinciples/SKILL.md`, `Workflows/{Challenge,Deconstruct,Reconstruct}.md` | Challenge inherited assumptions while preserving Waldo hard constraints: privacy, user approval, protected files, law, ADRs, and data boundaries. |
| Iterative depth | `IterativeDepth/SKILL.md`, `ScientificFoundation.md`, `TheLenses.md`, `Workflows/Explore.md` | Use 2-8 lens passes for hidden requirements; stop when new yield repeats. |
| Systems thinking | `SystemsThinking/SKILL.md`, `Foundation.md`, `Archetypes.md`, `LeveragePoints.md`, `Workflows/*` | Route recurring patterns through event -> pattern -> structure -> mental model and name the structural fix. |
| Root cause analysis | `RootCauseAnalysis/SKILL.md`, `Foundation.md`, `MethodSelection.md`, `Workflows/*` | Use for incidents/regressions; humans are not root causes; pick 5 Whys/Fishbone/Fault Tree/Kepner-Tregoe/Postmortem by failure shape. |
| Science | Waldo rules plus LifeOS research/verification patterns | Hypothesis, falsifier, evidence threshold, experiment/result. |
| Bias check | `BiasCheck/SKILL.md`, `BiasTaxonomy.md`, `Workflows/Check.md` | Audit data, source organization, and commentary before adopting source claims. |
| Red team | `RedTeam/SKILL.md`, `Philosophy.md`, `Integration.md`, `Workflows/*` | Steelman first, attack assumptions, converge on fixes; scale parallelism by risk. |
| Council | Historical LifeOS Thinking lineage plus Waldo review practice | Use for valid stakeholder tradeoffs; do not confuse with source truth. |
| Creative | `BeCreative/`, `Ideate/`, `WriteStory/`, `Sales/` | Generate diverse options only after user job/source intent is clear; follow with scoring and anti-cliche/founder-intent checks. |
| World model | `WorldThreatModel/` | Use as scenario stress testing, not prediction authority; require fresh cited models before strong claims. |

## Rejected Source Assumptions

- Mandatory voice/Pulse notifications, JSONL execution logs, and host-specific local side effects.
- Fixed 32-agent red-team scale or any numerology not justified by risk.
- World-model outputs as authority.
- People-search or contact enrichment as a thinking-mode dependency.
