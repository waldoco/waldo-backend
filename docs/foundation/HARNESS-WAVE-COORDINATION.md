# Harness Wave Coordination Ledger

Status: Wave 0 reconciliation is documented and independently reviewed; the current full wall passes,
but a prior runtime-suite reliability issue remains recorded for human review before merge. Coordinator
Draft coordinator PR #49 is open. No implementation ticket may begin until this reconciliation PR has
human approval and is merged.

Updated: 2026-07-11 IST.
Coordinator: Codex.

## Authority And Safety

- Backend baseline: `82f582b5a28530c1fb7800b7fad889590b35e57d` (PR #47 merge).
- Brain baseline: `75591543053dbdda6cf7c7f0210f8d16f36c3db8` (Brain PR #17 merge).
- This temporary program assigns Codex the listed implementation tickets. It does not amend the
  mirrored universal rules.
- The session bus is HEY-109, Linear issue comments, this ledger, and repo-local phase handoffs.
  The legacy `/session-bus` packaging gap is recorded below and is not part of an implementation
  ticket.
- No live credential, provider, R2, sink, staging, deployment, Supabase, or Cloudflare mutation is
  authorized. Local fake bindings and Miniflare remain the only permitted runtime substrate.
- Logs, traces, metrics, eval artifacts, fixtures, handoffs, and this ledger must not contain raw
  health, private content, credentials, prompts, provider bodies, skill bodies, recall text, or
  full URLs.

## Coordination Decision Record

Mode: Systems thinking plus red-team, with a privacy pass.

Evidence threshold: an accepted ADR or directly verified source, current code or tracker state, and
the applicable command output. A worker report alone is not proof.

Observed facts:

- The original `main` checkout is dirty and behind; it is not used for edits, commits, or branches.
- The coordinator worktree started clean on `codex/hey-109-harness-wave-coordination` at the
  backend baseline and now contains only this coordinator-owned Wave 0 documentation diff.
- The baseline, multiple later, and most recent full verification walls passed: 1,188 contract tests
  and 485 runtime tests, with all typechecks and guards passing. A post-commit full wall between
  passing runs exposed an unchanged runtime test failure; its reproducibility evidence and unresolved
  status are recorded in the HEY-109 ledger entry below.
- Observed local toolchain versions: Node `v26.4.0`, pnpm `10.34.4`, Zod `4.4.3`, Vitest `4.1.9`,
  `@cloudflare/vitest-pool-workers` `0.16.20`, `@cloudflare/workers-types` `4.20260616.1`, Wrangler
  `4.105.0`, fast-check `4.8.0`, and Stryker `9.6.1`. No dependency upgrade is part of Wave 0.
- `git fetch origin main` failed because the local remote credential cannot access GitHub. The cached
  `origin/main` equals the required backend baseline, and GitHub confirms PR #47 merged at that SHA.
  A fresh GitHub connector commit search also returned that SHA as the newest indexed repository
  commit. This corroborates the required baseline, while a fresh branch-ref fetch remains unavailable
  locally.
- The local Brain checkout is dirty and predates Brain PR #17. Canonical Brain reads use the pinned
  merge object, never its working tree.

Decision: use the pinned merge objects for Wave 0 source truth; stop for human approval before any
merge, deployment, cloud mutation, or Wave 1 implementation edit.

Falsifier: a fresh authenticated remote read shows either baseline is not the named merge, or a
required tracker/ADR source contradicts a proposed reconciliation. In that case, revise the ledger
before writing or merging Wave 0 changes.

## Primary-Source Research Decisions

- [observed] Cloudflare Docs, “Durable Objects migrations” (consulted 2026-07-11), states that a
  migration declaration is required when a DO class is created, renamed, deleted, or transferred,
  while changing code/storage interaction for an existing class does not require one.
  HEY-144 therefore must not add `new_sqlite_classes` for its V2 table inside the existing DO class;
  it still owns transactional internal schema versioning and backward compatibility.
- [observed] Cloudflare Docs, “Testing” (consulted 2026-07-11), recommends the Vitest integration
  for local Workers/DO tests, including direct DO access and eviction testing. This supports
  fake-first local verification and does not authorize deployment.
- [observed] OWASP GenAI, “LLM01:2025 Prompt Injection” (consulted 2026-07-11), identifies external
  content as an indirect-injection source. HEY-75 keeps injection scoring within the existing Scribe
  seam, uses authored/provenanced fixtures, and retains content-free evidence.
- [observed] OWASP Cheat Sheet Series, “Server Side Request Forgery Prevention” (consulted
  2026-07-11), supports parsed allowlist validation and warns against redirect bypasses. HEY-141
  therefore uses deterministic declared-path/schema conformance plus literal-address policy, without
  silently expanding into DNS resolution or redirect chasing.

## Dependency And Merge Order

```text
Wave 0 reconciliation PR (human merge)
  -> Wave 1: HEY-144, HEY-14, HEY-15
     merge: HEY-144 -> HEY-14 -> HEY-15 after rebase when FTS remains required
  -> Wave 2: HEY-16, HEY-100 static guard, HEY-75
  -> Wave 3: HEY-141 after HEY-100 unless write sets are proved disjoint
  -> clean-main convergence gate
  -> HEY-143 closure planning only
```

HEY-15 is the lead context slice: its pure Module may begin with the Wave 1 barrier, but it is
read-only at the schema seam until HEY-144 merges. Its default trusted base is committed memory;
the accepted same-day pending leg, if used, must already be Scribe-sanitized and explicitly
provisional. This preserves ADR-0006 rather than treating raw or untrusted inbox rows as recall.

## Work-Item Ledger

### HEY-109 / Wave 0 coordination

- Owner: Codex coordinator.
- Worktree: `/Users/shivanshfulper/.codex/worktrees/hey109-harness-wave-coordination/waldo-backend`.
- Branch: `codex/hey-109-harness-wave-coordination`.
- Baseline SHA: `82f582b5a28530c1fb7800b7fad889590b35e57d`.
- Exact owned files: `CLAUDE.md`, `README.md`, `docs/foundation/AGENT-OPERATING-WORKFLOW.md`,
  `docs/foundation/CONTRIBUTOR-ONBOARDING.md`,
  `docs/foundation/DEFERRED-DO-SCHEMA-COVERAGE.md`,
  `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`,
  `docs/foundation/HARNESS-WAVE-COORDINATION.md`, `docs/foundation/HEY-109-WAVE-0-PHASE-HANDOFF.md`,
  `docs/foundation/HEY-10-DO-SQLITE-SCHEMA.md`,
  `docs/foundation/HEY-13-ISA-RUN-CONTRACT.md`, `docs/foundation/HEY-13-PHASE-HANDOFF.md`,
  `docs/foundation/HEY-143-PHASE-HANDOFF.md`, `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`,
  `docs/foundation/NEXT-SESSION-PLAN.md`, and
  `docs/planning/WALDO_APP_BACKEND_INTEGRATION_PLAN.md`.
- Explicitly forbidden files: `.claude/rules/**`, `.claude/skills/**`, `packages/**`,
  `wrangler.jsonc`, generated binding types, package manifests, `pnpm-lock.yaml`, migrations, and
  every implementation ticket's source or test file.
- Produced interfaces: one current build order, Wave 1 admission bar, ticket ownership ledger, and
  historical promotion annotations.
- Consumed interfaces: accepted ADRs, Brain PR #17, PRs #44/#47, HEY-109, and the named Linear
  tickets.
- Status: documentation and tracker reconciliation complete; the latest full wall passes and
  coordinator draft PR #49 is open. Wave 1 remains blocked on human approval/merge and a recorded
  review disposition for the runtime-suite reliability issue.
- Commits: current coordinator reconciliation commit (`docs: reconcile harness wave coordination`);
  exact SHA is the current branch head and will be recorded in the PR/Linear evidence.
- Verification evidence: baseline, several later, and the most recent `npx -y pnpm@10.34.4 verify`
  walls passed with 1,188 contract tests, 485 runtime tests, workspace typechecks, and every guard;
  `git diff --check` and `verify:guards` passed; no standalone eval suite is claimed. One initial
  full-wall run exposed an unchanged tracer idempotency assertion failure; the isolated target and
  ten tracer-file repetitions passed. A later post-commit full wall failed in the unchanged
  `delivery-gate` runtime test with `scribe:invalid_payload`; a repeated file run passed five times
  and then failed on its sixth attempt. A succeeding later wall does not explain or erase those
  observations. This establishes intermittent behavior, not root cause. No runtime code was changed
  in Wave 0 and the branch must not claim a stable green wall.
- Review status: independent spec/standards, security/privacy/source-discipline, and tracker/GitHub
  reviews passed after their findings were resolved.
- Merge dependency: explicit human approval of the Wave 0 PR.
- Remaining risks: unauthenticated local fetch prevents fresh remote-tip confirmation; the backend
  accepted-ADR snapshot omits newly accepted ADR-0081/0082 and must not be hand-edited; an
  unchanged runtime delivery-gate test is intermittently failing and needs an in-scope diagnosis
  before merge confidence can be restored.
- PR URL: GitHub PR #49 (draft; canonical repository).

### HEY-144 / goals DO schema

- Owner: Codex Wave 1 worker, unassigned until Wave 0 merges.
- Worktree: not created.
- Branch: `codex/hey-144-goals-do-schema`.
- Baseline SHA: current `origin/main` only after the human-approved Wave 0 merge.
- Exact owned files: none; no ownership manifest is accepted yet.
- Explicitly forbidden files: all repository files until a coordinator-approved manifest exists;
  afterward, Supabase migrations, prompt composition, autonomous goal mutation, and new DO-class
  migrations remain forbidden.
- Produced interfaces: ordered V2 internal goals migration, strict `GoalRecord` read Module, and
  idempotent provisioning behavior.
- Consumed interfaces: ADR-0064 `GoalRecord`, current V1 DO schema, and the existing contract.
- Status: gated by Wave 0 merge and Agent-Ready verification.
- Commits: none.
- Verification evidence: none; baseline gate is required before ticket state changes.
- Review status: no worker or review package assigned.
- Merge dependency: Wave 0 merge; then human approval for its PR before any downstream rebase.
- Remaining risks: V1 must remain immutable; DDL and schema version must advance atomically.
- PR URL: none.

### HEY-14 / SkillLoader

- Owner: Codex Wave 1 worker, unassigned until Wave 0 merges.
- Worktree: not created.
- Branch: `codex/hey-14-skill-loader`.
- Baseline SHA: current `origin/main` only after the human-approved Wave 0 merge.
- Exact owned files: none; no ownership manifest is accepted yet.
- Explicitly forbidden files: all repository files until a coordinator-approved manifest exists;
  HEY-16, sanitizer vocabulary, live R2, R2 REST/public buckets, private skill content in telemetry,
  and fabricated exclusions remain forbidden.
- Produced interfaces: `loadForTrigger(ctx)`, typed exclusion evidence, and bounded source-failure
  telemetry.
- Consumed interfaces: ADR-0028 source merge plus four eligibility filters and terminal top-K,
  Scribe skill-body seam, and fake R2 bindings.
- Status: gated by Wave 0 merge and Agent-Ready verification.
- Commits: none.
- Verification evidence: none; baseline gate is required before ticket state changes.
- Review status: no worker or review package assigned.
- Merge dependency: Wave 0 merge; independent of HEY-144 unless it requires a serialized binding
  change.
- Remaining risks: `wrangler.jsonc` and generated binding types become its exclusive write set if
  they change.
- PR URL: none.

### HEY-15 / RecallGateway

- Owner: Codex Wave 1 worker, unassigned until Wave 0 merges.
- Worktree: not created.
- Branch: `codex/hey-15-recall-before-act`.
- Baseline SHA: current `origin/main` only after the human-approved Wave 0 merge.
- Exact owned files: none; no ownership manifest is accepted yet.
- Explicitly forbidden files: all repository files until a coordinator-approved manifest exists;
  `do-schema.ts` and schema-version work until HEY-144 merges, RunLoopDO, prompt composition,
  memory writes, raw health, live providers, channel effects, and sanitizer vocabulary remain
  forbidden.
- Produced interfaces: deterministic fail-open RecallGateway, fenced sanitized recall output, and
  bounded content-free retrieval-failure telemetry.
- Consumed interfaces: ADR-0006 provisional union-read rule, ADR-0031 recall interface/fail-open
  behavior, HEY-144 schema result, and Scribe seam.
- Status: gated by Wave 0 merge and Agent-Ready verification.
- Commits: none.
- Verification evidence: none; baseline gate is required before ticket state changes.
- Review status: no worker or review package assigned.
- Merge dependency: Wave 0 merge; rebase after HEY-144 before any additive FTS migration.
- Remaining risks: FTS may require a next internal DO migration; no Supabase/external migration is in
  scope.
- PR URL: none.

### HEY-16 / REASONS prompt composition

- Owner: Codex Wave 2 worker, unassigned.
- Worktree: not created.
- Branch: assigned only after all Wave 1 interfaces merge.
- Baseline SHA: current `origin/main` after the final Wave 1 human-approved merge.
- Exact owned files: none; no ownership manifest is accepted yet.
- Explicitly forbidden files: all repository files until a coordinator-approved manifest exists;
  duplicate context/recall policy, Scribe bypass, live provider/sink use, and unmerged worker
  interfaces remain forbidden.
- Produced interfaces: REASONS prompt Module and fake-provider/fake-sink integration at the existing
  seams.
- Consumed interfaces: merged HEY-14, HEY-15, and HEY-144 Modules only.
- Status: gated by Wave 1 convergence and Agent-Ready verification.
- Commits: none.
- Verification evidence: none.
- Review status: no worker or review package assigned.
- Merge dependency: all Wave 1 PRs human-approved and merged.
- Remaining risks: a prompt-builder caller is the only production caller of recall and skills.
- PR URL: none.

### HEY-100 / DO-only static guard

- Owner: Codex Wave 2 worker, unassigned.
- Worktree: not created.
- Branch: assigned only after Wave 1 convergence.
- Baseline SHA: current `origin/main` after Wave 1 convergence.
- Exact owned files: none; no ownership manifest is accepted yet.
- Explicitly forbidden files: all repository files until a coordinator-approved manifest exists;
  production JWT minting, `db.forUser()` data-plane implementation, service-role custody changes,
  and claims that a real custody path exists remain forbidden.
- Produced interfaces: fixture-backed static guards against `invoke-agent` reintroduction and
  service-role reachability in Worker/DO paths.
- Consumed interfaces: ADR-0052 and ADR-0066 custody constraints.
- Status: gated by Wave 1 convergence and Agent-Ready verification.
- Commits: none.
- Verification evidence: none.
- Review status: no worker or review package assigned.
- Merge dependency: Wave 1 convergence; linked non-ready HEY-160 remains the only production-custody
  follow-up and must not be absorbed.
- Remaining risks: false assurance if static protection is described as a production data plane.
- PR URL: none.

### HEY-75 / prompt-injection hardening

- Owner: Codex Wave 2 worker, unassigned.
- Worktree: not created.
- Branch: assigned only after its Agent-Ready reconciliation.
- Baseline SHA: current `origin/main` after Wave 1 convergence.
- Exact owned files: none; no ownership manifest is accepted yet.
- Explicitly forbidden files: all repository files until a coordinator-approved manifest exists;
  persisted/logged match snippets, copied GPL or unprovenanced corpora, and unrelated sanitizer
  surfaces remain forbidden.
- Produced interfaces: deterministic prompt-injection scorer with content-free rule/count evidence.
- Consumed interfaces: ADR-0024 check order, primary OWASP source corpus, and the merged HEY-13
  Scribe surface.
- Status: gated by Agent-Ready reconciliation and HEY-13 compatibility review.
- Commits: none.
- Verification evidence: none.
- Review status: no worker or review package assigned.
- Merge dependency: Wave 1 convergence and human approval of its PR.
- Remaining risks: corpus provenance, ReDoS behavior, held-out denominator integrity, and the
  canonical ADR-0024 wording follow-up.
- PR URL: none.

### HEY-141 / egress hardening

- Owner: Codex Wave 3 worker, unassigned.
- Worktree: not created.
- Branch: assigned after HEY-100 merges unless the coordinator proves guard/config write sets are
  disjoint.
- Baseline SHA: current `origin/main` after HEY-100 human-approved merge.
- Exact owned files: none; no ownership manifest is accepted yet.
- Explicitly forbidden files: all repository files until a coordinator-approved manifest exists;
  DNS-rebinding work, redirect chasing, new outbound-fetch adapters, and silent provider behavior
  expansion remain forbidden.
- Produced interfaces: parsed URL conformance guard that covers declared nested URL paths and
  literal-address policy.
- Consumed interfaces: existing SSRF policy, declared URL schema paths, and primary OWASP guidance.
- Status: gated by HEY-100 or an explicit disjoint-write proof.
- Commits: none.
- Verification evidence: none.
- Review status: no worker or review package assigned.
- Merge dependency: HEY-100 merge or documented disjoint-write decision.
- Remaining risks: current nested URL discovery can miss arbitrary fields; literal IPv6 ULA handling
  must not become hostname resolution.
- PR URL: none.

### HEY-143 / closure planning

- Owner: Codex coordinator after convergence; no implementation authority is granted.
- Worktree: fresh clean worktree only after convergence.
- Branch: not assigned.
- Baseline SHA: clean `origin/main` after all required tickets merge.
- Exact owned files: none; planning ownership is not yet admitted.
- Explicitly forbidden files: all live-provider, live-secret, staging, sink, deployment, and cloud
  mutation surfaces.
- Produced interfaces: a closure plan only, covering spend reservation/reconciliation, HEY-99,
  Secrets Store custody, merged context/prompt interfaces, safe provider staging, kill switch,
  fallback, staging sink, replay, and rollback.
- Consumed interfaces: merged HEY-14, HEY-15, HEY-144, HEY-16, HEY-100 static guard, HEY-75, and
  HEY-141; HEY-153, HEY-110, and HEY-156 remain separate Alpha dependencies.
- Status: gated by the clean-main convergence wall.
- Commits: none.
- Verification evidence: none.
- Review status: no plan package assigned.
- Merge dependency: all convergence tickets human-approved and merged.
- Remaining risks: convergence authorizes planning only; any real-provider/staging operation needs a
  separate explicit human go.
- PR URL: none.

## Cross-Session And Source Gaps

- Legacy `session-bus` exists as a stale non-loadable markdown file with obsolete MCP identifiers and
  a duplicated Linear document slug. Repair is deliberately deferred outside these tickets.
- `docs/foundation/accepted-adrs.json` is a generated/read-only snapshot and does not yet contain
  ADR-0081 or ADR-0082. Do not hand-edit it; non-ready HEY-161 owns source-backed generator
  reconciliation before a future scanned code path cites those IDs.
- DeepWiki source pages remain a useful target/source map but can preserve pre-reconciliation views.
  Accepted ADRs, especially ADR-0081's destination matrix, outrank them.

## Wave 0 Tracker And GitHub Reconciliation

- Linear HEY-109 is refreshed as the session-bus fallback; its previous state is preserved in a
  history comment.
- HEY-14, HEY-15, HEY-144, HEY-75, HEY-100, and HEY-141 have a checked 11-item plan and
  `agent:codex`; their `ready-for-agent` labels are intentionally withheld until Wave 0 merges and
  each wave-specific admission gate is true. HEY-16 likewise has `agent:codex` and remains
  non-ready/Backlog until Wave 1 merges.
- HEY-75 is assigned, its stale `blocked:harness-runtime` label and HEY-13 blocker are removed, and
  its corpus/provenance/ReDoS/no-snippet requirements are explicit.
- HEY-16, HEY-75, and HEY-143 no longer list merged HEY-13 as a live blocker. HEY-100 no longer
  lists Done HEY-125; Done HEY-136 no longer lists HEY-15/HEY-16 as live blockers.
- HEY-143 now directly records its required planning-convergence gates; HEY-14/HEY-144 remain
  transitive through HEY-16, while HEY-153/HEY-110/HEY-156 stay separate Alpha dependencies.
- New non-ready HEY-160 owns future production ES256 per-user JWT, `db.forUser()`, RLS isolation,
  refresh/rotation, and service-role-custody proof. It is related to HEY-100/HEY-125 but is not a
  HEY-143 convergence gate.
- New non-ready HEY-161 owns source-backed regeneration of the accepted-ADR snapshot; it does not
  authorize a hand edit or runtime change.
- A post-merge comment on PR #47 corrects the earlier proof summary with the final 1,188/485/235/351
  evidence and explicitly records that no standalone eval-suite pass is claimed.
