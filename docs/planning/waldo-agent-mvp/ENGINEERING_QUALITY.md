# Engineering quality, dependencies and improvement loop

Updated 21 September 2026. Implementation guidance for the [canonical MVP plan](../WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md), applied through the [worker guide](WORKER_GUIDE.md) and [repository map](REPOSITORY_MAP.md). This document defines work to implement; it does not claim those systems are operating. S0–S4/H/B/C/K0 scope and A1–A16 acceptance remain in the canonical plan.

## 1. Current evidence and first engineering frontier

Observed source baseline: backend main `65a334ccf1cb2b7d8298d416680b546cce0e868f`. It contains TypeScript checks, contract guards, Cloudflare-runtime Vitest tests, Supabase migration/RLS and session-revocation tests, fast-check property tests and targeted Stryker configurations. The full `pnpm verify` does not itself establish model behavior or native/provider acceptance. No `tools/eval` directory or executable general agent evaluation suite was found at this baseline; the run-eval skill's fallback verification is not an equivalent behavior evaluation.

GitHub inspection on 21 September: Actions enabled; workflow `verify` active; Actions runs API returned `total_count: 0`; current main exposed only a skipped Supabase Preview check. The branch-protection request returned a GitHub plan-related HTTP 403. These observations do not establish the cause of missing runs or enforced merge checks. Recheck current state. Do not infer billing failure, disable protections, make the repository public, or label CI green from YAML alone.

**First CI deliverable:** reproduce the pinned verification wall in an appropriate clean environment, diagnose workflow dispatch/event/account availability, record one actual run at an exact SHA, and verify how required checks are enforced for this private repository. If hosted Actions remains unavailable, record that blocker and attach exact-SHA independent verification; do not silently treat that as enforced CI. Document the supported runner, commands, secrets requirements, artifacts and failure triage. No production credentials belong in untrusted PR runs.

Build the first small behavior evaluation runner alongside S0 and grow it with each slice. This is supporting work for the existing build order, not a new platform prerequisite.

## 2. Coding-agent delivery loop

1. Read only the current slice, owning source, contracts, relevant tests and exact-version references. Register one owner and bounded files in the existing issue/ledger; use an isolated worktree.
2. Define observable success and reproduce the missing behavior. For a defect, compare plausible causes at the owning layer before choosing a fix.
3. Implement the smallest production path. Give independent app/connector/health workers a released contract and fixtures before they write consumers.
4. Run focused tests and behavior cases, then the required repository wall. Inspect the actual effect and failure recovery, not just the model's answer.
5. Have an independent reviewer inspect the changed source and evidence. Apply the existing security/health/contract review triggers. A second agent's approval alone is not evidence.
6. Verify integration on staging/device/provider at the layer claimed; publish a reviewable PR and handoff. Merge/deployment follows the repository's authorization and release process.
7. Convert meaningful failures and user corrections into regression cases; preserve one next frontier in the owning issue rather than another status database.

Keep worker instructions short and navigable; promote recurring architectural mistakes into useful deterministic checks. OpenAI's [harness-engineering account](https://openai.com/index/harness-engineering/) reports this approach in one internal-beta experiment. Its minimal merge-gate choices are not a universal standard or Waldo's release policy.

## 3. Tests, evaluations and CI lanes

| Lane | Scope | Evidence / gate |
|---|---|---|
| Every code PR | Frozen install, types, contracts/generated freshness, owning behavior tests, Workers storage/recovery, applicable local Supabase/RLS/migrations, isolation and deterministic action rules | Required checks at reviewed SHA; explicit failures and unavailable prerequisites. Focused tests during development do not replace the full repository merge wall. |
| Model/prompt/tool/context PR | Previous checks plus affected behavior regressions, pinned baseline comparison and held-out cases | Report task success and harm/error categories separately. Keep deterministic permission/isolation checks blocking; calibrate probabilistic usefulness/tone thresholds. |
| Scheduled expensive verification | Repeated isolated model trials, live test-account adapter conformance, bounded browser checks and targeted mutation tests | Budgeted runs, sanitized artifacts, failure issue/PR; meaningful regressions require triage. Introduce scheduling only after one manual run works. |
| Release candidate | Actual iPhone/cloud/provider loop; HealthKit/push and laptop-off follow-through; restart, cancellation, revocation, account switch; K0 when claiming joined showcase | Exact source/config/device/provider pins, observed effects, rollback/recovery procedure and A1–A16 evidence. Physical-device checks may be manual but must be recorded. |

Reuse Vitest and a small TypeScript scenario runner before buying an evaluation platform. Suggested new locations are `tools/eval/` for runner/graders and synthetic development cases; these are proposed paths, not existing commands. Publish the executable command and artifact contract when implemented. Keep held-out cases in a separately controlled suite inaccessible to the optimizing worker. Repeatedly revealed holdouts must be rotated.

A scenario record needs: ID and acceptance-ID mapping; synthetic starting state; user instructions; allowed permissions; injected failures; expected outcome; forbidden effects; grader/version; trial count and budgets. Reset owner/store/provider fixtures between trials. A result needs source/model/prompt/tool/config pins, trial/seed where supported, environment, statuses, observed effect references, recovery result, latency, tokens/cost, interventions, and sanitized evidence. Seeds do not guarantee deterministic model behavior. Do not store private health values, credentials, full private conversations or hidden reasoning in artifacts.

Use deterministic graders for owner isolation, exact approvals, memory revisions, duplicate prevention and actual state. Use calibrated model/human rubrics for usefulness, personality and unnecessary clarification. Judge observable outcomes; assert exact tool order only where an invariant requires it. Keep expected successful actions as well as refusal cases so refusing everything cannot pass.

Start with a small representative suite and preserve the canonical plan's required case counts, repeats and thresholds. In particular, do not shrink A1–A16 memory/longitudinal acceptance to one smoke test. Include missing/stale/revoked health, correction during execution, restart after effect but before receipt, uncertain email send, irrelevant memory, noisy proactivity and disconnected Kennel. Report every trial, repeated success and failure categories rather than best-of-many results. [Anthropic evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

CI implementation should add appropriate timeouts, cancellation of obsolete PR runs, sanitized failure artifacts and minimum permissions. Preserve unique migration coverage while consolidating repeated setup. Separate untrusted PR tests from credential-bearing provider tests; those use explicit test accounts and bounded effects. Keep action pins at full commit SHAs. [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)

## 4. Bounded automatic improvement

The development loop is: **failure → reproducible case → candidate code/prompt/tool patch → baseline and regression evaluation → independent review → PR → staged proof**.

Agents may diagnose failing checks, propose narrow repairs, refresh stale references and prepare dependency updates. Run in an isolated worktree with explicit file/tool permissions, attempt/time/spend limits and no production credentials. After three unsuccessful repair attempts, record the cause/evidence and decompose or hand off; never lower a threshold, skip a failing test or rerun indefinitely to obtain green. Classify product, environment, evaluator and intermittent failures separately.

Keep candidate changes separate from protected graders and held-out cases. Changes to grading rules require independent review and re-baselining. Preserve outcome success, intervention burden and cost together so a prompt cannot win by refusing useful work. Anthropic describes agent-assisted tool improvement with held-out evaluation; that is evidence for a measured candidate-patch loop, not unsupervised production self-rewriting. [Tool engineering](https://www.anthropic.com/engineering/writing-tools-for-agents)

Customer memory learning remains the correctable, permission-aware process in the plan. A remembered preference, generated procedure or useful runtime observation does not install a dependency, rewrite deployed tools, grant permission or merge code. Runtime procedures and prompts can be proposed for versioned evaluation through this development loop.

## 5. Library and dependency lifecycle

The [worker guide §3](WORKER_GUIDE.md#3-dependency-and-library-choices) owns the selected stack. Preserve its single durable runtime, typed model gateway, existing persistence, direct Google adapters and hosted browser interface. No second orchestration framework, memory database or generic connector catalog is required by this quality plan.

For a new dependency or meaningful upgrade, include a short record in its PR:

| Required field | Worker action |
|---|---|
| Need and alternative | Name the user-visible gap; compare reuse/native API with the dependency. Prefer an official maintained library when it avoids rebuilding difficult protocol, auth or validation behavior. |
| Exact compatibility | Inspect lockfile, installed code/types, official versioned docs, changelog and runtime constraints. Test the specific API used, including deployment-runtime behavior. |
| Source and footprint | Verify canonical package/repository, maintenance, license suitability, transitive dependencies, install scripts, bundle/startup/native impact and relevant advisories. Apply existing severity rules. |
| Contract and owner | Name the Waldo interface, error/retry/cancel semantics, schema validation, maintainer and affected consumers. Wrap model/browser/provider seams; do not wrap every utility. |
| Proof and rollback | Record old/new versions, a focused contract regression, applicable full checks and deployed smoke proof. For storage/native upgrades, document forward/backward compatibility; reverting a package alone may not revert its data. |

Use each repository's own committed lockfile and package manager. Keep backend direct pins and frozen CI installs; standardize the exact Node/CLI version used in verification without silently upgrading sibling repositories. Never use an unrelated feature PR for broad dependency churn or `update --latest`. Models and hosted APIs also drift: pin snapshots where available; otherwise record the alias/date and detect behavior changes with conformance/evaluation runs.

Choose one update bot, initially Dependabot, to propose manageable scheduled PRs for supported ecosystems and Actions. Group coupled runtime/test packages; separate major upgrades, native platform upgrades and unrelated ecosystems. Review release notes and compatibility; automated proposal does not imply automatic merge. No bot configuration is installed by this documentation change. [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)

Retain the backend's current 14-day dependency release-age delay and narrowly justified exceptions. At the inspected baseline, June hotfix exclusions remain, including a broad `@cloudflare/workerd-*` exemption. Re-evaluate and expire unnecessary exemptions without changing resolved versions accidentally. Allow necessary dependency build scripts narrowly; keep a frozen-install smoke check. Use the installed pnpm 10 documentation, not current-major defaults. [pnpm 10 settings](https://pnpm.io/10.x/settings)

Specific compatibility checks:

- Cloudflare: evaluate Wrangler, workerd/Miniflare and the Vitest Workers pool together. Preserve DO eviction/restart tests; a Node-only test cannot prove those semantics. [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- Browser: the selected hosted Stagehand HTTP contract and the newest JS SDK are distinct. Follow the [browser research note](RUNTIME_BROWSER_RESEARCH.md); prove sessions, Context persistence, cancellation and iPhone takeover before declaring compatibility. Do not add a Node server merely to copy an SDK example.
- App: keep Expo/React Native/native HealthKit/SQLCipher compatibility as a tested set. A JS test cannot establish native permission, background or encrypted-store behavior.
- External responses: validate at the adapter, normalize errors once, bound output and avoid nested retries. After an uncertain write, reconcile; an SDK's generic retry is not sufficient.

## 6. Cleanup that advances the MVP

These are candidate work packets, not permission for bulk deletion. Reverify the current source and complete cleanup with its owning slice.

| Priority / owner | Change | Exit evidence |
|---|---|---|
| S0 / CI owner | Make actual verification runnable and observable; consolidate duplicate dependency installation/common SQL setup while preserving transitional migration cases | Exact-SHA run, retained test coverage, artifact links and honest enforcement status |
| S0 / backend integration | Wire real context/spend/permission/output dependencies; separate test fixtures from production composition; align generated closure routes with implemented behavior | Production-target conversation and Calendar-read proof, isolation/recovery tests, no fabricated success |
| S0 / app | Finish account/consent-epoch cache purge and late-callback fencing; verify existing containment PR before duplicating it | Two-owner switch/reconnect tests plus app integration proof |
| Touched runtime slices / backend | Extract coherent responsibilities from the approximately 6,200-line `run-loop/do.ts` only where needed for the current change | Same authoritative writer, unchanged persisted semantics, smaller change surface and passing recovery cases; no rewrite prerequisite |
| S1 / memory | Complete retained-provenance write/read and useful recall; keep correction/deletion invalidation intact | Actual multi-session recall and correction evidence, not a disabled provenance filter |
| Migration owner / app + backend | Inventory callers, deployment/env state and data before retiring legacy app execution functions | Canonical path proven; consumer migration and rollback documented; deployed remnants accounted for |
| Documentation/dependency owner | Keep one entrypoint; retire stale release instructions, expired overrides/exemptions and genuinely unused dependencies | Verified consumers/imports/generators and links; no protected mirror edits, migration deletion or unrelated worktree cleanup |

Freeze later relationship/commerce/general orchestration breadth until its named frontier. Do not delete existing modules merely because they are absent from the MVP UI.

## 7. Premium experience and competitive evidence

Instinct and Meta Muse set an experience target; the [competitor evidence register](COMPETITOR_RESEARCH.md) separates public claims and observations. Full product parity is not promised by an adapter architecture. Recheck sources for a specific capability only when it affects the assigned slice.

| Experience to prove | Waldo acceptance / comparison |
|---|---|
| One easy-to-use personal assistant | First useful task with minimal setup; optional health/connections; continuity and correctable memory using A1–A2/A15–A16 and the plan's §1 UX decisions |
| Initiative that finishes useful work | Day adjustment, exact-approved follow-up and timely return; compare completed commitments, rescue interventions, missed returns and unwanted nudges |
| Natural, fresh personalization | Relevant preference used without a recall prompt; irrelevant/expired context omitted; immediate correction and no invented memory |
| Useful browser reach | Supported research with citations, truthful limitations and usable takeover; report actual site/task coverage rather than “computer use supported” |
| Health plus work delegation | Optional health meaningfully changes the day; K0 delegates one actual task and returns independently checked evidence without losing the personal thread |
| Premium reliability | Clear pending/error/uncertain states, fast useful progress, accessible controls, stop/reconnect, quiet notifications and measured latency/cost on iPhone |

For a parity claim, record product/date/version or observed account configuration, the same consented synthetic scenario, permissions, trials, outcomes, latency/cost and interventions. Use the same rubric and proof level; public marketing or a single demo cannot establish relative reliability. When competitor access is unavailable, mark comparison unverified and evaluate Waldo against the explicit product rubric. No invented personally tested Instinct or Muse story, unsupported exclusivity claim, or competitive feature checklist expands the MVP release cut.
