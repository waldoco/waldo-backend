# Native36 fixture and adapter interface v1

Status: source contract, not an executed baseline. Core owns implementation of runner, effect custody and usage capture in #430/draft #433. Codex owns fixture source rows and fixture adapter definitions under this contract, not the core files named below. Changes to this contract require review before either side changes shape. Unsupported sources/effects stay blocked_fixture. No new model tools or prompt edits to manufacture benchmark coverage.

Pinned specification: `packages/runtime/evals/fixtures/Waldo_Benchmark_Cases_v2.jsonl`, SHA256 `fc651ed0e02bf53d3875d2497637f9f9309db794b6ce02386227a04b7155211f`. Target pre-prompt product HEAD: `8eae4bd1d1c8a3a3338a8c689f20ea2b1bd5077e`. Runner/fixture source fixes will have their own execution HEAD receipt; the pinned product baseline must not falsely be claimed unchanged if runtime behavior changes. Per-case sources/approval gaps: `docs/evals/native36-fixture-inventory.md`. All36 are currently blocked for full execution.

## Ownership and files

Codex authors JSON case bundles only under `packages/runtime/evals/fixtures/native36/v1/<case_id>.json` and adapter specifications under `packages/runtime/evals/fixtures/native36/v1/adapters.json`. Tests/docs for those bundles may accompany the PR. Core owns `evals/native-runner.ts`, `native-model-boundary.ts`, `native-manifest.ts`, `fixture-authority.ts`, `fixture-adapter-capture.ts`, `isolated-world-audit.ts`, `trial-result.ts`, `trial-provenance.ts`, `usage-reconciliation.ts`, native opt-in config/workflow and `scenarios/isolated-*` runtime adapter implementation. Do not touch these core paths from Codex without a coordinated transfer.

## Case bundle

```ts
type SourceRow = Readonly<{owner_id:string; id:string; [key:string]:unknown}>;
type Revision = Readonly<{at:string; owner_id:string; source:string; id:string;
  patch:Readonly<Record<string,unknown>>}>;
type NativeManifest = Readonly<{
  case_id:string; candidate_owner:string; control_owner:string;
  visible_prompt:string;
  world:{clock:string;owners:readonly {id:string}[];
    sources:Readonly<Record<string,readonly SourceRow[]>>;
    revisions?:readonly Revision[]};
  grants:readonly {owner_id:string;purpose:string;scope:string;
    allowed_effects:readonly string[];effective_at:string;expires_at:string}[];
  branches:readonly {id:string;trigger_at:string;owner_id:string;
    permitted_effects:readonly string[]}[];
  supported_tools:readonly string[];
  source_digest:string;
}>;
type NativeCaseBundleV1 = Readonly<{
 version:1; suite_digest:string; baseline_head:string; revision:string;
 manifest:NativeManifest;
 selected_source_ids:Readonly<Record<string,readonly string[]>>;
 // Evaluator-visible only, not additional owner instructions or model source rows.
 decisions:readonly {id:string;missing_spec_field:string;synthetic_value:unknown;
   rationale:string}[];
 turns:readonly {id:string;at:string;kind:'owner_text'|'provider_event'|'disconnect'|'reconnect'|'revoke';
   text?:string;payload?:unknown;source_decision_id?:string}[];
 required_source_families:readonly string[];
 required_effect_kinds:readonly string[];
 readiness:{sources_complete:boolean;branches_complete:boolean;
   provider_readback_complete:boolean;missing:readonly string[]};
}>;
```

Manifest type matches existing `evals/native-manifest.ts`; bundle fields are the new adapter handoff, not a claim the parser is already implemented. First owner_text must equal `visible_prompt`, which equals the original pinned case's `user_prompt` byte-for-byte. World clock equals pinned fixture clock. Exactly two distinct owner IDs; all rows/grants/events bind to one of them. Source row IDs need only be unique per owner per family. Candidate/control may deliberately share source IDs to test isolation. Revisions cannot change id/owner_id, must target existing rows and move strictly forward. `source_digest` is `sha256:` plus SHA256 of UTF-8 `JSON.stringify(manifest.world.sources)` preserving committed key order. Bundle revision is a nonempty immutable fixture revision, with full bundle byte digest recorded by core.

`selected_source_ids` restricts which candidate rows may be read for selected-source cases. Control/denied-family canaries must never be visible model context merely because present in the world. Expected answers, reference judgments, rubric, authority prose, decisions, canaries, tariff/error oracle and pass evidence are supervisor-only. Do not paste fixture.facts into the prompt in place of tool-accessible typed sources. Source content must include actual dates/versions/bytes/recipients/amounts/durations named by inventory. Clearly label synthetic completions of omitted author fields in decisions; never call them historical owner permission. Any unresolved load-bearing decision makes readiness false.

Later approval words are synthetic owner_text turns, not grants invented from rubric prose. Pin recipient/body/attachment/cart/event revision/amount as applicable before a branch effect. No silent escalation to purchase, human handoff, send, merge/deploy or blanket capture. Conditional approvals need the quoted synthetic grant plus independent fixture policy/readback. A delayed provider_event cannot grant authority. Turn timestamps must lie within matching grant/branch scope; later grants cannot revive expired approvals. Missing branch inputs stay blocked.

## Adapter specification and core runtime signature

```ts
type AdapterSpecV1 = Readonly<{
 version:1; revision:string;
 sources:readonly {family:string;row_fields:readonly string[];
   read_methods:readonly string[];selected_id_filter_required:boolean}[];
 effects:readonly {kind:EffectKind;state_family:string;
   required_payload_fields:readonly string[];requires_exact_approval:boolean}[];
}>;
type FixtureAdapter = Readonly<{
 read:(owner:string,family:string,id:string)=>Promise<SourceRow|null>;
 list:(owner:string,family:string)=>Promise<readonly SourceRow[]>;
 apply:(request:EffectRequest)=>Promise<EffectReceipt>;
 readback:(owner:string)=>Promise<SyntheticProviderStateV1>;
 accessLog:(owner:string)=>readonly SourceAccess[];
}>;
```

Core maps existing production connector signatures to this synthetic adapter. Codex specifies fields/method support, never invents model tools or a successful stub for an unsupported production capability. All reads logged with owner/family/id/clock, including denied or missing row accesses. Provider state lives separately from source rows and intercepted effects. Final state is collected directly from adapter custody, never supplied by model output or response text. Fail closed on missing method, denied source/owner, unknown effect, bad time or changed approved revision.

## Effects and provider state

```ts
type EffectKind = 'calendar.create'|'calendar.move'|'calendar.cancel'|
 'mail.draft'|'mail.send'|'watch.start'|'watch.stop'|'order.submit'|
 'order.cancel'|'refund.request'|'subscription.cancel'|'subscription.switch'|
 'executor.admit'|'capture.admit'|'preference.correct'|'responsibility.stop'|
 'consent.revoke'|'data.delete';
type EffectRequest = Readonly<{owner_id:string;kind:EffectKind;target:string;
 payload:unknown;idempotency_key:string;approved_revision:string|null}>;
type EffectReceipt = Readonly<{version:1;provenance:'synthetic_only';owner_id:string;
 kind:EffectKind;target:string;idempotency_key:string;payload_digest:string;
 state:'applied'|'rejected'|'unknown';provider_receipt_id:string|null;
 at:string;before_digest:string;after_digest:string}>;
type SyntheticProviderStateV1 = Readonly<{version:1;provenance:'synthetic_only';
 owner_id:string;families:Readonly<Record<string,readonly SourceRow[]>>;
 receipts:readonly EffectReceipt[]}>;
```

Taxonomy names are fixture-side custody labels, not proof each corresponding live capability exists. For existing calendar.create, core preserves compatibility with current calendar capture while extending before/after auditing. Do not replace existing legacy `candidate_calendar` fields unilaterally. Only core will migrate sealed-world packet/audit shape.

Owner+kind+idempotency_key identifies one effect intent. Same key with changed target/payload/approved revision is a conflict, not another effect. No key reuse across trials; retries and lost transport responses keep original intent identity. Unknown/pending is not failure or success and forbids blind resubmit. before/after digests are `sha256:` plus SHA256 of UTF-8 JSON.stringify of the canonical payload `{version:1,provenance:"synthetic_only",owner_id,families}`; receipts are excluded to prevent digest recursion. Canonicalize recursively: plain JSON object keys sorted by unsigned Unicode code-unit comparison (`a < b`), arrays preserve order except each top-level families[family] row array is sorted by exact row.id with the same comparator; duplicate IDs reject. Every row retains owner_id and all JSON fields, including null, false and zero. Reject undefined, non-finite numbers, bigint, functions, symbols and non-plain objects. Object insertion order is discarded recursively; strings/whitespace/case and numeric values are unchanged. JSON.stringify emits compact JSON without indentation, then UTF-8 bytes with no BOM or appended newline. Empty families are retained. This state-digest rule differs intentionally from existing source_digest committed-key-order rule. State family records are owner-labelled, stable IDs; approved payload fields compare exact bytes/values, not lowercased/partial matches. Every state delta must have a matching applied effect or declared timed provider revision; Rejected effects require no state delta. Unknown effect outcome is not a rollback/noncommit assertion: a lost transport response can follow an applied fixture effect and changed provider state. An unknown operation may have applied-but-unobserved delta; settle it only against declared/logged provider custody and original-intent readback. Never erase the delta to force unknown into failure, invent completion, or blindly retry. Any later settled receipt must bind to the same intent and observed delta; until then preserve unknown transport/outcome honestly. Provider event revisions such as refund pending -> credited are separately logged and never assumed from request acceptance. Control state starts nonempty where relevant and must remain equal to its initial snapshot, not merely an empty-array assertion.

Existing source `InterceptedEffect` remains `{owner_id,kind,target,payload,idempotency_key,at}` from `scenarios/isolated-source-world.ts`. Core binds it to new receipt and initial/final state with owner and operation identity. External send/order amounts need exact synthetic approval; executor/capture disclosure fields must enforce allowed packet/source set. If receipt/readback is unavailable, report unknown/blocked rather than fabricate completion. Synthetic receipt never upgrades to real provider truth.

## Capture receipts and usage

Use existing types/functions from `evals/trial-provenance.ts`, `grading-contract.ts`, `fixture-adapter-capture.ts`. `SealedReceipt` is `{case_id,seed,owner_id,field,digest,role,signature}`; seven fields are fixture_manifest/transcript/tool_trace/authority_timeline/source_revisions/intercepted_effects/final_state_readback. Roles runner/source_adapter/effect_interceptor/provider_readback are separately keyed in supervisor only. Signature keys are not fixtures, source JSON, model context or committed secrets. Artifact digest is `sha256:` plus SHA256 of exact captured bytes. No page/model/caller-authored final receipt accepted. HMAC verifies packet binding only; synthetic supervisor custody is not real external provider authority or billing proof.

OpenAI raw Responses receipt: response ID, returned model, input/output/cached token counts, request attempt sequence/status. Never create per-response billed_usd. Keep runner trace vs captured usage consistency separate from `estimate_not_bill` under pinned tariff and aggregate optional invoice reconciliation. Every failed/concurrent/retry model attempt counts toward finite chunk budget; only admitted OpenAI Responses route, no redirects. R33 remains blocked until an explicit tariff, exact research question, source snapshots, deterministic tool failure schedule, finite aggregate token/tool cost budget and deadline are pinned and reviewed.

## Ready versus blocked

Core validates source bundle bytes, ownership, per-case content and supported adapters before opening model key. Completeness booleans are declarations for review, not adequate proof alone. `inspectNativeManifest` currently covers only selected source families; green alone is not full-case readiness. Adapter/turn compatibility and exact fixtures must also pass. Six-case chunks maximum; report per-case blocked_fixture without model calls for missing inputs, and stop on harness/transport failure. Once harness-ready, an unavailable actual Waldo capability is an observed product limitation/failure, not a reason to replace it with an ideal mock answer. No reducing task workflows to read-only Q&A.

Independent five-criterion review remains excerpt-backed and outside the candidate model. Captured/review_pending/failed/candidate_pass_unverified are distinct. No official pass, leaderboard, live parity, deployed readiness or provider billing claim from fixture captures. Source suite execution_status stays not_run; separate per-run ledger carries observations. No prompt-related merge until baseline receipts exist.
