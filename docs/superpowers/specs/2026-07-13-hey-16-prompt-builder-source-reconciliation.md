# HEY-16 REASONS Prompt Builder — Source Reconciliation

Status: research-only input to HEY-16 planning. This note changes no runtime, contract, ticket, provider, storage, or deployment state.

## Scope and source precedence

- [observed] The live [HEY-16 Linear ticket](https://linear.app/heywaldo/issue/HEY-16/backend-reasons-canvas-prompt-builder-7-layer), read on 2026-07-13, names `packages/contracts/src/prompt/{reasons,narrative}.ts` and ADR-0028 as the authority. It says the contract is already shipped; the remaining work is a fake-first runtime builder in `packages/runtime`, with prompt-cache breakpoint placement deliberately out of scope.
- [observed] Accepted ADR-0028 controls the seven-layer composition, selected-skill placement, deterministic top-skill recall hint, and one builder seam. Accepted ADR-0031 controls the sole recall gateway, its fail-open behavior, and `<recall>` rendering. Accepted ADR-0046 controls conflict-pair authority and requires the shared `dominates()` comparator rather than an LLM decision.
- [observed] Existing TypeScript contracts are the executable tie-breaker where an older ADR illustration disagrees with another accepted ADR or the current public shape.

| Classification | Source | Reconciled fact |
| --- | --- | --- |
| [observed] | `packages/contracts/src/prompt/reasons.ts:11-73` | The seven layers, their order, the closed twelve-input vocabulary, byte-stable `REASONS_LAYER_JOIN`, and generic one-call `PromptBuilder<Ctx>` seam already exist. |
| [observed] | `packages/contracts/src/prompt/reasons.ts:75-104` | The A-layer skill serializer and empty-fence behavior already exist as canonical branded artifacts. |
| [observed] | `packages/contracts/src/memory/recall.ts:39-52,191-291` | `RecallGateway<Ctx>` returns typed `RecallResult`; `renderRecall(result, conflicts, authority)` owns the visible recall fence and conflict rendering. |
| [observed] | `packages/contracts/src/memory/trust.ts:81-114` | `DominanceAuthority` and `dominates()` are the sole comparator seam for conflict rendering and Scribe merge parity. |
| [observed] | `packages/runtime/src/skills/loader.ts:58-79,195-272` | HEY-14 already owns source merge, filtering, ranking, top-K, and canonical serialized skill-budget proof. |
| [observed] | `packages/runtime/src/recall/gateway.ts:99-189` | HEY-15 already owns a fake-first, fail-open recall gateway and returns its typed result without a prompt-builder or provider call. |
| [observed] | `packages/runtime/src/scribe/prepare.ts:19-48` | `prepareWithScribe()` is the existing single admission implementation; it validates, sanitises, preserves taint, and revalidates. |

## Current → ideal → gap contract

### Current

- [observed] The contract pins a closed REASONS order: Requirements, Entities, Approach, Structure, Operations, Norms, Safeguards; safeguards is last in `packages/contracts/src/prompt/reasons.ts:9-24`.
- [observed] The current loader returns an ordered, immutable `selected` array. It ranks priority pin, effectiveness, recent use, and name in `packages/runtime/src/skills/loader.ts:195-238`; its tests prove the snapshot survives asynchronous counter races in `packages/runtime/test/skill-loader.test.ts:416-462`.
- [observed] The current recall gateway accepts exactly one optional hint, Scribe-admits any nonempty hint as external input, omits ordinary rejected hints, and raises a typed halt for a current canary in `packages/runtime/src/recall/gateway.ts:192-205`.
- [observed] The current runtime has no `packages/runtime/src/prompt/*` module. A repository search finds the `PromptBuilder` name only in prompt contracts/tests, while the fake run loop still renders fixed system strings at `packages/runtime/src/run-loop/do.ts:725-739,864-894`.
- [observed] `NarrativeContext` is strict and derived-only, but no runtime context hydrator exists: `packages/contracts/src/prompt/narrative.ts:5-19`.
- [observed] The current H15 handoff records that a prompt builder owns canonical recall rendering, conflict authority, and composition at `docs/foundation/HEY-15-PHASE-HANDOFF.md:22-27`.

### Ideal

- [observed] ADR-0028 places trigger context in R, user profile in E, behavior plus selected skills in A, trigger ACL in S, recall plus health plus workspace in O, zone/mode/soul in N, and safety rules last in S: `waldo-brain/01-Waldo/Architecture Decision Records (ADR)/0028-skill-loader-prompt-builder-integration.md:130-176`.
- [observed] ADR-0031 requires deterministic recall before generation, a visible fenced recall block, and continuation on retrieval failure: `waldo-brain/01-Waldo/Architecture Decision Records (ADR)/0031-recall-before-act-wiring.md:97-198`.
- [observed] ADR-0046 requires renderer conflict tags and ordering to use the same code comparator as the merge path, never model-selected authority: `waldo-brain/01-Waldo/Architecture Decision Records (ADR)/0046-external-truth-invalidates-memory.md:41-43,199-204`.
- [observed] The live HEY-16 ticket requires separate internal layer functions, a single external `buildPrompt(ctx)` seam, exact safeguards-last ordering, fenced memory/skills, snapshot tests, explicit absence for null optional context, and fake-first behavior without a provider implementation.

### Gap

- [blocked] H15's public `RecallResult` contains hits, `query_used`, and duration only; it contains neither `ConflictPair[]` nor a `DominanceAuthority` provider. H15's runtime context likewise has no conflict source: `packages/contracts/src/memory/recall.ts:39-46,191-247` and `packages/runtime/src/recall/gateway.ts:82-97`.
- [blocked] Full goal hydration is not available. HEY-162 remains the owner of durable Scribe-backed goal admission, so a builder must not manufacture active goals from storage: `docs/foundation/HEY-144-PHASE-HANDOFF.md:80-87,112-117`.
- [blocked] `WorkspaceMount` exposes opaque `Uint8Array` blobs and versions, not a prompt-safe workspace-text result: `packages/contracts/src/adapters/workspace.ts:4-44`. No H16 source authorizes an R2 read, decode, binding, or a `workspace_file` sanitizer destination.
- [blocked] No accepted source supplies a full-canvas token cap or cache-breakpoint algorithm. H14 proves the selected skill fence against its own model-aware per-fragment/block budget; it does not establish a total canvas envelope: `packages/runtime/src/skills/budget.ts:15-33` and `packages/runtime/src/skills/loader.ts:240-272`.
- [observed] The H15 handoff pre-dates its merge and still says “In Progress” at `docs/foundation/HEY-15-PHASE-HANDOFF.md:1-5`, while this research worktree is based on `be8af3a feat(runtime): implement HEY-15 recall gateway (#64)`. [inference] The code commit is the current implementation source; the handoff status is historical publication text.
- [observed] The live HEY-16 Linear issue is In Progress as of 2026-07-13 and still records H14/H15 as historical `blockedBy` relations. [inference] The merged status of those predecessors satisfies the implementation gate; relation cleanup is coordination metadata, not a new runtime dependency.

## Canonical ownership and boundaries

| Classification | Owner | H16 may do | H16 must not do |
| --- | --- | --- | --- |
| [observed] | Prompt contracts | Consume layer order, input vocabulary, serializer revision, `renderSkill`, and `renderBlock`. | Change the contract or reproduce a serializer. |
| [observed] | H14 `RuntimeSkillLoader` | Call `loadForTrigger(ctx)` once and consume its ordered selected snapshots. | Re-filter, re-rank, recount, re-read mutable skills, or use unselected candidates. |
| [observed] | H15 `RecallGateway` | Call `recall(ctx, hint?)` once after selected skills are known; consume its fail-open typed result. | Retrieve, fan out, query-build, retry, add a second recall wrapper, or turn recall failure into a prompt-builder failure. |
| [observed] | `renderRecall` plus ADR-0046 comparator | Render the existing `RecallResult` through the canonical renderer with supplied typed conflicts and authority. | Infer trust from content, create an allow-all authority, or let an LLM resolve a conflict. |
| [observed] | Scribe | Rely on H14/H15 admission and the existing provider egress path. | Add a sanitizer, alter sanitizer vocabulary, or reclassify taint. |
| [observed] | HEY-162 / future context sources | Accept only already-formed fake/typed health, profile, and goal inputs for this bounded builder. | Add a goal reader/writer, owner routing, or hydration source. |
| [observed] | Workspace reader/writer owner | Render a fixed explicit absence in the H16 fake-first path. | Read `WorkspaceMount`, decode a blob, add R2 binding/configuration, or commit a workspace write. |
| [observed] | Provider / HEY-143 | Leave provider routing, spend, egress, staging, sink, and deployment outside this module. | Claim a real provider path or Alpha proof. |

## Reconciled ordering and top-skill hint

- [observed] ADR-0028 says the loader-derived hint comes from the top selected skill before the canonical `recall(ctx, hint?)` call, and expressly says `recallBeforeAct(ctx, skills)` is not an exported function: `.../0028-skill-loader-prompt-builder-integration.md:179-223`.
- [observed] ADR-0031 says the optional hint is the third query component after trigger and zone signals, bounded with the query: `.../0031-recall-before-act-wiring.md:41-59`.
- [observed] H14's selected order is deterministic, and H15 conservatively treats the passed generic hint as external before it can enter a query or `query_used`: `packages/runtime/src/skills/loader.ts:214-238` and `packages/runtime/src/recall/gateway.ts:192-205`.
- [proposed] The builder should load first, use `selected[0]?.trigger_condition` only when present, pass no skill body as a query hint, then await the existing gateway before rendering O. This is the smallest top-selected-skill-derived hint and preserves H15’s existing current-invocation admission path.
- [observed] The exact `deriveHintFromSkill` bytes are not pinned by ADR-0028 or ADR-0031. ADR-0031 gives “first skill’s name + trigger_condition” as an example, not a serializer contract. [proposed] HEY-16 pins the conservative `trigger_condition`-only local choice in a behavior test rather than creating a new serializer.
- [observed] H14 Scribe-admits mutable `body_markdown` as `skill_body`, but copies the trusted record’s `trigger_condition` without a Scribe pass: `packages/runtime/src/skills/mutable-reader.ts:462-489`. [inference] H15’s external-taint re-admission of the composed hint is therefore the required safety boundary for that route; H16 must preserve it by calling H15 rather than composing a recall query itself.

## Conflict and authority reconciliation

- [observed] The current contract deliberately makes `renderRecall(result, conflicts, authority)` the canonical renderer, and `DominanceAuthority` contains injected `inDomain` and `hallAdmits` predicates: `packages/contracts/src/memory/recall.ts:217-291` and `packages/contracts/src/memory/trust.ts:81-114`.
- [observed] ADR-0046 requires conflict data to be code-stamped and uses the same `dominates()` implementation for Scribe and renderer behavior: `.../0046-external-truth-invalidates-memory.md:41-43,137-153,199-204`.
- [blocked] A builder cannot invent conflict pairs or a truthful authority from H15 result content. H15 currently admits only `memory_hits`, `episode_hits`, and no evolution records in its fake implementation: `packages/runtime/src/recall/gateway.ts:157-185`.
- [proposed] Keep conflicts and authority as explicit, typed builder inputs in the fake-first context. Tests may provide a deterministic fake pair and matching authority. Production source ownership remains outside H16; an empty typed conflict list is valid, but a permissive default authority is not.

## Proposed minimal deep module

- [proposed] Add one runtime-only prompt module behind the existing `PromptBuilder<RuntimePromptContext>` type. It receives the existing loader and recall dependencies by injection and returns one canvas string. Its internal layer renderers are pure functions; it has no storage, network, provider, logger, writer, or clock dependency.
- [proposed] Snapshot the supplied pre-formed canvas before the first asynchronous dependency
  awaits. This is an invocation-integrity copy only: it does not hydrate, admit, cache, or mutate
  caller data, but prevents a caller-side mutation from removing a previously checked safeguards
  suffix or changing rendered layer values mid-build.
- [proposed] `RuntimePromptContext` should structurally include the existing H14 loader fields and H15 recall fields, plus already-formed canvas values, typed conflict inputs, and a closed workspace absence state. This keeps caller knowledge at one explicit seam and avoids inventing a new shared contract before the actual context-hydration owner exists.

```ts
// [proposed] Runtime-private shape; no contract change in HEY-16.
type RuntimePromptContext = RuntimeSkillLoadContext & RuntimeRecallContext & {
  readonly canvas: {
    readonly triggerContext: string;
    readonly userProfile: string | null;
    readonly triggerBehaviour: string;
    readonly healthContext: NarrativeContext | null;
    readonly zoneModifier: string;
    readonly modeTemplate: string;
    readonly soulBase: string;
    readonly safetyRules: string;
    readonly workspace: { readonly kind: 'unavailable' };
  };
  readonly recallConflicts: readonly ConflictPair[];
  readonly dominanceAuthority: DominanceAuthority;
};
```

- [proposed] The orchestration sequence is: (1) `loadForTrigger(ctx)`; (2) derive the single optional hint from `selected[0]`; (3) `recall(ctx, hint)`; (4) call canonical skill and recall renderers; (5) assemble seven nonempty layer strings in `reasonsLayerSchema.options` order with `REASONS_LAYER_JOIN`; (6) return the canvas. Safety rules are constructed last and nothing is appended after them.
- [proposed] The Structure layer should derive its tool list solely from `TOOL_PERMISSIONS[ctx.trigger]`, as the live ticket requires, instead of accepting caller-provided tools. A missing/invalid profile, health input, or workspace source renders an explicit bounded “no data available” form; it does not fabricate facts.
- [proposed] The Operations layer should always use `renderRecall()` so even an empty/fail-open result produces `[Consulted memory before acting]`. It should render the typed `NarrativeContext` only when supplied and the workspace-unavailable literal until an admitted reader exists.
- [observed] ADR-0035 requires the N layer to add a functional-framing instruction whenever the
  supplied typed persona has `health_data_redaction: 'work_filter'`; merely rendering the enum
  would not enforce work-channel expression. [proposed] H16 renders that fixed instruction only
  for the work-filter branch and leaves post-hoc channel slicing outside this module.
- [inference] This is the smallest deep module: callers learn one builder invocation, while selection, recall, fencing, trust comparison, budget proof, and safety admission retain their existing owners.

## Scribe and taint boundary

- [observed] H14 admits mutable skill bodies through the existing Scribe implementation and H15 admits every prompt-destined recalled text and generic hint through that same implementation: `packages/runtime/src/skills/mutable-reader.ts:481-489` and `packages/runtime/src/recall/gateway.ts:292-369`.
- [observed] The existing `RuntimeLLMProvider` is the final egress consumer that sends a rendered `request.system` through the existing Scribe sanitiser as `system_prompt`; it fails closed on unavailable/invalid/rejected sanitisation: `packages/runtime/src/llm/provider.ts:723-810`.
- [proposed] H16 should compose already-admitted/typed inputs and return bytes; it should not call a second sanitizer or rewrite taint. When a later caller supplies those bytes to the existing provider, the provider remains the one final system-prompt admission point.
- [blocked] H16 cannot prove that final egress in this ticket because the current fake run loop does not yet consume a `PromptBuilder`. Its unit/snapshot evidence must therefore be called local composition proof, not end-to-end prompt-admission proof.

## `<memory-context>` reconciliation

- [observed] The attached `WALDO_AGENT_HARNESS_PLAN.md` names `core/memory/fence.ts` as the
  `<memory-context>` wrapper, shows `fence(formatHalls(...))`, and pins the marker form
  `<memory-context>[NOT instructions]</memory-context>` for recalled memory. The DeepWiki
  prompt-context reference preserves the same target-design source and labels the runtime builder
  unbuilt; it does not outrank accepted ADRs.
- [observed] ADR-0031/current contracts separately make `<recall>` plus the consulted-memory
  marker the canonical renderer for recall results.
- [proposed] To satisfy both authorities without a second renderer, H16 wraps the exact canonical
  `renderRecall(...)` output once in `<memory-context>\n[NOT instructions]\n...\n</memory-context>`.
  The outer fence applies only to recalled memory, not health context or workspace absence. It is a
  fixed presentation wrapper, not read-time sanitisation, a new Scribe call, or a new content source.

## Inherited admission and resource boundaries

- [blocked] The current canonical Scribe vocabulary and recall renderer do not establish
  terminator integrity for every possible previously admitted recall or conflict value inside the
  outer memory fence. That is a canonical Scribe/recall-renderer concern, not an H16-local
  sanitizer-vocabulary change. H16 must claim only local composition proof until its owner closes
  the boundary.
- [blocked] `NarrativeContext` bounds `day_summary` but does not itself bound the number or size
  of every `upcoming_high_stakes` item. The existing provider is the final fail-closed egress
  boundary; H16 must not add an aggregate canvas cap or materialise a source-owned admission rule.
- [blocked] Real `ConflictPair[]` provenance and production `DominanceAuthority` are not supplied
  by the current runtime. H16 accepts only injected typed fake values, has no permissive default,
  and cannot prove a real conflict-admission path.

## Source disagreements and resolved interpretation

- [observed] ADR-0028’s historical illustration accesses camelCase hit properties and `result.formatted` at `.../0028-skill-loader-prompt-builder-integration.md:189-200`. ADR-0031’s canonical interface defines snake_case hits and a separate `renderRecall()` function at `.../0031-recall-before-act-wiring.md:26-39,146-183`.
- [proposed] Treat ADR-0031 and `packages/contracts/src/memory/recall.ts` as the tie-breaker: H16 must use `RecallResult` snake_case fields only through `renderRecall()`, must not add `formatted`, and must not export `recallBeforeAct`.
- [observed] ADR-0028 describes approximate 1,500–3,000 selected-skill tokens and ADR-0031 describes approximate 200–800 recall tokens, but neither establishes aggregate canvas budgeting or a cache split: `.../0028-skill-loader-prompt-builder-integration.md:282-291` and `.../0031-recall-before-act-wiring.md:209-217`.
- [proposed] Preserve H14’s existing selected-skill budget proof unchanged and leave total-canvas cap/cache decisions out of H16. Add only deterministic canvas snapshots and, if a future source supplies a full prompt budget, consume it behind a separately admitted seam.

## Acceptance evidence implied by the sources

- [proposed] Test all seven layers in canonical order and assert `safetyRules` is the final byte sequence.
- [proposed] Test zero selected skills produces no empty `<available-skills>` fence, while selected skills render via the canonical `renderBlock(selected.map(renderSkill))` bytes.
- [proposed] Test the selected-order-to-hint path: loader ordering determines the one hint; no selected skill means `undefined`; body text never enters the hint.
- [proposed] Test a H15 empty/fail-open result still emits the canonical `<recall>` marker and no prompt-builder exception.
- [proposed] Test a supplied conflict pair uses the injected authority and canonical `renderRecall`; reject any implementation that calculates trust from strings.
- [proposed] Test null profile, null `NarrativeContext`, and workspace-unavailable paths render explicit absence without fabricated values or a read attempt.
- [proposed] Test raw-health-looking, instruction-looking, and canary-bearing candidates through the existing H14/H15/provider Scribe paths; H16 tests should prove it does not call a second sanitizer or change taint.
- [proposed] Use snapshot coverage per trigger type with synthetic, non-health content. Keep tests fake-first and assert no `WorkspaceMount`, R2, provider, sink, or deployment adapter is invoked.

## Explicit non-goals and open choices

- [blocked] Real conflict-pair sourcing, `DominanceAuthority` production implementation, and ADR-0046 union-read provenance are not H16 sources. The builder can consume typed fake inputs but cannot prove the real path.
- [blocked] Full profile, narrative, goal, and workspace hydration are not H16 sources. HEY-162 and a future workspace reader/admission owner retain those responsibilities.
- [blocked] Prompt-cache breakpoint placement, aggregate full-canvas token budgeting, provider calls, live model choice, staging, sink effects, and deployment remain out of scope under the live ticket and build plan.
- [blocked] The exact neutral copy for missing profile/health/workspace and the exact top-skill hint delimiter are implementation choices not ratified by the cited ADRs. They require deterministic fixtures and no architecture change.
- [observed] The harness build plan still says HEY-143 has no wired production context, recall, skills, or prompt hydration proof at `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md:135-147`. [inference] A passing H16 fake-first suite is local composition proof only and cannot close HEY-143.
