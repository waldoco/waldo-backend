# Waldo Backend Contributor Onboarding

**Status:** current onboarding entrypoint
**Updated:** 2026-08-17

## What you are joining

Waldo is one private, continuously understanding, user-owned agent account across personal assistance and work/agent orchestration. The three primary launch surfaces are Electron Kennel desktop, Waldo mobile with optional Health/Care, and messaging presence. Telegram and Discord are required launch adapters; WhatsApp remains a primary target but vendor approval is non-blocking. Named helpers are bounded roles beneath the account, not separate identities or truth stores. Providers, tools, channels, connectors, people, and local/cloud environments execute bounded capabilities; none owns Waldo identity, the full Personal Understanding Kernel, Outcome truth, authority, Acceptance, or Open Loop closure.

The repository contains owner-routed responsibility capture, an Outcome/Mission/WorkUnit graph, a guarded public adapter, a bounded zero-tool planning turn, released v0.4 responsibility contracts, one canonical execution writer, a recover-before-issue execution-environment seam, one authenticated start-only WorkUnit bridge through the trusted Durable Object RunLoop composition, and #82's landed `JudgmentAuthorityModule`. The missing real execution adapters, #84 Evidence/Verification/Acceptance runtime, #85 OpenLoop/ReEntry, multi-presence/Home, real Connection/effect, `SourceAdmissionPolicy`, automatic Personal Profile compiler, local/Waldo kernel and provider projections, universal external-LLM egress, record-scoped Kennel attachment, context/routine, cloud-workspace, deletion, staging, and operations paths prevent any claim that the target product is shipped.

## Read before changing code

1. [`AGENTS.md`](../../AGENTS.md) and `.claude/rules/INDEX.md`.
2. [Current session entrypoint](./NEXT-SESSION-PLAN.md).
3. [Current product and architecture convergence](../planning/WALDO_PRODUCT_ARCHITECTURE_CONVERGENCE_2026-08-11.md).
4. [Product capability matrix](../planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md).
5. [Architecture lock](../planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md).
6. [Source-pinned final architecture](../planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md) for retained contract/failure-path detail.
7. [Execution ledger](./EXECUTION-LEDGER.md), [agent operating workflow](./AGENT-OPERATING-WORKFLOW.md), and [local verification pipeline](./LOCAL-DEV-TESTING-PIPELINE.md).
8. [Production run contract](./NEXT-BACKEND-SESSION-PROMPT.md), then fresh source, tests, issue/PR state, and accepted ADRs for the touched seam.

The [production-launch milestone](https://github.com/Pin4sf/waldo-backend/milestone/1) and [umbrella issue #78](https://github.com/Pin4sf/waldo-backend/issues/78) carry the current B0-B6 work map. [Execution ledger #116](https://github.com/Pin4sf/waldo-backend/issues/116) carries live session/worktree ownership and links durable handoffs. GitHub issues, labels, milestones, PRs and linked evidence are the current workflow; Linear/HEY identifiers are historical evidence only. B0, bounded B1, and #82 are complete at `origin/main@105e4b5`; #84 PR #133 is open, unmerged, and contract-only, while #85 remains blocked. Use the [B2–B6 goal execution contract](../planning/WALDO_BACKEND_B2_B6_GOAL_EXECUTION_CONTRACT_2026-08-15.md); do not start one write-capable worktree per gate. Retired plans and ticket handoffs remain in Git history for archaeology. They cannot establish current work order, ownership, product scope, or shipped behavior.

## Architecture boundaries

- One owner maps to one canonical backend authority root.
- One named reducer is the durable writer for each aggregate. Use the architecture lock's definitive writer matrix.
- `WaldoCoordinator` authenticates, authorizes, and sequences; it does not bypass owning reducers.
- `RunLoopEngine` remains the trusted execution kernel and physical effect path during additive migration.
- Persist `EffectIntent`, frozen arguments, digest, and reconciliation key before external I/O.
- Never blindly retry an indeterminate effect. Reconcile first and expose a terminal user-visible resolution path.
- Context is compiled for a declared purpose, audience, destination, and data class. Memory is not permission.
- A connected source is not admitted automatically. `SourceAdmissionPolicy` enforces lawful access, account/category/organization policy, purpose, processor region/retention, and revocation before Profile/Memory compilation; explicit statements and corrections outrank inference.
- `ContinuityModule` is sole writer for admitted `waldo_synced` Profile/Memory Claims; `ContextCompiler` owns the owner-root kernel and projections. Kennel separately owns pre-attachment and `local_only` records, and attachment is content-free-inventory first plus per-item receipts.
- Every external model path passes `ExternalLLMEgressGate`: explicit destination/data-class consent, active applicable DPA, remote-egress policy, region/retention, and fail-closed Scribe masking. Providers receive only destination-specific projections; no tool/MCP/fallback path may query or disclose the full kernel.
- Credentials are brokered outside model-visible prompts, events, logs, artifacts, and checkpoints.
- Provider `done` is an observation. Evidence, Verification, Acceptance, Outcome state, and Open Loop closure are distinct.
- A disconnected presence cannot create/queue commands, approve, execute Waldo work, mutate truth, or claim completion under protocol 0.1.
- User corrections outrank inference. Raw health, full transcripts, credentials, and unrelated personal context are excluded from execution by default.
- Health First is a recommended first-class enhancement, never a prerequisite. Health-declined fixtures must preserve the complete core agent/orchestration path without invented readiness or pressure.
- The primary product Interface is one Waldo account, service-first Connections, “Have Waldo handle this,” understandable authority, and truthful placement/status. Infrastructure vocabulary belongs in optional Inspect/Advanced surfaces.
- Named helper/agent roles do not receive independent identity, ambient credentials, memory authority, or canonical writers.

## Repository map

| Surface | Responsibility |
|---|---|
| `packages/contracts` | Versioned schemas, commands/events, adapter contracts, public DTOs, shared fixtures |
| `packages/runtime` | Durable Object runtime, trusted RunLoop, execution/effect foundations, adapters, persistence |
| `scripts/guards` | Static invariants for architecture, contracts, tooling, and agent instruction surfaces |
| `docs/planning` | Current target architecture, capability envelope, source notes, implementation boundaries |
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

The current dependency order is backend contracts/fixtures first, then parallel Electron Kennel, selected mobile, and messaging clients against those releases; real Telegram/Discord adapters integrate at B4/B5 and all required surfaces converge at B6. It is an integration order, not authorization to remove any launch-surface acceptance from the definition of done.

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
