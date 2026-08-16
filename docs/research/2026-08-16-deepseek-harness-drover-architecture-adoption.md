# DeepSeek Harness and Drover — Waldo backend architecture adoption

**Checked:** 2026-08-16
**Status:** source-pinned research and proposed architecture constraints; not shipped behavior, a runtime dependency decision, or a change to the active B2–B6 issue frontier
**Issue:** [#132](https://github.com/Pin4sf/waldo-backend/issues/132)

## Executive decision

The official name is **DeepSeek Harness (`dsh`)**, not “DeepSea Harness.” The inspected systems supply complementary mechanics:

- [DeepSeek Harness at `47f943859`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a) is the benchmark for reversible runtime composition, one causal model-visible session log, one tool-policy seam, ordered effects, durability barriers, and interrupted-turn repair.
- [Drover at `4b9ac521`](https://github.com/arniesaha/drover/tree/4b9ac5211d520953b7b05519e8b243f5768167cc) is the benchmark for host-local execution custody separated from a replayable context plane, source-preserving provider adapters, fact/projection provenance, degraded optional workers, and quiescent fleet updates.

Adopt these mechanics only beneath Waldo's existing ownership split:

```text
Waldo backend owns
  owner routing · authority · Outcome · WorkUnit · Evidence · Verification
  Acceptance · OpenLoop · governed durable memory · cross-surface truth

Kennel owns
  local process/provider custody · workspaces/worktrees · runtime lifecycle
  provider-native sessions · ordered observations · local effect receipts

Providers own
  model/tool execution and native session state
  completion is an observation, never canonical responsibility closure
```

No active runtime or contract code is changed by this research. In particular, the document does not overlap the active #84 contract work.

## Source and maturity boundary

| Source | Pin | What it can establish | What it cannot establish |
| --- | --- | --- | --- |
| DeepSeek Harness | `47f943859bef60e4160492346772ded9b24f765a`, developer preview `0.1.0-rc.5`, MIT | public source design, package boundaries, local runtime mechanics, test/release posture | runtime reliability, independent security, stable API, distributed custody, Waldo semantics |
| Cordis | `8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4`, MIT | officially linked upstream design language | exact equivalence to the vendored/modified runtime |
| Drover | `4b9ac5211d520953b7b05519e8b243f5768167cc`, source `0.3.2`, Apache-2.0 | public command/context architecture, storage, adapters, auth, update and CI mechanics | multi-user security, sandboxed execution, production scale, hosted recovery |

Static inspection did not build, credential, benchmark, penetration-test, or deploy either project. Repository claims are not represented as Waldo capability.

One read-only dependency-consistency check was run against Drover: `uv lock --check` with the locally available `uv` and CPython 3.14.6 resolved 65 packages and failed because `uv.lock` needs an update, consistent with `pyproject.toml` reporting `0.3.2` while the lock's root package reports `0.3.1`. This is lock-drift evidence, not a runtime failure claim.

## First-principles comparison

| Harness responsibility | DeepSeek Harness | Drover | Waldo requirement |
| --- | --- | --- | --- |
| Composition | Cordis services/events/reversible plugins, ordered profiles | explicit hub/daemon/collector/worker components and adapters | locked domain kernel with replaceable providers and evaluated manifests |
| Execution | local agent loop and coherent capability providers | host daemon owns local process, PTY and provider adapter | Kennel executes under server-derived grant; backend never pretends to own local process |
| Authority | approvals, monotonic guards, sandbox modes | bearer trust domain and provider-native controls | purpose-, data-, destination-, budget-, and effect-scoped grants that narrow across delegation |
| Causality | append-only model-visible session event log | ordered harness events plus Parquet events/spans | frozen attempt manifest plus ordered observations and effect receipts |
| Recovery | flush barriers, interrupted-turn repair, explicit missing results | dedup keys, receipts/jobs/attempts/artifacts, host reconciliation | recover/reconcile before reissue; unknown effect is first-class |
| Projection | model surface, trajectory, replay/fork/query | DuckDB views, summaries, briefs, decisions, embeddings | projections are ContextClaim candidates, never canonical Outcome or memory truth |
| Completion | turn/session terminal state | session/job/artifact terminal state | independent Verification plus authorized Acceptance/open/reopen/release |

## DeepSeek mechanisms to adopt

### Reversible lifecycle ownership

Cordis gives every registration an owning scope and disposal path. Harness teardown waits for quiescence, then disposes scoped resources and detaches registries.

Backend/Kennel constraint: every provider connection, process, terminal, tool registration, watcher, worker, approval waiter, lease, and projection subscription has one owner, cancellation path, drain deadline, idempotent disposal, and terminal observation.

### Model-visible means logged

The session event stream is the source of context, replay, fork, query, trajectory, compaction, and repair. Request/context records, assistant chunks/messages, tool calls/results, and lifecycle boundaries remain causally reconstructable.

Backend constraint: an `ExecutionAttempt` must freeze and correlate the authority revision, capability manifest, context source hashes, provider/version, native session, workspace root, and budget. This ledger is execution evidence and cannot write Outcome Acceptance.

### One effect pipeline

Direct tools and Code Mode subcalls converge on pre-execute middleware, approval, monotonic guards, provider execution, result normalization/finalization, observers, and durable result.

Backend constraint: direct tools, generated code, MCP, dynamic tools, terminals, subagents, approval resumes, and recovered work all cross one evaluated authority/effect seam. The prompt-visible and dispatchable capability views must be identical.

### Ordered commit under concurrency

DeepSeek dispatches parallel tools in a bounded pool but commits results/model context in model order. Exclusive tools create barriers. Cancellation drains started calls and emits explicit terminal results for calls not started.

Backend constraint: parallel Work Units/evidence gathering may execute concurrently, while consequential effects are barriers and receipt/evidence order remains deterministic.

### Interrupted evidence repair

Cold recovery synthesizes missing tool errors and closing step/turn records while preserving the turn as interrupted. It does not erase partial work into a clean success.

Backend constraint: partial attempts reconcile into explicit `interrupted`, `unknown`, and `reconciled` states. Repair cannot manufacture acceptance.

## Drover mechanisms to adopt

### Command/context plane separation

The hub/host command plane has a different latency and failure budget from the Parquet/DuckDB analytical context plane. Drover moved live registry state to a separate DuckDB file after discovering that locks did not isolate analytical scans from the shared DuckDB scheduler/buffer/memory budget.

Backend constraint: local command custody, session intelligence/projections, and canonical Waldo aggregate truth remain separate Modules. Summary, embedding, or analytics failure must not stop raw evidence capture or controllable work.

### Host-local process authority

`drover-harnessd` owns processes, structured sessions, PTYs, and filesystem access. The hub routes but does not claim remote process authority.

Backend constraint: Waldo Cloud owns grants, commands, revisions, and canonical state; Kennel owns the actual local process lifecycle. Heartbeats and registry rows are observations, not process truth.

### Fact/projection/provenance split

Drover stores append-oriented event/span facts in Parquet, normalized views and operational state in DuckDB, and replaceable summaries/briefs/decisions/embeddings with generator/source/attempt/supersession provenance.

Backend constraint:

```text
ExecutionObservation → Evidence candidate → Verification
Derived ContextClaim → confirmed/corrected/rejected/released durable state
Provider completion → never automatic Outcome Acceptance
```

### Provider honesty and raw fallback

Drover normalizes common provider message kinds, retains native session identities, and degrades unparseable output to `raw`. Its DeepSeek adapter explicitly reports positional turn correlation because the consumed RPC surface has no turn ID.

Backend constraint: provider adapters declare version, transport, resume, approval, correlation, and enforcement completeness. Protocol drift yields `degraded`/`raw`, not dropped evidence or invented exactness.

### Quiescent fleet updates

Drover installs beside the active runtime, waits for no structured work or attached terminal, treats uncertainty as busy, flips a symlink, and automatically rolls back if the new version cannot rejoin the hub.

Backend/Kennel constraint: provider, plugin, and runtime updates define quiescence, atomic activation, handshake proof, rollback, and version-skew negotiation. Version convergence cannot interrupt user work silently.

## Proposed future contracts

The shapes below are research inputs for the appropriate future contract issue; they are not current code.

### Capability provider manifest

```ts
interface CapabilityProviderManifest {
  providerId: string;
  providerVersion: string;
  capabilityDefinitionId: string;
  transport: "app-server" | "rpc" | "mcp" | "stdio" | "pty" | "local";
  correlation: "native-turn-id" | "session-seq" | "positional" | "raw";
  enforcement: {
    fileRead: "full" | "partial" | "unavailable";
    fileWrite: "full" | "partial" | "unavailable";
    process: "full" | "partial" | "unavailable";
    network: "full" | "partial" | "unavailable";
    credential: "full" | "partial" | "unavailable";
    device: "full" | "partial" | "unavailable";
  };
}
```

### Effect receipt

```ts
interface EffectReceipt {
  effectId: string;
  attemptId: string;
  capabilityId: string;
  authorityGrantId: string;
  state: "denied" | "not-started" | "started" | "succeeded" |
         "failed" | "cancelled" | "unknown" | "reconciled";
  externalId?: string;
  inputHash: string;
  resultHash?: string;
}
```

`unknown` is not equivalent to failed and does not permit blind reissue.

### Derived context claim

```ts
interface ContextClaim {
  claimId: string;
  sourceObservationIds: string[];
  kind: "summary" | "decision-candidate" | "preference-candidate" |
        "open-loop-candidate" | "artifact";
  status: "derived" | "confirmed" | "corrected" | "rejected" | "released";
  generatorKind: "deterministic" | "model" | "human";
  generatorVersion: string;
}
```

## Security disposition

| Upstream behavior | Disposition |
| --- | --- |
| DeepSeek local workspace-write approval pipeline | Adapt as one layer; add read, network, credential, device, and provider-egress policy |
| DeepSeek same-UID YAML credentials | Reject as a security boundary; broker scoped credentials outside model-readable files |
| DeepSeek `danger-full-access` / never ask | Reject as ordinary Waldo/Kennel mode |
| DeepSeek loopback Web RPC without remote auth/TLS | Local provider-only; never expose as Waldo remote control |
| Drover individual revocable bearer credentials | Adapt pairing/revocation mechanics |
| Drover any credential effectively controls every host | Reject; bind credentials/grants to owner, surface, host, capability, and expiry |
| Drover private LAN/tailnet boundary | Useful reachability fence, insufficient authorization |
| Raw/full transcript telemetry | Reject by default; use classified, minimized, previewable evidence bundles |

## Adopt / adapt / reject

| Decision | Pattern | Waldo boundary |
| --- | --- | --- |
| Adopt | causal model-visible log | execution evidence only |
| Adopt | reversible lifecycle and disposal to quiescence | applies to every runtime resource |
| Adopt | single tool/effect policy pipeline | add Waldo authority, purpose, budget and data/destination checks |
| Adopt | bounded concurrency with ordered commit/barriers | deterministic Evidence and receipts |
| Adopt | interrupted repair without erasure | explicit partial/unknown/reconciled states |
| Adopt | host-local process custody | Kennel owns actual local process lifecycle |
| Adopt | fact/projection provenance | generated records remain replaceable candidates |
| Adopt | raw provider fallback | protocol drift remains inspectable |
| Adopt | quiescent update/rollback | protect active work |
| Adapt | plugin graph | below locked domain reducers only |
| Adapt | profiles | frozen versioned evaluated attempt manifests |
| Adapt | trajectory | authority + effect + evidence + verification + acceptance lanes |
| Adapt | context summaries/decisions/open loops | candidate ContextClaims requiring governed promotion |
| Reject | context inheritance implies authority | child grant is explicit intersection |
| Reject | provider/session completion implies responsibility closure | Verification and Acceptance remain separate |
| Reject | private network or local process authority implies safe effect | require purpose, scope and effect policy |
| Reject | one fleet bearer domain | incompatible with scoped Waldo authority |

## Conformance requirements

Every future Kennel adapter should prove:

1. one evaluated catalog feeds model visibility and dispatch;
2. denied capability cannot execute through raw name, Code Mode, MCP, terminal, or subagent;
3. child authority cannot exceed parent grant;
4. duplicate and stale commands are rejected/idempotent;
5. crash before/after dispatch creates truthful receipts;
6. unknown external effects reconcile before retry;
7. parallel completion still commits causally;
8. provider drift degrades to raw evidence;
9. interruption repairs history without false completion;
10. unload/update drains or records explicit interruption;
11. raw transcript export requires preview, classification and consent;
12. provider `completed` cannot mutate Outcome Acceptance.

## Current → ideal → gaps

### Current

Through B1, Waldo has public-contract reproducibility, authenticated owner routing, full-command replay identity, one committed execution writer, server-derived authority, recover-before-execute, stale-observation rejection, and a deterministic local/fake WorkUnit start path. Kennel has real Codex custody and richer local orchestration, but those capabilities do not establish the joined B2–B6 responsibility loop.

### Ideal

One owner-authorized WorkUnit freezes its capability/grant/context manifest, executes through a capability-declared Kennel adapter, records ordered observations and classified effect receipts, returns minimized Evidence, passes independent Verification, and reaches authorized Acceptance, reopen, or OpenLoop state.

### Gaps

1. no generalized cross-provider capability manifest/conformance wall;
2. no proved single effect pipeline across every Kennel execution path;
3. no joined causal attempt/effect/evidence ledger across backend and desktop;
4. no cross-platform enforcement-completeness vector;
5. no completed real-provider Evidence → Verification → Acceptance/OpenLoop loop;
6. no uniform provider-degraded/raw projection;
7. no quiescent provider/plugin update contract;
8. no executable cross-harness outcome/effect-recovery benchmark.

### Anti-criterion

No provider `completed`, tool success, generated summary/decision/open-loop label, PR merge, or delivered message may write Outcome Acceptance directly.

## Verification and falsifier

Future adoption is real only when at least two structurally different providers pass the same authority, cancellation, crash, duplicate, protocol-drift, ordered-commit, recovery, disclosure, and no-auto-acceptance fixtures.

Simplify or reject the design if a spike shows that capability manifests cannot represent provider differences honestly, one effect seam cannot cover the available transports without bypass, or the causal/provenance machinery adds material friction without improving recovery, authority leakage, Evidence quality, or owner confidence.

## Sources

- [DeepSeek official page](https://deepseek.com/harness/en/)
- [DeepSeek architecture](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md)
- [DeepSeek agent lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/agent-lifecycle.md)
- [DeepSeek tool pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/tool-execution-pipeline.md)
- [DeepSeek persistence](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/persistence.md)
- [DeepSeek safe-use policy](https://deepseek.com/harness/en/privacy/)
- [Drover architecture](https://github.com/arniesaha/drover/blob/4b9ac5211d520953b7b05519e8b243f5768167cc/docs/architecture.md)
- [Drover context store](https://github.com/arniesaha/drover/blob/4b9ac5211d520953b7b05519e8b243f5768167cc/docs/context-store.md)
- [Drover integrations](https://github.com/arniesaha/drover/blob/4b9ac5211d520953b7b05519e8b243f5768167cc/docs/integrations.md)
- [Drover security](https://github.com/arniesaha/drover/blob/4b9ac5211d520953b7b05519e8b243f5768167cc/docs/security.md)
- [Drover multi-host and update model](https://github.com/arniesaha/drover/blob/4b9ac5211d520953b7b05519e8b243f5768167cc/docs/multi-host.md)
