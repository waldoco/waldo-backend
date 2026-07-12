# Harness Wave Coordination Ledger

Status: Wave 0 reconciliation merged in PR #49 (`a257a175`). The current verified
`origin/main` tip is `aff9b5188feb8ee2ae61b3a3f6f7bb00d6355d65`: PR #50 (HEY-100),
PR #52 (HEY-144), PR #51 and corrective PR #53 (HEY-75), PR #54 (HEY-141), PR #56
(HEY-163), PR #55 (ledger refresh), and PR #58 (HEY-166) are merged. HEY-163 and
HEY-166 are Done; HEY-167 is the remaining canonical-decision gate for HEY-14.

Updated: 2026-07-12 IST.
Coordinator: Codex.

## Authority And Safety

- Backend baseline: `82f582b5a28530c1fb7800b7fad889590b35e57d` (PR #47 merge).
- Current verified backend merge tip: `aff9b5188feb8ee2ae61b3a3f6f7bb00d6355d65`
  after PR #49 -> #50 -> #52 -> #51 -> #53 -> #54 -> #56 -> #55 -> #58.
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

- PR #49 merged the Wave 0 reconciliation at `a257a175`; the subsequent first-parent history is
  PR #50 at `7d02b173`, PR #52 at `4e1cac30`, and PR #51 at `2fd798f8`.
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
- [historical] During Wave 0, `git fetch origin main` failed and the coordinator used the pinned
  baseline plus GitHub evidence. A later authenticated fetch confirmed then-current `origin/main` at
  `2fd798f818213b344e700d98def006e80e0d56ae`.
- The local Brain checkout is dirty and predates Brain PR #17. Canonical Brain reads use the pinned
  merge object, never its working tree.

Decision: retain the pinned merge objects as Wave 0 source truth. The Wave 0 merge barrier and the
HEY-163/HEY-166 engineering prerequisites are complete: PR #56 supplies the typed WorkspaceMount
seam and PR #58 records the proposed reader-admission policy. That proposal is not a canonical
reader-Scribe/token-counter decision; HEY-167 must be human-approved in waldo-brain before HEY-14
begins. Deployment, cloud mutation, and any implementation edit still require their own applicable
admission and verification.

Falsifier: a fresh authenticated remote read shows either baseline is not the named merge, or a
required tracker/ADR source contradicts a proposed reconciliation. In that case, revise the ledger
before using it to admit subsequent work.

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
Merged history:
PR #49 -> PR #50 -> PR #52 -> PR #51 -> PR #53 -> PR #54 -> PR #56 -> PR #55 -> PR #58

Remaining critical path:
HEY-167 canonical reader-Scribe/token-counter ADR ratification
  -> HEY-14 fresh Agent-Ready admission and implementation
  -> HEY-15 under its serialized rebase discipline
  -> HEY-16 after the remaining context interfaces converge
     (complete goal hydration additionally awaits HEY-162)
  -> clean-main convergence gate -> HEY-143 closure planning only
```

HEY-15 is the lead recall context slice and is directly blocked by HEY-14; it is indirectly gated by
HEY-167 through HEY-14. Once admitted, HEY-15 remains read-only at the schema seam until its own
approved additive migration work. Its default trusted base is committed memory; the accepted
same-day pending leg, if used, must already be Scribe-sanitized and explicitly provisional. This
preserves ADR-0006 rather than treating raw or untrusted inbox rows as recall.

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
- Status: merged in PR #49 at `a257a175d0361df5c129d73144f95ff245cb63d1`. Historical
  Wave 0 reliability observations remain recorded below; they are not a claim that current runtime
  behavior was diagnosed or changed by this documentation PR.
- Commits: PR #49 merge `a257a175d0361df5c129d73144f95ff245cb63d1`.
- Verification evidence: baseline, several later, and the most recent `npx -y pnpm@10.34.4 verify`
  walls passed with 1,188 contract tests, 485 runtime tests, workspace typechecks, and every guard;
  `git diff --check` and `verify:guards` passed; no standalone eval suite is claimed. One initial
  full-wall run exposed an unchanged tracer idempotency assertion failure; the isolated target and
  ten tracer-file repetitions passed. A later post-commit full wall failed in the unchanged
  `delivery-gate` runtime test with `scribe:invalid_payload`; a repeated file run passed five times
  and then failed on its sixth attempt. A succeeding later wall does not explain or erase those
  observations. This establishes intermittent behavior, not root cause. No runtime code was changed
  in Wave 0 and the branch must not claim a stable green wall.
- Current 2026-07-12 diagnostic evidence is recorded in HEY-165: a generated UUID can be
  credit-card-redacted by Scribe on persisted-candidate revalidation, yielding
  `scribe:invalid_payload`. Later passing walls do not establish a fix or erase the recorded
  intermittent failures; no runtime fix is bundled here.
- Review status: independent spec/standards, security/privacy/source-discipline, and tracker/GitHub
  reviews passed after their findings were resolved.
- Merge dependency: none for the merged Wave 0 documentation.
- Remaining risks: the backend accepted-ADR snapshot omits newly accepted ADR-0081/0082 and must
  not be hand-edited; HEY-165 owns the diagnosed UUID/Scribe revalidation failure and its
  regression-first repair before stable-green confidence can be restored.
- PR URL: GitHub PR #49 (merged; canonical repository).

### HEY-144 / goals DO schema

- Current execution state: merged in PR #52 at `4e1cac308e935da2b4e514afbe8fe56b94003655`.
  This is a storage foundation only; it does not claim a durable writer, admission path, or prompt
  hydration.
- Owner: merged PR #52; a subsequent slice needs a new, explicit owner.
- Worktree: historical/dormant; no active worker is assigned.
- Branch: `codex/hey-144-goals-do-schema` (merged via PR #52).
- Baseline SHA: `4e1cac308e935da2b4e514afbe8fe56b94003655` merge.
- Exact owned files: recorded in PR #52; no active ownership manifest remains.
- Explicitly forbidden files: Supabase migrations, prompt composition, autonomous goal mutation,
  and new DO-class migrations remain forbidden for follow-up work.
- Produced interfaces: ordered V2 internal goals migration, strict `GoalRecord` read Module, and
  idempotent provisioning behavior.
- Consumed interfaces: ADR-0064 `GoalRecord`, current V1 DO schema, and the existing contract.
- Status: merged storage foundation; downstream writer/admission/hydration work remains separately
  gated.
- Commits: PR #52 merge `4e1cac308e935da2b4e514afbe8fe56b94003655`.
- Verification evidence: recorded in PR #52; this ledger makes no new runtime claim.
- Review status: merged PR evidence is the authoritative review record.
- Merge dependency: satisfied for the merged storage foundation; downstream work keeps its own gates.
- Remaining risks: V1 must remain immutable; DDL and schema version must advance atomically.
- PR URL: GitHub PR #52 (merged).

### HEY-163 / WorkspaceMount contract seam

- Owner: merged PR #56; a subsequent slice needs a new, explicit owner.
- Worktree: historical/dormant; no active worker is assigned.
- Branch: `codex/hey-163-workspace-mount` (merged via PR #56).
- Baseline SHA: `2fd798f818213b344e700d98def006e80e0d56ae`.
- Exact owned files: `packages/contracts/src/adapters/workspace.ts`, its tests and barrel export, plus
  HEY-163's contract plan/design/handoff documents.
- Explicitly forbidden files: runtime, bindings, R2 client/configuration, writer implementation,
  sanitiser vocabulary, deployment, and live cloud actions.
- Produced interfaces: typed allowlisted `WorkspaceMount`, opaque version/write ids, and
  `WorkspaceBlob` transport seam; no provider mapping or byte-admission policy.
- Consumed interfaces: ADR-0029, ADR-0076, and existing skill-name contract.
- Status: Done in Linear; PR #56 merged at `79eb6ef74b2990c367fe15ac046b2c38d97ec236`.
- Commits: PR #56 merge `79eb6ef74b2990c367fe15ac046b2c38d97ec236`.
- Verification evidence: PR #56 records a final wall with 49 contract files / 1,190 tests and 20
  runtime files / 514 tests; typechecks, guards, and diff check passed. Eval suite is absent and no
  eval pass is claimed.
- Review status: merged PR evidence is the authoritative review record.
- Merge dependency: satisfied by PR #56. A later implementation still requires HEY-167 and its own
  serialized admission.
- Remaining risks: ADR-0076 writer discipline remains separate; no reader byte policy is accepted.
- PR URL: GitHub PR #56 (merged).

### HEY-166 / Workspace admission policy

- Owner: merged PR #58; a subsequent slice needs a new, explicit owner.
- Worktree: historical/dormant; no active worker is assigned.
- Branch: `codex/hey-166-workspace-policy` (merged via PR #58).
- Baseline SHA: `2fd798f818213b344e700d98def006e80e0d56ae`.
- Exact owned files: HEY-166's ISA contract, phase handoff, research, policy proposal, and plan only.
- Explicitly forbidden files: `packages/**`, bindings, `wrangler.jsonc`, provider clients, R2 object
  access, writer/commit code, deployment, cloud actions, and sanitiser vocabulary.
- Produced interfaces: proposed user-skill reader-admission policy and fake-R2 test matrix only; no
  runtime interface or accepted ADR change.
- Consumed interfaces: ADR-0024/0028/0076, current Scribe/Skill contracts, HEY-14 acceptance, and
  official Cloudflare R2 behavior.
- Status: Done in Linear; PR #58 merged at `aff9b5188feb8ee2ae61b3a3f6f7bb00d6355d65`. It records
  a proposed reader-admission policy, not an accepted ADR.
- Scope: decide proposed reader per-file/total-read bounds and decode/failure/cache/prompt-admission
  behavior. ADR-0076 separately fixes staged writer-to-commit admission through Scribe/sanitiser,
  destination, size, and path checks; HEY-166 may identify the later writer-policy owner but cannot
  implement or unblock a writer/commit path. No arbitrary universal cap, R2 binding, sanitiser
  widening, or cloud action is admitted.
- Commits: PR #58 merge `aff9b5188feb8ee2ae61b3a3f6f7bb00d6355d65`.
- Verification evidence: PR #58 records a final wall with 48 contract files / 1,186 tests and 20
  runtime files / 514 tests; typechecks, guards, and diff check passed. Eval suite is absent and no
  eval pass is claimed.
- Review status: merged PR evidence is the authoritative review record.
- Merge dependency: HEY-163 is satisfied. HEY-167 must ratify the canonical
  reader-Scribe/token-counter authority before HEY-14 implementation.
- Remaining risks: numeric limits and hard token rejections are proposed, not accepted ADR facts.
- PR URL: GitHub PR #58 (merged).

### HEY-167 / Reader-Scribe and token-budget ADR ratification

- Owner: Codex architecture/security coordinator; canonical-decision proposal only.
- Worktree: none; a waldo-brain worktree is not admitted until the proposal receives human review.
- Branch: none.
- Baseline SHA: not applicable; no canonical-repository branch is admitted.
- Exact owned files: none until a human-reviewed canonical ADR proposal is admitted.
- Explicitly forbidden files: backend runtime/contracts, R2 binding/configuration, writer/commit,
  sanitiser implementation, deployment, and cloud actions.
- Status: Backlog. HEY-166's proposal is merged; HEY-167 is the remaining active HEY-14 admission
  gate.
- Scope: ratify the owner, interface, and fail-closed behavior for a model-aware token counter and
  clarify whether the existing single Scribe seam admits mutable R2 skills in memory before
  cache/prompt use. It does not implement a reader, writer, binding, prompt builder, or sanitizer
  vocabulary change.
- Produced interfaces: accepted ADR wording only, once reviewed.
- Consumed interfaces: accepted ADR-0024/0028/0076, HEY-166's proposed reader policy, and current
  Scribe/Skill contracts.
- Commits: none.
- Verification evidence: source conflict and proposal evidence are recorded in HEY-166; no code or
  canonical ADR diff exists yet.
- Review status: not started; requires human architecture/ADR review.
- Merge dependency: HEY-166's proposal prerequisite is satisfied. A human-approved canonical
  decision must precede HEY-14.
- Remaining risks: no model-aware counter or read-admission authority is currently accepted.
- PR URL: none.

### HEY-14 / SkillLoader

- Owner: unassigned; historical preflight remains evidence only.
- Worktree/branch: do not reuse a historical checkout. Create a fresh worktree only after HEY-167
  is accepted and HEY-14 receives a new ownership manifest.
- Baseline SHA: pin the then-current `origin/main` SHA in that fresh admission record.
- Exact owned files: none; no ownership manifest is accepted yet.
- Explicitly forbidden files: all repository files until a coordinator-approved manifest exists;
  HEY-16, sanitizer vocabulary, live R2, R2 REST/public buckets, private skill content in telemetry,
  and fabricated exclusions remain forbidden.
- Produced interfaces: `loadForTrigger(ctx)`, typed exclusion evidence, and bounded source-failure
  telemetry.
- Consumed interfaces: ADR-0028 source merge plus four eligibility filters and terminal top-K,
  Scribe skill-body seam, merged HEY-163 WorkspaceMount seam, merged HEY-166 proposed policy, and
  HEY-167's future canonical decision.
- Status: Todo. HEY-163 and HEY-166 are complete; HEY-167 is the remaining active gate.
- Commits: none.
- Verification evidence: historical preflight found the typed WorkspaceMount/R2 seam absent before
  PR #56; a fresh baseline gate is required before ticket state changes.
- Review status: no worker or review package assigned.
- Merge dependency: accepted HEY-167 ADR decision, then a fresh ticket-local ownership/verification
  gate; any binding/configuration decision remains serialized.
- Remaining risks: `wrangler.jsonc` and generated binding types become its exclusive write set if
  they change.
- PR URL: none.

### HEY-15 / RecallGateway

- Owner: unassigned; ticket cannot start until HEY-14 merges.
- Worktree/branch: any existing historical checkout is not reused; a future activation gets a fresh
  worktree after HEY-14 merges.
- Baseline SHA: current `origin/main` after the HEY-14 merge.
- Exact owned files: none; no ownership manifest is accepted yet.
- Explicitly forbidden files: all repository files until a coordinator-approved manifest exists;
  `do-schema.ts` and schema-version work outside an explicitly admitted FTS migration, RunLoopDO,
  prompt composition, memory writes, raw health, live providers, channel effects, and sanitizer
  vocabulary remain forbidden.
- Produced interfaces: deterministic fail-open RecallGateway, fenced sanitized recall output, and
  bounded content-free retrieval-failure telemetry.
- Consumed interfaces: ADR-0006 provisional union-read rule, ADR-0031 recall interface/fail-open
  behavior, HEY-144 schema result, and Scribe seam.
- Status: Todo; directly blocked by HEY-14 and indirectly gated by HEY-167 through HEY-14.
- Commits: none.
- Verification evidence: none; baseline gate is required before ticket state changes.
- Review status: no worker or review package assigned.
- Merge dependency: HEY-167 -> HEY-14, then rebase after the merged HEY-144 storage seam before
  any additive FTS migration.
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
- Consumed interfaces: merged HEY-144 storage plus merged HEY-14 and HEY-15 Modules.
- Status: gated by completion of HEY-167 -> HEY-14 -> HEY-15 and Agent-Ready verification; full
  goal hydration remains gated by HEY-162's Scribe-backed admission boundary.
- Commits: none.
- Verification evidence: none.
- Review status: no worker or review package assigned.
- Merge dependency: all Wave 1 PRs human-approved and merged.
- Remaining risks: a prompt-builder caller is the only production caller of recall and skills.
- PR URL: none.

### HEY-100 / DO-only static guard

- Current execution state: merged in PR #50 at `7d02b17370c04a66d3bfb1ed2317c9e563da6910`.
  It remains a static-only guard and is not a production custody or data-plane claim.
- Owner: merged PR #50; a subsequent slice needs a new, explicit owner.
- Worktree: historical/dormant; no active worker is assigned.
- Branch: `codex/hey-100-do-only-guard` (merged via PR #50).
- Baseline SHA: `7d02b17370c04a66d3bfb1ed2317c9e563da6910` merge.
- Exact owned files: recorded in PR #50; no active ownership manifest remains.
- Explicitly forbidden files: production JWT minting, `db.forUser()` data-plane implementation,
  service-role custody changes, and claims that a real custody path exists remain forbidden.
- Produced interfaces: fixture-backed static guards against `invoke-agent` reintroduction and
  service-role reachability in Worker/DO paths.
- Consumed interfaces: ADR-0052 and ADR-0066 custody constraints.
- Status: merged static-only guard.
- Commits: PR #50 merge `7d02b17370c04a66d3bfb1ed2317c9e563da6910`.
- Verification evidence: recorded in PR #50; this ledger makes no data-plane claim.
- Review status: merged PR evidence is the authoritative review record.
- Merge dependency: satisfied for this guard; linked non-ready HEY-160 remains the only
  production-custody follow-up and must not be absorbed.
- Remaining risks: false assurance if static protection is described as a production data plane.
- PR URL: GitHub PR #50 (merged).

### HEY-75 / prompt-injection hardening

- Current execution state: scorer merged in PR #51 and its held-out corpus correction merged in PR
  #53 at `bbb8e91b740c07cbb0c5d7643b7adf26ceaab55a`.
- Owner: merged PRs #51/#53; no active worker is assigned.
- Worktree: historical/dormant; no active worker is assigned.
- Branch: `codex/hey-75-corpus-integrity` (merged via PR #53).
- Baseline SHA: `bbb8e91b740c07cbb0c5d7643b7adf26ceaab55a` merge.
- Exact owned files: PR #51 scorer implementation and PR #53 held-out hostile/benign fixtures plus
  `packages/runtime/test/scribe-sanitiser.property.test.ts`.
- Explicitly forbidden files: persisted/logged match snippets, copied GPL or unprovenanced corpora,
  and unrelated sanitizer surfaces.
- Produced interfaces: deterministic prompt-injection scorer with content-free rule/count evidence.
- Consumed interfaces: ADR-0024 check order, primary OWASP source corpus, and the merged HEY-13
  Scribe surface.
- Status: Done in Linear.
- Commits: PR #51 merge `2fd798f818213b344e700d98def006e80e0d56ae`; PR #53 merge
  `bbb8e91b740c07cbb0c5d7643b7adf26ceaab55a`.
- Verification evidence: PR #53 records a full wall, canonical partition-disjointness checks, and a
  100% mutation score.
- Review status: merged PR evidence is authoritative.
- Merge dependency: satisfied.
- Remaining risks: corpus provenance, ReDoS behavior, held-out denominator integrity, and the
  canonical ADR-0024 wording follow-up.
- PR URL: GitHub PR #51 (merged); GitHub PR #53 (merged corrective).

### HEY-141 / egress hardening

- Current execution state: merged in PR #54 at `3283ea16996143d4b9d6205978e640b630f25fef`. It
  remains a declared-target parse-only policy, not DNS, redirect, fetch, transport, ACL, or
  production egress enforcement.
- Owner: merged PR #54; no active worker is assigned.
- Worktree: historical/dormant; no active worker is assigned.
- Branch: `codex/hey-141-egress-hardening` (merged via PR #54).
- Baseline SHA: `3283ea16996143d4b9d6205978e640b630f25fef` merge.
- Exact owned files: egress policy/registry plus focused egress policy, schema-conformance, and hook
  tests.
- Explicitly forbidden files: DNS-rebinding work, redirect chasing, new outbound-fetch adapters,
  and silent provider behavior expansion.
- Produced interfaces: parsed URL conformance guard that covers declared nested URL paths and
  literal-address policy.
- Consumed interfaces: existing SSRF policy, declared URL schema paths, and primary OWASP guidance.
- Status: Done in Linear.
- Commits: PR #54 merge `3283ea16996143d4b9d6205978e640b630f25fef`.
- Verification evidence: PR #54 records a fresh full wall plus security, health-data, and
  adversarial review evidence.
- Review status: merged PR evidence is authoritative.
- Merge dependency: satisfied for the declared policy guard.
- Remaining risks: current nested URL discovery can miss arbitrary fields; literal IPv6 ULA handling
  must not become hostname resolution.
- PR URL: GitHub PR #54 (merged).

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

- Linear HEY-109 remains the session-bus fallback. Its post-merge comment should record
  `aff9b5188feb8ee2ae61b3a3f6f7bb00d6355d65` and the completed PRs #53, #54, #56, and #58.
- Wave 0 gating is satisfied. HEY-75, HEY-141, HEY-163, and HEY-166 are Done; HEY-14 is Todo,
  HEY-15 is Todo, and HEY-16 and HEY-167 are Backlog. HEY-167 is the sole unresolved
  canonical-decision gate before HEY-14; its completion does not waive HEY-14's own Agent-Ready
  requirements.
- The ledger records merged/draft state and does not replace ticket-specific admission criteria.
- HEY-16, HEY-75, and HEY-143 no longer list merged HEY-13 as a live blocker. HEY-100 no longer
  lists Done HEY-125; Done HEY-136 no longer lists HEY-15/HEY-16 as live blockers.
- HEY-143 now directly records its required planning-convergence gates; HEY-14 remains transitive
  through HEY-16, while the HEY-144 storage prerequisite is merged and HEY-153/HEY-110/HEY-156 stay
  separate Alpha dependencies.
- New non-ready HEY-160 owns future production ES256 per-user JWT, `db.forUser()`, RLS isolation,
  refresh/rotation, and service-role-custody proof. It is related to HEY-100/HEY-125 but is not a
  HEY-143 convergence gate.
- New non-ready HEY-161 owns source-backed regeneration of the accepted-ADR snapshot; it does not
  authorize a hand edit or runtime change.
- A post-merge comment on PR #47 corrects the earlier proof summary with the final 1,188/485/235/351
  evidence and explicitly records that no standalone eval-suite pass is claimed.
