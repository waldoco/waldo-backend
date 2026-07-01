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

No publish machinery: the only emitted artifact is `packages/contracts/openapi/waldo-public-api.json`.

## Build order (dependency DAG)

Root (landed, green): `core/error` → `core/trigger` (leaf parts) → `model/roster` + toolchain wiring.
Then, in dependency layers: memory (`trust`→`pattern-id`→`hall`→`episode`→`sanitise`→`recall`)
→ `health/crs` → `prompt/narrative` → `runtime/routing` → `adapters/llm` → `ui/card`,`notification`
→ `adapters/*` → `tools/permissions`,`schemas`,`handler` → `core/hooks` → `memory/skill`
→ `auth/mint`,`consent` → `runtime/run`,`session`,`working-memory` → `scheduler` → `runtime/goal`
→ `governor` → `delivery` → `telemetry/*` → public DTOs + `emit-openapi` (leaf) → `verify.yml` CI wall.
`core/trigger`'s `invocationContext` is deferred to the wave after `core/user` + `health/crs` (it depends on both).

## Status

- [x] **Root** — `core/error`, `core/trigger` (leaf), `model/roster`; toolchain wiring; 15 tests green, strict typecheck clean.
- [ ] verify.yml CI wall (SHA-pinned actions) — next.
- [ ] Layer waves 1–N via parallel build workflow, `tsc`+`vitest` barrier between waves.
- [ ] Adversarial-verify pass, then Codex audit.

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
