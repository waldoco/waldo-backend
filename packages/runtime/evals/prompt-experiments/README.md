# Prompt and tool experiment foundation

This evaluator-only slice inventories existing static templates and compares explicit versions against the pinned synthetic native suite. It does not change runtime prompt assembly, dispatch, handlers or core producers. No runtime fetch, remote configuration, playground or Langfuse prompt-link attributes are added.

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

The manifest records description, parameter schema, trigger allowlist, autonomy/state flags, idempotency flag and existing external-origin/privileged contract membership. Side-effect class is `privileged_action`, `state_mutation` or `unspecified`. Privileged membership reports `runtime_privileged_gate`; other approval requirements remain `handler_specific_unverified`. Missing `mutates_state` and `autonomy_gated: false` cannot prove read-only behavior or approval exemption. Handler-specific proposal/desk behavior still requires source review and captured authority evidence. Keep generated tool manifests as explicit versioned snapshots, load with `loadToolCatalog`, and rollback by supplying the older snapshot. The comparison verifies the selected snapshot against its real handlers before any execution.

## Comparison handoff

`compareExperiments(options, execute)` runs exactly two named variants for each selected pinned case/seed pair. Each variant specifies a prompt id/version, generated tool manifest and actual handlers for argument validation. `options.dataset_digest` must equal `WALDO_NATIVE_SUITE_SHA256`; the existing loader verifies the suite's exact bytes. The existing native grader also loads the independently pinned reference judgments. A subset is reported as a subset, never as completion of the 36-case baseline.

The callback receives:

- `model_input`: selected static instruction, response schema, user request and handler-derived tool definitions. Reply tool availability uses the existing `messagingSystemPrompt` factory. No evaluator expected/forbidden behavior, authority rubric, pass evidence or reference judgment is passed here.
- `fixture`: the pinned synthetic case world to provision, separate from model-visible input. Source/tool adapters decide what the model may observe through existing authority boundaries.
- `binding`: paired seed plus dataset, prompt, tool, fixture and assembled-input digests. Record the exact `binding`, `fixture` and `model_input` in the isolated capture's JSON `fixture_manifest` as `{experiment, fixture, model_input}`.

The callback returns `{capture, review, tool_review?, resolved_branches?}`. `capture` is the existing `IsolatedCapture`, with two distinct owners and runner/source-adapter/effect-interceptor/provider-readback roles. The existing assembler rejects empty, wrong-owner or wrong-role receipts. The experiment checks manifest binding and invokes **the existing `gradeNativeOutcome`**, preserving its result and reasons. These checks validate receipt labels and bytes; they do not authenticate provider custody, reviewer independence or actual execution.

The tool trace's evaluator normalization is JSON:

```json
{"format":1,"calls":[{"id":"call-1","name":"get_context","arguments":{}}],"latency_ms":12,"token_estimate":{"input":100,"output":25}}
```

Normalize real runner observations; do not manufacture this trace from a proposed plan or model answer. Calls require unique ids. Latency is the runner's measured trial duration in milliseconds, not the sum of overlapping hop durations. Token counts are estimates reported by the adapter; they are not billing receipts. Missing latency/token observations remain `null`. Report adapter/model provenance separately when interpreting these measurements.

## Evidence layers

| Layer | Reported result | Limit |
|---|---|---|
| Code contracts | Handler/catalog compatibility, pinned fixture/input identity, isolated receipt owner/roles, valid/invalid argument counts using real Zod schemas | Does not dispatch or prove runtime auth/approval gates executed |
| Independent judgment | Native `useful_outcome` as task completion; native `authority` as approval behavior | Broad native rubric findings, not a new automatic task-success or approval oracle; unusable reviews become unknown |
| Tool judgment | Appropriate-selection count and unnecessary-call count from independent per-call findings | No name/order heuristics; missing review or unknown findings remain null; denominator is observed call count |
| Recorded measurements | Calls, latency and token estimates; paired latency/call deltas | Recorded observations, not authenticated timing or provider billing |
| Execution evidence | Source revisions, authority timeline, intercepted effects and provider final-state readback, with original bytes/digests; capture and review artifacts retained | A tool return, schema validity or model claim does not prove a durable effect. Provider readback plus durable effect receipts require external verification |

`tool_review` has `{binding, tool_trace_digest, reviewer, judgments, record}`. The full experiment binding and tool-trace digest must match this variant's capture, so a paired variant's review cannot be replayed even if its call ids and text match. Each judgment has `{call_id, appropriate, unnecessary, excerpt, explanation}`; yes/no/unknown are accepted for the two judgments. Every observed call must be covered once. The excerpt must occur in that call's serialized trace object. `record` is a captured artifact whose bytes are exactly `JSON.stringify({binding, tool_trace_digest, reviewer, judgments})`, with matching SHA-256 and source label. The native independent review retains its existing stricter five-criterion contract. Neither review may be produced by the model being evaluated and presented as independent evidence.

Reports preserve `incomplete`, `blocked`, `fail` and `candidate_pass_unverified`; they never emit an official pass. R33's unresolved fixture inputs remain an existing grader hold. Captured receipt bytes may contain sensitive data: use sealed synthetic worlds and do not commit live owner captures or credentials.

## Acceptance and merge gate

Local tests prove source parity, schema reflection without execution, catalog loading, bump/rollback integrity, paired bindings, real native-grader invocation, unknown handling and adversarial rejection. The two-version test uses **identical prompt content under versions 1 and 2** and synthetic reviewer/capture records against pinned W02. Different grade outputs exercise report plumbing; they are not evidence that a prompt improved. Identical-content comparisons are labeled `identical_content_control` even when version numbers differ.

The PR must remain draft until the separate **actual 36-trial baseline harness run completes** with its independently collected evidence and held cases explicitly dispositioned. This module always reports `external_36_trial_run_required`; even 36 fabricated/unit-test rows cannot close that gate. This slice does not launch a paid provider run, change fixture pins, implement a provider runner or widen into sole-writer core producer seams. Prompt-to-trace linking awaits the separate typed core-owned handoff.

Focused checks from the repository root:

```sh
pnpm --filter @waldo/runtime exec vitest run --config vitest.integration.config.ts integration/prompt-tool-catalog.test.ts integration/prompt-tool-experiment.test.ts
pnpm --filter @waldo/runtime typecheck:integration
```

The existing integration test gate includes these files automatically.
