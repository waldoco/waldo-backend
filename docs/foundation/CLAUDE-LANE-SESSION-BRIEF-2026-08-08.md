# Claude lane session brief

**Cut at:** `dd434e9` (current `origin/main`)
**Lane:** Claude — product-truth modules and contract/spec review
**Goal:** one working Waldo. Nothing beside the obligation spine.

## Scope

A person hands Waldo a responsibility. It stays alive, asks for judgment when it needs to,
does one real thing, and reports honestly what became true.

```
capture -> stays open -> asks for judgment -> does one real thing
        -> reports honestly -> reaches you -> wired together
```

That chain is `#85A -> #82 -> #83 + #89 -> #84 -> a channel -> #88A`. Anything not on it is
parked. Scope discipline is part of the deliverable; this sprint has already absorbed several
rounds of well-argued expansion.

## Start here, in order

1. **Review PR #103** — `AcceptanceCheck` v0.4, 825 lines, every WP-2..WP-5 module binds to it.
   Review findings are already posted on issue #81; check whether they landed before
   re-deriving them. Only open PR with real code.
2. **Write failing tests for #85A and #84** against the expected contract shapes. Both are
   Claude's, both blocked on unpublished slices. Tests written now surface contract problems
   before the slice merges.
3. **Keep reviewing Codex PRs** as they open. Cross-cluster review is the check that caught the
   discriminated-union and negotiation-state gaps in #103 — a fresh Codex context is independent
   of the author but not of the cluster.

## Blocking

- **`main` is red.** `test/work-unit-planning-authorization.test.ts` fails 7 tests at `dd434e9`
  from a wall-clock fixture that has expired. Verified by stashing all local changes and running
  clean HEAD. **PR #99 is the 9-line fix and is unmerged.** Every branch inherits it.
- **Queue is not draining.** Six open sprint PRs, zero merged, all `CLEAN`. None of #98-#103
  touches `do-schema.ts`, so none is gated by #100. Merge is separately authorized — surface the
  recommendation, do not act on it.

## Ownership

| Owner | Owns |
|---|---|
| Claude | contract/spec review of Codex PRs · #85A OpenLoop at capture · #84 Evidence/Verification/Acceptance · #91B Supabase Vault half · `supabase/**` |
| Codex | #81 contract slices · #82 · #83 · #87 · #88A/B · #89 · #90 · #91A · #100 · dispatcher · all runtime wiring |

**Reserved — Claude must not touch:** `do-schema.ts`, `coordinator/waldo-coordinator.ts`,
`run-loop/do.ts`, `runtime/src/index.ts`, `PlanningExecutionModule`.

**Single-writer constraint:** architecture lock §5 puts `ContextClaim`, Spot, Episode,
Constellation, `OpenLoop`, and `ReEntryPoint` under one writer — `ContinuityModule`. Memory-claim
work absorbs into #85A rather than running beside it.

## Verified at `dd434e9` — do not re-derive

Two of these overturned characterizations taken secondhand from issue #78. Treat that issue's
measured starting point as accurate about the **runtime** and unreliable about **contracts**.

| Area | What is actually true |
|---|---|
| `tools/dispatcher.ts` | 906 lines, owning auth, trigger ACLs, schema validation, hooks, taint, effect prep, receipts, reconciliation, bounds, recovery. Not a stub. Fails closed at `:432`; separate `handler_acl_drift` guard. |
| tool surface | 30 names. ADR-0021 forbids asserting a count in prose — derive it from the union. `search_tools` (ADR-0034) already ships lazy discovery. `execute_code` (ADR-0050) is typed but dispatchable nowhere; enabling it is a `TOOL_PERMISSIONS` change, never a type change. |
| taint | `source_taint: external` is required on external-origin results; absent *or* null is a parse failure so taint cannot be laundered (ADR-0049). Failure arm stamped too. Gap is lineage and derived-output propagation, not absence. |
| `ChannelPersona` | Full register vocabulary exists. Consumed **only as prompt text** at `prompt/reasons.ts:145-148`. Declared, not enforced. |
| inbound channel | `ChannelAdapter` already has `receive_webhook`, a five-gate inbound contract whose order is contract, and `update_id` as replica key. |
| read adapters | `calendar.ts`, `email.ts`, `doc.ts`, `sheet.ts` exist. `CalendarProvider` exposes `query_events` / `find_slots` / `propose_event`. **Zero runtime implementations.** |
| vocabulary | `obligation` and `commitment` return zero contract files. `commitments` is in `DEFERRED_DO_PRODUCT_TABLES`. `ContextClaim` returns zero files. Capture payload is work-decomposition shaped; `responsibility` exists only as free text on a WorkUnit. |
| #86 Telegram | Blocked correctly. Bot API has no idempotency parameter, cannot satisfy `DeliverySink.idempotentOnKey: true`. An unresolved transport design, not a small package. |

## Repo mechanics

- **Runtime tests live in `packages/runtime/test/`, not colocated.** Contracts colocates; runtime
  does not. A colocated runtime test yields `No test files found` and exit 1.
- **A fresh worktree has no `node_modules`.** Run `pnpm install` first.
- **Migration order is load-bearing.** `provisionDoSchema` applies a migration only where
  `MAX(version) < migration.version`. Merging a higher version first permanently strands lower
  ones on any DO provisioned in between. No guard covers this.
- **Mutation-test every new test.** Break the production code in the way the test should catch and
  confirm it fails. This repo has already shipped one vacuous test.

## Parked — no work, no review

#104 WD track · #105 PersonaFormatter · code-mode spike · taint propagation · Gatekeeper
comparison · agentskills envelope · Kitesurf · approval simulation.

#105 is finished and mergeable; leave it open and unattended. The findings posted on #81
(obligation-shaped identity, acceptance-check negotiation) stand on their own evidence — do not
re-argue them.

## Commands

```bash
pnpm install
npx -y pnpm@10.34.4 typecheck
npx -y pnpm@10.34.4 test
npx -y pnpm@10.34.4 verify:guards
git diff --check
npx -y pnpm@10.34.4 verify
```

Cloudflare, Supabase, provider, staging, and production mutations require explicit authority.
Local fakes and hermetic tests do not grant it.
