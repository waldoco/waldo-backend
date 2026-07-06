# Source Map

## Primary Sources

- `EveryInc/compound-engineering-plugin` README and `docs/skills/ce-compound.md`
- Every guide: `https://every.to/guides/compound-engineering`, checked 2026-07-05
- Current upstream snapshot checked 2026-07-05: `d3f35297adccea3ad8735e988253966ffa8cf74c`, release tracked locally as `compound-engineering-v3.17.1`
- `docs/skills/ce-sweep.md`: recurring feedback sweep, durable state, connector persona files, merge-evidence verification, prompt-injection posture
- `skills/ce-compound/SKILL.md`: full vs lightweight capture, overlap detection, scratch artifacts, docs/solutions schema
- `skills/ce-compound-refresh/SKILL.md`: Keep/Update/Consolidate/Replace/Delete refresh outcomes
- `skills/ce-plan/SKILL.md` and references: plan readiness, Product Contract, Planning Contract, Verification Contract
- `skills/ce-pov/SKILL.md`: project floor plus external-source floor for adoption verdicts
- Waldo Brain AGENTS.md Evidence Trail rules
- Waldo ADR-0022/0028 skill provenance and loader constraints

## Adaptation Notes

- Compound Engineering's strongest idea is the return arrow: each engineering loop should leave a reusable learning for the next loop.
- Waldo Brain already has Evidence Trail and reference pages, so this skill routes learnings into the vault rather than creating a separate `docs/solutions/` convention.
- EveryInc's overlap detection maps to "update/link existing page first"; duplicate docs are a regression.
- EveryInc's refresh lifecycle maps to Keep/Update/Consolidate/Replace/Stale. Its delete behavior is not imported because Waldo deletion requires explicit user approval.
- `ce-sweep` maps to future recurring feedback review, not default autonomous rewriting or source-side acknowledgements.
- `ce-pov` adds a useful adoption-decision rule: do not Adopt/Reject an external source unless both the Waldo project floor and external-source floor are proven.
- `ce-plan` adds readiness discipline: a requirements-only artifact should not be executed as an implementation plan.
- Runtime skill authoring remains a product feature with ACL/provenance/effectiveness constraints, not a repo-local shortcut.
