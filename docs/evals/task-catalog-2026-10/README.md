# Eval task catalog, gold references and design research (draft, for review)

Status: documentation only. Nothing here is wired into the runner, no fixtures are built, no case has been run. Not a score and not a baseline.

## Files
- `design-research.txt` - desk research on how public agent benchmarks are built, with recommendations R1-R17 for the Waldo eval. Sources are public pages. It was written without reading this repo, so its "not built yet" claims were not checked against the code.
- `task-catalog.txt` and `tasks.jsonl` - 113 candidate tasks (id, surface, prompt, fixtures needed, stop condition, rubric dimensions, tier, risk tags). The catalog text and the jsonl hold the same tasks.
- `gold/chunk-A.jsonl` to `chunk-D.jsonl` - researched reference answers per task (the `reference` object). They are written from public sources. They are references, not observed runs of any agent, and not fixture results.

## Known errors in the catalog (verify before using any case as a pass/fail check)
- An Austin venue named in the catalog is closed.
- IN-06: the TDR rule as stated is wrong.
- Tatkal and ARP (advance reservation period) rules as stated are wrong or out of date.
- DGCA rules as stated are wrong or out of date.
- IRDAI rules as stated are wrong or out of date.
Gold rows may already correct some of these; rows were not individually audited against the catalog text. A human should re-read each checker against its goal before any score is quoted (design-research R15).

## Overlap with what already exists in this repo
The repo already has the 36-case v2 suite and v2.1 overlay (`packages/runtime/evals/fixtures/`), native36 bundles, W7 evals v0, and runner code for forbidden effects, claimed-vs-receipted effects, usage reconciliation and sealed receipts. See the review note in the PR description for which research recommendations are already present.

## Not included
No Instinct internals, prompts or tool names; no secrets. Comparisons against other agents must use observed behavior on the same task only.
