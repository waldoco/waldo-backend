# Source Map

## Primary Sources

- `danielmiessler/LifeOS` README at `1405445344b61d228d4e3c0eef635708368fe31b`: current state to ideal state through checkable steps.
- Current LifeOS paths: `LifeOS/install/skills/ISA/SKILL.md`, `LifeOS/install/skills/Telos/SKILL.md`, `LifeOS/install/skills/Loop/SKILL.md`, and `LifeOS/install/LIFEOS/DOCUMENTATION/Isa/IsaSystem.md`.
- Historical LifeOS pack paths are useful as lineage only; current top-level `Packs/` is no longer primary.
- Waldo ADR-0064: persistent goals are DO SQLite state and must not be mutated casually.

## Adaptation Notes

- LifeOS uses an Ideal State Artifact as a core primitive. This skill adapts that as a planning/reasoning pattern, not a Waldo runtime state write.
- In Waldo, the durable equivalent is a GoalRecord plus prompt-builder hydration, not a file-only artifact.
- For durable work contracts, use `waldo-isa-run-contract`; keep this skill as the lightweight current -> ideal pass.
