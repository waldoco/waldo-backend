# Next-Session Runbook - Phase D Contract Spine

## Verdict

Use Fable 5 in Claude Code dynamic workflows for a phase-gated Phase D run, not
as an autonomous "finish the foundation" mode. It is useful for Waldo because
Phase D has independent research, review, attack, and contract-wave lanes. It is
risky if it is allowed to write runtime code concurrently across shared files or
continue after a failed wave barrier.

Phases A/B/C and Phase D Waves 1-4a are complete on `main` via PR #7. PR #8 adds channel
adapters, tools, hooks, auth minting/consent, and memory-skill lifecycle contracts. The
correct next move is not to replay the CI wall, runtime substrate, scheduled tracer,
routing/LLM contracts, completed UI/provider adapter seams, or the PR #8 contract spine.
The immediate gate is:

```text
make the PR #8 follow-up verification branch reviewable
-> npx -y pnpm@10.34.4 verify
-> git diff --check
-> fresh post-merge branch for runtime run/session/working-memory
```

Codex remains the external adversarial audit lane after a phase or commit.
Ultracode is a Claude Code dynamic workflow mode. Do not describe it as "Codex
Ultracode."

## Sources to Load Before Coding

Read these in order:

1. `.claude/rules/INDEX.md`
2. `docs/foundation/BUILD-PLAN.md`
3. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
4. This file
5. Waldo Brain DeepWiki pages relevant to the selected Phase D wave
6. Accepted ADRs for the selected wave. For the first memory wave, include
   ADR-0046 plus the storage/runtime ADRs it crosses. For runtime reconciliation,
   include ADR-0054, ADR-0065, ADR-0068, ADR-0074, and ADR-0029.

Cloud Claude Code sessions clone only committed repo files. They do not
automatically receive a sibling `waldo-brain` checkout. If the cloud session
cannot read Waldo Brain directly, copy the required DeepWiki/ADR extracts into
committed foundation docs before launching the workflow.

## Verified External Constraints (2026-07-01)

Claude Code dynamic workflows:

- Trigger with the word `ultracode` or `/effort ultracode`.
- Ultracode combines high reasoning effort with automatic workflow
  orchestration. It can spend more time and tokens than a normal session.
- A workflow is a generated script that orchestrates agents. The script runtime
  itself has no filesystem or shell access; the agents it launches do.
- Inspect the generated plan and raw script before approval.
- Once approved, the workflow cannot stop for mid-run user input.
- Subagents inherit the session tool allowlist and can edit files.
- The documented limits are 16 concurrent agents and 1,000 total agents.
- Run a small slice before letting a large workflow continue.
- Agent teams are best used for parallel exploration, review, and design
  comparison. Keep most teams around 3 to 5 agents unless the work is
  mechanically independent.
- Pre-allow only safe commands needed for the phase, such as `rg`, `git diff`,
  `pnpm install`, `pnpm -r typecheck`, `pnpm -r test`, and `pnpm verify`.
  Do not pre-allow deploy, production secret, or live-provider commands.

Claude Code web/cloud:

- Cloud sessions run in fresh Anthropic-managed VMs from committed repository
  state.
- User-level local files are not available unless committed or explicitly
  provided.
- There is no dedicated secrets store yet. Do not put production secrets in the
  cloud environment for this foundation work.
- Package installs done inside one session do not automatically carry to other
  sessions unless encoded in setup.
- Keep setup under about 5 minutes; the VM is Ubuntu and supports Node, pnpm,
  git, rg, tmux, and Docker.
- Expected resource envelope is modest: roughly 4 vCPU, 16 GB RAM, and 30 GB
  disk.
- Use Claude Code worktree isolation for parallel cloud sessions. Base them
  from the pushed branch, not from uncommitted local state.

Cloudflare runtime testing:

- `@cloudflare/vitest-pool-workers` runs Vitest tests inside the Workers
  runtime, backed by Miniflare/workerd.
- Cloudflare's Durable Object testing example uses
  `vitest@^4.1.0` with `@cloudflare/vitest-pool-workers`.
- Workers-runtime tests can access helpers such as `runInDurableObject`,
  `runDurableObjectAlarm`, and `evictDurableObject`.
- Storage is isolated per test file. Design tests accordingly.
- Known limitations exist around coverage, dynamic imports, WebSockets, and
  resource cleanup. Await storage promises and consume response bodies.

## External Harness Signals

These are sanity checks, not authority over Waldo's ADRs.

- Cloudflare Agents SDK uses Workers-native tests with
  `@cloudflare/vitest-pool-workers`, repo-wide checks, affected test runs,
  `wrangler.jsonc`, strict Workers conventions, and a coverage matrix tying
  features to evidence.
- Hermes uses a single CI-parity wrapper (`scripts/run_tests.sh`), manual
  smoke checks (`hermes doctor`, `hermes chat`), cross-platform footgun checks,
  and explicit security protections around shell use, cron prompt injection,
  skill installation, and code execution.
- Pi uses `npm run check` plus `./test.sh` as the PR bar, skips LLM-dependent
  tests without keys, pins direct dependencies, uses a release-age policy, and
  release-smokes packed installs before tagging. Pi also states that its default
  process has no built-in permission sandbox, which is not acceptable for
  Waldo's health-data runtime.
- OpenHands-style benchmark infrastructure separates local Docker workspaces
  from remote scalable workspaces and records structured logs of tool calls,
  messages, errors, and final run status.

Waldo should adopt the discipline, not the shape: one command wall, hermetic
runtime tests, isolated scenario/eval workspaces, structured trace artifacts,
and human/CI gates around agent-generated changes.

## Cloud Session Preflight

Before launching the Fable 5 dynamic workflow:

1. Push the current post-PR7 branch if the cloud session will work from the remote.
2. Commit the mirrored `.claude/rules/` files from Waldo Brain.
3. Confirm the cloud session is on Node 22 and the package manager from
   `package.json`.
4. Run setup:

```bash
corepack enable
corepack prepare pnpm@10.34.4 --activate
pnpm install --frozen-lockfile
```

5. Run the baseline:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

6. Do not provide production Supabase, Cloudflare, Anthropic, OpenAI, or Google
   secrets. This phase should use fakes and hermetic runtime tests.

## Workflow Approval Checklist

Before approving any generated dynamic workflow, reject it if it:

- Skips the local rule index, foundation docs, DeepWiki, or accepted ADRs.
- Plans parallel writes to the same files or tightly coupled modules.
- Replays Phase A/B/C instead of starting the selected Phase D wave.
- Uses live providers, production data, or production secrets.
- Calls external LLMs in default tests.
- Touches unrelated legacy code, stashed work, or old Codex spine branches.
- Bypasses the release-age policy, `tsc`, Vitest, or runtime Workers tests.
- Produces implementation without an adversarial review/attack lane.
- Leaves the cloud session without a committed artifact or clear stop reason.

## Historical Phase A - CI and Conformance Wall

Status: landed. Do not replay unless a regression forces it.

Built:

- Add `pnpm verify` as the single local wall.
- Add `verify.yml` with pinned GitHub Actions SHAs and minimal permissions.
- Keep `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, and
  `pnpm -r test` in the wall.
- Enforce the package release-age gate.
- Add static guards for stale `@waldo/types`, stale model IDs, health/PII leak
  patterns, `--passWithNoTests`, and direct `setAlarm` outside the scheduler
  abstraction.
- Add ADR-status lint against accepted ADR metadata where practical.

Done evidence:

- `pnpm verify` passes.
- At least one intentional violation was proven to fail each new guard.
- The phase ends with a short Codex-review handoff note.

## Historical Phase B - Cloudflare Runtime Test Substrate

Status: landed. Do not replay unless a regression forces it.

Built:

- Add `@cloudflare/vitest-pool-workers`.
- Add `wrangler.jsonc` with Durable Object binding and
  `new_sqlite_classes`.
- Add a minimal test-only Durable Object.
- Add one Workers-runtime test that:
  - obtains a Durable Object stub,
  - writes/reads state in DO SQLite,
  - drives `alarm()` with `runDurableObjectAlarm`,
  - evicts with `evictDurableObject`,
  - proves state survives eviction.

Done evidence:

- The runtime test runs in `@cloudflare/vitest-pool-workers`, not plain Node.
- The test is wired into `pnpm verify`.
- Known Cloudflare pool limitations are documented in the test README or file
  header.

## Historical Phase C - Scheduled Tracer Bullet

Status: landed and post-review hardened. Do not replay unless a regression forces it.

Minimum slice:

- Run-journal FSM from ADR-0054.
- Schedule entry and alarm multiplexer from ADR-0065.
- Loop Governor admission from ADR-0074.
- DeliveryGate current block from ADR-0068.
- Transactional outbox with fake channel sink.
- Only the contracts required for this scheduled path.

Build discipline:

- Use a judge-panel workflow for design synthesis.
- Use a single implementation writer for the runtime slice.
- Use parallel adversarial agents only for review, failure hunting, and test
  design.

Simulation discipline:

- For each committed run-journal state, evict the Durable Object and re-drive
  `alarm()`.
- Assert resume-from-committed.
- Assert outbox delivery fires exactly once.
- Fuzz idempotency keys and trigger variants.
- Include null, hostile, concurrent, and degraded cases.

Done evidence:

- `DO alarm -> Governor -> run journal -> DeliveryGate -> outbox` works in the
  Workers runtime test substrate.
- Crash/resume and exactly-once behavior are tested before broad contract waves.

## Phase D - Contract Spine Waves

Resume runtime-adjacent contract waves only after PR #8 and any follow-up verification branch
are mergeable/merged and the fresh gate passes.

Current wave status:

- Done: Wave 1 memory contracts.
- Done: Wave 2 CRS/prompt contracts.
- Done: Wave 3 routing/LLM contracts with fake-provider seams.
- Done: Wave 4a UI card/notification contracts and provider adapter seams for
  health, calendar, sheet, email, and doc.
- Done in PR #8: channel adapters, tools/ACL/schemas/handler,
  core hooks, auth minting/consent, and memory-skill lifecycle.
- Remaining after the follow-up verification branch lands: runtime run/session/working-memory, scheduler/goal,
  delivery, telemetry, public/OpenAPI, scenario/property/mutation lanes, and live/dogfood lanes.

Remaining wave order:

```text
runtime run/session/working-memory
-> scheduler/goal
-> delivery
-> telemetry
-> public/OpenAPI
-> scenario/property/mutation/live lanes
```

Per wave:

- Authors may work in parallel only on disjoint files.
- Every module names its owning ADR.
- Runtime boundaries use schemas, not type-only helpers.
- Each module gets positive, negative, and mutation-style tests.
- Barrier: `pnpm verify`, ADR drift review, and a focused security/privacy
  review.

Recommended next safe unit after the PR #8 follow-up verification branch lands:

```text
Fresh post-merge PR: runtime run/session/working-memory and scheduler/goal contracts,
with exports, docs, and fresh gates before full delivery or public API expansion.
```

Done criteria:

- exact Zod schemas and exported types for the selected contract seams
- valid and invalid tests that would fail on enum, field, or trust-order drift
- no raw health values, live providers, production data, or public DTO derivation from internals
- source refs named in tests or docs
- `npx -y pnpm@10.34.4 verify` and `git diff --check` green

## Phase E - External Audit

After each major phase, generate a Codex adversarial-review handoff with:

- File list and line references.
- Commands run and exact results.
- Source docs/ADRs used.
- Known test gaps.
- Mutation or intentional-break evidence.
- Any Cloudflare runtime limitations that still affect confidence.

## Ready Prompt for Fable 5 Claude Code

```text
ultracode

Use Fable 5 in Claude Code dynamic workflows after PR #8 and any follow-up verification
branch have merged. Start from updated `main` and create a fresh post-merge branch for
runtime run/session/working-memory and scheduler/goal contracts.

First read:
- .claude/rules/INDEX.md
- docs/foundation/BUILD-PLAN.md
- docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md
- docs/foundation/NEXT-SESSION-PLAN.md
- docs/foundation/CODEX-REVIEW-HANDOFF.md
- required Waldo Brain DeepWiki pages and accepted ADRs for each Phase D wave

Use dynamic workflows for research, review, attack, and independent disjoint
contract modules only. Keep runtime implementation single-writer. Keep one
writer per shared contract surface. Parallelize reading/review/testing lanes,
not tightly coupled writes.

Phases A/B/C and Phase D Waves 1-4a landed in PR #7. PR #8 added channel adapters,
tool ACL/schemas/handler, hooks, auth minting/consent, and memory-skill lifecycle.
Before runtime expansion, update from `main` and run:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

If the current verification branch is conflicting or the baseline gate fails, stop and
report the blocker. Do not continue runtime expansion on an unmergeable or red foundation.

Continue Phase D in this wave order, with a hard verify barrier after every wave:

1. runtime run/session/working-memory contracts, reconciling Phase C's reduced FSM
2. scheduler/goal contracts that consume the trigger, hook, tool, auth, and memory-skill contracts
3. full delivery policy beyond the fetch_alert tracer path
4. telemetry contracts
5. public DTOs, OpenAPI emitter, and generated-client freshness
6. scenario/property/mutation evidence lanes
7. live/dogfood lanes after hermetic defaults are proven

For each wave:
- name the owning ADRs and DeepWiki pages before writing
- use exact Zod schemas and exported types
- add valid and invalid tests that fail on enum, field, ordering, trust, ACL, or budget drift
- keep live providers, production data, production secrets, and raw health values out of default tests
- do not derive public DTOs with .pick()/.omit() from internal schemas
- run `npx -y pnpm@10.34.4 verify` and `git diff --check`
- stop if a wave fails after three focused fix attempts or exposes an ADR conflict

Before running the workflow, show the phase plan and raw script for approval.
Reject your own plan if it writes shared runtime files in parallel, uses live
secrets/providers, skips the ADRs, skips pnpm verify, broadens runtime before
contracts exist, or lacks an adversarial review lane.

After Phase D, report:
- files changed,
- commands run,
- intentional failures that proved the guards/tests,
- OpenAPI/generated-client freshness evidence,
- residual risks,
- exact next phase recommendation.
```

## Next-Session Success Criteria

A strong Fable 5 session should complete Phase D only if each wave clears its
barrier. If a blocker appears, the correct outcome is a precise stop reason, not
partial work dressed up as completion. The highest-value outcome is:

1. PR #8 and any follow-up verification branch are merged or explicitly reported as the blocker.
2. Remaining Phase D/runtime waves land in order with exact valid/invalid tests and source refs.
3. OpenAPI and generated-client freshness are implemented before public/API work is called done.
4. `npx -y pnpm@10.34.4 verify` and `git diff --check` pass after every wave and at the end.
5. Residual target-only gates are named honestly: scenario artifacts, property tests, and mutation
   unless implemented in the Phase D run.
