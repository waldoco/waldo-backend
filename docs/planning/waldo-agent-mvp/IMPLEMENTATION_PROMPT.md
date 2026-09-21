# Implementation assignment: complete the Waldo MVP

Updated 21 September 2026. Copy the block below into the implementation agent's task. The [worker packet](README.md) links all required references. The canonical plan owns the release cut and acceptance thresholds; this prompt coordinates execution rather than redefining them.

```text
You are the implementation lead for the Waldo Agent MVP. Build and verify the complete agreed MVP workflow, progressing through bounded work packages and leaving a working integrated product. Do not stop at another plan, scaffolding, a mocked demo or a collection of independently green modules. Do not attempt every slice simultaneously.

PRODUCT
Waldo is one cloud personal agent that understands the person's goals, commitments, preferences and permitted body context. It helps the person accomplish more while protecting their capacity: decide what should happen, act or delegate to the appropriate executor, check evidence, follow through and update its understanding. Kennel gives Waldo a way to delegate work to the user's existing coding harnesses. It does not replace Waldo's identity or personal judgment.

The MVP must demonstrate:
1. A continuing personal conversation with stable personality and strong correctable memory.
2. Organizing and adapting a real day with calendar, priorities, self-reported energy and optional permitted health context; cloud follow-through works with the laptop off.
3. A real approved email follow-up and response tracking; useful public research through the selected managed browser path.
4. A bounded Kennel work handoff: one explicitly attached test project, one available Codex-first harness, progress/cancel/reconnect, returned diff/artifact and independent verification. This is required for the joined showcase; the personal pilot has its own separate completion criteria.
5. A coherent iPhone experience with truthful state, clear decisions, stop/correct/forget/revoke controls, useful results and optional health sharing. Demonstrate Telegram when included in the promised surface. WhatsApp remains a first-class supported-route workstream, with eligibility checked before claiming support.

PHASES
First complete and verify the agreed MVP. Collect baseline experience, outcome, latency and cost measurements during implementation. After the complete MVP works, perform a separate dated competitor comparison and close the observed quality gaps against Instinct and Meta Muse. Do not defer basic usability, reliability, personality or the existing acceptance thresholds to that second phase. Do not expand the first phase into every competitor feature, a full web dashboard, cross-person agent network or all harnesses.

START HERE
Read current remote refs in fresh isolated checkouts; preserve dirty primary checkouts and user profiles. Read each repository's AGENTS.md and required rules. Use this backend packet:
https://github.com/Pin4sf/waldo-backend/tree/main/docs/planning/waldo-agent-mvp

Read in this order:
1. README.md and WORKER_GUIDE.md: product intent, principles, selected stack, role-specific reading and delivery loop.
2. REPOSITORY_MAP.md: exact repo ownership, source starting points, current-ref traps, producer/consumer contracts and commands.
3. ../WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md: applicable sections, S0–S4/H/B/C/K0 dependency order, A1–A16 criteria and cost model. This is the sole execution build plan.
4. IMPLEMENTATION_CONTRACTS.md: authoritative writer/store responsibilities, durable publication, identity, approval, effects and recovery.
5. ENGINEERING_QUALITY.md: testing/CI, behavioral evaluations, dependency lifecycle, bounded improvement and cleanup.
6. FIRST_WORKER_ASSIGNMENT.md, current source/tests and the owning issue/ledger. Inspect previous PRs and handoffs before repeating completed work.
7. ADR_RECONCILIATION.md for affected accepted seams; ECOSYSTEM_STRATEGY.md for rationale; COMPETITOR_RESEARCH.md, RUNTIME_BROWSER_RESEARCH.md and KENNEL_K0_SOURCE_MAP.md only where relevant.

Backend coordination: https://github.com/Pin4sf/waldo-backend/issues/116
Repository entrypoint: docs/foundation/NEXT-SESSION-PLAN.md
Check current merge/status evidence; old pins, audit findings and copied milestones are historical observations. Reconcile the specific accepted ADRs/snapshots before changing a contradictory seam. The product direction is already decided; do not reopen it as a broad strategy exercise. A merged planning PR does not mean every ADR amendment or runtime behavior is complete.

REPOSITORY RESPONSIBILITIES
- waldo-backend: main cloud agent in packages/runtime; shared public contracts in packages/contracts; protected database/RLS/Vault and migrations in supabase. Own durable tasks, memory, context, schedules, permissions, action intent, evidence and delivery sequencing.
- waldo-app: existing Expo/React Native iPhone experience, generated client integration, account/consent lifecycle, HealthKit, secure device storage, approval/result UI, push and reconnect. Legacy embedded/server functions are migration references, not another canonical agent runtime.
- Waldo-Kennel: local project/workspace custody, native harness auth/lifecycle, approved execution and artifacts. Keep cloud-to-desktop communication scoped and authenticated; no public local daemon or credential copying.
- waldo-brain: canonical product decisions, protected ADRs and rules. Follow its own workflow; never edit backend rule mirrors to bypass an accepted decision.

ENGINEERING RULES
Reuse the selected Cloudflare/Supabase/Expo substrate, current typed model gateway, direct Google adapters and hosted Browserbase/Stagehand interface. Do not add a second durable orchestrator, memory database, generic connector marketplace or new coding-agent loop without a demonstrated gap and bounded decision. Use existing lockfiles; research installed-version documentation and source before coding an API assumption. A library's popularity is not a compatibility test.

Preserve one owner authority root and one writer for each aggregate. Explicit corrections outrank inferred memory. Memory never grants permission. Routine reversible actions may use bounded standing permissions; sends, bookings and purchases require exact approval by default. Freeze approved intent before external I/O. After an uncertain effect, reconcile before retrying. Preserve identity, operation IDs and frozen results through crashes, retries, cancellation and compaction.

Health remains central to the product and optional to share. Preserve freshness, source, consent epoch and destination restrictions. Declined/missing/stale data must leave a useful assistant without invented readiness. Keep raw sensitive values and credentials out of model context, logs, notifications and evaluation artifacts as required by the contracts.

Use relevant minimal context and narrow typed tools with explicit errors. Separate deterministic validation from model judgment. Preserve completed effects and pending approvals in durable state, not only summaries. Do not treat provider completion, a commit or a test run as user acceptance or closure of the human outcome.

WORK ORDER
Begin by reporting the current implemented state, exact refs, next missing dependency and proposed bounded file ownership. Then act on that frontier:
- S0: truthful app behavior/account isolation and real app → authenticated owner → model → read-only Calendar → durable answer, with stop/reconnect and production context/spend/permission/delivery wiring. Verify existing app containment before duplicating it.
- S1: consistent conversation/personality, correctable and usable memory, durable commitments, publication recovery and generated client integration.
- S2 + H: real day planning/Calendar effects, health-aware adaptation, cloud schedules, quiet follow-through and physical-device health/push proof.
- S3 + B: exact-approved email follow-up/response tracking and bounded public browser research.
- K0: separate Kennel readiness spike and one real joined work task after its shared contracts exist.
- C when advertised; S4: integrate the full personal release and repeat its acceptance/utility/cost tests. Report joined-showcase readiness separately.
Defer W/full K/R and unsupported breadth to their named future slices.

One integration owner controls shared schemas, migrations and generated outputs. Release exact contracts/fixtures before parallel consumer work. Assign independent agents only bounded, nonoverlapping files or read-only reviews. Register work and handoffs in the existing issue/ledger; do not create a competing task authority or flood the tracker with speculative work.

VERIFICATION AND AUTOMATION
For each slice: reproduce the gap → implement → relevant tests → behavioral evaluation → independent adversarial review → required repo wall → actual integration evidence. Check happy, missing-data, hostile-input, concurrent, revoked, disconnected, restart and ambiguous-effect paths as applicable. Fix causes at the owning layer. Never silence failures, loosen thresholds or retry until green.

Establish a real CI run and the small executable behavior suite alongside S0; do not assume YAML or a run-eval fallback proves either. Use current repo commands from REPOSITORY_MAP.md. Test Workers semantics in the Workers runtime; Supabase isolation/migrations against an appropriate isolated database; HealthKit/push/account switching on a physical iPhone; Kennel through an actual available harness. Respect the current repo's merge gates and environment authorization.

Map scenarios to the canonical A1–A16 checks, preserving their case counts, repeats and thresholds. Keep synthetic development cases separate from protected held-out cases. Assert actual effects and persisted state in code; calibrate model/human graders for judgment and tone. Track all attempts, abstention, failures, interventions, repeated success, p50/p95 latency and complete cost. A mocked connector cannot prove live action completion.

Automated improvement produces bounded candidate patches and reviewed PRs. Keep protected graders/holdouts out of the optimizing worker's control; bound attempts/time/spend, stop after repeated failure and diagnose. No production self-rewriting, automatic authority expansion or unreviewed dependency upgrades. Scheduled automation should be enabled only after its manual run and permissions are proven.

DELIVERY
Maintain small reviewable commits/PRs and a compatible cross-repository ref set. For every handoff record outcome, owner, base/head and config pins, files/contracts, exact commands, passed/failed/blocked/not-run results, evidence references, remaining risks, rollback and next frontier. Do not merge/deploy or make consequential external actions without the authorization applicable to that task.

MVP completion means the integrated personal criteria pass, the required device/provider/recovery and observation evidence exists, and K0 passes for the joined showcase. Report incomplete/blocked gates honestly; do not relabel a smaller pilot as the full MVP. No fixed launch date, budget or exact cohort has been agreed; revise estimates from measured work and per-user costs.

After that milestone, run the same consented synthetic tasks on dated Instinct/Meta Muse configurations where access permits. Separate advertised claims, observed behavior and unavailable comparisons. Compare completion, initiative, fresh memory, unnecessary interruptions, ease of use, recovery, latency and cost. Prioritize demonstrated gaps without rebuilding the architecture or abandoning Waldo's health-plus-work thesis.

Start with the current-source assessment and first actionable slice, then continue implementing. Ask only for missing information or decisions that genuinely block safe progress; keep independent work moving.
```
