# Prompt and tool experiment foundation

This evaluator-only slice inventories existing static templates and compares diagnostic packets for explicit versions against pinned synthetic cases. Every report carries `evidence_kind: 'diagnostic_packet'`, `native_result_eligible: false` and `native_score: null`. These comparisons cannot produce native results or scores. It does not change runtime prompt assembly, dispatch, handlers or core producers. No runtime fetch, remote configuration, playground or Langfuse prompt-link attributes are added.

## Catalog

`catalog.v1.json` is generated from existing exports at source commit `c002d446327bfccb72cbe3e13492017f5c828b6d`. The stable names are `waldo.reply`, `waldo.reaction`, `waldo.memory-extraction`, `waldo.nightly-consolidation` and `waldo.day-planning`. The reply entry captures `MESSAGING_BEHAVIOR`; available tools remain a local factory input. Structured entries include the existing response schema. This is an inventory of those five requested templates, not every prompt fragment in the product.

Every entry has an explicit positive version, source symbol, source revision, local-input inventory and content digest. Instruction bytes, response schema and assembly metadata participate in the content digest. Version/source revision are provenance, outside the content digest; the bundle digest covers both. Digests detect changed bytes, not authorship or source authenticity. Regenerate only from a verified checkout, recording its actual source commit.

From `packages/runtime`, generate a candidate snapshot on stdout:

```sh
node --import tsx evals/prompt-experiments/generate.mjs <verified-source-commit-sha>
```

`loadPromptCatalog(bytes)` validates the schema, digests, complete five-template inventory and unique `(id, version)` pairs. `selectPrompt(catalog, id, version)` returns a verified independent copy. `appendPromptVersion(catalog, entry)` accepts only the next version and retains all older snapshots. For a future source change, build a new source snapshot, append its selected entry with the next version, and retain previous entries. Rollback selects the old version explicitly; no mutable “latest” alias exists. Never overwrite an old entry to bump it.

Owner memories, standing orders, clocks, exchange history and provenance fences are not captured in this static catalog. Production assembles them locally exactly as before. An experiment adapter must assemble its synthetic owner context through existing local seams. The comparison handoff contains the static instruction, schema, user request and tool definitions, not a complete production conversation. Do not insert rubric text or authority targets into that conversation.

`buildToolCatalog(handlers, version, sourceRevision)` reflects the **actual supplied handler set**, using the same `toolParameters(handler.schema)` conversion used by the provider-facing tool loop. It never calls `handle`, never assembles a second live registry, and never asserts that an unavailable handler is available. The supplied handler set is the experiment's tool manifest, not a claim to inventory every runtime tool.

The manifest records description, parameter schema, trigger allowlist, autonomy/state flags, idempotency flag and existing external-origin/privileged contract membership. Side-effect class is `privileged_action`, `state_mutation` or `unspecified`. Privileged membership reports `runtime_privileged_gate`; other approval requirements remain `handler_specific_unverified`. Missing `mutates_state` and `autonomy_gated: false` cannot prove read-only behavior or approval exemption. Handler-specific proposal/desk behavior still requires source review and independently verified authority evidence outside this diagnostic comparator. Keep generated tool manifests as explicit versioned snapshots, load with `loadToolCatalog`, and rollback by supplying the older snapshot. The comparison checks the selected snapshot against its supplied handlers before requesting packets; it does not dispatch or execute them.

## Comparison handoff

`compareExperiments(options, execute)` requests diagnostic packets for exactly two named variants for each selected pinned case/seed pair. Each variant specifies a prompt id/version, generated tool manifest and actual handlers for argument validation. `options.dataset_digest` must equal `WALDO_NATIVE_SUITE_SHA256`; the existing loader verifies the suite's exact bytes. The internal excerpt-check helper also loads the pinned reference judgments. A subset is reported as a subset, never as completion of the 36-case baseline. The callback name does not attest that an execution occurred.

The callback receives:

- `model_input`: selected static instruction, response schema, user request and handler-derived tool definitions. Reply tool availability uses the existing `messagingSystemPrompt` factory. No evaluator expected/forbidden behavior, authority rubric, pass evidence or reference judgment is passed here.
- `fixture`: pinned synthetic case data, separate from model-visible input. A diagnostic callback can author a packet without provisioning or executing a world; these bytes cannot prove it did either.
- `binding`: paired seed plus dataset, prompt, tool, fixture and assembled-input digests. Record the exact `binding`, `fixture` and `model_input` in the isolated capture's JSON `fixture_manifest` as `{experiment, fixture, model_input}`.

The callback returns `DiagnosticExperimentCapture`: `{capture, review, tool_review?, resolved_branches?}`. `capture` is the existing `IsolatedCapture` packet shape, with two declared owners and runner/source-adapter/effect-interceptor/provider-readback labels. The existing assembler rejects empty or mismatched owner/role labels. `gradeNativeOutcome` is used internally only as an excerpt-check helper. Its output is mapped into a new diagnostic review object; its result is never exposed. These checks validate receipt labels and bytes; they do not authenticate provider custody, reviewer independence or actual execution. Compare reports are diagnostic-only and ineligible as native results, including caller-authored packets with five positive findings and a matching `{experiment, fixture, model_input}` manifest.

The tool trace's evaluator normalization is JSON:

```json
{"format":1,"calls":[{"id":"call-1","name":"get_context","arguments":{}}],"latency_ms":12,"token_estimate":{"input":100,"output":25}}
```

Calls require unique ids. Latency and token estimates are caller-recorded diagnostic values, not authenticated duration or billing receipts. If recorded from a runner, latency represents its trial duration in milliseconds, not the sum of overlapping hop durations. Missing latency/token observations remain `null`. A proposed plan, invented tool trace or forged effect/readback packet can still satisfy byte checks; the report retains unverified proof labels in every case.

## Evidence layers

| Layer | Reported result | Limit |
|---|---|---|
| Code contracts | Handler/catalog compatibility, fixture/input byte binding, declared owner/role consistency, valid/invalid argument counts using real Zod schemas | `packet_structure_and_schema_only`; does not establish custody, dispatch, execution or runtime auth/approval |
| Diagnostic reviewer assertions | `useful_outcome` as claimed task completion; `authority` as claimed approval behavior | `caller_supplied_diagnostic_findings`; unusable reviews become unknown; even positive findings are not verified outcomes |
| Tool reviewer assertions | Appropriate-selection count and unnecessary-call count from caller-supplied per-call findings | No name/order heuristics; missing review or unknown findings remain null; reviewer proof always unverified; denominator is packet call count |
| Recorded measurements | Calls, latency and token estimates; paired latency/call deltas | Caller-recorded values, not authenticated timing or provider billing |
| Unverified source records | Claimed source revisions, authority timeline, intercepted effects and final-state readback, with original bytes/digests | Labels and digests cannot establish source/provider custody or durable effects. `unverified_source_records` retains the packet bytes for diagnostics only |

`tool_review` has `{binding, tool_trace_digest, reviewer, judgments, record}`. The full experiment binding and tool-trace digest must match this variant's packet, so a paired variant's review cannot be replayed even if its call ids and text match. Each judgment has `{call_id, appropriate, unnecessary, excerpt, explanation}`; yes/no/unknown are accepted for the two judgments. Every packet call must be covered once. The excerpt must occur in that call's serialized trace object. `record` bytes are exactly `JSON.stringify({binding, tool_trace_digest, reviewer, judgments})`, with matching SHA-256 and a source label. `tool_review_checks` reports only packet/excerpt matches; `reviewer_proof` remains `unverified`, including after every check passes. The five-criterion excerpt helper also cannot authenticate the caller's claimed independent reviewer.

Each row has `diagnostic_review`; paired status lists use `diagnostic_reviews`. The only exposed statuses are `diagnostic_incomplete`, `diagnostic_blocked`, `diagnostic_violation` and `diagnostic_findings_supplied`. No native helper status or `TrialResult` is returned. Top-level and per-row `evidence_limits` always keep `reviewer_proof`, `source_proof`, `custody_proof` and `execution_proof` visibly `unverified`, even when all five findings are positive. R33's unresolved fixture inputs remain a diagnostic incomplete result. Packet bytes may contain sensitive data; use synthetic inputs and do not commit live owner captures or credentials.

## Acceptance and merge gate

Local tests prove source parity, schema reflection without execution, catalog loading, bump/rollback integrity, paired byte bindings, diagnostic excerpt checking, visible missing proof and adversarial rejection. The two-version test uses **identical prompt content under versions 1 and 2** and caller-authored reviewer/packet records against pinned W02. Different diagnostic findings exercise report plumbing; they are not evidence that a prompt improved. Identical-content comparisons are labeled `identical_content_control` even when version numbers differ. Forged calendar/control-effect packets remain diagnostic-only and cannot yield a native score.

The PR must remain draft until the separate **actual 36-trial baseline harness run completes** with its independently collected evidence and held cases explicitly dispositioned. This module always reports `external_36_trial_run_required`; even 36 fabricated/unit-test rows cannot close that gate. This slice does not launch a paid provider run, change fixture pins, implement a provider runner or widen into sole-writer core producer seams. Prompt-to-trace linking awaits the separate typed core-owned handoff.

Real paired native comparison is a separate future integration through `evaluateCapturedTrial`, requiring typed ready `NativeManifest` bundles, custody, sealed-world audit and usage reconciliation. None of that integration is implemented or prepared in this PR. Diagnostic packet comparisons cannot bypass those gates or supply the native baseline.

Focused checks from the repository root:

```sh
pnpm --filter @waldo/runtime exec vitest run --config vitest.integration.config.ts integration/prompt-tool-catalog.test.ts integration/prompt-tool-experiment.test.ts
pnpm --filter @waldo/runtime typecheck:integration
```

The existing integration test gate includes these files automatically.
