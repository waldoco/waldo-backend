# Next Backend Session Prompt — merge Gate A, then build the minimum Outcome-bound working agent

Continue from the Gate A branch/worktree without discarding its changes or touching the saved and
dirty checkouts. Read the [Gate A handoff](./RESPONSIBILITY-PUBLIC-ADAPTER-GATE-A-HANDOFF-2026-08-06.md),
then the repository rules, architecture lock, responsibility phase handoff, current contracts,
`RunLoopDO`, provider-effect path, migrations, guards, and tests. Fetch and re-pin live
`origin/main` before claiming current state.

## Starting truth

PR #76 contains the repaired Gate A candidate. Do not begin Gate B unless the PR's current head
passes the full verification/review wall and is merged. Its local proof covers the v0.1/v0.2
authenticated public adapter, stable subject-derived owner routing, Supabase account/session
authentication, Waldo-owned canonical identity/Presence revalidation, fresh migration/pgTAP wall,
and a real local exact-token sign-out retry through capture/projection. The production feature flag
remains off, and public identity/Presence enrollment is not implemented.

Hosted/staging deployment is unavailable, and Kennel acceptance is unproved. The hosted Waldo and
Waldo Staging Supabase projects were visible but inactive and were not restored or changed. Treat
that as an operational gap, not as permission to deploy.

## Required Gate B slice

Use `/waldo-isa-run-contract`, planner/workflow mapping, `/codebase-design`, `/tdd`, and
`/check-contract` before claiming the slice.

1. Add the minimum canonical WorkUnit authorization transition under optimistic revision.
2. Atomically persist an `ExecutionRequest`, lease/fence/cancellation generation, idempotency,
   and pinned provider/executor capability-manifest references before provider I/O.
3. Use only the existing trusted RunLoop/provider-effect path for one planning turn. The initial
   capability manifest is empty: no tools, connectors, filesystem, shell, network, email,
   calendar, publication, or other external effect.
4. Execute provider I/O outside the DO transaction. Atomically persist only bounded receipt
   metadata, AgentSession activity, a validated `WorkUnitCandidatePlan`, ordered projection item,
   cursor, and result digest after the call.
5. Prove injected failures leave no partial session/candidate/projection result, and prove exact
   retry/restart behavior around the provider receipt boundary.
6. Run both scenarios through the same interfaces:
   - “Prepare a reviewable product update, but do not publish it.”
   - “Prepare me for tomorrow’s investor meeting and identify the follow-ups I should handle.”
7. Keep candidate plans separate from Evidence, Verification, Acceptance, OpenLoop, and Outcome
   completion. Provider/session `DONE` cannot close or mutate the Outcome.
8. Prove deterministically with a contract fake, then run one real provider turn only when a
   version-pinned non-production configuration and credentials are already authorized. Never
   solicit, print, persist, or commit secrets; record unavailable honestly.

Before delivery, run separate Standards and Spec reviews, mandatory security review, an
adversarial breaker pass, the exact package/full verification wall, and `git diff --check`.

Do not claim Kennel UI acceptance, connectors, personal-assistance surfaces, Evidence/
Verification, Acceptance/OpenLoop/ReEntry, staging, production, or operations unless each is
independently exercised.
