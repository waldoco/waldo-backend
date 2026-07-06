# Source Map

## Primary Sources

- `danielmiessler/LifeOS` at `1405445344b61d228d4e3c0eef635708368fe31b`: Memory documentation and proposal queues.
- Waldo ADR-0064: persistent goals and skill curator lifecycle contract.
- Waldo security checklist: health-data and privacy boundaries.
- Waldo AGENTS.md: protected files and Evidence Trail rules.

## Adaptation Notes

- LifeOS memory is file-first; Waldo memory is scoped by approved runtime stores and APIs.
- Proposal queues, confidence, status lifecycle, and rollback are useful patterns.
- Raw health data remains outside general memory; only approved derived summaries or aspirations may enter user-facing memory.
