# Source Map

## Primary Sources

- `danielmiessler/LifeOS` at `1405445344b61d228d4e3c0eef635708368fe31b`, release `v6.0.3`: `LifeOS/install/skills/ISA/SKILL.md`, `LifeOS/install/skills/ISA/Workflows/*`, `LifeOS/install/skills/Hardening/Workflows/PropertyTest.md`, `LifeOS/install/skills/{Agents,Prompting,Loop,Optimize,Interview,LifeOS}/`, and `LifeOS/install/LIFEOS/ALGORITHM/*`.
- Waldo ADR-0064: persistent goals and skill curator lifecycle remain runtime-governed.
- Waldo AGENTS.md: Evidence Trail, protected-file rules, and impact-surface discipline.
- Matt Pocock skills: vertical slices, TDD probes, and handoff discipline.
- EveryInc Compound Engineering: stable U-IDs, guardrails-not-choreography, confidence gates, compound capture.

## Direct LifeOS Adoptions

| Source | Waldo import |
| --- | --- |
| `ISA` | Stable criteria IDs, anti-criteria, guard rails, test strategy, decisions, changelog, verification log. |
| `Agents` | Role briefs as reading lists, raw source packets, observer gates, main-agent spotchecks after parallel work. |
| `Prompting` | Templates separate structure from data; eval prompts and validation gates belong in reusable references or scripts. |
| `Hardening` | Property-test selection questions, reproducible seeds/run counts where implemented, adversarial criteria where tests are not yet practical. |
| `Loop` | Goal lock, halt conditions, dead-end ledger, supervised multi-pass execution. |
| `Optimize` | Metric/eval mode, sandboxing, keep/revert records, guard rails before hill-climbing. |
| `Interview` | Review age is not write age; freshness checks should ask one focused question at a time. |
| `LifeOS` | Detect, dry-run, conflict scan, backup, additive deploy, verify, fail loud. |

## Adaptation Notes

- LifeOS ISA is a file-backed system of record; Waldo uses this as a run-contract pattern, not as unmanaged runtime state.
- Criteria are useful only when each one has a falsifier and evidence tool.
- Long-lived product/runtime contracts must be reconciled with ADRs, PRDs, issues, or runtime DB contracts rather than duplicated.
- Do not import LifeOS mandatory voice notifications, localhost bridges, broad saved-agent permissions, or host-specific installer side effects.
