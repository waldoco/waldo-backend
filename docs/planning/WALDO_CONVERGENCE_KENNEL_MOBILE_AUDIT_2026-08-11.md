# Waldo Convergence — Canonical Kennel Electron and Mobile Audit

> **Reference only.** This preserves a pinned cross-surface audit. It does not establish the current mobile revision, delivery order, or product readiness.

**Date:** 2026-08-11
**Mode:** read-only source and isolated verification audit
**Kennel authority:** Electron remote `main@367c484dac87d0c64aac2247e57ceb367f50c196`
**Mobile evidence pin:** active local `main@d9578e6dd1ec9ba2ad5bc2e4dc09f76221581dae`; remote `main@ed255869a09493acd93a1327cd826a3230411173` remains a separate unaudited lineage

## Executive verdict

**[Observed]** Kennel is an Electron desktop application and persistent local orchestration harness. Electron `main` is the canonical runtime for this convergence and the only Kennel implementation used below.

Electron Kennel already contains a credible Codex-first local execution foundation:

- sandboxed Electron renderers over one versioned projection/command contract;
- a persistent daemon with authenticated local transport and SQLite WAL state;
- supervised official Codex App Server integration and capability conformance;
- local Git repositories, branches, worktrees, terminals, and bounded Take Control;
- Outcome, Work Unit, Agent Session, Mission Run, dependency, retry, budget, evidence, and attention models;
- a Work surface, top-edge Island, `$kennel:mission` plugin, and recorded live-acceptance artifacts.

It is still not the durable Waldo product. Outcome/Mission state is local, Codex is the only managed executor, the Work board remains strongly session/delivery-oriented, completion evidence is not joined to independent Waldo Verification and owner Acceptance, and no cloud/mobile continuity protocol exists.

**[Decision]** Keep Electron as Kennel's runtime. Migrate its local product objects into cloud projections/proposals while preserving its local execution custody, operation durability, provider-native control, worktree isolation, and exact desktop re-entry.

The active mobile checkout remains a source-empty scaffold. It cannot currently provide capture, briefing, judgment, synchronization, or closure. The richer remote mobile lineage must be selected and audited before implementation tickets rely on it.

## Evidence discipline

- **[Observed]** means directly supported by the pinned Git object, repository artifacts, or commands run in this audit.
- **[Inference]** is the narrowest implication supported by that evidence.
- **[Decision]** is the recommended target architecture.
- **[Unknown]** is not proved by source or current execution.

README claims, stored screenshots, fixtures, local tests, and provider self-reports are evidence of different strength. None alone proves shipped cross-surface behavior or Outcome completion.

## Canonical Kennel architecture

```text
Electron Island renderer ─┐
                          ├─ frozen preload API
Electron Work renderer ───┘          │
                                     v
                         authenticated local transport
                                     │
                                     v
                           persistent Kennel daemon
                         ├─ SQLite repositories
                         ├─ Mission scheduler
                         ├─ Codex supervisor/client
                         ├─ Git/worktree manager
                         ├─ terminal/shell manager
                         ├─ GitHub/review/preview adapters
                         ├─ recovery and redaction
                         └─ projection publisher
                                     │
                                     v
                         official Codex App Server
```

Island and Work consume the same contract-v6 `DesktopProjection` and send the same versioned command family. Renderers do not own durable state. The daemon persists projects, Outcomes, Work Units, sessions, worktrees, Mission Runs, attempts, attention, utilities, and derived Insights.

This is the right local shape. The missing seam is a cloud-authorized execution lease and ordered projection/event protocol that makes local objects subordinate to the canonical per-owner Waldo state.

## Surface and capability classification

| Surface / capability | Classification | Observed evidence | Product disposition |
| --- | --- | --- | --- |
| Electron Island | **partial** | Real top-edge window, quiet/glance/workspace phases, exact return, attention state, capture, utilities, and reduced-motion behavior. | **KEEP/MODIFY.** Use for capture, status, exact `Needs You`, completion-ready, and re-entry—not as a miniature dashboard. |
| Work / orchestration surface | **partial** | Outcomes and sessions are visible; board lanes are Working, Needs You, In Review, Ready to Merge; users can create work, spawn an orchestrator, steer, interrupt, terminate, and inspect Mission Runs. | **REBUILD INFORMATION PRIORITY.** Make Outcome truth, remaining consequence, Evidence, Verification, Acceptance, and Open Loop primary. Sessions remain operator detail. |
| Outcome model | **partial / wrong authority** | Local SQLite stores Outcomes with intent, acceptance checks, and active/ready/accepted/released states; tests preserve separation from provider termination. | **KEEP CONTRACT INTENT, MIGRATE AUTHORITY.** Cloud becomes sole writer; Kennel keeps a projection/cache and local execution bindings. |
| Mission Runs | **partial** | Versioned DAG plans, dependencies, read-only safe launch, explicit approval, concurrency, retry, deadline, token budget, pause/resume/cancel, isolated branches, and evidence-gated integration exist. | **KEEP/MODIFY.** Mission stays optional under Outcome. Replace local approval/acceptance authority with cloud-minted Judgment and lease receipts. |
| Codex managed execution | **partial** | Generated App Server contracts, supervised JSONL client, managed/discovered sessions, start/resume/steer/interrupt/unsubscribe, approvals/questions, and capability degradation are present. | **KEEP/HARDEN.** Preserve provider-native semantics behind a minimum adapter floor. Installed-version mismatch must remain fail-closed. |
| Concurrent orchestration | **partial** | A scoped orchestrator can create isolated workers with concurrency and capability ceilings; Mission tasks carry dependencies and attempts. | **KEEP/MODIFY.** Bind every worker to a cloud Work Unit, execution lease, fence, authority ceiling, evidence recipe, and cancellation generation. |
| Git/worktrees | **partial** | Validated repository registration, branch/worktree creation, isolation, cleanup guards, SHA-scoped review, GitHub observation, and integration flows exist. | **KEEP.** This is core Kennel custody. A worktree is repository isolation, not complete process/network/secret isolation. |
| Terminal and Take Control | **partial** | Managed shells and discovered Codex sessions can be inspected; Take Control is memory-only and bounded to exact provider state. | **KEEP/HARDEN.** Add explicit cloud authority bindings and operation receipts; do not sync terminal bodies by default. |
| Local persistence/recovery | **partial** | SQLite WAL migrations, typed repositories, durable Mission state, explicit termination, effect recovery rules, and daemon lifetime independent of UI exist. | **KEEP.** Recast as operation ledger plus cloud projection cache, never a second canonical personal truth store. |
| Session Intelligence / Insights | **wrong-design** | Opt-in local scans cover Codex, Claude Code, Cursor, and OpenCode without retaining transcript bodies, but the visible product produces archetypes, five numeric dimensions, growth edges, and verification-rate summaries. | **REMOVE/REBUILD.** Keep privacy-minimized deterministic event extraction and explicit Outcome linking. Remove builder scoring/archetypes; produce evidence, decisions, blockers, unresolved questions, artifacts, and correctable proposals. |
| Outcome verification | **prototype** | Acceptance checks and evidence strings exist, provider completion is separated from Outcome acceptance, and Mission integration waits for manual evidence acceptance. No independent verifier registry or cloud acceptance ledger exists. | **REBUILD ON CLOUD CONTRACTS.** Executor claim → Evidence → independent Verification → owner/policy Acceptance → close/reopen/release. |
| Claude integration | **absent as managed executor** | Claude Code is an Insights source, not a process/session adapter or execution target. | **DEFER until the Codex vertical slice is cloud-connected and accepted.** Then add Claude to prove the adapter seam without pretending semantic parity. |
| Cloud synchronization/authentication | **absent** | No Waldo backend identity, presence enrollment, cloud projection cursor, execution lease, or cross-device judgment transport was found. | **BUILD P0.** This is the primary product bridge. |
| Local utilities | **prototype / secondary** | Capture tasks, focus, calendar/reminders/media/power/Shelf preferences and adapters appear in the five-phase Island. | **REDUCE.** Keep only utilities that support a current Outcome, execution, judgment, or re-entry. They must not define Kennel. |
| Packaging and release | **unproved** | Electron build configuration and smoke/acceptance artifacts exist, but no current signed/notarized/update-channel/production acceptance was established. | **VERIFY BEFORE LAUNCH CLAIM.** |

## What Electron Mission Control should become

The current Work surface is materially stronger than a session viewer: it has Outcomes, Mission Runs, Work Units, dependencies, exact attention, and evidence-bearing integration. Its visible lanes still organize delivery/session activity more strongly than the user's unresolved responsibility.

The canonical hierarchy should be:

```text
Outcome
  ├─ optional Mission
  ├─ Work Unit
  │    └─ Execution Attempt
  │         └─ provider-native Session(s)
  ├─ Artifact / Effect Receipt
  ├─ Evidence
  ├─ Verification
  ├─ Acceptance
  └─ Open Loop + Re-entry Point
```

Mission Control must answer:

- what the user wants to become true;
- what is executing and under which authority;
- what is blocked or needs judgment;
- which claims have attributable evidence;
- whether verification passed, failed, is stale, or is indeterminate;
- what remains before acceptance or conscious release.

Provider session lists, terminals, token usage, diffs, logs, and native controls belong under the selected Execution Attempt.

## Session Intelligence replacement

Keep deterministic, local-first extraction from Electron Kennel:

```text
provider events + Git/worktree + terminal receipts + checks + artifacts
  -> bounded normalized observations
  -> content-addressed artifact/evidence candidates
  -> correctable model proposals for intent, decisions, blockers, and next actions
  -> cloud reconciliation against Outcome revision and acceptance checks
  -> independent Verification
  -> owner Acceptance, reopen, wait, block, or release
  -> Open Loop and exact re-entry update
```

Do not upload raw transcripts by default. Do not turn activity into a personality or builder-quality score. A provider or model may propose an interpretation; it may not certify its own Outcome.

## Mobile evidence status

The active mobile checkout at `d9578e6` contains package/configuration and instruction files but no application routes, screens, components, services, state store, native module, notification implementation, tests, app manifest, or assets.

| Requested surface | Active-checkout status |
| --- | --- |
| Onboarding/authentication | **absent** |
| Today/Home | **absent** |
| Capture/chat/voice | **absent** |
| Outcome/Mission/Needs You | **absent** |
| Morning Brief and Daily Close | **absent** |
| Notifications and re-entry | **absent** |
| Memory correction/privacy | **absent** |
| Health/calendar capacity context | **absent** |
| Cloud sync/offline projection | **absent** |

Remote `main@ed255869` is 66 commits ahead and contains a materially richer application lineage. This audit does not silently attribute that source to the active checkout. Select and audit the intended mobile revision before deciding what to keep or rebuild.

## Cross-surface boundary

### Waldo Cloud owns

- identity, enrolled presences, canonical Outcome/Mission/Work Unit revisions;
- policy, authority, execution leases/fences, schedules, and notification intent;
- Evidence admission, Verification, Acceptance, Open Loops, and re-entry;
- purpose-bound context/memory, provenance, correction, retention, export, and deletion;
- ordered projections and reconciliation across Kennel and mobile.

### Electron Kennel owns

- local processes, provider adapters, terminals, repositories, worktrees, files, apps, and device credentials;
- local execution supervision, containment, cancellation, recovery, and deterministic evidence collection;
- operation durability and a visibly stale cloud projection cache;
- desktop Work, `Needs You`, evidence inspection, exact return, and provider-native operator detail;
- no canonical Outcome acceptance or personal memory truth.

### Mobile owns

- fast capture and conversation;
- Today, Morning Brief, consequential `Needs You`, and Daily Close;
- Outcome evidence receipts and accept/reopen/release;
- correction, notification re-entry, privacy, account, and device lifecycle;
- no local executor runtime and no direct access to internal canonical databases.

## Minimal cloud protocol for Electron Kennel

```text
presence.enrolled
capabilities.advertised
projection.snapshot_received
execution.lease_offered
execution.lease_accepted | rejected
execution.started
execution.observation_appended
artifact.candidate_created
effect.receipt_recorded
execution.claimed_complete | failed | indeterminate
verification.requested
judgment.requested
execution.cancel_requested
execution.lease_expired
projection.acknowledged
```

Every mutation binds owner, Kennel presence, Work Unit, Execution Attempt, lease, fencing generation, capability/contract digest, idempotency key, authority scope, and expiry. Reconnect reconciles durable observations and effect receipts before any command is reissued.

## Electron build implications

1. Keep Electron, its daemon, preload boundary, SQLite operation durability, and one shared Island/Work contract.
2. Consume backend-owned fixtures for registration, projection sync, execution leases, judgments, evidence, verification, acceptance, and reconnect.
3. Make local Outcome/Mission rows explicit cached projections or pre-cloud migration records; stop local code from being a second canonical writer.
4. Bind Mission workers to cloud Work Units and leases while retaining local DAG scheduling, worktrees, and provider-native control.
5. Replace Insights scoring/archetypes with deterministic Session Intelligence and correctable evidence/open-loop proposals.
6. Rebuild Work around Outcome consequence and verification; preserve Sessions as a secondary operator view.
7. Prove daemon crash, UI close, provider crash, laptop sleep, lease expiry, duplicate command, late event, version mismatch, account switch, revocation, and artifact deletion.
8. Add Claude only after the Codex/cloud responsibility loop passes end to end.

## Verification performed

The canonical Electron Git object was exported to an isolated temporary directory; the existing Kennel checkout was untouched.

- `npm ci` completed and reported one high-severity transitive `nanoid` advisory with a fix available.
- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm run build` passed.
- `npm test`: 83 passed, 2 failed out of 85.
  - Codex conformance failed closed because installed `0.147.0-alpha.6.6` did not match the reviewed capability manifest.
  - The worktree-scoped shell test failed at `node-pty` `posix_spawnp` inside the isolated exported checkout.

The second failure may be an isolated-test-environment artifact; it was not dismissed or counted green. Electron `main` is buildable and mostly locally verified, but current provider conformance and the full test wall are not green.

## Open decisions

1. Which exact mobile revision becomes canonical?
2. What is the first launch Outcome and deterministic verification recipe?
3. Which normalized local observations may leave Kennel by default, and which checks execute locally with only signed receipts uploaded?
4. What identity and revocation contract represents a Kennel installation across multiple computers?
5. What is the exact behavior when the laptop sleeps or a cloud lease expires after a local provider effect?
6. Which Electron local records need migration, archival, or explicit deletion when cloud authority takes over?
7. What installed Codex versions and capability digests are admitted at launch?

## Primary evidence map

- Canonical declaration and capability inventory: Electron `README.md` at `367c484`
- Runtime and command dispatch: `src/service/runtime.ts`; `src/service/index.ts`; `src/service/local-transport.ts`
- Projection and UI contract: `src/service/projection.ts`; `src/shared/contracts.ts`; `src/shared/preload-api.ts`
- Work and Island: `src/renderer/workbench/main.tsx`; `src/renderer/island/main.tsx`
- Mission orchestration: `src/service/missions.ts`; `src/orchestrator/controller.ts`; `src/orchestrator/tools.ts`
- Provider custody: `src/provider/codex/*`
- Local execution: `src/git/*`; `src/shell/manager.ts`; `src/review/registry.ts`; `src/github/*`
- Persistence/recovery/security: `src/persistence/*`; `src/recovery/*`; `src/security/redaction.ts`
- Session Insights: `src/insights/runtime.ts`; `src/domain/models.ts`
- Stored acceptance artifacts: `results/live-acceptance/*`; `results/managed-orchestrator-acceptance/*`; `results/wired-*`
