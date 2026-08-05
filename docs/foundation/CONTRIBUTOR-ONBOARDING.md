# Waldo Backend Contributor Onboarding

**Status:** current onboarding entrypoint
**Updated:** 2026-08-05

## What you are joining

Waldo is one private, user-owned agent across personal assistance and work/agent orchestration. Kennel, mobile, web, messaging, and voice are presences of that same Waldo. Providers, tools, connectors, people, and local/cloud environments execute bounded capabilities; none owns Waldo identity, canonical personal context, Outcome truth, authority, Acceptance, or Open Loop closure.

The repository contains a trusted fake-first Durable Object RunLoop and broad contract/runtime foundations. The source-pinned architecture audit found useful effect intent, reconciliation, journal/outbox, governor, evidence, scheduling, and adapter seams, but not the complete Home + Work product. The default Worker route and missing product modules prevent any claim that the target architecture is shipped.

## Read before changing code

1. [`AGENTS.md`](../../AGENTS.md) and `.claude/rules/INDEX.md`.
2. [Current session entrypoint](./NEXT-SESSION-PLAN.md).
3. [Architecture lock](../planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md).
4. [Source-pinned final architecture](../planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md).
5. [Product capability matrix](../planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md).
6. [Agent operating workflow](./AGENT-OPERATING-WORKFLOW.md) and [local verification pipeline](./LOCAL-DEV-TESTING-PIPELINE.md).
7. Fresh source, tests, issue/PR state, and accepted ADRs for the touched seam.

Historical harness plans and phase handoffs are archaeology. They may explain an existing contract or compatibility test, but they cannot establish current work order, ownership, product scope, or shipped behavior.

## Architecture boundaries

- One owner maps to one canonical backend authority root.
- One named reducer is the durable writer for each aggregate. Use the architecture lock's definitive writer matrix.
- `WaldoCoordinator` authenticates, authorizes, and sequences; it does not bypass owning reducers.
- `RunLoopEngine` remains the trusted execution kernel and physical effect path during additive migration.
- Persist `EffectIntent`, frozen arguments, digest, and reconciliation key before external I/O.
- Never blindly retry an indeterminate effect. Reconcile first and expose a terminal user-visible resolution path.
- Context is compiled for a declared purpose, audience, destination, and data class. Memory is not permission.
- Credentials are brokered outside model-visible prompts, events, logs, artifacts, and checkpoints.
- Provider `done` is an observation. Evidence, Verification, Acceptance, Outcome state, and Open Loop closure are distinct.
- A disconnected presence cannot create/queue commands, approve, execute Waldo work, mutate truth, or claim completion under protocol 0.1.
- User corrections outrank inference. Raw health, full transcripts, credentials, and unrelated personal context are excluded from execution by default.

## Repository map

| Surface | Responsibility |
|---|---|
| `packages/contracts` | Versioned schemas, commands/events, adapter contracts, public DTOs, shared fixtures |
| `packages/runtime` | Durable Object runtime, trusted RunLoop, execution/effect foundations, adapters, persistence |
| `scripts/guards` | Static invariants for architecture, contracts, tooling, and agent instruction surfaces |
| `docs/planning` | Current target architecture, capability envelope, source notes, implementation boundaries |
| `docs/foundation` | Current contributor/verification procedures and historical implementation evidence |
| `supabase` | Migration/RLS/Vault surfaces; never mutate hosted environments without explicit authority |

## Working loop

1. Inspect current source and define the observable result.
2. Name the owning module, writer, contracts, stores, trust boundaries, and affected repositories.
3. Specify happy, null, hostile, concurrent, disconnected, cancellation, retry, restore/deletion, and rollback cases that apply.
4. Add or change behavior through tests first where practical.
5. Run adversarial review and the relevant contract/security/privacy checks.
6. Verify at the proof level being claimed; record gaps honestly.
7. Commit only intended files and leave a bounded workstream handoff when another session must continue.

## Proof language

Track capability delivery independently:

```text
architecture_specified
contract_defined
module_implemented
adapter_conformance_passed
cross_surface_acceptance_passed
operational_proof_passed
```

One status never implies the next. Use “target architecture,” “is designed to,” or “will” until the relevant implementation, conformance, acceptance, and operational proof pass. Do not claim universal uniqueness or operator-inaccessible privacy without the required market evidence or key-protocol proof.

## Verification

For documentation/instruction-only changes:

```bash
git diff --check
npx -y pnpm@10.34.4 verify:guards
```

For source changes, run targeted tests during development and the full repository gate before merge:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

Do not use `--passWithNoTests`, live credentials, production data, remote mutations, or unreviewed fallback paths to manufacture proof.
