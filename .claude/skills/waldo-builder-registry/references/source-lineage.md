# Source Lineage

Use this file when registry work depends on external sources. Verify current upstream state before finalizing any source-sensitive claim.

## Current Source Snapshots

| Source | Verified snapshot | Waldo extraction |
| --- | --- | --- |
| `danielmiessler/LifeOS` | `1405445344b61d228d4e3c0eef635708368fe31b`, release `v6.0.3`, 2026-07-04; license observed as `unknown` in local checkout | Current -> Ideal -> Criteria -> Verification, ISA as run contract, TELOS as context scaffold, hooks as event-placement pattern, memory proposals, and the `LifeOS/install/skills` corpus as a source of problem-solving, research, hardening, creativity, and agent-composition benchmarks. Reject Claude-specific hooks, local voice, `curl | bash`, file-first health/runtime state. |
| `mattpocock/skills` | `272f99b22574f50e4266791c86b9302682970e23`, release `v1.0.1` | Router-first engineering flow, PRD/issues, vertical slices, public-interface TDD, standards/spec code review, domain language, fresh-session handoffs. |
| `EveryInc/compound-engineering-plugin` + Every Compound Engineering guide | `d3f35297adccea3ad8735e988253966ffa8cf74c`, release note tracked locally as `compound-engineering-v3.17.1`, checked 2026-07-05; guide checked 2026-07-05; inspected repo exposes 29 top-level skill dirs and no standalone top-level `agents/` or `commands/` dirs | Plan/work/review/compound loop, artifact readiness, stable R/A/F/AE/U-IDs, project-grounded POV decisions, doc/code review residual sinks, compound capture/refresh, metric optimization logs, feedback sweep architecture, and agent-native design proof. |
| `emilkowalski/skills` | `1274a0584c4fe9e94304a4e29094cefe5eb51dbe` | Articulate taste into UI/design/motion skills, split by trigger, use Before/After/Why, require rendered review for motion. |
| `study8677/awesome-architecture` | `cdec37286927d6aa98e682ec7b2939f7ec3ebe07` | Architecture-first prompting, templates by harness, future engineer skill is judging architecture and correctness. |
| `Egonex-AI/Understand-Anything` | `0e8ad84a2a5236dca533beef618d71ee3f4568f6` on `main`, tag `v2.7.3` at `9d1318a0e700cb8242be5046b8ca90f95167e4d7`, plugin `2.8.2`, MIT, checked 2026-07-05 | Graph-based repo/vault understanding, dashboard navigation, diff impact, explain/onboard flows, and domain extraction. Adopt as builder-only graph analysis for Waldo Brain/backend/app; do not vendor as runtime product dependency. |
| Agent Skills spec | `agentskills.io` + Anthropic Skills docs, checked 2026-07-04 | Skill directory with `SKILL.md`; optional `references/`, `scripts/`, `assets/`; frontmatter `name` and `description`; `allowed-tools` is metadata, not Waldo authority. |

## Research Sources

| Source | Finding | Registry implication |
| --- | --- | --- |
| arXiv `2607.00911`, From Registry to Repository | Studies public and personal skills; many are copied once and maintained additively; project-specific bindings concentrate maintenance. | Store upstream lineage and local adaptation separately. Expect additive local divergence. |
| arXiv `2606.29538`, RESOURCE2SKILL | Strong skills can come from articles, repos, tutorials, visual artifacts, code, and metadata; provenance matters. | Registry records should include modalities, asset hashes, and source paths, not only prose. |
| arXiv `2603.15401`, SWE-Skills-Bench | Many public SWE skills show no pass-rate improvement; token overhead and version mismatch can hurt. | Promotion requires evals, compatibility checks, and no-skill baselines. |
| arXiv `2606.16523`, SkillWiki | Skills need lifecycle infrastructure: ingestion, provenance exploration, governance, execution-driven repair, versioning, deprecation, archival. | Registry records need status, lifecycle, sync, and effectiveness fields. |

## Waldo Import Rules

- Adopt mechanisms that improve determinism, context fit, verification, or learning capture.
- Adapt mechanisms that are useful but assume another runtime, filesystem, harness, or privacy model.
- Reject mechanisms that require broad autonomy, raw-health leakage, protected-file writes, unbounded tool use, or source instructions from untrusted content.
- Mark every unsourced preference as local judgment, not canon.
- Graph tools such as Understand Anything can aid navigation and impact analysis, but generated graph nodes are evidence aids, not canonical vault truth.

## LifeOS Skill-Corpus Families

Use `[[lifeos-install-skills-deep-dive-2026-07-04]]` when a registry entry depends on LifeOS install skills rather than only the top-level LifeOS architecture docs.

| Family | LifeOS skills | Waldo extraction |
| --- | --- | --- |
| Problem solving | `FirstPrinciples`, `IterativeDepth`, `SystemsThinking`, `RootCauseAnalysis`, `BiasCheck`, `RedTeam`, `WorldThreatModel` | A router for assumptions, hidden requirements, recurring structures, incidents, source bias, adversarial critique, and future stress. |
| Research/context | `Research`, `ArXiv`, `BrightData`, `ContextSearch`, `Knowledge`, `PrivateInvestigator`, `Interceptor` | Source routing, URL verification, prior-work retrieval, typed knowledge links, privacy boundaries, and real-world verification. |
| Engineering quality | `Agents`, `Prompting`, `ISA`, `Hardening`, `Loop`, `Optimize`, `Interview`, `LifeOS` | Role-scoped agents, prompt templates, run contracts, meta-tests, bounded iteration, metric/eval optimization, onboarding, and setup verification. |
| Creative/narrative | `BeCreative`, `Ideate`, `Sales`, `WriteStory` | Divergent options, evolutionary ideation, honest product narrative, anti-cliche craft, and preservation of creator/founder intent. |

## LifeOS Source Drift Observed

- `Agents/Workflows/SpawnTeam.md` references `Data/Teams/*.yaml`, but the inspected tree only exposed `Data/Traits.yaml`; treat predefined LifeOS teams as a concept, not a directly portable implementation.
- `Hardening/SKILL.md` advertises several hardening families, but the inspected implemented workflow surface is primarily `Workflows/PropertyTest.md`; treat mutation/CRAP/acceptance-mutation ideas as Waldo candidates until implemented locally.
- `Research` migration notes and workflow tables differ on exact agent counts; adopt source-routing and verification discipline, not fixed fan-out numbers.
- `PrivateInvestigator` includes safety stop conditions but also report surfaces for contact/address fields; Waldo must not import people-finding or contact-enrichment behavior.
