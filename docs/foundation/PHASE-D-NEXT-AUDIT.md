# Phase D Next Contract Audit

Date: 2026-07-03
Branch: `codex/phase-d-next-contracts`
Baseline: PR #7 squash-merged into `main`

## Verdict

Ready for PR after the verification wall passes on the final diff. This branch is a contract
spine, not runtime expansion. It correctly adds typed seams for channel adapters, tools,
hooks, auth minting/consent, and memory-skill lifecycle without live providers, production
data, or broad runtime behavior.

## Source Set Checked

- Accepted ADRs in `waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`.
- DeepWiki pages in `waldo-brain/01-Waldo/waldo-harness-deepwiki/`, especially app surfaces,
  tools/permissions, memory/scribe, substrate parity, and reference appendices.
- Current branch code under `packages/contracts/src`.
- Current public repo pages for Hermes and Pi:
  - `https://github.com/NousResearch/hermes-agent`
  - `https://github.com/earendil-works/pi`
- Local Waldo Brain reference notes for deeper Hermes/Pi architecture:
  `03-References/repos/hermes-agent.md`, `03-References/repos/pi-mono.md`, and
  `04-Agent-Harness/harness-runtime-architecture-2026-06-26.html`.

## What This Branch Adds

- `adapters/channel`: channel names/persona slicing, Telegram inbound identity gates,
  binding state, peer identity, message/thread binding, send receipt, and adapter seam.
- `tools/permissions`: canonical 30-tool union with `search_tools` as first-class lazy
  discovery, trigger ACLs, always-on tools, and execute_code typed but undispatchable.
- `tools/schemas`: read, write, and threading arg schemas with strict Zod bounds and
  source-owned vocabularies.
- `tools/handler`: dispatch result shape, external-origin taint stamping, handler ACL
  conformance, and taint-to-privileged-action direct-execution block.
- `core/hooks`: 9 accepted hook events, hook result contract, PreToolUse/PostToolUse
  priority constants, autonomy gate, and taint gate seam.
- `memory/skill`: skill curator lifecycle contract, provenance locks, trial thresholds,
  archive/stale states, and agent-authored trigger denylist.
- `auth/mint` and `auth/consent`: contract-only minting/refresh shape, consent records,
  withdrawal, per-purpose/per-source consent classes, and active-consent helper.
- `packages/contracts/src/index.ts`: exports the new contract modules from the package root.

## Engineering Audit

The branch follows the "small interface, deep implementation" direction. Runtime code sees
compact seams: `ChannelAdapter`, `ToolHandler`, `HookHandler`, mint requests/responses, consent
records, and skill rows. The larger policy is under those seams: ACLs, strict schemas, taint
gates, consent classes, and lifecycle state are explicit contracts instead of prompt text.

One slop issue was found and fixed before PR: `reads.ts` duplicated mutating tool schemas owned
by `writes.ts`, and `search_tools` was duplicated outside `tools/permissions`. The branch now
has one owner for each contract surface:

- mutating tool arg schemas live in `tools/schemas/writes.ts`
- lazy discovery schema lives with `tools/permissions.ts`
- memory block content cap imports `MEMORY_BLOCK_CONTENT_MAX` instead of restating a number

No TODO/FIXME/HACK markers, skipped tests, `as any`, `@ts-ignore`, or console logging were found
in the WIP contract files during review.

## ADR Alignment

Aligned:

- ADR-0008: per-trigger ACL is the security boundary.
- ADR-0012/0035/0067: channel persona and Telegram identity gating are contract-visible.
- ADR-0021/0034/0039/0050: tool union, lazy discovery, threading tools, and deferred
  execute_code are represented without widening current ACLs.
- ADR-0029: backend-owned workspace contracts are the source of truth.
- ADR-0032: hook event lifecycle and priority bands are typed.
- ADR-0049: external-origin results carry required `source_taint`; privileged action direct
  execution blocks when tainted.
- ADR-0064: memory-skill curator lifecycle is represented.
- ADR-0066: minting is contract-only, with ES256 staging spike still required.
- ADR-0073: consent is per-source, per-purpose, versioned, and withdrawable.

Not claimed:

- no real Supabase RLS/JWKS mint execution
- no runtime dispatcher
- no scheduler multiplexer
- no run/session/working-memory reconciliation
- no public OpenAPI/generated client yet
- no live provider or dogfood lane

## Adversarial Review

Attack questions checked:

- Can a trigger get every tool? No. `execute_code` is in the union but no trigger grants it.
- Can `search_tools` widen permission? No. It is granted only to lazy-discovery triggers;
  loading never bypasses `TOOL_PERMISSIONS`.
- Can external web/doc/MCP content become untainted? No. External result schemas require a
  non-null external taint stamp.
- Can tainted content directly execute privileged action tools? No. The handler/hook contract
  exposes a pure block predicate and separate taint gate.
- Can the model write the facts hall? No. Mutating memory write schema excludes `facts`.
- Can auth minting imply runtime readiness? No. Docs now state it is contract-only and still
  needs staging/JWKS/RLS runtime work.

Residual risk:

- `search_tools` is first-class and bounded, but ranking quality is still runtime work. Hermes
  has more specificity here with ranked discovery and describe/call separation.
- Error-classifier mapping for model/provider failure recovery remains implementation latitude
  under the future runtime wave.
- Contract tests are strong for schemas and static invariants, but scenario/property/mutation
  evidence is still target-only.

## Hermes And Pi Benchmark

Current public-source check:

- Hermes remains a shipping, multi-platform agent repo with gateway, cron, tools, plugins,
  skills, tests, and a self-improving learning-loop claim.
- Pi now resolves to `earendil-works/pi`; its README exposes packages for coding-agent CLI,
  agent core, unified LLM API, and TUI. It also states default Pi has no built-in permission
  sandbox and must be containerized or sandboxed for stronger boundaries.

Comparison:

- Waldo is now ahead of Pi's default stance on permission safety for health data because ACL,
  taint, consent, and deferred execute_code are typed before runtime.
- Waldo is ahead of Hermes/Pi on contract discipline for Art-9-style health constraints:
  source-owned Zod schemas, health leak guards, strict trigger ACLs, and no live providers in
  default gates.
- Hermes is still ahead on shipped product surface: gateway adapters, cron, tool discovery depth,
  auto-resume, skill/curator runtime, and user-facing operations.
- Pi is still ahead on interactive coding-agent ergonomics: session tree, steering/follow-up
  queues, compaction/retry, and extension packaging.
- Waldo's intended advantage is different: Durable Object run journal, exactly-once outbox,
  consent/mint/RLS boundary, and health-safe memory/contracts. This branch moves that from
  architecture into package-level contracts, but not into full runtime proof.

## Next Step

After this PR lands, the next branch should implement:

1. `runtime/run`, `runtime/session`, and `runtime/working-memory` contracts.
2. Scheduler/goal contracts that consume the trigger, hook, tool, auth, and memory-skill seams.
3. Runtime integration tests in the Workers pool, including crash/resume and ACL reset behavior.
4. Then delivery expansion, telemetry, public DTO/OpenAPI, generated-client freshness, and
   scenario/property/mutation lanes.
