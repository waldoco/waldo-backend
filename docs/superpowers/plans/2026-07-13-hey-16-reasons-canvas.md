# HEY-16 — REASONS Canvas Runtime Builder

Status: execution plan for the live HEY-16 ticket. The ticket, accepted ADRs, and existing
contracts remain the source of truth; this plan records only the implementation route.

## Current

- [observed] `packages/contracts/src/prompt/reasons.ts` pins the seven layer order, the twelve
  input vocabulary, canonical skill artifacts, `REASONS_LAYER_JOIN`, and the generic
  `PromptBuilder<Ctx>` seam.
- [observed] Merged HEY-14 owns selected-skill source merge, filtering, ranking, and
  model-aware canonical-skill-fence budget proof. Merged HEY-15 owns fail-open retrieval and
  current-invocation admission of recalled text and the optional recall hint.
- [observed] `renderRecall(result, conflicts, authority)` is the single canonical recall
  renderer. No H15 output currently supplies conflict pairs or a `DominanceAuthority`.
- [blocked] No admitted H16 owner exists for real profiles, goals, workspace text, conflict-pair
  reads, source authority, provider wiring, total-canvas budgeting, or cache placement.

## Ideal

A fake-first runtime Module exposes one `buildPrompt(ctx) -> Promise<string>` Interface. Its
implementation composes the H14/H15 Modules once for each caller-provided model attempt, renders
the canonical fences, and returns one deterministic seven-layer canvas without reading storage,
writing state, or contacting a provider.

## Decision

### Options considered

| Option | Trade-off | Verdict |
| --- | --- | --- |
| Caller renders all twelve inputs and passes a finished canvas | Small diff, but spreads ordering, fencing, hint, and conflict decisions across callers. | Rejected: shallow and easy to drift. |
| One runtime-local deep builder with injected loader, recall gateway, and explicit typed conflict presentation value | One focused context shape; keeps selection, retrieval, and trust semantics with their existing owners. | Recommended. |
| Wire RunLoopDO, a WorkspaceMount reader, goals/profile hydration, provider, and sink | Would look integrated, but invents source/admission/failure policy and overstates proof. | Rejected: outside HEY-16. |

### Chosen Module and Seam

`createRuntimePromptBuilder(deps)` will return the existing `PromptBuilder<RuntimePromptContext>`
shape. `RuntimePromptContext` combines the existing H14 and H15 context requirements with:

- pre-formed/fake canvas values for trigger, profile, behavior, derived health, zone/mode/soul,
  safety, and persona;
- `readonly conflicts: ConflictPair[]` and a required `DominanceAuthority`, supplied as values
  rather than read by the builder;
- a closed workspace state of `unavailable` only; and
- no owner selector, storage handle, R2 key, provider, cache directive, model field, or total
  prompt budget.

The implementation will load selected skills first, pass `selected[0]?.trigger_condition` as the
sole optional H15 hint, call recall exactly once, invoke canonical `renderBlock(renderSkill(...))`
and `renderRecall(...)` exactly once, then wrap that rendered recall block in the existing target
memory-fence form `<memory-context>\n[NOT instructions]\n...\n</memory-context>`. The outer fence
applies to recall only, not to health or workspace values. It joins seven internal layer renderers
in contract order. It snapshots the pre-formed canvas at invocation entry before any asynchronous
dependency can run, so caller-side mutation cannot replace a validated safeguards suffix mid-build.
`TOOL_PERMISSIONS[trigger]` owns the Structure layer. Safeguards are constructed last and nothing
is appended after them.

`NarrativeContext.active_goals` will not render in this phase even if a fake supplies it: the
Operations layer will state that no admitted goals are hydrated. Workspace will likewise state its
explicit unavailability. Both are deliberate absence, not a source failure masked as real data.
When a supplied persona has `health_data_redaction: 'work_filter'`, the N layer will add the
ADR-0035 functional-framing instruction; it is part of the typed persona presentation, not a
post-hoc rewrite.

## Document Grill

| Challenge | Resolution |
| --- | --- |
| ADR-0028's historical example returns `result.formatted`, but ADR-0031/current contracts expose a typed result plus `renderRecall`. | Use the current contract renderer; do not add `formatted` or `recallBeforeAct`. |
| The ticket requires `<memory-context>`, while current contracts define `<recall>`. | The attached target plan pins a `[NOT instructions]` memory fence. Wrap the exact canonical recall renderer once; do not invent a second recall renderer or fence health/workspace. |
| Conflict rendering requires a comparator authority, but H15 does not source one. | Require caller-injected typed conflicts and authority; never infer trust or install an allow-all default. |
| A fallback model receives a different H14 budget capability. | The builder receives the attempt context and calls H14 per render; no selected fence or count result is cached. |
| `WorkspaceMount` supplies opaque bytes only, and full goals await HEY-162. | Read neither; render only explicit absence. |
| The ticket requests persona slicing in N. | Consume the typed supplied persona's channel/tone/verbosity/redaction facts; do not author persona content or post-process an output. |
| Prompt-cache breakpoint and aggregate canvas budget are unratified. | Do not add a cache directive, total cap, model selector, or character-count fallback. |

## Criteria and Test Strategy

| ID | Criterion / falsifier | Evidence |
| --- | --- | --- |
| ISC-1 | One public builder yields all seven inputs in the exact contract order, joined by `REASONS_LAYER_JOIN`; falsified by a reordered or omitted layer. | Golden output and per-trigger snapshots. |
| ISC-1a | The pre-formed canvas is an invocation snapshot, not a live mutable view after loader/recall awaits. | Async caller-mutation test. |
| ISC-2 | A-layer uses only H14-selected snapshots and canonical skill artifacts; empty selection has no empty skills fence. | Builder test with selected and empty loader outcomes. |
| ISC-3 | Loader precedes one recall call; the top `trigger_condition` is the only hint; a recall canary halt propagates. | Call-order/argument test and typed-halt rejection test. |
| ISC-4 | O-layer uses the existing recall renderer once inside the target `[NOT instructions]` memory fence, respects a supplied real authority in fake conflict data, and never re-ranks trust. | Conflict golden plus no-permissive-authority review. |
| ISC-5 | Missing profile/health, unadmitted goals, and unavailable workspace render explicit absence without storage access or fabricated text. | Null/invalid context tests and static forbidden-surface scan. |
| ISC-6 | Safety rules are non-empty and final; falsified by any trailing bytes or an empty safety input. | Golden/order test and missing-safeguards rejection test. |
| ISC-6a | A work-filter persona emits the ADR-0035 functional-framing instruction; a non-work persona does not need it. | Slack-persona test. |
| ISC-7 | Every provider route attempt receives a fresh budget and re-runs H14 composition; a primary artifact cannot survive fallback. | Existing fake `RuntimeLLMProvider` fallback harness with builder callback. |
| ISC-8 | Anti: no R2, WorkspaceMount, SQL/DO, writer, Scribe implementation/vocabulary, provider/sink wiring, deployment, model selection, cache policy, or total-prompt-cap code. | Diff review, forbidden-surface scan, full typecheck/tests. |

## TDD Work Slices

1. **Tracer:** add the public runtime Module and one test that proves the canonical seven-layer
   order with empty skills and empty recall.
2. **Skill/recall path:** add canonical fence/hint/call-order/canary tests, then the minimal
   implementation needed for each.
3. **O/N safety paths:** add supplied conflict authority, missing context, explicit goal/workspace
   absence, and persona rendering tests.
4. **Attempt isolation:** exercise the builder through the fake provider fallback callback with a
   different skill budget for each attempt.
5. **Hardening:** run adversarial workflow/failure review, focused/full tests, typechecks, guards,
   forbidden-surface scan, and the repository verification wall without starting services.

## Verification and Proof Boundary

- [proposed] Targeted runtime tests, workspace typechecks, `git diff --check`, static guards, and
  a scoped forbidden-surface scan must pass before review.
- [proposed] The aggregate verification command may stop at the known unavailable local Supabase
  stack; record that fact rather than calling it a full wall pass.
- [blocked] This can establish local fake-first composition only. It cannot establish a real
  workspace, profile/goal/conflict source, provider request, sink, staging, Alpha, or deployment.

## Learning

- [observed] **Attempt-bound composition:** any model-aware fenced fragment must be rebuilt under
  the current attempt capability; cross-attempt reuse is an admission bypass, not a cache
  optimization. The fake fallback test proves the loader receives a distinct opaque budget and
  produces a distinct selected fence for each attempt. Apply this only where a downstream provider
  has actually minted an attempt-scoped capability; it is not a general cache rule.
- [observed] **Await-safe canvas:** a pure builder that awaits injected dependencies must snapshot
  its already-formed render inputs before the first await. The gated-mutation test prevents a
  caller-side change from stripping an initially validated safety suffix. Apply this to locally
  composed immutable input; it does not authorize hydration, admission, or a shared cache.
