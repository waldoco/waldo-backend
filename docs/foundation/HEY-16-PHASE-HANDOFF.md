## Phase HEY-16 → HEY-143 Handoff

Status: local implementation and review evidence are complete. HEY-16 remains **In Progress**
until its reviewed PR is merged. HEY-143 remains **In Progress** and receives no implementation
authority from this handoff.

### What Was Built

- [observed] A runtime-local `createRuntimePromptBuilder()` behind the existing generic
  `PromptBuilder<RuntimePromptContext>` Interface. It has seven internal REASONS layer renderers
  and no package-root export or new shared Contract.
- [observed] Canonical H14 selected skills render only through `renderBlock(selected.map(renderSkill))`.
  The builder loads before recall, passes only the top selected `trigger_condition` as its optional
  hint, and calls the existing recall gateway once.
- [observed] Operations wraps the single canonical `renderRecall(...)` result in the target
  memory-context presentation fence. It consumes injected typed conflict data and authority without
  inventing trust, a source read, or a permissive default.
- [observed] The N layer consumes typed persona facts and emits ADR-0035 functional framing for a
  `work_filter` persona. Unadmitted goals and workspace text render explicit absence.
- [observed] The builder snapshots pre-formed canvas values before its first asynchronous dependency
  call. It cannot lose an initially validated safeguards suffix through a caller-side canvas
  mutation while selection or recall is pending.

### What Works (with evidence)

- [verified] Seven-layer order, safeguards-final byte suffix, canonical fences, explicit absence,
  conflict authority, empty selection, recall-security-halt propagation, all-trigger snapshots,
  work-filter persona framing, concurrent isolation, and async canvas-mutation resistance pass in
  `packages/runtime/test/prompt-builder.test.ts`.
- [verified] Fake provider fallback coverage proves a fresh opaque H14 skill-budget capability,
  loader invocation, and selected fence on each retry. A block-scored synthetic canvas value is
  stopped by the existing provider Scribe gate before the fake gateway is called.
- [verified] `npx -y pnpm@10.34.4 --filter @waldo/runtime test -- prompt-builder.test.ts`:
  26 runtime test files / 706 tests passed.
- [verified] `npx -y pnpm@10.34.4 --filter @waldo/runtime typecheck` passed.
- [verified] Independent standards/spec, security, health-data, workflow-mapping, and adversarial
  QA reviews passed after the final canvas hardening.

### What Doesn't Work Yet (known issues)

- [blocked] **MEDIUM — fence integrity:** current canonical Scribe/recall-renderer vocabulary does
  not prove terminator integrity for every previously admitted value inside the outer memory fence.
  This is a canonical admission/renderer follow-up, not an H16 sanitizer-vocabulary change.
- [blocked] **MEDIUM — narrative resource boundary:** `NarrativeContext` is derived-only but does
  not establish H16-owned aggregate canvas budgeting or source admission for every free-text item.
  The existing provider Scribe gate remains final egress; do not add a total canvas cap here.
- [blocked] **HIGH — real source proof:** no profile, goal, workspace, conflict-pair provenance, or
  production `DominanceAuthority` hydration exists. The builder accepts typed fake inputs only.
- [blocked] **HIGH — operational proof:** no RunLoop wiring, real provider, sink, staging, R2,
  deployment, Alpha, or production evidence exists. HEY-143 retains its separately admitted
  provider-readiness scope.
- [blocked] **MEDIUM — recall liveness:** H15's all-sources-hang deadline/cancellation design is
  still a future real-adapter concern; H16 preserves its public gateway seam rather than adding a
  timer or retry policy.

### Architecture Decisions Made During This Phase

- [decision] Keep one deep runtime-local builder factory with injected loader and recall seams;
  do not add a second renderer, sanitizer, storage adapter, provider adapter, or cache policy.
- [decision] Preserve H14's selection/budget ownership and H15's retrieval/admission ownership.
  H16 composes returned values and does not inspect mutable source, query storage, or recalculate
  token budgets.
- [decision] Use `selected[0]?.trigger_condition` as the single optional recall hint. No skill
  body enters the hint.
- [decision] Render a fixed workspace and goal absence while their real admitted owners are absent.
  This does not amend the Master Reference or imply source failure telemetry.
- [decision] Use the ADR-0035 work-filter instruction in N-layer generation guidance, while leaving
  post-hoc channel slicing outside this builder.
- [decision] Snapshot only pre-formed canvas presentation inputs at invocation entry. This guards
  canvas integrity across awaits; it does not create a cache, write, hydration path, or new policy.

### Hard-Won Lessons

- [observed] A model-aware fenced fragment is attempt-bound: retry/fallback must rebuild it under
  the current opaque budget capability. Reusing a primary-attempt selection is an admission bypass,
  not a cache optimization.
- [observed] TypeScript `Readonly` does not freeze a value at runtime. When a pure builder awaits
  dependencies, it should snapshot its locally rendered inputs before the first await so the final
  safety suffix cannot drift.

### Prerequisites for Next Phase

1. [blocked] Open, review, and merge the HEY-16 PR; only then mark HEY-16 Done and remove its
   completed predecessor relations from the active blocker view.
2. [blocked] Run a fresh clean-main convergence wall across merged HEY-14, HEY-15, and HEY-16
   before HEY-143 closure planning.
3. [blocked] Before any HEY-143 implementation, create a new ticket-local ISA/ownership plan for
   real provider/staging work. Do not infer authority for R2, provider, sink, secrets, deployment,
   or source hydration from H16.

### Files Changed

- `packages/runtime/src/prompt/reasons.ts`
- `packages/runtime/test/prompt-builder.test.ts`
- `packages/runtime/test/__snapshots__/prompt-builder.test.ts.snap`
- `docs/superpowers/plans/2026-07-13-hey-16-reasons-canvas.md`
- `docs/superpowers/specs/2026-07-13-hey-16-prompt-builder-source-reconciliation.md`
- `docs/foundation/NEXT-SESSION-PLAN.md`
- `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
- `docs/foundation/HEY-16-PHASE-HANDOFF.md`

### Verification Boundary

- [verified] Final aggregate `npx -y pnpm@10.34.4 verify` passed the package-manager guard,
  frozen install, recursive workspace typecheck, and 50 contract files / 1206 tests.
- [verified] After its expected Supabase stop, `verify:workers` passed 26 runtime files / 706
  tests; `verify:property` passed 3 files / 258 tests; all 11 repository guards passed.
- [verified] Local fake-first composition and existing final Scribe-gate behavior are proven by
  tests. No fake gateway call reaches a network or provider.
- [blocked] The aggregate repository wall cannot complete locally while `supabase start` is not
  running. It stopped at `verify:supabase`; no service was started and no full wall pass is claimed.
- [blocked] `tools/eval/run-suite.ts` is absent. No separate eval-suite pass is claimed.
- [blocked] This handoff is not an end-to-end prompt, real-provider, staging, delivery, or Alpha
  acceptance claim.
