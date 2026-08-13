# Waldo Backend Local Verification

**Status:** current merge and evidence standard
**Scope:** contracts, Durable Object runtime, Supabase migrations, static guards, and cross-repository responsibility flows

## Purpose

Tests prove a named invariant at a named proof level. They do not promote architecture, fixtures, fake adapters, or local success into shipped product capability.

Before changing code, read the [current session entrypoint](./NEXT-SESSION-PLAN.md), the [product and architecture convergence](../planning/WALDO_PRODUCT_ARCHITECTURE_CONVERGENCE_2026-08-11.md), the [capability matrix](../planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md), the [architecture lock](../planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md), the touched source/tests, and the accepted ADRs for the seam.

## Proof levels

Record these independently:

```text
contract
local_node
workers_runtime
local_supabase
cross_repo_conformance
live_adapter
staging
production
product_acceptance
```

A higher-sounding label is not implied by a lower one. In particular:

- schema parsing is not runtime behavior;
- a fake provider is not adapter conformance;
- provider `done` is not Outcome Verification or Acceptance;
- local tests are not staging or production proof;
- an external-effect receipt is not proof that the intended result remains true.

## Current command surface

Install with the repository-pinned package manager:

```bash
npx -y pnpm@10.34.4 install --frozen-lockfile
```

Full source/integration merge wall:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

`verify` currently runs the package-manager guard, frozen install, workspace and Node-integration
typechecks, contract tests, isolated Supabase verification, Workers runtime tests, the local
Auth/REST exact-token revocation integration, and static guards. Start the full local Supabase
stack, not only its database, before invoking this wall.

Documentation and instruction-only changes:

```bash
git diff --check
npx -y pnpm@10.34.4 verify:guards
```

Targeted development commands:

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts typecheck
npx -y pnpm@10.34.4 --filter @waldo/contracts test
npx -y pnpm@10.34.4 --filter @waldo/runtime typecheck
npx -y pnpm@10.34.4 --filter @waldo/runtime test
npx -y pnpm@10.34.4 verify:supabase
npx -y pnpm@10.34.4 verify:guards
```

Property and mutation lanes are targeted evidence, not substitutes for `verify`:

```bash
npx -y pnpm@10.34.4 verify:property
npx -y pnpm@10.34.4 verify:mutation
```

Do not claim a command exists until it is present in the current package scripts. Do not use `--passWithNoTests`, broad skips, or repeated reruns to manufacture green output.

## Change loop

1. **Orient:** record branch/SHA, dirty state, observable result, owning module/reducer, contracts, stores, trust boundaries, downstream consumers, and rollback.
2. **Write the failing proof:** use an exact schema rejection, deterministic policy case, Workers/DO test, Supabase contract test, or regression reproducer.
3. **Implement narrowly:** keep one writer per aggregate and one retry owner per call path. Do not add provider authority or a parallel DTO.
4. **Exercise degraded paths:** test the relevant null, hostile, concurrent, disconnected, timeout, cancellation, expiry, replay, account-switch, and restart cases.
5. **Run targeted checks:** use the smallest fast loop while editing.
6. **Run the merge wall:** use the commands above before a ready PR.
7. **Report evidence:** distinguish passed, failed, skipped, unavailable, and not-run checks.

## Required proof by surface

| Surface | Minimum merge evidence |
|---|---|
| Contract/schema | Strict valid/invalid cases, unknown-key rejection, semantic invariants, exports, typecheck, generated artifact freshness when applicable |
| Public gateway | Authentication/authorization, owner and presence binding, size/rate limits, replay/digest conflict, content-free errors |
| Durable Object state | Workers runtime test, SQLite inspection, deterministic replay, invalid transition, eviction/restart |
| External effect | Intent and frozen digest before I/O, same-key/different-digest conflict, apply-then-timeout reconciliation, one retry owner, expiry/cancellation |
| Provider/executor | Manifest/version pin, lease/fence, start/reconcile/cancel, truthful unsupported states, transcript and credential boundary |
| Evidence/verification | Candidate/admission boundary, source provenance, stale/indeterminate states, provider `done` cannot imply verification |
| Acceptance/continuity | Revision/evidence-digest binding, accept/reopen/release history, exact surviving OpenLoop/ReEntryPoint |
| Supabase migration/RLS | Migrate from zero, pgTAP/schema contract, canonical migration ordering, two-owner rejection when relevant |
| Cross-repository protocol | Shared golden fixtures, compatibility policy, backend/Kennel consumer conformance, no handwritten parallel truth model |
| Messaging presence | Verified webhook/interaction secret or signature, server-derived owner binding, normalized untrusted envelope, dedupe/replay/rate-limit tests, deterministic privacy/health redaction, durable delivery intent, reconciliation/terminal ambiguity, revoke/block/removal |

## Production-gate integration order

These are dependency and proof gates, not separate products. The [production run contract](./NEXT-BACKEND-SESSION-PROMPT.md) owns their exact issue map and acceptance criteria:

1. **B0:** reproducible repository baseline plus public route/OpenAPI parity;
2. **B1:** one contract-defined writer from product WorkUnit to trusted execution;
3. **B2:** durable Judgment, Evidence, Verification, Acceptance, OpenLoop, and ReEntry;
4. **B3:** ordered desktop/mobile/messaging presence contracts and daily interaction in health-connected and health-declined states;
5. **B4:** capability admission, credential custody, service-first Connections, real reversible effects, and real Telegram/Discord adapters;
6. **B5:** governed context, routines, schedules, recoverable laptop-off execution, and durable channel delivery/recovery;
7. **B6:** portability, deletion, Electron/mobile/Telegram/Discord staging, recovery, observability, rollback, and canonical production proof.

Run both complete proofs:

- “Publish this product update by Friday, but do not publish without my approval.”
- “Prepare me for tomorrow's investor meeting and make sure every follow-up is handled.”

Provider breadth, cloud workspaces, knowledge ingestion, MCP distribution, or dashboard breadth cannot substitute for this loop.

## Privacy and fixture rules

- Use synthetic data by default.
- Never commit credentials, production data, raw health values, full transcripts, or unrelated personal context.
- Keep owner IDs, provider payloads, logs, traces, snapshots, and error fixtures non-identifying.
- Surface requests cannot supply authoritative owner, actor, authority, credential, provider/model, Acceptance, or closure fields.
- Credentials remain outside model-visible prompts, events, artifacts, and checkpoints.
- Missing authorization, capability proof, or current consent fails closed.

## Cloudflare and Supabase boundaries

Use Workers Vitest for Worker APIs, Durable Objects, SQLite, alarms, bindings, eviction, and restart behavior. Node-only mocks cannot prove those semantics.

Default tests must not call Workers AI, external providers, hosted Supabase, messaging services, or production connectors. Supabase verification operates on disposable local containers unless the user explicitly authorizes a named external environment.

Live tests are opt-in and must name the environment, data class, credentials, expected cost, cleanup, and rollback. Missing prerequisites are `unavailable`, not passing.

## Failure classification

| Classification | Meaning | Required action |
|---|---|---|
| In-branch | The change broke a previously passing gate | Fix before merge |
| Introduced | A new proof fails because the work is incomplete | Complete the behavior; do not skip it |
| Pre-existing | Reproduces unchanged on the pinned base | Record exact evidence; do not hide it |
| Environment | Required local dependency or permission is unavailable | Report `unavailable` with the failed probe |
| Flaky | Same source/environment produces inconsistent results | Capture seed/timing and diagnose; do not rerun until green |

## Final report

```text
Changed:
- files and behavior

Verified:
- command -> result
- scenario/fixture/evidence path

Not run or unavailable:
- gate -> reason

Rollback:
- exact boundary

Residual risk:
- specific remaining uncertainty
```

Work is complete only when the claimed proof level is observed, privacy and authority boundaries remain intact, the relevant downstream contract is checked, and no stale instructions or generated residue remain in the diff.
