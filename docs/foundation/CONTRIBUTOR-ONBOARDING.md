# Waldo Harness Contributor Onboarding

Status: active onboarding entrypoint for backend contributors.
Date: 2026-07-09.

## What You Are Joining

Waldo backend is building a Cloudflare Durable Object based agent harness. The current proof is
fake-first but durable: scheduler, governor, run journal, ToolDispatcher, hooks, fake LLM routing,
runtime driver hardening, context schema root, and local replay/evidence are merged.

The next honest runtime milestone is **HEY-142**: a governed multi-iteration
`plan -> act -> observe` loop. Do not describe the runtime as a real Pi/Hermes-style agent loop
until HEY-142 and the context lane are wired and verified.

## Read This First

1. `README.md`
2. `AGENTS.md`
3. `.claude/rules/INDEX.md` and the six referenced rule files
4. `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
5. `docs/foundation/NEXT-SESSION-PLAN.md`
6. `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
7. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
8. The accepted ADRs and Waldo Brain source files named by the seam you are touching

Use `docs/foundation/archive/` for archaeology only. Archived files may mention old branches,
closed tickets, retired package names, or pre-HEY-142 sequencing.

## Current Build Lanes

| Lane | Next work | Notes |
| --- | --- | --- |
| Runtime | HEY-142 governed multi-iteration loop | Single-writer over `packages/runtime/src/run-loop/*` and runtime evidence behavior. |
| Context | HEY-15 recall, HEY-14 skills, HEY-16 prompt builder | Starts from HEY-10's merged DO SQLite schema root. Full goal hydration waits for HEY-144. |
| Safety/Scribe | HEY-13 sanitiser runtime and Scribe proposal lifecycle | No direct committed-memory writes from the LLM. |
| Evidence | Extend HEY-111 evidence during HEY-142 | Reuse `readRunEvidence`, `replayFixture`, and `scoreRun`; do not create a parallel trace path. |
| Provider flip | HEY-143 after HEY-142 | No live provider calls before fake-first iteration is proven. |
| Product surfaces | Brief, Fetch, Chat, Spots after shared harness | Product loops should use the shared runtime spine, not bespoke paths. |

## Detailed Track Build Order

Use this section to assign ownership. Each contributor should take one track, declare owned files,
and avoid editing another track's single-writer surfaces without coordination.

### 0. Foundation / Dev Loop

Status: mostly done. This is a support lane now.

Order:

`HEY-6 -> HEY-7 -> HEY-8 -> HEY-9`

Done:

- `HEY-6` repo/org/branch setup.
- `HEY-7` type/contract foundation.
- `HEY-8` Worker and Durable Object scaffold.
- `HEY-9` Supabase canonical schema/RLS baseline.

Next / parallel:

- `HEY-103 -> HEY-104 -> HEY-105 -> HEY-106 -> HEY-107`.
- Highest leverage: `HEY-107` CI/branch-protection verification wall if still open.

Suggested owner: infra/dev-loop.

### 1. Durable Runtime Spine

Status: done as the core durability spine.

Order:

`HEY-120 -> HEY-121 -> HEY-124`

Done:

- `HEY-120` durable DeliveryGate/outbox exactly-once proof.
- `HEY-121` promoted journal/outbox runtime interface.
- `HEY-124` DeliveryGate runtime policy state.

Next / parallel:

- `HEY-100` DO-only conformance guard.
- `HEY-125` ES256 issuer staging spike.

Suggested owner: runtime/infra. Do not reopen the spine unless a later slice exposes a real gap.

### 2. Wake / Governor / Scheduler

Status: core control plane done; support follow-ups remain.

Order:

`HEY-122 -> HEY-123 -> HEY-77 -> HEY-12`

Done:

- `HEY-122` Loop Governor.
- `HEY-123` scheduler/alarm multiplexer.
- `HEY-77` triage dispatcher single entry.
- `HEY-12` hook registry.

Next / parallel:

- `HEY-137` DeliveryGate test hardening; can start now.
- `HEY-135` fleet watchdog; follows scheduler.
- `HEY-138` user timezone / quiet-hours; after context/user timezone state exists.

Suggested owner: runtime/control-plane.

### 3. Main Runtime Loop

Status: critical path.

Order:

`HEY-78 -> HEY-17 -> HEY-136 -> HEY-139 -> HEY-111 -> HEY-142 -> HEY-143`

Done:

- `HEY-78` ToolDispatcher + per-trigger ACL.
- `HEY-17` fake-first LLMProvider.
- `HEY-136` fake-first run-loop skeleton.
- `HEY-139` runtime driver hardening.
- `HEY-111` local runtime evidence/replay spine.

Next:

- `HEY-142` governed multi-iteration `plan -> act -> observe` loop.

After:

- `HEY-143` real-provider flip readiness.

Suggested owner: Codex/runtime. This is single-writer over `packages/runtime/src/*`; do not
parallelize `HEY-142` implementation with other runtime-loop edits.

### 4. Context / Memory / Prompt

Status: can run parallel to `HEY-142`.

Order:

`HEY-10 -> HEY-15 -> HEY-14 -> HEY-16`

Done:

- `HEY-10` DO SQLite context schema root.

Next:

- `HEY-15` recall-before-act.
- `HEY-11` AuditedDB wrapper alongside.
- `HEY-13` Scribe sanitiser runtime alongside.

After:

- `HEY-14` skill loader.
- `HEY-16` REASONS prompt builder.

Needed / related:

- `HEY-144` before full goal hydration.
- `HEY-134` Supabase schema re-land.
- `HEY-133` ADR-0024 vocabulary sync.
- `HEY-102`, `HEY-75`, `HEY-79`, `HEY-74` as context/safety support.

Suggested owner: Claude/context plus Codex integration. Hard rule: no raw health in DO SQLite,
prompts, logs, traces, or fixtures.

### 5. Tools / Adapters / Write Gates

Status: after core loop/context for integration, but design and isolated adapter work can start.

Order:

`HEY-129 -> HEY-48 -> HEY-31 -> HEY-30/HEY-98 -> adapters -> write tools`

Adapters:

- `HEY-38` document adapter.
- `HEY-39` email drafts.
- `HEY-64` calendar OAuth.
- `HEY-50` sheets.

Write tools:

- `HEY-40`, `HEY-41`, `HEY-42`, `HEY-51`, `HEY-52`.

External / decision blockers:

- `HEY-130` Google restricted-scope verification; can start early.
- `HEY-99` spend-cap decision; blocks production cap policy.

Suggested owner: adapter/tooling lane. Restricted writes wait for OAuth custody, ACL, autonomy, and
sanitiser gates.

### 6. Delivery / Product Loops

Status: after the shared harness loop is real.

Order:

`HEY-18 -> HEY-19 -> HEY-127 -> HEY-126 -> product loop skills/threading`

Channels:

- `HEY-18` Telegram inbound and shared thread identity.
- `HEY-19` APNs.
- `HEY-5` Apple/APNs external setup is done.

Product surfaces:

- `HEY-127` in-app feed; needs founder/Suyash input.
- `HEY-126` live-chat transport spike.
- `HEY-131` Telegram privacy/product residue.

Skills / threading:

- `HEY-20` through `HEY-24`, plus `HEY-44` and `HEY-45`.
- `HEY-25` through `HEY-27`.
- `HEY-32`, `HEY-46`, `HEY-66`, `HEY-67`, `HEY-43`.

Suggested owner: channel/product plus app team. Product loops must use the shared harness, not
bespoke paths.

### 7. Eval / Launch Hardening

Status: evidence spine has started; launch proof remains.

Order:

`HEY-111 -> HEY-53 -> HEY-54 -> HEY-55`

Done:

- `HEY-111` local runtime evidence/replay spine.

Next eval:

- `HEY-53` LLM judge.
- `HEY-54` WIS instrumentation.
- `HEY-55` 30 golden eval cases.

Launch proof:

- `HEY-101` GDPR deletion cascade.
- `HEY-128` privacy artifacts, DPIA, and consent model.
- `HEY-113` through `HEY-118` Supabase hardening.
- `HEY-99` outcome/spend enforcement.

Suggested owner: eval/privacy/infra. Beta gate requires replay, crash/resume, privacy fuzzing, and
mutation evidence.

### 8. App Track

Status: parallel, but depends on backend contracts and delivery surfaces.

Order:

`HEY-132 -> iOS surfaces -> channel/feed integration`

Next:

- `HEY-132` generated client refresh from committed OpenAPI artifact.

After:

- iOS/chat/feed surfaces as backend contracts stabilize.
- Push/feed surfaces after `HEY-18`, `HEY-19`, and `HEY-127`.

Suggested owner: app team.

### 9. Deferred / Post-V1

Status: do not assign for V1 unless founder scope changes.

Deferred:

- `HEY-49`, `HEY-37`, `HEY-58`, `HEY-59`.
- `HEY-80` through `HEY-97`.
- `HEY-76`, `HEY-108`, `HEY-60`, `HEY-61`, `HEY-62`.

Suggested owner: none for V1. Keep this lane parked while Phases 1-6 remain open.

## What To Assign Now

1. Runtime single writer: `HEY-142`.
2. Context parallel: `HEY-15`, `HEY-11`, `HEY-13`.
3. Safe parallel: `HEY-137`, `HEY-141`, `HEY-100`, `HEY-125`, `HEY-104` through `HEY-107`.
4. Human/external: `HEY-128`, `HEY-130`, `HEY-127`, `HEY-131`.
5. App parallel: `HEY-132`.

## Working Rules

- Keep raw health, secrets, provider bodies, prompts, and live channel payloads out of logs, DO
  SQLite, R2, traces, fixtures, and docs.
- Do not make live provider calls, use live credentials, trigger live channel delivery, or write to
  production Cloudflare/Supabase unless a ticket explicitly scopes that work and the user approves.
- Prefer contract-first changes in `packages/contracts` and strict Zod schemas for public or
  persisted shapes.
- Use TDD for runtime behavior. Prove happy, denial, malformed, retry/resume, and degraded paths.
- Keep single-writer files single-writer. Coordinate before touching shared runtime, contract,
  policy, trigger, schema barrel, or model roster files.

## Before Opening A PR

Run the commands appropriate to the change:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

For docs-only changes, `git diff --check` plus `npx -y pnpm@10.34.4 verify:guards` is enough.
For harness/runtime changes, include focused runtime or contract tests and evidence/replay checks.

## How To Pick Work

Start from Linear and the active docs, not from archived plans:

- Runtime builder: HEY-142 first.
- Context builder: HEY-15, then HEY-14 and HEY-16.
- Safety builder: HEY-13 / HEY-141 where scoped.
- Infra/provider builder: HEY-143 only after HEY-142.

When in doubt, post the current -> ideal -> gap and ask for the lane owner before editing shared
runtime files.
