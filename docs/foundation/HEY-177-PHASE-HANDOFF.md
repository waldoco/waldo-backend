# HEY-177 RunLoop Context Convergence Handoff

Status: **HEY-177 remains In Progress.** Post-fix verification and fresh review gates passed on
`codex/hey-177-runloop-context-convergence`; PR #69 remains open and unmerged for normal peer
review. Do not merge or mark the Linear issue Done from this handoff.

Date: 2026-07-18 IST.
Base: `origin/main` `3219cd8` (`feat(runtime): add trusted ContextComposer (#68)`).

## Phase HEY-177 → Review Handoff

### What Was Built

- `RunLoopDO` remains the single V2 runtime orchestrator. Trusted admission atomically creates one
  content-free invocation sidecar, journal state, and `scheduled_wake` evidence; duplicate
  admission returns the existing run.
- The V2 branch calls `ContextComposer` at the existing `CONTEXT_BUILT` state. A missing, corrupt,
  changed, or unavailable frozen witness fails closed with a typed, content-free reason and never
  falls back to `buildFakeContext` or `source: fake-derived`.
- `packages/contracts` owns the complete strict persisted V2 envelope: accepted invocation,
  snapshot, checkpoint, pending effect intent, provider/tool receipt witnesses, and bounded
  evidence. Runtime helpers only apply semantic invariants around that contract.
- Provider and trusted-tool effects use the HEY-177 receipt protocol: persist a runtime-owned
  intent and deterministic reconciliation key before I/O; issue or reconcile by that key; then
  atomically commit the bounded content-free receipt, Governor observation, and one FSM
  transition. An adapter/tool without keyed reconciliation fails closed. Unexpected adapter or
  storage failures are preserved rather than relabelled as an integrity failure.
- The authenticated local HTTP fixture has an empty caller vocabulary and server-selects its
  trusted scheduled Brief, frozen local sources, provider, ACL, output and delivery policy. A
  full-input admission method is an explicitly named local/test RPC only. All non-lifecycle
  implementation methods are ECMAScript-private `#` methods, so Workerd's prototype RPC surface
  contains only the exact lifecycle and locally guarded test/proof controls.
- Output is disposition-specific in the existing durable path: proactive delivery uses
  DeliveryGate and transactional outbox; solicited reply runs safety plus Governor egress with no
  proactive budget/outbox and fails closed without a configured reply transport; internal output
  completes durably with the explicit internal completion mode and no user-visible effect.
- Terminal evidence now binds V2 provider/egress/done disposition witnesses to gate, journal,
  outbox, delivery, and completion facts. It rejects contradictory solicited/internal proactive
  facts and corrupted V2 delivery facts with no disposition witness.
- V1 historical reader compatibility remains explicit. Immutable V2 markers prevent a damaged V2
  run or evidence read from silently becoming a V1/fake-derived path.

### What Works (with evidence)

- **Golden guarded local V2 Brief — PASS.** Workerd coverage proves authenticated `POST /local/runs` with
  the fixed fixture reaches trusted admission → `PENDING` → V2 `CONTEXT_BUILT` → provider plan →
  two governed tools → synthesis → DeliveryGate → outbox → fake-sink acknowledgement → `DONE`.
  It asserts canonical identity, V2 provenance, trigger ACL, usage bounds, one delivery effect,
  full journal order, and deterministic restart boundaries.
- **External-effect crash windows — PASS.** Workerd eviction/reset tests cover provider plan,
  provider observe, and tool effects after physical I/O but before durable receipt; reconciliation
  occurs by the persisted key and physical effect counts stay at one. They also cover unavailable,
  mismatched, and throwing reconcilers, post-receipt recomposition, Governor kills, source failure,
  and concurrent drives.
- **Disposition/evidence truth table — PASS.** Contract fixtures reject hold, drop, send, and
  degrade facts on solicited/internal paths and reject the same V2 facts when the disposition
  witness is absent. The legitimate solicited path exercises safety and Governor egress, leaves
  proactive DeliveryGate budget untouched, creates no proactive outbox, and fails closed without a
  reply transport.
- **Privacy and health-adjacent boundaries — PASS.** SQLite/journal/outbox/trace inspections prove
  staged input, recall, prompt, provider/tool content, hostile canaries, and `fake-derived`
  provenance do not persist in V2. The health review also verified deterministic `health: null`,
  content-free ContextComposer failures, closed trace schemas, and tenant-plus-principal opaque
  owner scope checks.
- **Contract and replay integrity — PASS.** Strict contract fixtures lock pending/settled effect
  relationships, ACL-safe tool witnesses, V2 evidence flavor, no V1 fallback, replay-witness
  weakening, gate verdict mismatch, and disposition confusion.
- **Performance/budget evidence — bounded, not benchmarked.** Existing deterministic golden
  assertions cap Composer/provider/tool calls, tokens, provider message bytes, outbox rows, and
  sink effects. No before/after alarm latency, SQLite query-count, or memory benchmark was captured;
  broader performance claims remain unproved.
- **Full verify — PASS.** `npx -y pnpm@10.34.4 verify` exited 0: three package typechecks,
  contracts 52 files/1,328 tests, local Supabase schema 44 tests, runtime 32 files/873 tests, and
  all repository guards. It only reset/tested the local Docker database; no staging or production
  system was touched.
- **Additional gates — PASS.** Trusted Workerd 71/71; scheduler 8/8; focused provider/tool/delivery/evidence
  117/117; ContextComposer 113/113; Scribe/V2 property 261/261; ContextComposer mutation 3/3
  mutants killed (100%); `git diff --check` passed. `/run-eval` found no
  `tools/eval/run-suite.ts`, so this is an explicitly recorded evaluator gap rather than an
  eval-suite pass.
- **Fresh reviews — PASS.** Independent Standards and Spec reviews passed after the exact
  RunLoopDO RPC-prototype allowlist and bounded-extraction decision. Security rechecked the
  ECMAScript-private conversion and passed; health/privacy review passed; workflow-map plus
  QA-breaker passed with reset, hostile/null/concurrent/degraded, owner-scope, disposition, and
  receipt-bypass attacks.

### What Doesn't Work Yet (known issues)

- **MEDIUM — production adapter prerequisite:** HEY-177 proves keyed reconciliation with the
  fake/local adapters. A real provider or future mutating tool must implement durable
  idempotency/reconciliation by the runtime-owned key before it is admitted. Gateway mode remains
  fail-closed without that contract, audited spend, and a configured real sink.
- **MEDIUM — HEY-176 scope:** HEY-176 owns frozen ContextComposer source manifests and production
  replay completeness. This branch only proves local frozen-source witnesses; changed or unavailable
  sources fail closed and are not claimed as durable production source replay.
- **MEDIUM — scheduler recovery:** admission commits before `scheduler.schedule()`. Duplicate
  admission/redelivery restores scheduling after that narrow crash window; there is no autonomous
  recovery scan.
- **LOW — storage trust:** strict schemas, digests, and cross-table witnesses protect the V2
  sidecar, but it is not a keyed tamper-evident MAC.
- **LOW — evaluator gap:** no standalone runtime eval suite exists at `tools/eval/run-suite.ts`.
- **LOW — non-local RPC fixture strength:** the Workerd regression changes the resident test
  instance's `WALDO_ENV` and proves every prototype-exposed proof/replay method rejects before
  reading. It does not use a separately configured production namespace; the entry guard and exact
  prototype allowlist make this non-blocking, but such a fixture would be stronger when supported
  by the pool without credentials.

### Architecture Decisions Made During This Phase

- Keep all V2 mechanics within the existing `RunLoopDO`, journal/outbox, scheduler, and FSM. No
  RunPort, second loop, alternate journal, surface-owned runtime, CLI service, or MCP server was
  created.
- Treat `TrustedInvocationEnvelope` as the sole admission vocabulary. Caller request bodies never
  choose authority, principal, tenant, trigger, provider/routing, ACL, output disposition, delivery
  policy, or snapshot trust.
- Treat intent → keyed reconciliation → receipt as the only honest external-effect guarantee. The
  private resident coalescer helps concurrent in-process calls but is never evidence of cross-reset
  exactly-once behavior.
- Treat a V2 delivery fact without a consistent persisted disposition witness as corruption, not as
  implicit proactive delivery.
- Keep V1 historical read compatibility separate from V2 runtime behavior; V2 never downgrades.
- `trusted-v2.ts` is the bounded persisted-vocabulary and pure-transform extraction. Extracting
  effect-drive helpers further in this corrective wave would duplicate `RunLoopDO` transition and
  writer ownership, so any broader extraction is deferred to a separately scoped follow-up with no
  second loop, scheduler, journal, or writer.

### Hard-Won Lessons

- TypeScript `private` does not remove a method from Workerd's prototype RPC surface. Use an
  ECMAScript `#` helper for every internal `RunLoopDO` method, and expose harness controls only
  under an explicit, locally guarded `__...ForTest` name. Lock the full prototype allowlist, not
  just one known-sensitive helper name.
- A 500 ms real alarm is not a deterministic test clock under a busy Workerd suite. Keep an alarm
  safely future-dated during setup and move a valid persisted schedule row to due only at the
  controlled manual-alarm boundary.
- A durable state transition alone does not protect the external-effect-to-receipt interval. The
  intent must commit before I/O, recovery must reconcile by a durable runtime-owned key, and only
  then may the bounded receipt/state transition commit.
- V2 terminal evidence must not infer a permissive disposition from gate/outbox facts. Once such a
  fact exists, a consistent provider/egress/done disposition witness is mandatory.

### Prerequisites for Next Phase

- Keep HEY-177 In Progress until PR #69 is reviewed and merged; do not merge from this handoff.
- HEY-176 may define owner-attested frozen-source manifests and source replay completeness only
  after this receipt protocol is merged. It must not reopen provider/tool receipt ownership.
- A separately authorized production lane must supply a source owner, audited spend, a real sink,
  and receipt-capable provider/mutating-tool adapters before gateway or delivery enablement.
- Founder coordination update: after HEY-177 passes review and merges, Codex owns the separate
  Supabase/database harness lanes formerly reserved for Ashish/Claude (schema, migrations, RLS,
  pgTAP, and DO-to-Supabase custody). That is an ownership change only: this branch makes no
  Supabase schema/RLS edits and authorizes no staging or production mutation.

### Files Changed

- Contracts: `packages/contracts/src/index.ts`, runtime invocation/run/journal/loop-policy/evidence
  contracts and tests, `runtime/trusted-run-v2.{ts,test.ts}`, and `tools/handler.ts`.
- Runtime implementation: ContextComposer types; provider, Governor, journal/outbox, dispatcher,
  adapters, evidence, `RunLoopDO`, V2 helper, and tracer schema/journal modules.
- Runtime proof: DeliveryGate, Governor, provider, dispatcher, adapter, journal interface,
  run-loop/evidence, trusted V2 Workerd, and V2 property suites plus the Scribe Vitest config.
- Handoff: this file.

## Compound-learning capture

- **Lesson:** Workerd RPC visibility, durable effect receipts, and V2 terminal evidence are one
  safety boundary: hide general admission behind `#` helpers, persist intent before I/O, and require
  a disposition witness before accepting any delivery fact.
- **Mode:** Lightweight.
- **Track:** Bug/failure and knowledge/practice.
- **Overlap check:** searched `.claude`, `docs`, and runtime code for existing DO-RPC or receipt
  guidance; current provider/tool comments own adapter mechanics, but no foundation page owned this
  cross-boundary rule.
- **Destination:** this phase handoff, the smallest discoverable runtime-local artifact.
- **Source/provenance:** independent Standards/security/Spec/QA/health reviews, Workerd RPC
  prototype and controlled-alarm tests, V2 receipt crash tests, and
  `packages/contracts/src/runtime/evidence.test.ts` regression fixtures.
- **Applicability limit:** do not apply this pattern to ordinary read-only methods or use it to claim
  real-adapter exactly-once behavior without an adapter-owned reconciliation contract.
- **Eval/pressure scenario:** invoke a former public RPC name through a Workerd stub; evict after
  provider/tool I/O before receipt; forge V2 hold/drop/send/degrade evidence with wrong or absent
  disposition; and verify no duplicate effect or false terminal proof.
- **Refresh outcome:** Keep until a production adapter/source-manifest lane provides equivalent
  durable contracts and independently re-runs these pressure cases.
- **Evidence Trail:** HEY-177 PR #69, current Linear evidence comment, this handoff, contracts
  terminal-evidence regressions, and trusted Workerd crash/replay suites.
- **Impact surface:** RunLoopDO admission/RPC, provider/tool adapters, V2 persistence, Governor,
  DeliveryGate/outbox, evidence reader, ContextComposer replay, and privacy proof.
