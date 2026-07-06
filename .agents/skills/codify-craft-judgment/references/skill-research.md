# Skill Research Notes

## Core Findings

- Skills are structured context bundles, usually `SKILL.md` plus optional references/scripts/assets.
- Current research warns against assuming every skill helps. The benefit depends on domain fit, abstraction level, local compatibility, and verification.
- Effective skills preserve provenance, support progressive disclosure, and evolve from actual use.

## Research Map

- `From Registry to Repository` (arXiv 2607.00911): public and personal skills are often copied once and then maintained additively. Project-specific bindings are where maintenance effort concentrates.
- `RESOURCE2SKILL` (arXiv 2606.29538): stronger skill assets combine articles, code, visual examples, metadata, and provenance instead of text-only summaries.
- `SWE-Skills-Bench` (arXiv 2603.15401): many public software skills do not improve pass rate; a small number of specialized, context-fit skills do. Version mismatch can hurt.
- `SkillWiki` (arXiv 2606.16523): skills need lifecycle infrastructure: ingestion, provenance-aware exploration, governance, and execution-driven evolution.
- Agent Skills spec and Anthropic Skills docs: `SKILL.md` is the entry point; `references/`, `scripts/`, and `assets/` support progressive disclosure; `allowed-tools` is metadata and should not replace Waldo ACLs.

## Design Implications

1. Prefer narrow, high-signal skills over broad advice.
2. Bind generic rules to local conventions at use time.
3. Store source maps next to the skill or in the wiki.
4. Test against realistic tasks.
5. Treat skill updates as behavior changes, not casual documentation edits.
6. Preserve registry metadata: source commit, applicability limits, required tools, lifecycle state, and eval scenario.
7. Keep runtime authority outside the skill body; the loader and dispatcher enforce ACL.
