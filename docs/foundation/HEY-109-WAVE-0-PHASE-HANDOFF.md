# Phase Wave 0 → Wave 1 Handoff

Status: Wave 0 is documented, independently reviewed, and committed; its current full wall passes,
but draft coordinator PR #49 awaits human approval and a review disposition for an intermittent
unchanged runtime-suite failure. Do not start a Wave 1 implementation worktree or edit before that
merge barrier clears.

## What Was Built

- A coordinator-only Wave 0 ledger with owned-file boundaries, merge order, risks, source decisions,
  and the temporary Codex ownership override.
- Current foundation/onboarding/session documentation that records HEY-13 as Done at
  `82f582b5a28530c1fb7800b7fad889590b35e57d`, uses the accepted Brain PR #17 baseline, and makes
  HEY-15 the lead context slice.
- A tracker reconciliation that retires stale completed blockers, gives all named wave tickets
  `agent:codex`, keeps them non-ready until their actual admission gates, and records the direct
  HEY-143 convergence gates.
- Non-ready HEY-160 for production per-user JWT/`db.forUser()` custody and non-ready HEY-161 for
  generated accepted-ADR snapshot reconciliation.
- A post-merge PR #47 proof correction with the final Scribe verification counts.

## What Works (with evidence)

- Coordinator docs/guards: `git diff --check` and `npx -y pnpm@10.34.4 verify:guards` passed.
- Full verification evidence: the baseline, multiple post-edit, and most recent
  `npx -y pnpm@10.34.4 verify` walls passed with 1,188 contract tests, 485 runtime tests, workspace
  typechecks, and all guards.
- Independent reviews: spec/standards, security/privacy/source-discipline, and tracker/GitHub audits
  passed after their findings were incorporated.
- Draft coordinator PR #49 is open; it is not authorization to begin Wave 1.
- No live credentials, real provider/R2 object, channel effect, staging/production write,
  deployment, Supabase mutation, or Cloudflare mutation occurred.

## What Does Not Work Yet (known issues)

- Wave 1 implementation is not authorized until the reconciliation PR is human-approved and merged.
- A first post-edit full verification run had one unchanged tracer idempotency assertion failure.
  The isolated target and ten tracer-file repetitions passed. A later post-commit full wall failed
  in the unchanged `delivery-gate` runtime test with `scribe:invalid_payload`; an isolated repeated
  file run passed five times then failed on its sixth attempt. A succeeding later full wall does not
  establish a cause or erase those observations. Root cause is unconfirmed, so this branch must not
  claim stable runtime-suite health; no runtime change belongs in this documentation phase.
- Local `git fetch origin main` cannot authenticate. A fresh GitHub connector commit search returned
  the required SHA as the newest indexed repository commit, but a local branch-ref fetch remains
  unavailable.
- The standalone eval suite is absent. This phase records a verification-wall result, not an eval
  suite pass.

## Architecture Decisions Made During This Phase

- HEY-15 uses committed memory as its default trusted base; only Scribe-sanitized same-day pending
  rows may be read with explicit provisional trust. Raw/untrusted inbox rows are excluded.
- HEY-144 adds an internal V2 goals migration without changing V1 or adding a new DO class migration.
  If still required after rebase, HEY-15 owns the next additive internal FTS migration.
- HEY-100 is a static conformance guard only. HEY-160 owns any future production custody/data-plane
  design and is not a HEY-143 convergence gate.
- Agent-Ready labels are withheld until both the 11-item plan and the real wave admission barrier are
  satisfied; a complete plan is not permission to start early.

## Hard-Won Lessons

- Mutable tracker state must not outrank accepted ADRs, verified source, or active foundation docs.
- A merged ticket can retain useful historical evidence without retaining a live blocker relation;
  label historical prose explicitly so it cannot be read as current scope.
- A passing retry does not erase an observed test failure. Preserve the symptom and repro evidence
  when it cannot be attributed without an in-scope diagnostic change.

## Compound Learning Capture

- **Lesson:** coordination artifacts carry mutable state; accepted ADRs, verified source, and active
  foundation docs carry authority. Historical plan text must be marked as such when a ticket merges
  or a dependency retires.
- **Mode / track:** Lightweight knowledge/practice capture.
- **Overlap check:** existing phase handoffs already own hard-won lessons; no separate solution page
  or governance change is warranted.
- **Destination / refresh outcome:** this handoff and the coordinator ledger; update their source
  hierarchy rather than creating a new abstraction.
- **Source/provenance:** Wave 0 review findings, accepted Brain baseline
  `75591543053dbdda6cf7c7f0210f8d16f36c3db8`, and local verification evidence.
- **Applicability limit:** applies to coordinator/tracker reconciliation, not as a substitute for an
  ADR decision or a code-level test.
- **Eval/pressure scenario:** an independent reviewer must be able to find every live dependency in
  the ticket relation, current body, ledger, and active docs without a stale plan claiming otherwise.
- **Evidence trail:** independent review reports, `git diff --check`, verification-wall attempts,
  and HEY-109/PR #47 reconciliation comments.
- **Impact surface:** coordinator docs and tracker hygiene only; no universal-rule, runtime, or
  external-state mutation.

## Prerequisites for Wave 1

1. Human approval and merge of the Wave 0 coordinator PR.
2. Fetch/verify the merged baseline; create three new worktrees only then:
   `codex/hey-144-goals-do-schema`, `codex/hey-14-skill-loader`, and
   `codex/hey-15-recall-before-act`.
3. Each worker passes the baseline wall, receives an exact owned-file manifest, and writes a
   ticket-local ISA plan with installed versions and primary-source references before editing.
4. Keep HEY-144 sole writer for the schema seam; HEY-14 sole writer for any binding/config seam;
   HEY-15 remains read-only at the schema seam until its rebase.

## Files Changed

- `CLAUDE.md`
- `README.md`
- `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
- `docs/foundation/CONTRIBUTOR-ONBOARDING.md`
- `docs/foundation/DEFERRED-DO-SCHEMA-COVERAGE.md`
- `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
- `docs/foundation/HARNESS-WAVE-COORDINATION.md`
- `docs/foundation/HEY-109-WAVE-0-PHASE-HANDOFF.md`
- `docs/foundation/HEY-10-DO-SQLITE-SCHEMA.md`
- `docs/foundation/HEY-13-ISA-RUN-CONTRACT.md`
- `docs/foundation/HEY-13-PHASE-HANDOFF.md`
- `docs/foundation/HEY-143-PHASE-HANDOFF.md`
- `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
- `docs/foundation/NEXT-SESSION-PLAN.md`
- `docs/planning/WALDO_APP_BACKEND_INTEGRATION_PLAN.md`

## Post-Merge Record — 2026-07-12 IST

- [observed] The historical draft PR #49 merged as `a257a175d0361df5c129d73144f95ff245cb63d1`.
  The verified first-parent post-Wave-0 sequence is PR #50 (`7d02b173`), PR #52 (`4e1cac30`), then
  PR #51 (`2fd798f8`).
- [decision] The Wave 0 merge barrier is retired. The next coordinator action is a fresh HEY-14
  SkillLoader preflight from `2fd798f8`, not an automatic implementation grant.
- [observed] PR #52 supplies the V2 goals storage foundation only. Full goal hydration still awaits
  HEY-162's Scribe-backed admission boundary.

## Post-Preflight Addendum — 2026-07-12 IST

- [verified] The fresh HEY-14 worktree passed its `2fd798f8` baseline wall, then source inspection
  found no typed WorkspaceMount/R2 seam in the current backend contracts or runtime bindings.
- [decision] HEY-163 is the contract-only ADR-0029/0076 fulfillment. Subsequent review created
  HEY-166 for proposed bounded workspace admission; the remaining serialized context sequence
  is HEY-163 -> HEY-166 -> HEY-14 -> HEY-15 -> HEY-16. No raw R2/key workaround or invented
  universal blob cap is admitted.
