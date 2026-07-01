# Next-Session Runbook - Claude Code Ultracode Foundation Build

## Verdict

Use Claude Code Ultracode for a phase-gated dynamic workflow, not as an
autonomous "finish the foundation" mode. It is useful for Waldo because the next
work has independent research, review, attack, and contract-wave lanes. It is
risky if it is allowed to write runtime code concurrently across shared files.

The correct next move remains tracer-first:

```text
CI wall
-> @cloudflare/vitest-pool-workers substrate
-> minimal scheduled-path contracts
-> Durable Object alarm tracer
-> crash/resume exactly-once proof
-> contract waves
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
5. Waldo Brain DeepWiki pages for scheduler, conformance build, run journal,
   delivery, and harness tests
6. Accepted ADRs: ADR-0054, ADR-0065, ADR-0068, ADR-0069, ADR-0074, ADR-0029,
   ADR-0032, ADR-0015, ADR-0042

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

Before launching Ultracode:

1. Push `greenfield/harness-foundation` if the cloud session will work from the
   remote.
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
pnpm -r typecheck
pnpm -r test
git diff --check
```

6. Do not provide production Supabase, Cloudflare, Anthropic, OpenAI, or Google
   secrets. This phase should use fakes and hermetic runtime tests.

## Workflow Approval Checklist

Before approving any generated Ultracode workflow, reject it if it:

- Skips the local rule index, foundation docs, DeepWiki, or accepted ADRs.
- Plans parallel writes to the same files or tightly coupled modules.
- Starts the full contract spine before the CI wall and runtime substrate.
- Uses live providers, production data, or production secrets.
- Calls external LLMs in default tests.
- Touches unrelated legacy code, stashed work, or old Codex spine branches.
- Bypasses the release-age policy, `tsc`, Vitest, or runtime Workers tests.
- Produces implementation without an adversarial review/attack lane.
- Leaves the cloud session without a committed artifact or clear stop reason.

## Phase A - CI and Conformance Wall

Goal: make quality deterministic before runtime work grows.

Build:

- Add `pnpm verify` as the single local wall.
- Add `verify.yml` with pinned GitHub Actions SHAs and minimal permissions.
- Keep `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, and
  `pnpm -r test` in the wall.
- Enforce the package release-age gate.
- Add static guards for stale `@waldo/types`, stale model IDs, health/PII leak
  patterns, `--passWithNoTests`, and direct `setAlarm` outside the scheduler
  abstraction.
- Add ADR-status lint against accepted ADR metadata where practical.

Attack:

- Use parallel reviewer agents to try to sneak each forbidden pattern past the
  wall.
- A bypass means the guard is weak. Fix the guard before moving on.

Done:

- `pnpm verify` passes.
- At least one intentional violation was proven to fail each new guard.
- The phase ends with a short Codex-review handoff note.

## Phase B - Cloudflare Runtime Test Substrate

Goal: prove the local loop can run code in the real Workers/Durable Object
runtime before the harness runtime grows.

Build:

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

Done:

- The runtime test runs in `@cloudflare/vitest-pool-workers`, not plain Node.
- The test is wired into `pnpm verify`.
- Known Cloudflare pool limitations are documented in the test README or file
  header.

## Phase C - Scheduled Tracer Bullet

Goal: prove the durable execution pattern before building 30 more contracts.

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

Done:

- `DO alarm -> Governor -> run journal -> DeliveryGate -> outbox` works in the
  Workers runtime test substrate.
- Crash/resume and exactly-once behavior are tested before broad contract waves.

## Phase D - Contract Spine Waves

Resume contract waves only after Phase C is green.

Suggested wave order:

```text
memory
-> crs/prompt
-> routing/llm
-> ui/adapters
-> tools/hooks
-> runtime
-> delivery
-> telemetry
-> public/OpenAPI
```

Per wave:

- Authors may work in parallel only on disjoint files.
- Every module names its owning ADR.
- Runtime boundaries use schemas, not type-only helpers.
- Each module gets positive, negative, and mutation-style tests.
- Barrier: `pnpm verify`, ADR drift review, and a focused security/privacy
  review.

## Phase E - External Audit

After each major phase, generate a Codex adversarial-review handoff with:

- File list and line references.
- Commands run and exact results.
- Source docs/ADRs used.
- Known test gaps.
- Mutation or intentional-break evidence.
- Any Cloudflare runtime limitations that still affect confidence.

## Ready Prompt for Claude Code

```text
ultracode

Build the next Waldo backend foundation phase on branch
greenfield/harness-foundation.

First read:
- .claude/rules/INDEX.md
- docs/foundation/BUILD-PLAN.md
- docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md
- docs/foundation/NEXT-SESSION-PLAN.md
- required Waldo Brain DeepWiki pages and accepted ADRs listed in the runbook

Use dynamic workflows for research, review, attack, and independent disjoint
work only. Keep runtime implementation single-writer. One phase per workflow.
Start with Phase A. Do not start the full contract spine until the CI wall,
Cloudflare runtime substrate, and scheduled tracer bullet are green.

Before running the workflow, show the phase plan and raw script for approval.
Reject your own plan if it writes shared runtime files in parallel, uses live
secrets/providers, skips the ADRs, skips pnpm verify, or lacks an adversarial
review lane.

After the phase, report:
- files changed,
- commands run,
- intentional failures that proved the guards/tests,
- residual risks,
- exact next phase recommendation.
```

## Next-Session Success Criteria

A strong next session does not need to finish the whole foundation. It should
finish a phase with evidence. The highest-value outcome is:

1. CI/conformance wall committed and proven with intentional failures.
2. Workers/Durable Object runtime test substrate committed.
3. At least one DO alarm + SQLite + eviction test passing under
   `@cloudflare/vitest-pool-workers`.

If time remains, start the scheduled tracer bullet. Do not trade away the
runtime substrate to generate more contracts.
