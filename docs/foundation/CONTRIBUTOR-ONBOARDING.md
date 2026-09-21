# Waldo Backend Contributor Onboarding

**Status:** current onboarding entrypoint
**Updated:** 2026-09-21

## What you are joining

Waldo is one private, user-governed personal agent with a stable personality, correctable memory, health-aware planning, bounded actions, and continuity across the Waldo app and officially supported remote presences. App and push are first; Telegram is the recommended same-agent demonstration/fallback and inbound email is optional. WhatsApp India is currently blocked for a general-purpose AI provider under the public Business Solution Terms unless Meta admits Waldo to its Third Party Agent/provider path or authoritatively confirms another eligible route; no production adapter or launch claim precedes that gate. K0 supplies a bounded Codex-first Kennel work handoff for the joined showcase; broader work orchestration follows. Providers, tools, channels, connectors, people, and environments contribute bounded observations or effects; none owns Waldo identity, canonical personal context, authority, Acceptance, or Open Loop closure.

The repository contains authenticated owner routing, responsibility capture/planning state, one execution writer and start-only bridge, Judgment Authority, RunLoop recovery/effect foundations, ContextComposer/Scribe foundations, and closure contracts. It does not yet contain the production conversation, real connectors, delivery, multi-presence, Trusted Relationships, closure runtime, staging, or operations needed for the target agent. Contract names, fakes, OpenAPI, and green local tests are not shipped capability.

## Read before changing code

1. [`AGENTS.md`](../../AGENTS.md) and `.claude/rules/INDEX.md`.
2. [Personal-agent product architecture and build plan](../planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md).
3. [Current session entrypoint](./NEXT-SESSION-PLAN.md).
4. [Execution ledger](./EXECUTION-LEDGER.md), [agent operating workflow](./AGENT-OPERATING-WORKFLOW.md), and [local verification pipeline](./LOCAL-DEV-TESTING-PIPELINE.md).
5. Fresh source/tests, the owning issue/PR, released schemas, and accepted ADRs for the exact seam.

[Execution ledger #116](https://github.com/Pin4sf/waldo-backend/issues/116) carries live session/worktree ownership and links durable handoffs. GitHub issues, PRs, and linked evidence are the current workflow; copied B0–B6 tables, historical milestones, Linear/HEY identifiers, and dated handoffs cannot establish current work order or shipped behavior. Promote only the next dependency frontier from the canonical build plan; do not start every gate as a parallel writer.

## Architecture boundaries

- One owner maps to one canonical backend authority root.
- One named reducer is the durable writer for each aggregate. The current build plan owns the proposed writer/store matrix; accepted ADRs constrain the touched seam.
- `WaldoCoordinator` authenticates, authorizes, and sequences; it does not bypass owning reducers.
- `RunLoopEngine` remains the trusted execution kernel and physical effect path during additive migration.
- Persist `EffectIntent`, frozen arguments, digest, and reconciliation key before external I/O.
- Never blindly retry an indeterminate effect. Reconcile first and expose a terminal user-visible resolution path.
- Context is compiled for a declared purpose, audience, destination, and data class. Memory is not permission.
- Resolve the smallest per-turn capability manifest; connecting a service does not expose its whole API to every message.
- OAuth credentials remain in Vault and are used only by the trusted typed connector proxy; bearer tokens never enter the DO, model-visible prompts, events, logs, artifacts, or checkpoints.
- Provider `done` is an observation. Evidence, Verification, Acceptance, Outcome state, and Open Loop closure are distinct.
- A disconnected presence cannot create/queue commands, approve, execute Waldo work, mutate truth, or claim completion under protocol 0.1.
- User corrections outrank inference. Raw health, full transcripts, credentials, and unrelated personal context are excluded from execution by default.
- Health-aware planning is a first-class differentiator, while health sharing remains optional. Health-declined fixtures preserve the complete core assistant path without invented readiness or pressure.
- Trusted Relationships exchange minimal signed proposals. Each owner independently admits, approves, executes, and accepts; no shared memory or transitive authority exists.
- The primary product Interface is one Waldo account, service-first Connections, “Have Waldo handle this,” understandable authority, and truthful placement/status. Infrastructure vocabulary belongs in optional Inspect/Advanced surfaces.
- Named helper/agent roles do not receive independent identity, ambient credentials, memory authority, or canonical writers.

## Repository map

| Surface | Responsibility |
|---|---|
| `packages/contracts` | Versioned schemas, commands/events, adapter contracts, public DTOs, shared fixtures |
| `packages/runtime` | Durable Object runtime, trusted RunLoop, execution/effect foundations, adapters, persistence |
| `scripts/guards` | Static invariants for architecture, contracts, tooling, and agent instruction surfaces |
| `docs/planning` | One current build plan plus short historical redirects |
| `docs/foundation` | Current contributor, session-handoff, and verification procedures |
| `supabase` | Migration/RLS/Vault surfaces; never mutate hosted environments without explicit authority |

## Working loop

1. Inspect current source and define the observable result.
2. Name the owning module, writer, contracts, stores, trust boundaries, and affected repositories.
3. Specify happy, null, hostile, concurrent, disconnected, cancellation, retry, restore/deletion, and rollback cases that apply.
4. Add or change behavior through tests first where practical.
5. Run adversarial review and the relevant contract/security/privacy checks.
6. Verify at the proof level being claimed; record gaps honestly.
7. Register the lane before writing, commit only intended files, and leave a GitHub plus repository handoff when another session must continue.

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

The finalized order is S0 composition/truth, S1 conversation/memory, S2 + H health-aware day/Calendar/proactivity, S3 + B email/research, and S4 personal-beta proof. K0 is required for the joined showcase; channels C and later W/K/R have explicit scope. Read the [worker guide](../planning/waldo-agent-mvp/WORKER_GUIDE.md) and complete the [bounded ADR synchronization](../planning/waldo-agent-mvp/ADR_RECONCILIATION.md) before changing conflicting accepted seams. The exact gates and exit criteria live only in the canonical build plan.

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

## MVP engineering companion

Use the [repository map](../planning/waldo-agent-mvp/REPOSITORY_MAP.md) for source ownership, fresh checkouts and per-repo verification. Apply the [engineering quality guide](../planning/waldo-agent-mvp/ENGINEERING_QUALITY.md) to CI/evaluations, dependencies, bounded improvement and cleanup. Establish actual CI and first behavior-suite evidence alongside S0; preserve the canonical plan's acceptance criteria and existing repository merge wall.
