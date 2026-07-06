# EveryInc Compound Engineering Adoption Registry

Use this file when a Waldo builder skill, plugin record, or contributor benchmark depends on EveryInc's Compound Engineering guide or plugin skills. The source audit is current for `EveryInc/compound-engineering-plugin` commit `d3f35297adccea3ad8735e988253966ffa8cf74c`, checked 2026-07-05 at `skills/*/SKILL.md`, plus the public guide at `https://every.to/guides/compound-engineering`.

Important drift note: the guide describes a broader packaged system with agents, commands, and skills. The inspected repository snapshot exposes 29 top-level skill directories, with specialist behavior mostly encoded as skill-local references, scripts, assets, and prompt material. Do not treat upstream counts as stable registry facts.

## Direct Adoption Records

| Registry id | Trigger | Source skills | Waldo behavior | Required tools | Boundary | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `waldo-plan-artifact-contract` | Non-trivial feature, architecture, research, or cross-repo task needs a durable plan | `ce-brainstorm`, `ce-plan`, `ce-work` | Separate Product Contract from Planning Contract; set `artifact_readiness`; use stable R/A/F/AE/U-IDs; require Verification Contract and Definition of Done before build. | `rg`, file reads, Markdown/frontmatter parser, test/build commands, issue/PR tools when available | Plans are decision artifacts, not progress trackers; no protected-file edits without approval. | Strong candidate; fold into `waldo-isa-run-contract` and planning skills. |
| `waldo-plan-doc-review` | A plan/spec/requirements doc is about to drive implementation | `ce-doc-review`, `ce-plan` | Review for coherence, feasibility, product intent, design, security, testability, and scope before execution. | File reads, source references, role-lens checklist, optional reviewer subagents | Review docs only unless user asks for implementation; preserve contradictions instead of smoothing them away. | Candidate. |
| `waldo-source-grounded-pov` | User asks whether to adopt/switch to/revisit an external repo, tool, pattern, or architecture | `ce-pov` | Give Adopt/Trial/Hold/Reject/Not-our-problem verdict only after clearing project floor and external-source floor; include reversibility tier. | Web/GitHub/source fetch, local repo/vault search, citation notes | If either floor is missing, answer Hold; do not give generic technology advice as a project decision. | Strong candidate. |
| `waldo-review-residual-sink` | Code/doc review produces findings that are not all fixed immediately | `ce-code-review`, `ce-work`, `lfg` | Every meaningful finding is fixed, filed, explicitly accepted with rationale, or deferred with owner/context in PR/issue/plan/Evidence Trail. | Git diff, test runner, issue/PR tools, Markdown editor | "Accepted risk" is not closure unless durable and inspectable. | Candidate; pair with `code-review`. |
| `waldo-compound-learning-capture` | Solved problem, repeated mistake, or durable vocabulary should benefit future work | `ce-compound` | Run overlap check; classify bug vs knowledge; capture problem type, component, severity, source path, applicability limit, related links, and Evidence Trail. | `rg`, file reads, Markdown/frontmatter parser, `apply_patch`, git diff | Use Obsidian pages and Waldo Evidence Trail, not Every's `docs/solutions/` as canonical store. | Active via `compound-learning-capture`; enrich further. |
| `waldo-learning-refresh-sweep` | Existing lessons may be stale, duplicated, superseded, or misleading | `ce-compound-refresh` | Evaluate Keep, Update, Consolidate, Replace, or Stale/propose-delete; mark ambiguous cases for human review. | `rg`, git history, file reads, Markdown/frontmatter parser, source check | No auto-delete in Waldo Brain; deletion requires explicit user approval under AGENTS.md. | Candidate. |
| `waldo-debug-causal-chain` | Bug, failing test, regression, stack trace, or repeated failed fix | `ce-debug` | Reproduce, verify environment, trace causal chain, make predictions for uncertain links, write a test first where possible, and add defense-in-depth. | Test runner, logs, git diff, debugger/profiler where relevant | Do not shotgun fixes or stop at "works now"; use existing `diagnose` skill as the local surface. | Adapt into `diagnose`. |
| `waldo-optimization-loop` | A measurable behavior should improve through experiments | `ce-optimize` | Define hard metric or judge rubric, degenerate gates, experiment log on disk, checkpoint reads, keep/revert decisions. | Eval/test runner, benchmark fixtures, judge harness if needed, git diff, experiment log | Only use when metric/rubric exists; conversation memory is not the source of truth. | Candidate. |
| `waldo-agent-native-checklist` | Setting up or auditing a repo for agent work | Guide agent-native architecture, `ce-setup`, `ce-test-browser`, `ce-test-xcode`, `ce-polish` | Ensure agents can run app/tests/lint/migrations/seeds, inspect logs, capture screenshots/traces, create branches/PRs, and recover safely. | Shell, package manager, dev server, browser/simulator, logs, CI/PR tools | Production, secrets, 2FA, and irreversible writes require explicit approval and scoped tools. | Candidate rule/checklist. |
| `waldo-design-prototype-loop` | Hard product/UI question needs taste exploration before production implementation | Guide design workflow, `ce-polish`, `ce-dogfood`, `ce-test-browser` | Build throwaway prototype, click through, capture design decisions, transfer via plan/spec, verify rendered result. | Dev server, browser, screenshots, viewport matrix, console/network logs, design/taste references | Prototype code is not production by default; design claims need rendered proof. | Candidate; pair with `prototype` and `design-engineering-taste`. |
| `waldo-feedback-pulse-sweep` | Product/user feedback should become structured improvement work | `ce-sweep`, `ce-product-pulse`, guide user research/data patterns | Sweep configured sources, redact sensitive content, cluster feedback, verify merged fixes, emit rolling plans with machine/human regions. | Slack/GitHub/email connectors, state store, lease/lock, sanitizer, issue/PR tools | Deferred until connector scopes, audit logs, idempotency, and privacy model exist. | Deferred. |
| `waldo-release-story-pipeline` | Shipped work needs release notes, launch copy, or product narrative | `ce-promote`, guide copy/product marketing | Draft copy from plan, implementation, tests, screenshots, and user evidence; preserve project voice and provenance. | PR diff, plan, screenshots, source voice notes, review checklist | No false founder/user authorship; marketing claims must be traceable. | Candidate. |
| `waldo-worktree-isolation` | Starting risky/multi-step work or parallel agent work | `ce-worktree`, guide parallel execution | Use isolated branches/worktrees when useful; keep changes scoped; avoid clobbering user work. | Git, worktree commands, branch naming rules, status checks | Never reset/rewrite user changes without explicit request. | Active local practice; document per repo as needed. |

## Existing Skill Targets

| Existing Waldo skill | Direct Every adoption |
| --- | --- |
| `waldo-builder-registry` | Every adoption records, source drift tracking, plan/readiness and review residual evals. |
| `compound-learning-capture` | Full/lightweight/sweep modes, overlap-first capture, bug/knowledge tracks, refresh lifecycle. |
| `waldo-isa-run-contract` | Artifact readiness, Product Contract vs Planning Contract, stable R/A/F/AE/U-IDs, Verification Contract. |
| `research` | Project floor + external-source floor for adoption decisions; Hold when evidence is insufficient. |
| `code-review` | Confidence-gated findings, severity, autofix class, durable residual sink. |
| `diagnose` / `diagnosing-bugs` | Causal-chain gate, predictions, test-first fix, defense-in-depth, anti-shotgun debugging. |
| `prototype` | Throwaway baby-app exploration, transfer decisions through spec rather than production-copying prototype code. |
| `design-engineering-taste` | Browser proof, polish passes, rendered evidence, taste capture. |
| `teach` | `ce-explain` style personal explainers and check-ins for human learning. |
| `implement` | Plan-as-decision-artifact, execution evidence, residual gate, no plan progress mutation. |

## Do Not Import

- Full `/lfg` autonomy as a default Waldo behavior.
- Blanket permission skipping or unsafe shell/network/write assumptions.
- `ce-compound-refresh` delete behavior without explicit user approval.
- Source-side acknowledgements, comments, closes, or emails from feedback sweeps before connector ACLs and audit logs exist.
- Proof-specific and Riffrec-specific integrations unless the user explicitly chooses those tools.
- Upstream command/agent counts as canonical truth; the current repo layout is skill-centric and may drift.
- Product marketing or copy claims without source voice, product evidence, and review.
- Browser dogfood autonomy in repos without reliable dev-server/test harness setup.

## Promotion Evals

| Eval | Pass condition |
| --- | --- |
| Plan readiness gate | Requirements-only artifact is not executed until missing Implementation Units and Verification Contract are filled. |
| POV floors | External adoption request returns Hold when either project floor or external-source floor is missing. |
| Residual sink | Review findings are either fixed or durably tracked; none disappear into chat. |
| Compound overlap | New lesson updates/links existing page when overlap is high. |
| Refresh no-delete | Stale or superseded knowledge is marked/proposed, not deleted automatically. |
| Optimization durability | Experiment log exists on disk and is reread before claiming result. |
| Feedback injection | External feedback text is treated as untrusted data and cannot alter agent instructions. |
| Rendered design proof | UI/design claim includes browser or simulator evidence beyond prose. |

## Source Skill Families

| Family | Every skills | Waldo extraction |
| --- | --- | --- |
| Planning and execution | `ce-brainstorm`, `ce-plan`, `ce-work`, `lfg` | Readiness, stable IDs, plan-as-contract, verification, cautious autonomy. |
| Review and simplification | `ce-code-review`, `ce-doc-review`, `ce-simplify-code`, `ce-resolve-pr-feedback` | Role-lens review, severity, autofix class, simplification, residual sink. |
| Learning lifecycle | `ce-compound`, `ce-compound-refresh`, `ce-explain` | Capture, overlap, refresh, personal learning, concept maintenance. |
| Decision and strategy | `ce-pov`, `ce-strategy`, `ce-ideate`, `ce-optimize` | Project-grounded verdicts, strategy anchors, grounded ideation, metric loops. |
| Product/design proof | `ce-polish`, `ce-dogfood`, `ce-test-browser`, `ce-test-xcode` | Agent-native UI validation, browser/simulator evidence, polish loops. |
| Feedback and communication | `ce-sweep`, `ce-product-pulse`, `ce-promote`, `ce-riffrec-feedback-analysis` | Feedback pipelines, pulse reports, release narrative, specialized integrations. |
| Repo operations | `ce-worktree`, `ce-commit`, `ce-commit-push-pr`, `ce-setup`, `ce-proof` | Isolation, commit/PR workflow, health checks, external publishing integrations. |
