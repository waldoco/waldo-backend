# Waldo Harness Contributor Onboarding

Status: active onboarding entrypoint for backend contributors.
Date: 2026-07-10.

## What You Are Joining

Waldo backend is building a Cloudflare Durable Object based agent harness. The current proof is
fake-first but durable: scheduler, governor, run journal, ToolDispatcher, hooks, fake LLM routing,
runtime driver hardening, context schema root, local replay/evidence, and governed multi-iteration
runtime looping are merged.

PR #44 merged HEY-143 provider-readiness/fail-closed hardening at `b311d54`. HEY-143 remains In
Progress: no real context/provider/source/sink/staging path has been proved. HEY-13 structured
Scribe/sanitizer runtime is the next backend harness slice.

The canonical deployable app is
[`Pin4sf/waldo-app`](https://github.com/Pin4sf/waldo-app), audited at
`c8b3b4555de076339554391da4dbf5fbe2dac0ae`.
`Pin4sf/Waldo.git/waldo-app` is historical, nondeployable lineage.

## Read This First

1. `README.md`
2. `AGENTS.md`
3. `.claude/rules/INDEX.md` and the six referenced rule files
4. `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
5. `docs/foundation/NEXT-SESSION-PLAN.md`
6. `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
7. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
8. `docs/planning/WALDO_APP_BACKEND_INTEGRATION_PLAN.md` for any app/backend path or cutover work
9. The accepted ADRs and Waldo Brain source files named by the seam you are touching

Authority promotion note: the ADR-0001/0071/0077 amendment set and new ADR-0081/0082 are approved
target decisions in [`waldo-brain` PR #17](https://github.com/Pin4sf/waldo-brain/pull/17), but are
not yet on `waldo-brain/main`. The PR may advance during review; its eventual merge result governs.
Treat it as a merge dependency and retain the target-pending qualifier until it merges.

Use `docs/foundation/archive/` for archaeology only. Archived files may mention old branches,
closed tickets, retired package names, or pre-HEY-142 sequencing.

## Current Build Lanes

| Lane | Next work | Notes |
| --- | --- | --- |
| Runtime safety | HEY-13 structured Scribe/sanitizer runtime | Todo/ready-for-agent and next backend harness slice; single-writer over sanitizer/hook/egress seams. |
| Context | HEY-15 recall, HEY-14 skills, HEY-16 prompt builder | Starts from HEY-10's merged DO SQLite schema root. Full goal hydration waits for HEY-144. |
| Provider | HEY-143 remains In Progress | PR #44 is merged; real context/provider/spend/secret/staging proof remains. |
| Evidence | HEY-111/HEY-142 local evidence is available | Reuse `readRunEvidence`, `replayFixture`, and `scoreRun`; do not create a parallel trace path. |
| Public Brief seam | HEY-151 -> 153 -> 154 -> 132 -> 28/35/47 -> 156 -> 155 | Side-effect-free GET first; generated client only; no legacy fallback. |
| Delivery | HEY-110 async idempotent in-app adapter | Backlog/Phase 5; separate from the Brief GET and required for Alpha. |
| Product surfaces | Home composition, shadow Fetch-off, HEY-158 Spots, HEY-126 text Chat spike | HEY-127 generic Feed is conditional/deferred, not an Alpha prerequisite. |
| App lifecycle | Target-pending Brain ADR-0082 plus HEY-159 | Account/consent-bound device state gates persistent caching, HEY-156, and HEY-56. |

## Detailed Track Build Order

Use this section to assign ownership. Each contributor should take one track, declare owned files,
and avoid editing another track's single-writer surfaces without coordination.

### 0. Foundation / Dev Loop

Status: contract/runtime foundation exists; the canonical data plane does not.

Order:

`HEY-6 -> HEY-7 -> HEY-8 -> HEY-134/114`

Merged evidence:

- `HEY-6` repo/org/branch setup.
- `HEY-7` type/contract foundation.
- `HEY-8` hermetic Worker and Durable Object scaffold only.

Next / parallel:

- `HEY-134` owns the canonical Supabase/RLS/Vault re-land; `HEY-9` is historical unmerged
  evidence, not a baseline capability.
- `HEY-114` owns environment migration/rollback validation.
- `HEY-103 -> HEY-104 -> HEY-105 -> HEY-106 -> HEY-107`.
- Highest leverage: `HEY-107` CI/branch-protection verification wall if still open.

Suggested owner: infra/dev-loop.

### 1. Durable Runtime Spine

Status: local durability spine merged; real asynchronous delivery remains open.

Order:

`HEY-120 -> HEY-121 -> HEY-124`

Merged evidence:

- `HEY-120` durable DeliveryGate/outbox crash proof with an idempotent fake sink.
- `HEY-121` promoted journal/outbox runtime interface.
- `HEY-124` DeliveryGate runtime policy state.

Next / parallel:

- `HEY-100` DO-only conformance guard.
- `HEY-125` ES256 issuer staging spike.
- `HEY-110` asynchronous idempotent in-app delivery interface and adapter proof.

Suggested owner: runtime/infra. Do not reopen the spine unless a later slice exposes a real gap.

### 2. Wake / Governor / Scheduler

Status: core control plane done; support follow-ups remain.

Order:

`HEY-122 -> HEY-123 -> HEY-77 -> HEY-12`

Merged evidence:

- `HEY-122` Loop Governor.
- `HEY-123` scheduler/alarm multiplexer.
- `HEY-77` triage dispatcher single entry.
- `HEY-12` hook registry.

Next / parallel:

- `HEY-137` DeliveryGate test hardening; can start now.
- `HEY-135` fleet watchdog; follows scheduler.
- `HEY-138` user timezone / quiet-hours; after context/user timezone state exists.

Suggested owner: runtime/control-plane.

### 3. Main Runtime Loop

Status: fake-first loop merged; privacy/context/live-path work remains.

Order:

`HEY-78 -> HEY-17 -> HEY-136 -> HEY-139 -> HEY-111 -> HEY-142 -> HEY-143`

Merged evidence:

- `HEY-78` ToolDispatcher + per-trigger ACL.
- `HEY-17` fake-first LLMProvider.
- `HEY-136` fake-first run-loop skeleton.
- `HEY-139` runtime driver hardening.
- `HEY-111` local runtime evidence/replay spine.
- `HEY-142` governed multi-iteration `plan -> act -> observe` loop.
- `HEY-143` provider adapter/configuration hardening merged in PR #44.

Next:

- `HEY-13` structured Scribe/sanitizer runtime.

After:

- Real context/recall/prompt hydration, atomic spend, Secrets Store binding, a bounded provider
  smoke, async delivery, product projections, and standalone eval/live evidence runners.

Suggested owner: safety/context with Codex runtime integration. Keep sanitizer, hooks, run loop,
provider egress, public projection, and delivery files single-writer when HEY-13 touches them.

### 4. Context / Memory / Prompt

Status: active in parallel with auth/public-contract lanes.

Order:

`HEY-10 -> HEY-15 -> HEY-14 -> HEY-16`

Merged evidence:

- `HEY-10` DO SQLite context schema root.

Next:

- `HEY-15` recall-before-act.
- `HEY-11` AuditedDB wrapper alongside.
- `HEY-13` Scribe sanitiser runtime alongside.

After:

- `HEY-14` skill loader.
- `HEY-16` REASONS prompt builder.

Needed / related:

- `HEY-144` before full goal hydration.
- `HEY-134` Supabase schema re-land.
- `HEY-133` ADR-0024 vocabulary sync.
- `HEY-102`, `HEY-75`, `HEY-79`, `HEY-74` as context/safety support.
- Target-pending Brain ADR-0081 before health-derived computation authority or public health
  fields.

Suggested owner: Claude/context plus Codex integration. Hard rule: no raw health in DO SQLite,
prompts, logs, traces, or fixtures.

### 5. Tools / Adapters / Write Gates

Status: after core loop/context for integration, but design and isolated adapter work can start.

Order:

`HEY-129 -> HEY-48 -> HEY-31 -> HEY-30/HEY-98 -> adapters -> write tools`

Adapters:

- `HEY-38` document adapter.
- `HEY-39` email drafts.
- `HEY-64` calendar OAuth.
- `HEY-50` sheets.

Write tools:

- `HEY-40`, `HEY-41`, `HEY-42`, `HEY-51`, `HEY-52`.

External / decision blockers:

- `HEY-130` Google restricted-scope verification; can start early.
- `HEY-99` spend-cap decision; blocks production cap policy.

Suggested owner: adapter/tooling lane. Restricted writes wait for OAuth custody, ACL, autonomy, and
sanitiser gates.

### 6. Delivery / Product Loops

Status: contracts and local policies exist; product verticals are not end to end.

Order:

`HEY-110 async delivery || HEY-151/153/154 Brief seam || HEY-158 Spots || HEY-126 Chat spike`

Channels:

- `HEY-18` Telegram inbound and shared thread identity.
- `HEY-19` APNs.
- `HEY-5` Apple/APNs external setup is done.

Product surfaces:

- Home composes current Brief, Spots, relevant threads, and Patrol/audit. Do not create a persistent
  generic Feed entity.
- `HEY-151` owns the first current morning-Brief public contract.
- `HEY-158` owns backend generation/provenance/idempotency, public projection, evidence, dismissal,
  and two-user/privacy proof.
- `HEY-126` owns the bounded Chat transport/replay spike before the target-pending ADR-0077
  amendment merges; HEY-149 is the integration umbrella.
- `HEY-127` is conditional/deferred. Do not add a generic Feed to the Alpha critical path.
- `HEY-131` Telegram privacy/product residue.

Skills / threading:

- `HEY-20` through `HEY-24`, plus `HEY-44` and `HEY-45`.
- `HEY-25` through `HEY-27`.
- `HEY-32`, `HEY-46`, `HEY-66`, `HEY-67`, `HEY-43`.

Suggested owner: backend product-loop plus app team. Product loops use public projections and the
shared harness, not bespoke app runtime/provider/table paths.

### 7. Eval / Launch Hardening

Status: evidence spine has started; launch proof remains.

Order:

`HEY-111 -> HEY-53 -> HEY-54 -> HEY-55`

Merged evidence:

- `HEY-111` local runtime evidence/replay spine.

Next eval:

- `HEY-53` LLM judge.
- `HEY-54` WIS instrumentation.
- `HEY-55` 30 golden eval cases.

Launch proof:

- `HEY-101` GDPR deletion cascade.
- `HEY-128` privacy artifacts, DPIA, and consent model.
- `HEY-113` through `HEY-118` Supabase hardening.
- `HEY-99` outcome/spend enforcement.

Suggested owner: eval/privacy/infra. Beta gate requires replay, crash/resume, privacy fuzzing, and
mutation evidence.

### 8. App Track

Status: canonical deployable app is `Pin4sf/waldo-app`; live integration is not proved.

HEY-149 is the integration umbrella. Use the exact current live Linear relations, not a false
serial order:

| Node | Live Linear `blockedBy` |
| --- | --- |
| HEY-151 | HEY-150 |
| HEY-152 | HEY-150 |
| HEY-157 | None |
| HEY-159 | None |
| HEY-153 | HEY-114; HEY-125; HEY-134; HEY-152; HEY-157 |
| HEY-154 | HEY-13; HEY-151; HEY-153 |
| HEY-132 live client | HEY-151; HEY-153; HEY-154; HEY-157 |
| HEY-35 | HEY-28; HEY-132; HEY-151; HEY-154 |
| HEY-47 | HEY-28; HEY-132; HEY-151 |
| HEY-156 | HEY-13; HEY-28; HEY-35; HEY-47; HEY-132; HEY-154; HEY-159 |
| HEY-56 | HEY-28; HEY-29; HEY-35; HEY-36; HEY-47; HEY-132; HEY-156; HEY-159 |
| HEY-155 | HEY-132; HEY-156 |

Next:

- HEY-149 integration umbrella and HEY-150 matrix review; both are In Progress.
- HEY-151 strict current morning-Brief schema/OpenAPI.
- HEY-152 whole-path route assignment, cutover, and rollback.
- HEY-153 verified ES256 subject to one owner-bound DO.
- HEY-154 side-effect-free committed projection.
- HEY-132 generated runtime-validating client.

After:

- HEY-28 protected shell and HEY-35/47 honest renderer/degraded states.
- HEY-156 two-user staging parity and whole-path rollback.
- HEY-155 legacy app runtime/direct-path decommission.

Parallel prerequisite:

- Target-pending Brain ADR-0082 plus HEY-159 before persistent caching.
- Target-pending Brain ADR-0081 before health-derived computation becomes authoritative.

Status rule: HEY-150 directly gates only HEY-151 and HEY-152. HEY-157 and HEY-159 run in parallel.
HEY-151-159 otherwise remain Backlog in their documented lanes. Supplying
`docs/planning/WALDO_APP_BACKEND_INTEGRATION_PLAN.md` does not mark HEY-150 Done; acceptance is
still pending. HEY-110 and HEY-158 are separate Alpha gates, HEY-126 is a parallel spike, and
HEY-127 remains off-path conditional/deferred. The adopted dogfood gate follows HEY-156 and
precedes HEY-155 as an acceptance gate, not a Linear `blockedBy` relation.

Suggested owner: app team.

### 9. Deferred / Post-V1

Status: do not assign for V1 unless founder scope changes.

Deferred:

- `HEY-49`, `HEY-37`, `HEY-58`, `HEY-59`.
- `HEY-80` through `HEY-97`.
- `HEY-76`, `HEY-108`, `HEY-60`, `HEY-61`, `HEY-62`.
- Direct Apple Watch/watchOS/WatchConnectivity work, plus Handoff/live actions, voice, soft
  delete/recovery, live intervention, generative cards, full Constellations, and live Fetch.

Suggested owner: none for V1. Keep this lane parked while Phases 1-6 remain open.

## What To Assign Now

1. Backend next slice: `HEY-13` structured Scribe/sanitizer runtime.
2. Context parallel: `HEY-15`, `HEY-11`, then `HEY-14/16`.
3. Delivery parallel: `HEY-110` Backlog/Phase 5 async idempotent in-app adapter.
4. Auth/data parallel: `HEY-125`, `HEY-134`, `HEY-114`, `HEY-141`.
5. Product contract lane: HEY-151/153/154 first Brief seam, HEY-158 Spots, and the HEY-126 bounded
   Chat spike.
6. App lane: HEY-157 and target-pending ADR-0082/HEY-159 run in parallel; HEY-132/28/35/47 follow
   their live blockers above.

## How We Use Skills, Agents, And Coding Rules

Skills and agents are part of the build discipline, not ceremony. Use them to reduce ambiguity,
catch failure modes, and leave evidence that another contributor can inspect.

### Required Source Load

At the start of a non-trivial session:

1. Read `AGENTS.md`.
2. Read `.claude/rules/INDEX.md` and the referenced rule files.
3. Read this onboarding file.
4. Read `docs/foundation/NEXT-SESSION-PLAN.md` and the section of
   `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md` for the touched seam.
5. Read the relevant accepted ADRs and Waldo Brain source pages.
6. Read the specific skill instructions you will use. Do not load the whole skill directory.

### Skill Loop

Use this default sequence for runtime, context, tool, adapter, schema, or safety work:

```text
Open:
  /session-bus when coordinating across sessions
  read rules + onboarding + active plan + relevant ADRs

Shape:
  /current-ideal-gap for small fuzzy work
  /waldo-isa-run-contract for non-trivial work or handoffs
  /thinking-mode-router when the uncertainty type matters

Design:
  /codebase-design for modules, interfaces, seams, adapters, and impact surface
  name owned files and out-of-scope files before editing

Build:
  /tdd for new behavior
  /diagnose for bugs, regressions, or flakes
  /check-contract for DTOs, schemas, tool outputs, adapters, Worker/EF responses, persisted rows

Break:
  /break-feature or qa-breaker for happy/null/hostile/concurrent/degraded paths
  /review-all or /code-review before merge

Close:
  npx -y pnpm@10.34.4 verify
  git diff --check
  /run-eval when evals exist; otherwise record the eval-suite gap
  /compound-learning-capture when a reusable lesson emerged
  /phase-handoff at phase or lane boundaries
```

### Skill Selection

Use these consistently:

| Skill | Use it when |
| --- | --- |
| `/current-ideal-gap` | The work needs a quick current -> ideal -> gaps -> verification pass. |
| `/waldo-isa-run-contract` | Done must be durable: criteria, tests, work slices, evidence, learning. |
| `/thinking-mode-router` | The task needs first-principles, systems, RCA, red-team, research, or council mode. |
| `/codebase-design` | You are changing modules, seams, interfaces, adapters, contracts, or shared vocabulary. |
| `/tdd` | You are adding new runtime, contract, schema, adapter, or safety behavior. |
| `/diagnose` | You are debugging a failure, regression, flake, or confusing behavior. |
| `/check-contract` | You touch `packages/contracts`, persisted rows, DTOs, tool outputs, or adapter boundaries. |
| `/break-feature` | A feature appears done and needs adversarial proof. |
| `/review-all` | The change touches auth, health data, RLS, DO memory, prompts, provider calls, or delivery. |
| `/run-eval` | Eval suite exists or the ticket claims eval/replay/quality evidence. |
| `/compound-learning-capture` | A fix or review produced a reusable lesson. |
| `/phase-handoff` | A phase, lane, or PR series is ending and another builder will continue. |

### How We Use Agents

Use agents to split work only when the ownership boundaries are clear.

Good agent assignments:

- Read-only source reconstruction from ADRs, Waldo Brain, Linear, and local docs.
- Workflow mapping before a new Durable Object, Edge Function, schema, adapter, or channel path.
- Adversarial QA for privacy leaks, retry/resume bugs, duplicate side effects, malformed inputs,
  permission revocation, null health data, and timeout behavior.
- Spec-vs-code review after implementation.
- Fixture or eval-case drafting that does not touch shared runtime files.

Do not use agents this way:

- Do not let multiple agents edit `packages/runtime/src/*` at the same time.
- Do not let multiple agents edit shared contract barrels, schema vocabularies, model roster, trigger
  registry, or policy files at the same time.
- Do not treat subagent output as proof. The main owner must spot-check sources, run tests, review
  diffs, and own the final claim.
- Do not ask an agent to use live credentials, live providers, live channel delivery, or production
  Cloudflare/Supabase state unless the ticket explicitly scopes it and the user approves.

Every agent task should include:

```text
Owner:
Ticket:
Primary sources:
Files owned:
Files explicitly out of scope:
Invariant:
First failing test or review target:
Verification command:
Merge dependency:
```

### How We Manage Codex Sessions

Treat each Codex session as an owned build lane with a bounded contract, not an open-ended chat.

Session rules:

- One Codex session owns one ticket or one clearly named lane.
- The session starts by reading `AGENTS.md`, this onboarding file, the active plan, relevant ADRs,
  and the ticket body/comments.
- The session declares owned files and out-of-scope files before editing.
- Runtime-loop/provider sessions are single-writer. Do not run another Codex session that edits
  `packages/runtime/src/run-loop/*`, sanitizer/hooks, or provider seams when the active slice owns
  those files.
- Parallel Codex sessions are allowed for context, safety, docs, app, eval, and read-only review when
  their write sets do not overlap.
- Each session works on its own branch/worktree and opens a PR or reports why it is blocked.
- Each session posts evidence: changed files, tests run, skipped gates, residual risks, and exact next
  dependency.
- Coordinator reviews claims against source, tests, and diff before merging.

Session lifecycle:

```text
1. Assign one Linear ticket and one lane.
2. Paste the session prompt with primary sources, skills, ownership, and non-goals.
3. Let the session implement or verify inside its own branch/worktree.
4. Ask for a final report with observed evidence, inference, blockers, tests, and PR status.
5. Main coordinator spot-checks the diff and runs/reads verification.
6. Merge only when the PR claim matches the evidence.
7. Update Linear and, if needed, active docs.
```

Good parallel session examples:

- `HEY-13` sanitizer/Scribe/egress lane: one declared writer for shared safety files.
- `HEY-15` recall runtime: separate context session if it avoids runtime-loop files.
- `HEY-110` async delivery: separate runtime session if it avoids HEY-13 files.
- `HEY-137` DeliveryGate tests: separate test-hardening session.
- `HEY-132` app generated client: separate app session.

Bad parallel session examples:

- Two sessions both editing `RunLoopDO`.
- One session changing `packages/contracts/src/index.ts` while another changes public contract exports.
- A channel session wiring live delivery before the fake harness loop is verified.
- A provider session using real credentials before HEY-13, spend, secret, and staging gates.

### Example Codex Session Prompt

Use this shape when assigning a ticket. Replace bracketed fields before sending.

```text
You are starting a focused Waldo backend build session for [HEY-### / ticket title].

Repo:
- /Users/shivanshfulper/Developer/Pin4sf/waldo-backend
- Work from latest main.
- Create/use a branch named codex/[short-ticket-slug].

Goal:
- Complete [specific ticket outcome].
- Keep the claim narrow: [what this proves] and not [what remains out of scope].

Required reading before edits:
1. AGENTS.md
2. .claude/rules/INDEX.md and referenced universal rules
3. docs/foundation/CONTRIBUTOR-ONBOARDING.md
4. docs/foundation/NEXT-SESSION-PLAN.md
5. docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md
6. docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md
7. The Linear ticket body and latest comments for [HEY-###]
8. Relevant accepted ADRs and Waldo Brain source files for this seam
9. Relevant official library docs/cookbooks for any tool or framework touched

Required skills/modes:
- /waldo-isa-run-contract to define current -> ideal -> done
- /codebase-design for the seam and ownership boundary
- /tdd for new behavior or /diagnose for a bug
- /check-contract if contracts, schemas, DTOs, persisted rows, tool outputs, or adapters are touched
- /break-feature before calling the ticket done
- /run-eval if eval/replay quality is claimed; otherwise record the eval-suite gap
- /compound-learning-capture if reusable lessons emerge
- /phase-handoff if the session ends with follow-up work

Ownership:
- Files owned: [exact files/directories]
- Files explicitly out of scope: [exact files/directories]
- Single-writer rule: do not edit shared runtime/contract files outside this list without stopping and reporting.

Constraints:
- Do not make live provider calls.
- Do not use live credentials.
- Do not trigger live channel delivery.
- Do not cause production Cloudflare or Supabase side effects.
- Do not write raw health/private data into docs, logs, traces, fixtures, or Linear.
- Distinguish [observed] facts from [inference].
- Do not claim completion without verification evidence.

Implementation bar:
- Add failing tests first where practical.
- Cover happy, degraded, malformed, denied, retry/resume, timeout, and privacy paths relevant to this ticket.
- Keep changes scoped; no broad refactors.

Verification:
- Run focused tests for touched code.
- Run npx -y pnpm@10.34.4 verify unless the ticket is docs-only.
- Run git diff --check.
- For docs-only work, run git diff --check and npx -y pnpm@10.34.4 verify:guards.

Deliverables:
1. PR or local diff summary.
2. Exact changed files.
3. Tests/commands run and results.
4. Residual risks and follow-up tickets.
5. Linear-ready update comment.
6. If blocked, say exactly what is blocked and what source/evidence proves it.
```

### Coding Rules Contributors Must Follow

- Contract-first: public, persisted, tool, adapter, and DTO shapes belong in `packages/contracts`
  with strict schemas where appropriate.
- Source-backed: accepted ADRs, active foundation docs, and verified code beat stale Linear text or
  archived plans.
- Single writer: coordinate before editing shared runtime, contracts, schema barrels, registries,
  policies, model roster, triggers, or migrations.
- Privacy floor: no raw health, prompts, provider bodies, credentials, cookies, auth headers, or
  channel payload bodies in logs, DO SQLite, R2, traces, fixtures, docs, or Linear.
- Fake-first until scoped otherwise: no live provider calls, live credentials, live channel delivery,
  or production Cloudflare/Supabase side effects by default.
- Durable behavior needs durable evidence: journal, trace, replay, eval, ACL, sanitiser, or state
  evidence must prove the claim.
- Tests must cover degraded paths: malformed model output, denied tools, duplicate triggers,
  crash/resume, budget kill, timeout, null/missing data, and permission revocation where relevant.
- No broad refactors inside feature PRs. Keep changes scoped to the ticket's seam and ownership
  boundary.
- Report skipped gates honestly. Do not mark a ticket complete because the happy path works.

## Working Rules

- Keep raw health, secrets, provider bodies, prompts, and live channel payloads out of logs, DO
  SQLite, R2, traces, fixtures, and docs.
- Do not make live provider calls, use live credentials, trigger live channel delivery, or write to
  production Cloudflare/Supabase unless a ticket explicitly scopes that work and the user approves.
- Prefer contract-first changes in `packages/contracts` and strict Zod schemas for public or
  persisted shapes.
- Use TDD for runtime behavior. Prove happy, denial, malformed, retry/resume, and degraded paths.
- Keep single-writer files single-writer. Coordinate before touching shared runtime, contract,
  policy, trigger, schema barrel, or model roster files.

## Before Opening A PR

Run the commands appropriate to the change:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

For docs-only changes, `git diff --check` plus `npx -y pnpm@10.34.4 verify:guards` is enough.
For harness/runtime changes, include focused runtime or contract tests and evidence/replay checks.

## How To Pick Work

Start from Linear and the active docs, not from archived plans:

- Runtime/safety builder: HEY-13 structured sanitizer/Scribe path is next.
- Context builder: HEY-15, then HEY-14 and HEY-16.
- Delivery builder: HEY-110 async idempotent in-app adapter.
- Infra/provider builder: HEY-125/134/114 and the remaining HEY-143 live-path dependencies.
- Product-loop builder: first Brief seam, HEY-158 Spots vertical, or HEY-126 bounded Chat spike
  according to the ownership map above.

When in doubt, post the current -> ideal -> gap and ask for the lane owner before editing shared
runtime files.
