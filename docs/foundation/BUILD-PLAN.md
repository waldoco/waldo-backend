# Waldo Backend — Foundation Build Plan

Living record of the greenfield contract-first rewrite. This is the document the auditing
reviewer (Codex) reads to check what was built, why, and against which source of truth.

- **Branch:** `greenfield/harness-foundation` (off clean `main`).
- **Collaboration model:** Claude authors the build (parallelized via grounding/build/verify
  workflows); Codex audits + adversarially tests the result against this plan and the ADRs.
- **Canonical sources:** the accepted ADR corpus (`waldo-brain/agent-rules/adrs.json`, 73
  accepted), the build bible (`WALDO_HARNESS_DEEPWIKI`), and the docs-grounded design spec
  produced by the `waldo-foundation-grounding` workflow (12 subsystem briefs + synthesis).

## Mandate

Every line earns its place: a root reason, first-principles, no patches, no speculative
abstraction, no unnecessary comments. Verify against library/platform docs — never assume.
Green tests + strict typecheck are the proof; nothing is "done" without them.

## Clean-slate mechanic

Legacy `waldo-backend` code (76-line DO stub, old wrangler/config) was removed from the
working tree; the prior in-flight state is preserved in a git stash and the prior Codex spine
lives on its own branches (`codex/hey-72-*`, `codex/hey-112-71-core-harness`) — recoverable,
not used as the build base (per founder decision to rewrite from scratch).

## Toolchain (verified current, exact-pinned)

| Package | Version | Why |
|---|---|---|
| zod | 4.4.3 | Contract SoR; native `z.toJSONSchema` is the OpenAPI-emit path (no codegen dep). One major across the contract seam (ADR-0029). |
| typescript | 5.9.3 | `strict` + `noUncheckedIndexedAccess`; `exactOptionalPropertyTypes` OFF (fights `z.infer` optionals). |
| vitest | 4.1.9 | Node env for pure Zod contract tests; plain `vitest run` (no `--passWithNoTests`). |
| wrangler | 4.105.0 | `wrangler.jsonc`; DO migration key `new_sqlite_classes`; compat_date ≥ 2026-02-24. |
| pnpm / node | 10.34.4 / ≥22 | Workspace; `@waldo/contracts` consumed via `workspace:*`, exports point at `./src` (internal packages consume source — no build/dist). |

`vite` is pinned to `8.0.16` via a pnpm override (root `package.json`): Vitest 4.1.9 pulls `vite`
transitively, its latest (`8.1.2`, published ~1 day before review) fails the supply-chain
release-age gate, and `8.0.16` (~30 days aged) sits in Vitest's `^6||^7||^8` range. Dev-only build
tool — not shipped to the runtime.

No publish machinery: the only emitted artifact is `packages/contracts/openapi/waldo-public-api.json`.

## Build order

Landed foundation sequence:

1. Root contract leaves: `core/error`, `core/trigger`, `model/roster`.
2. Phase A: CI/conformance wall, SHA-pinned GitHub Actions, `pnpm verify`, and repo guards.
3. Phase B: Cloudflare Workers/Durable Object runtime substrate in `@cloudflare/vitest-pool-workers`.
4. Phase C: scheduled durable-execution tracer bullet proving one alarm-driven path through
   Loop Governor, run journal, DeliveryGate, outbox, and fake sink with crash/resume exactly-once.
5. Phase C hardening: journal read validation for corrupt FSM rows, multi-line health-leak guard
   coverage, and a guard self-test so weakened health scanning cannot silently pass.
6. Phase D Wave 1: memory contract spine from ADR-0046/0005/0006/0024/0031/0037.
7. Phase D Wave 2: CRS and prompt contracts from ADR-0011/0028, with health-zone vocabulary
   single-owned by `health/crs` and consumed by prompt contracts.

Next dependency layers remain Phase D contract-spine work:
`runtime/routing` -> `adapters/llm`
-> `ui/card`,`notification` -> `adapters/*` -> `tools/permissions`,`schemas`,`handler`
-> `core/hooks` -> `memory/skill` -> `auth/mint`,`consent`
-> `runtime/run`,`session`,`working-memory` -> `scheduler` -> `runtime/goal`
-> `governor` -> full `delivery` -> `telemetry/*` -> public DTOs + `emit-openapi`.
`core/trigger`'s `invocationContext` is deferred to the wave after `core/user` + `health/crs`
because it depends on both.

## Status

- [x] **Root** — `core/error`, `core/trigger`, `model/roster`; toolchain wiring; initially
  verified with 15 root tests, strict typecheck, and an active 14-day release-age gate
  (vite pinned). The current full gate covers the expanded contract/runtime suites.
- [x] **Codex audit** (of commit 368e2b3) — verdict + dispositions below.
- [x] **Phase A CI/conformance wall** — SHA-pinned `.github/workflows/verify.yml`,
  `pnpm verify`, package-manager guard, stale-types guard, model-id guard, no-passWithNoTests
  guard, ADR-status guard, setAlarm guard, and health-leak guard.
- [x] **Phase B runtime substrate** — `@cloudflare/vitest-pool-workers`, Durable Object SQLite,
  alarm driving, and eviction-survival proof in workerd.
- [x] **Phase C scheduled tracer bullet** — minimal scheduled path through Governor, journal,
  DeliveryGate, outbox, and fake sink with crash/resume exactly-once proof.
- [x] **Phase C hardening** — corrupt journal states now fail at the read seam; health-leak guard
  catches multi-line raw-value shapes; guard self-test added.
- [x] **Local verification discipline** — documented in `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`.
- [x] **Phase D Wave 1 memory contracts** — `memory/pattern-id`, `trust`, `sanitise`, `hall`,
  `episode`, and `recall`; committed locally in `03b5d49`.
- [x] **Phase D Wave 2 CRS/prompt contracts** — `health/crs`, `prompt/skill`,
  `prompt/narrative`, and `prompt/reasons`; included in this PR branch.
- [x] **PR #7 mergeability** — GitHub currently reports PR #7 `OPEN`, non-draft, and `CLEAN`.
  Re-run the local gate and GitHub mergeability check before merging.
- [ ] **Phase D remaining waves** — routing/LLM, UI/adapters, tools/hooks, runtime
  run/session/working-memory, full delivery, telemetry, and public DTO/OpenAPI/generated-client
  freshness.

## Grounding flags & dispositions

HIGH (all resolved into the build; two are genuine defects in the source, flagged for audit):

1. **ADR-0068 golden invariant `agent_invocable ∩ budget:exempt = ∅` is provably false** —
   `fetch_alert` is both. Disposition: reformulate to "every agent-reachable exempt class has a
   non-null daily cap" when building `delivery`. Genuine ADR defect — flag for Codex.
2. **Legacy memory contracts predate ADR-0046** (no bi-temporal fields, wrong action enum).
   Disposition: build from ADR-0046, diverge from legacy.
3. Zod v3→v4 straddle → pinned v4, migrate idioms (done in root).
4. `modelName` phantom-id drift → `model/roster` is single owner, 3 canonical ids (done).
5. Public-DTO derivation leak → public DTOs re-declared independently in `src/public/`, never
   `.pick()`/`.omit()` from internal; `leak-check` scans the serialized artifact.
6. Art-9 leak into append-only logs → violation/pattern fields carry stable IDs, never raw text.

Vocabulary (single-owner, enforced): `modelName`←roster, `channelName`←`adapters/channel`,
`AdapterResult`+`ISO8601`←`core/error`; Zod-4 idioms package-wide; `Admission.verdict` =
`send|hold|degrade|drop` (`defer_next_day` deleted); `EngagementEvent` canonical (not KeepRate).

## Open downstream decisions / spikes (do not block the root)

- **`search_tools` union A/B** (ADR-0034 vs the 29-tool union) — decide when building `tools/permissions`.
- **ES256 mint `iss` must be a registered HTTPS issuer URL + JWKS cache-TTL** — needs a day-1
  staging spike (ADR-0066); gates the DO→Supabase data plane.
- **Outbox exactly-once authority per kind** + idempotency hash (SHA-256 + canonical serialization) —
  pin when building `runtime/run` + the outbox flusher.

## Historical Codex review verdict (commit 368e2b3)

Codex audited the root: approach sound, root ADR alignment passes, tests real-but-thin (roster +
canary mutation-confirmed real). Two blocks, both accepted + actioned:
- **(1) official commands failed under the release-age gate** (vite too new) → **fixed**: vite
  pinned to 8.0.16; verified green under an active gate + strict tsc.
- Tests strengthened: `error`/`trigger` now assert the exact enum tuple (change-detector), per review.
- **(2) CI wall absent** → later resolved in Phase A.

Additional dispositions:
- **ADR-0068:** build delivery from the current implementation block (`fetch_alert` exempt-but-
  counted, cap+cooldown-bounded), NOT the stale `agent_invocable ∩ exempt = ∅` invariant. Encode:
  every agent-reachable exempt class has a non-null cap.
- **`AdapterResult<T>`** stays a type helper at the contract layer, but adapter *runtime* boundaries
  need `adapterResultSchema(dataSchema)` + valid/invalid tests — do not replicate the type-only
  shape as the runtime validation pattern.

That review set the tracer-first sequence. That sequence is now complete through Phase C and the
post-review hardening commit. Do not use this historical section as the next-session plan.

## Current next step

Before merging PR #7, prove the pushed branch with:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

After PR #7 lands on `main`, the next safe unit is Phase D Wave 3: routing/LLM contracts with fake
providers only. Do not broaden runtime implementation before the relevant contract seam exists.
