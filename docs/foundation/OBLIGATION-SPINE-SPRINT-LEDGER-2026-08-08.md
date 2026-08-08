# Obligation Spine Sprint Ledger

**Started:** 2026-08-08  
**Pinned base:** `dd434e9bb5dedc4a135e43e30571a141599e8991` (`origin/main`)  
**Umbrella:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78)  
**Authority:** the architecture lock and issue-specific accepted decisions remain normative. This file records execution, dependency, and verification evidence; it is not a parallel product specification.

## Sprint outcome

Build the durable obligation spine: Waldo carries a person's responsibility from canonical capture through bounded execution, judgment, authority, effects, evidence, independent verification, acceptance, and exact re-entry. Provider, executor, connector, and presence reports remain untrusted observations. None can close an Outcome.

## Non-negotiable acceptance boundary

- Stable responsibility identity and canonical owner binding survive retry and restart.
- An `OpenLoop` exists from responsibility capture, before provider or executor work begins.
- Authority grants are exact, backend-owned, expiring/revocable, and consumed atomically with frozen effect intent.
- Cancellation, expiry, revocation, reconciliation ambiguity, and stale lease generations fail closed.
- Provider or Kennel completion cannot imply Verification, Acceptance, OpenLoop closure, or Outcome closure.
- Evidence and Acceptance remain bound to the exact Outcome and acceptance-criteria revision.
- Eviction/restart restores the exact surviving `ReEntryPoint` without inventing continuity.
- One reversible connector effect is proven by independent read-back before the connector capability is claimed.
- Kennel remains an untrusted executor/presence with its own local operation ledger, never an alternate Waldo truth store.

## Corrected dependency graph

The live #78 body is a historical planning input, not current sequencing authority. This run applies these corrections:

1. #80 resolves to one execution writer: evolve `PlanningExecutionModule` into the `RunLoopEngine`; do not add a sibling writer over `ExecutionRequest`, `AgentSession`, or `ExecutionLease`. Keep provider invocation and execution-environment adapters as distinct internal seams: AI Gateway is not a Kennel-style executor.
2. #81 publishes contract slices vertically, beginning with `AcceptanceCheck`, then the judgment/authority, effect, evidence/verification/acceptance, continuity, admission, and executor families required by consumers.
3. #85 is two delivery points: capture-time OpenLoop/ReEntry creation, then verified acceptance/reopen/release transitions.
4. #88 is two barriers: fake-backed spine integration first; real adapter/connector integration only after adapter conformance.
5. #89 depends on #83, #90, and #91. It does not depend on its own later integration barrier.
6. #86 is not on the critical path until Telegram terminal-ambiguity/idempotency semantics satisfy the delivery contract or the contract is deliberately changed.
7. Migration numbers are allocated at rebase/integration time from the live schema head. Issue-time V6-V10 assignments are invalid.
8. #92 and #93 are outside this sprint. Existing governed context and provider seams may be consumed, but their full promotion is not required for the obligation-spine proof. The independent #104 Waldo-Daily track may run in disjoint worktrees without becoming a spine dependency or touching reserved integration files.
9. #90 is split. A narrow CapabilityRegistry A0 for the existing planning provider/executor path gates #83 and #87: immutable manifest admission, registry-owned assessment, owner-local disposition, and trusted pre-enqueue plus pre-I/O eligibility checks. Tool, MCP, connector, model, presence, signed-manifest trust roots, and global kill-switch coverage remain in the umbrella.
10. Capability eligibility is enforced by trusted callers outside adapters. A manifest is a claim; an adapter cannot certify itself, and no eligibility decision may be cached across the pre-I/O boundary.

## Single-writer and integration reservations

| Surface | Sole writer in this run | Reservation |
|---|---|---|
| `packages/contracts/**` | contracts lane | No other lane edits contracts; consumers pin its commit. |
| Migration policy/guard | migration-safety lane | No feature migration is allocated until the guard lands and live schema head is rechecked. |
| Feature migration blocks in `do-schema.ts` | one merge captain at integration | Feature lanes return schema requirements; the captain allocates and integrates in dependency order. |
| `PlanningExecutionModule` / future `RunLoopEngine` | execution lane | No sibling execution aggregate writer. |
| `waldo-coordinator.ts`, `run-loop/do.ts`, `runtime/src/index.ts` | #88 integration lane | Module PRs expose transaction-scoped seams and do not self-wire. |
| This ledger | root orchestration lane | Workers return evidence packets; only root updates rows. |

## Worktree-task orchestration

The run uses a hierarchical supervisor pattern for context isolation. The root task owns trajectory, dependency decisions, the merge queue, and this ledger; durable implementation happens in dedicated Codex worktree tasks created from reviewed dependency commits. A worktree task may use bounded subagents for read-only workflow mapping, test design, or mutation probes. It may not create a second concurrent writer for its owned files, and its author/subagents cannot independently clear their own implementation.

### Active-task cap and phase rotation

Keep no more than four live Codex contexts. Rotate the same slots instead of accumulating one task per ticket.

| Phase | Context 1 | Context 2 | Context 3 | Context 4 |
|---|---|---|---|---|
| contract gates | root orchestration | contracts writer | independent contract breaker | independent migration breaker |
| module wave | root orchestration | contracts writer | obligation runtime worktree | admission/identity runtime worktree |
| integration wave | root orchestration | remaining module worktree | RunLoop/integration worktree | independent breaker/security worktree |

### Worktree-task start packet

Every implementation task starts from a packet containing:

- objective and stable acceptance-criterion IDs;
- exact dependency/base SHA and source PR;
- worktree, branch, allowed writes, and forbidden hotspots;
- architecture/issue source paths rather than paraphrased conclusions;
- required first failing public-interface test and mutation candidate;
- expected evidence packet and halt/escalation conditions.

The task reload order is this ledger, the architecture lock, the owning issue/PR, then the pinned dependency diff. Full conversation history is not a dependency.

### Handoff and validation protocol

1. The worktree task records RED, GREEN, focused verification, mutation/non-vacuity evidence, changed files, head SHA, and residual uncertainty in the evidence-packet schema below.
2. The root spot-checks repository state and source evidence, then updates this ledger; workers never edit the ledger.
3. No consumer task starts from an unreviewed local diff. It pins a published commit that has passed the required contract or module gate.
4. Independent review runs in a fresh context/worktree and reproduces named failure modes. Author and author-spawned subagents cannot issue clearance.
5. Rejected work returns to the same owning worktree. After three failures on the same boundary, decompose or defer rather than adding reviewers.
6. Coordinator/run-loop/index and `do-schema.ts` remain serial merge-captain surfaces even while module work runs in parallel.
7. Pull-request comments hold full reviewer evidence; this ledger holds the concise state and direct link, avoiding lossy supervisor paraphrase.

## Worktree ledger

| Lane | Issue / purpose | Branch | Worktree | Base / dependency | Allowed writes | State | Head / PR |
|---|---|---|---|---|---|---|---|
| orchestration | #78 evidence and barriers | `codex/obligation-spine-ledger` | `/Users/shivanshfulper/.codex/worktrees/osp-orchestrator/waldo-backend` | `dd434e9` | this ledger only | active | draft PR [#102](https://github.com/Pin4sf/waldo-backend/pull/102) |
| contracts | #81 protocol v0.4 vertical slices | `codex/obligation-contracts` | `/Users/shivanshfulper/.codex/worktrees/osp-contracts/waldo-backend` | stacked on `12a014a` | `packages/contracts/**` plus its generator/guard registration | Judgment/Authority published and review-clear; local Effect contract returned to repair because retry basis can launder unavailable read-back | published dependency `b41bd287`, rejected local `307947d`; draft PR [#103](https://github.com/Pin4sf/waldo-backend/pull/103) |
| judgment authority runtime | B4 live admission and atomic grant use | `codex/obligation-judgment-authority-runtime` | `/Users/shivanshfulper/.codex/worktrees/osp-judgment-authority/waldo-backend` | `b41bd287` | new JudgmentAuthorityModule and its focused test only; no schema or wiring | active: workflow map then public-interface TDD | local branch from `b41bd287`; no PR |
| merge-wall repair | wall-clock-independent planning authority fixture | `codex/planning-authority-test-clock` | `/Users/shivanshfulper/.codex/worktrees/osp-test-clock/waldo-backend` | `dd434e9` | one runtime test fixture | review | `12a014a`; draft PR [#99](https://github.com/Pin4sf/waldo-backend/pull/99) |
| migration safety | parallel migration collision guard | `codex/obligation-migration-guard` | `/Users/shivanshfulper/.codex/worktrees/osp-migration/waldo-backend` | stacked on `12a014a` | guard/tests/docs required by the guard | paused outside the working-Waldo critical path after reduced guard review failed | `01a6296`; draft PR [#100](https://github.com/Pin4sf/waldo-backend/pull/100) |
| execution decision | #80 writer map and safe refactor plan | `codex/obligation-execution-map` | `/Users/shivanshfulper/.codex/worktrees/osp-execution/waldo-backend` | `dd434e9` | bounded decision artifact only | review | `a12c6d2`; draft PR [#98](https://github.com/Pin4sf/waldo-backend/pull/98) |
| credential boundary | #91 secret-flow map and safe first slice | `codex/obligation-credential-map` | `/Users/shivanshfulper/.codex/worktrees/osp-credential/waldo-backend` | `dd434e9` | disjoint port/guard or evidence artifact | evidence review-clear; implementation decisions remain | `61304a8`; draft PR [#101](https://github.com/Pin4sf/waldo-backend/pull/101) |
| Waldo-Daily review | #104 WD-1 PersonaFormatter / PR #105 | review task from `claude/wd-1-persona-formatter` | `/Users/shivanshfulper/.codex/worktrees/c5ea/waldo-backend` | live PR #105 head | review-only; no writes | rejected: privacy, token, Unicode, representation, and delivery-path blockers | Codex task `019fe02b-1412-7722-bf1b-02fdb1d4588e` |

## Planned implementation barriers

| Barrier | Required evidence | State |
|---|---|---|
| B0 preflight | live base pinned; dirty main untouched; worktrees and ownership recorded | passed |
| B1 contract kernel | strict schemas, exports, valid and rejection fixtures; contract tests; downstream handoff commit | Judgment/Authority slice passed independent exact-expiry mutation review and was published at `b41bd287`; downstream runtime admission may pin this commit while the contracts writer continues later #81 families |
| B2 migration allocation | feature migrations remain unallocated until their integration branch rebases and takes `max(existing)+1` | guard PR #100 is paused; serial merge-captain allocation is sufficient for the one-lane working-Waldo milestone |
| B3 capture continuity | capture transaction creates canonical OpenLoop and exact initial ReEntry | blocked by B1/B2 |
| B4 judgment and authority | exact grant, revision/digest binding, expiry/revocation, atomic consume | contract dependency released at `b41bd287`; runtime module wave ready, with migration allocation deferred to serial integration |
| B5 effects | frozen intent before I/O, single retry owner, reconcile-before-retry, terminal ambiguity | contract/module wave ready under the sole contracts writer and a disjoint runtime writer; integration still depends on B4 |
| B6 evidence and acceptance | candidate evidence separated from independent verification and human acceptance | workflow-mapped; runtime waits for published obligation-context, Evidence/Verification, Acceptance, and Continuity contracts plus the EffectReceipt dependency |
| B7 capability/identity admission | planning-path CapabilityRegistry A0 plus model-invisible credential broker A0/A1 seam | CapabilityRegistry source map complete; contracts blocked by B1 ownership, runtime blocked by B1/B2; credential custody package B remains decision-blocked |
| B8 execution seam | one writer plus fake Kennel executor conformance and cancellation/fencing | blocked by #80/B1 |
| B9 fake-backed whole spine | nine-step public path, restart/replay, breaker and mutation probes | blocked by B3-B8 |
| B10 real reversible effect | real connector, frozen key, independent read-back, ambiguity drill | blocked by B5/B7/B9 |
| B11 Claude review packets | independently reproducible PR evidence; no merge performed by this run | blocked by each PR completion |

## Migration allocation ledger

No feature migration version is reserved yet. A row may be added only after rebasing the owning integration branch onto live `origin/main` and recording `max(existing)+1`.

| Feature | Dependency commit | Live schema head at allocation | Allocated version | Captain | State |
|---|---|---|---|---|---|
| none | — | — | — | — | unallocated |

## Evidence packet schema

Every worker handoff and PR must report:

- issue and observable scope;
- base SHA and dependency SHA(s);
- permitted and changed files;
- first failing test and why it proved absence of the behavior;
- passing focused tests and mutation/non-vacuity probe;
- contract/architecture mapping;
- full verification-wall result with skipped/unavailable checks separated;
- security, standards, specification, and breaker dispositions where triggered;
- commit SHA, PR URL, residual blockers, rollback, and next dependency.

## Evidence log

| Time (Asia/Kolkata) | Lane | Event | Evidence / disposition |
|---|---|---|---|
| 2026-08-08 | orchestration | Base pinned | `origin/main` and clean worktrees start at `dd434e9`; the original main checkout has unrelated user changes and is not used for edits. |
| 2026-08-08 | orchestration | Authorship decision | Codex owns implementation lanes for this sprint. Claude is reserved for later independent PR review. |
| 2026-08-08 | orchestration | TDD policy | Vertical public-interface RED-GREEN cycles; mocks only at external boundaries; no bulk speculative contract scaffolding. |
| 2026-08-08 | execution decision | #80 source map complete | `a12c6d2` proves `PlanningExecutionModule` is the only behavioral writer for the current request/session/lease tables. It also corrects #81/#87: provider adapters and execution-environment adapters remain different categories behind one durable engine. |
| 2026-08-08 | execution decision | Review unit published | Draft PR [#98](https://github.com/Pin4sf/waldo-backend/pull/98) contains evidence only, does not close #80, and awaits independent review/ADR ratification. |
| 2026-08-08 | orchestration | Worker transport recovery | Contract and migration worker streams disconnected; worktrees were inspected before resumption. Contract had no diff; migration retained one self-test diff. No work was discarded or duplicated. |
| 2026-08-08 | merge-wall repair | Expired test authority reproduced and fixed | Live `origin/main` failed 7/20 planning tests after its active session fixture expired. PR #99 makes the active fixture wall-clock-independent; focused 20/20 and the complete Docker-backed wall pass. |
| 2026-08-08 | migration safety | Guard published | Stacked draft PR #100 blocks duplicate, gapped/reordered, unreserved, malformed, missing, and mismatched migration lineage. Mutation of duplicate detection makes its self-test fail. |
| 2026-08-08 | credential boundary | #91 source map published | Draft PR #101 splits handle metadata, isolated Vault/egress custody, and full canary integration. Existing `*_enc` columns are not claimed as Vault implementation. |
| 2026-08-08 | contracts | AcceptanceCheck v0.4 published for review | `578fc49` defines deterministic read-back against an exact responsibility revision. Focused 5/5, contracts 59/1,480, runtime 38/1,001, pgTAP 53, integration 5, full wall, guards, and mutation proof pass on #99. Draft PR #103 remains active for the rest of #81. |
| 2026-08-08 | merge-wall repair | Independent breaker pass | PR #99 has no blocking Codex findings. The reviewer reproduced RED on main and 24/24 focused planning/identity plus 1,001 runtime tests on the fix. Claude review remains pending. |
| 2026-08-08 | migration safety | Independent breaker rejected first guard | P1: paired source/ledger rewrites and historical SQL changes passed; a block-comment declaration spoof also passed. #100 returned to implementation for TypeScript AST parsing and base-aware immutable-prefix enforcement. |
| 2026-08-08 | contracts | Independent breaker rejected first freshness gate | P1: CRLF-mutated fixture bytes passed after normalization while the manifest digest changed. P2: exact 4,096/4,097-byte boundaries lacked committed assertions. #103 returned to raw-byte comparison and boundary-test repair. |
| 2026-08-08 | contracts | Freshness repair published | `b28549d` adds raw-byte comparison, a CRLF mutation regression, and exact 4,096/4,097-byte tests. Focused AcceptanceCheck 6/6 and freshness 2/2 pass; independent re-review remains pending. |
| 2026-08-08 | credential boundary | Independent review rejected first source map | P1: an out-of-runtime service-role boundary is not authorized, and the DO-to-custody redemption permit/TOCTOU protocol is missing. Re-slice as A0 contract/reducer/guard, A1 DO metadata, B needs explicit custody decision, C integration. |
| 2026-08-08 | migration safety | Guard repair published | `5f7cd8a` uses TypeScript AST parsing and base-aware immutable-prefix comparison. Historical name/SQL rewrites and comment spoof fail; a real suffix append and legal inline comment pass. Full wall and historical-SQL mutation probe pass; independent re-review pending. |
| 2026-08-08 | credential boundary | Source-map repair published | `61304a8` removes the unauthorized service-role recommendation, records the unresolved permit/revocation/TOCTOU design, unblocks A0, and requires generated sink manifests plus distinct canaries. Independent re-review pending. |
| 2026-08-08 | contracts | AcceptanceCheck repair re-review | Independent review reproduced the CRLF and byte-ceiling mutations against `b28549d`; both tests fail when the defects return. AcceptanceCheck is review-clear at contract/fixture proof only. |
| 2026-08-08 | credential boundary | Source-map repair re-review | Independent review passed all prior P1/P2 closures at `61304a8`; all 32 repository references resolve. Package B remains decision-blocked and no implementation claim is made. |
| 2026-08-08 | migration safety | Second breaker rejected repair | P1: SQL referenced through an external constant can change outside the fingerprint; `--base-ref HEAD` makes comparison vacuous. P2: punctuation-only formatting is treated as lineage. #100 returned to semantic up/down resolution and strict-ancestor validation. |
| 2026-08-08 | contracts | Judgment/Authority pre-push review rejected | Unpushed `93bcf53` uses a displayed digest unrelated to the canonical request, does not prove request-to-grant no-widening, asserts only 8/15 rejection names, and leaves use limit outside requested authority. Repair required before push. |
| 2026-08-08 | delivery | #86 source-backed preflight blocked implementation | Bot API has no documented idempotency/reconciliation key; MTProto has `random_id` and update recovery but does not fit the synchronous receipt-free `DeliverySink`. Issue relabeled blocked pending effect contract and MTProto feasibility proof; fixed V10 rejected. |
| 2026-08-08 | migration safety | Second guard repair published | `a59d042` fingerprints resolved ordered `up`/`down` SQL through top-level const aliases and array spreads, rejects unsafe/nonliteral shapes, and requires a strict ancestor base distinct from HEAD. Focused regressions, mutation probes, and full wall pass; third independent review active. |
| 2026-08-08 | contracts | Judgment/Authority repair committed locally | `52ea175` binds request, answer, decision, and grant to the real canonical request digest; makes requested authority executable; expands the exact rejection catalogue and counter/byte/hostility boundaries; and kills five recorded mutations. Full wall passes; independent review is active before any push. |
| 2026-08-08 | capability admission | #90 corrected and re-sliced | CapabilityRegistry A0 covers only existing planning-provider/planning-executor admission. Trusted callers enforce fresh pre-enqueue and pre-I/O checks; publisher claims are separated from registry-owned assessment. #83 and #87 depend on this interface; broad tool/MCP/connector/signed/global coverage remains in #90. |
| 2026-08-08 | contracts | Judgment/Authority repair rejected before push | Independent mutations proved that `option_reject` can still yield the unchanged grant and an arbitrary asserted digest can replace the canonical request hash. Causal time ordering and the rejection catalogue oracle are also incomplete. AcceptanceCheck requires deterministic read-back, deterministic artifact, and disclosed semantic method variants; absence/decline stays outside a confirmed check. Repair returned to the sole contracts writer. |
| 2026-08-08 | migration safety | Third semantic guard review rejected and halted | Executable element assignment, array mutation, and direct migration-property assignment change compiled historical SQL while `a59d042` passes. After three failures on this boundary, #100 is being decomposed to its original parallel-version safety scope; semantic SQL immutability moves to a follow-up representation-level design. |
| 2026-08-08 | Waldo-Daily | Parallel side lane admitted | Live #104 drops the redundant generic ReadPort because typed calendar/email/doc/sheet contracts already exist. PersonaFormatter PR #105 entered an independent Codex worktree review; the first read-only `CalendarProvider` implementation follows separately and remains off the spine critical path. |
| 2026-08-08 | contracts | Second Judgment/Authority repair ready for review | Local `b353db4` adds grant/refusal disposition, trusted canonical request hashing, causal ordering, an independent rejection oracle, and deterministic read-back/artifact/semantic AcceptanceCheck methods. Full wall and six mutation classes pass; nothing is pushed pending fresh review. |
| 2026-08-08 | migration safety | Collision-only guard published | `01a6296` removes all semantic SQL immutability machinery and claims while retaining reservation/source matching, version/name/order/contiguity, historical identity prefixes, strict-ancestor base, and merge-captain workflow. Fresh review is active. |
| 2026-08-08 | contracts | Obligation identity and negotiation disposition | Outcome remains the canonical responsibility identity. The next v0.4 slice will domain-model an owner-stated, revision-bound obligation context; OutcomeModule owns acceptance-check declaration/absence/decline while Continuity may project the confirmation OpenLoop. No separate Responsibility writer is introduced. |
| 2026-08-08 | Waldo-Daily | PersonaFormatter review rejected | PR #105 fails open on unenforced health controls, undercounts CJK/emoji, can emit malformed Unicode, filters an orphan affordance representation, and has no delivery-path caller. Review evidence posted; calendar/conversation work must not claim persona enforcement from this PR. |
| 2026-08-08 | orchestration | Working-Waldo scope collapsed | The sole critical path is one owner-scoped flow: admitted Outcome -> bounded WorkUnit -> Judgment/Authority -> one reversible Calendar effect -> independent read-back -> Evidence/Verification -> owner Acceptance or surviving OpenLoop/ReEntryPoint. Workspace breadth, code-mode research, PersonaFormatter, additional harnesses, and connector breadth do not gate this milestone. |
| 2026-08-08 | contracts | Third Judgment/Authority lifecycle repair committed | `9149d19` requires the exact open unanswered request snapshot, half-open expiry, update-before-decision ordering, and matching grant/refuse option disposition. Contracts 60/1,495, runtime 38/1,001, pgTAP 53, integration 5, all guards, and `git diff --check` pass. Fresh independent review is active before push. |
| 2026-08-08 | migration safety | Reduced guard rejected and paused | Independent review bypassed version/name lineage with valid post-declaration TypeScript mutation. PR #100 is not merge-ready and no longer gates the single integration lane; migration numbers are assigned serially at rebase. |
| 2026-08-08 | contracts | Third repair review rejected on proof quality | `9149d19` rejects every previously reproduced lifecycle input, but changing `>= expiresAt` back to `> expiresAt` leaves focused tests green because the granted exact-expiry fixture also fails grant chronology. Repair with the grant-free refusal binding, add an `expiry - 1 ms` pass control and issue-path/message assertion, and document the exported verifier as snapshot-integrity rather than final live admission. |
| 2026-08-08 | contracts | Exact-expiry proof repaired, independently cleared, and published | `b41bd287` builds the expiry negative from a grant-free refusal, proves `expiry - 1 ms`, and asserts the sole `decision.decidedAt` issue and message. A fresh breaker killed the `>=` to `>` mutation with exactly the named test failing. The full author wall passed: contracts 60/1,496; runtime 38/1,001; pgTAP 53; integration 5; all guards and diff check. PR #103 remains draft and unmerged. |
| 2026-08-08 | effects | Read-only workflow map fixed the module seam | Existing RunLoopDO intent-before-I/O and reconciliation behavior remains the sole physical effect path. The module wave reserves a new fake-backed EffectEngine and v0.4 contract family without wiring; outbox/runtime runs are not repurposed, and schema, coordinator, RunLoop, index, adapter, and Calendar files remain reserved for later owners. |
| 2026-08-08 | evidence and continuity | Read-only workflow map preserved aggregate writers and exposed a contract dependency | Wave C remains three modules: EvidenceVerifier, AcceptanceModule, and ContinuityModule. Runtime cannot start from `b41bd287` because Outcome lacks owner-stated acceptance-criteria binding and the Evidence/Verification, Acceptance, OpenLoop, and ReEntryPoint contracts are absent. The sole contracts writer must publish those families serially after Effect; verifier I/O is prepare-outside-I/O-settle, never inside `transactionSync`. |
| 2026-08-08 | effects | First Effect contract breaker rejected retry admission | Local `307947d` permits a retry basis to reference an actual `unavailable` reconciliation while relabeling it `authoritative_not_applied`; the schema and exported verifier accept it. Unavailable-specific widening mutations also survive. Repair must bind retry and terminal-ambiguity decisions to the exact canonical prior reconciliation record and add asymmetric negatives before any push. |

## Honest capability status

Until later rows contain their required proof, every capability remains independently classified. `contract_defined` never implies `module_implemented`; module tests never imply adapter conformance, cross-surface acceptance, or operational proof.

| Capability | Architecture specified | Contract defined | Module implemented | Adapter conformance | Cross-surface acceptance | Operational proof |
|---|---:|---:|---:|---:|---:|---:|
| obligation spine v0.4 | yes | no | no | no | no | no |
| exact judgment and authority | yes | yes | no | no | no | no |
| governed external effect | yes | no | no | no | no | no |
| evidence, verification, acceptance | yes | no | no | no | no | no |
| OpenLoop and ReEntry | yes | no | no | no | no | no |
| Kennel executor | yes | no | no | no | no | no |
| credential broker | yes | no | no | no | no | no |
| planning capability admission | yes | no | no | no | no | no |
| reversible connector | yes | no | no | no | no | no |
