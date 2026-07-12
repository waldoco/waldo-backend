# HEY-114 Environment and Migration Discipline

Status: implementation-ready repository discipline. This document does not authorize a remote command.

No staging/prod migration is authorized by this document.

## Run contract

Current: HEY-134 merged as `b0afed1e6eea7ea9df5d7e2a0592c95445579756`; its canonical lineage is seven ordered SQL files. The isolated Arch local proof is the only dynamic migration evidence available today. GitHub Actions is unavailable.

Ideal: every future schema change is an immutable reviewed migration artifact, proves clean local application before any shared change, and can advance only through an explicit Project Woof approval followed by a separate production approval.

Criteria:

- [ ] ISC-1: the repository names exactly the merged seven-file chain.
- [ ] ISC-2: Arch local is the only permitted dynamic verification target without a new approval.
- [ ] ISC-3: Project Woof is integration staging only; Waldo-MVP is legacy rollback only.
- [ ] ISC-4: production target/ref and operator are identified by an approved change request, never inferred.
- [ ] ISC-5: every remote action has immutable revision, preflight, recovery, and post-apply evidence.
- [ ] ISC-6: no credential or database URL enters Git, Linear, PR text, command output, or evidence.
- [ ] ISC-7: GitHub Actions remains an explicit blocking decision, not a silently waived CI control.
- [ ] ISC-8 Anti: this ticket never applies a staging/prod migration, creates a project/branch, changes billing/settings, or mutates Waldo-MVP.

Falsifiers: a non-seven-file inventory; a linked/remote command without approval; an undocumented production target; a secret in repository evidence; or a claim that local proof is CI.

## Canonical migration artifact

The only canonical chain is the merged HEY-134 history:

1. `20260709171312_0001_identity.sql`
2. `20260709171336_0002_health.sql`
3. `20260709171359_0003_intelligence.sql`
4. `20260709171417_0004_comms.sql`
5. `20260709171953_0005_integrations.sql`
6. `20260709172043_0006_harden_rls_auto_enable_execute.sql`
7. `20260710182949_reconcile_contract_spine.sql`

Migration identity is the timestamp version and its committed content. Never edit an applied artifact to repair an environment: add a later reviewed migration or follow the approved recovery classification below. `node scripts/verify-supabase-migrations.mjs` is the static ordering/inventory gate; `node scripts/verify-hey-114-discipline.mjs` is the no-shared-access documentation and inventory gate.

## Environment matrix

| Environment | Ref / owner | Role | Permitted now | Forbidden now |
| --- | --- | --- | --- | --- |
| Arch local | Docker-compatible local stack; operator is the developer running the pinned runbook | Isolated dynamic verification only | Fresh reset, full chain, pgTAP, local migration history/idempotency, local advisors, cleanup | `supabase link`, hosted URL, shared credentials, remote mutation |
| Project Woof | `oqcjjcytjvrckvylagsl`; integration owner: Ashish | Integration staging only | Read-only inventory only when separately justified; mutation only after approval packet | First proof target, disposable test target, unreviewed migration or settings change |
| production: unknown | Exact project/ref and accountable operator are not yet recorded | Production service | None | Inference, discovery-by-mutation, migration, configuration, billing, or secret work |
| Waldo-MVP | `togdshayyxycitzckpqv`; legacy rollback owner: Ashish | Legacy rollback only | Approved rollback/recovery planning | Forward schema authority, disposable testing, new integration traffic, migration |

Project refs are identifiers, not credentials. A ref does not authorize access.

## Pinned Arch local runbook

Run only from a clean checkout on a Docker-compatible Arch local host. Use `docs/foundation/HEY-134-ARCH-LINUX-VERIFICATION-RUNBOOK.md` only for its Docker prerequisites and the helper-present `0006` fixture path. Its historical `tee`-based evidence capture is superseded and is not part of HEY-114; this section is the maintained HEY-114 execution sequence.

Use the pinned array below in every local command; do not substitute a globally installed CLI.

```bash
SUPABASE=(npx -y supabase@2.109.1)
PNPM=(npx -y pnpm@10.34.4)
"${SUPABASE[@]}" start
"${SUPABASE[@]}" db reset --local --no-seed
"${SUPABASE[@]}" test db
"${SUPABASE[@]}" migration list --local
"${SUPABASE[@]}" stop --no-backup
```

1. **Fresh reset.** Unset `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID`, `SUPABASE_SERVICE_ROLE_KEY`, and `DATABASE_URL`; prove `supabase/.temp/project-ref` and `supabase/.temp/pooler-url` are absent. Use the pinned arrays above. Start local containers, then run `${SUPABASE[@]} db reset --local --no-seed`.
2. **Full migration chain.** Run `node scripts/verify-supabase-migrations.mjs`, `${SUPABASE[@]} migration list --local`, and `${SUPABASE[@]} db query --local --file supabase/fixtures/assert-canonical-migration-history.sql`. The expected state is exactly the seven files above.
3. **pgTAP.** Run `${SUPABASE[@]} test db`; all schema/RLS/grant contracts must pass. Run the helper-absent and helper-present `0006` paths documented in the HEY-134 runbook, then fresh-reset again.
4. **Migration-history/idempotency.** After the history assertion, run `${SUPABASE[@]} migration up --local`; it must apply nothing. Never use `migration repair` to make a failing local proof look healthy.
5. **Advisors.** Run local security and performance advisors only. Record warning/error findings; INFO-only service-table RLS findings need an explicit documented rationale.
6. **Repository wall and cleanup.** Run `node scripts/verify-hey-114-discipline.mjs`, `${PNPM[@]} verify`, and `git diff --check`; classify a baseline failure against the merge-base before changing unrelated code. Finish with `${SUPABASE[@]} stop --no-backup` and confirm no stack containers remain.
7. **Sanitized evidence only.** Do not pipe CLI output to `tee`, save raw transcripts, or commit an evidence directory. Manually record only the allowlisted summary: command exit status, pinned tool versions, seven-file inventory result, pgTAP total/pass-fail, advisor severity classification, verification-wall stage reached/result, and clean Git status. Review that summary for secrets and health data before sharing it.

This dynamic proof is local evidence, not CI and not staging evidence.

## Staging-first promotion runbook

No command in this section is approved yet. Before a Project Woof mutation, stop and present the approval packet required below.

1. Pin the exact merge commit and SHA-256 of each migration artifact; record `git status --short`, the seven-file static inventory, and the intended ordered list. A different commit, file, or migration timestamp is a new change request.
2. Read-only preflight: capture current migration list/history and schema drift against the immutable artifact; inspect database size/lock risk, Data API exposure/grants, RLS policies, and advisors. Do not use repair as a preflight shortcut.
3. **Statement timeout decision.** Proposed global scope: database `postgres`; proposed value: `5min`; role-level exceptions: none. It is a separately approved staging configuration action, performed before the migration, not a `SET LOCAL` embedded in a migration runner that may open a different connection. The approved operator must apply `ALTER DATABASE postgres SET statement_timeout = '5min'`, reconnect in two fresh sessions (migration operator and app/PostgREST role), run `SHOW statement_timeout` in both, and record the values before applying migrations. Re-check after the PostgREST reload/app-session probe. This is a proposed operational value, not present authorization to alter a remote database.
4. Classify the migration: additive/reversible, additive/forward-recovery, data backfill, locking/high-risk, or destructive. Attach the backup/PITR capability and restore owner; an untested rollback is not a rollback. For append-only or destructive work, prefer forward recovery and name the compensating migration.
5. Apply only the reviewed immutable artifact. Abort on unexpected migration history, timeout, lock threshold, grant/RLS mismatch, advisor warning/error, or application-session failure.
6. Post-apply: capture migration list/history; run advisors; verify Data API exposure/grants separately from RLS; run own-row and cross-account denial checks using approved synthetic identities; verify an app session and sanitized error behavior. Record the result without tokens, database URLs, user data, or raw health.
7. Production remains a separate manual approval gate after successful Project Woof evidence. No staging approval carries forward to production.

## Approval packet at the external-action boundary

Present this exact information before any shared action:

- exact Supabase project/ref and environment;
- exact command, migration versions, immutable Git revision, and intended mutation;
- expected cost/billing impact;
- blast radius, lock/downtime and data-risk assessment;
- rollback or forward-recovery plan, backup/PITR status, and recovery owner;
- required secret or role, held by whom, and confirmation it will not be logged;
- verification command and stop conditions;
- why local Arch proof is insufficient for this action.

The approval must separately cover staging and production. Remote migration, project creation, preview branching, billing changes, statement-timeout configuration, CI-secret work, and production settings all require this packet.

## CI decision and smallest viable alternative

GitHub Actions is unavailable. That blocks the intended required PR check; it is not satisfied by the committed workflow file or an Arch local result.

The smallest viable alternative is an owner-run, clean-Arch local gate using the pinned runbook, with a sanitized, allowlisted evidence summary attached to the PR by the authorized operator. The summary may contain only exit statuses, tool versions, the seven-file inventory, pgTAP pass/fail counts, advisor finding classifications, and a clean-status result. Never attach raw command transcripts; review and redact the evidence before attachment. It requires: an Ashish-owned Docker-capable Arch host, no hosted Supabase credentials, a clean checkout, pinned Node/pnpm/Supabase CLI versions, and human review of the captured result. It has no new vendor cost and no CI credential requirement, but it is not branch-protection enforcement.

Restoring Actions, using an external CI provider, adding a runner, adding credentials, enabling Supabase Branching, or creating preview branches is deferred pending explicit approval. Preview branches may incur usage/cost, carry branch-specific credentials, and are not required for HEY-114.

## No secrets contract

Allowed in repository documentation: project refs, roles, command names, migration versions, and non-sensitive ownership.

Never place passwords, access tokens, database URLs, service-role keys, personal access tokens, JWTs, private keys, or copied command output containing them in Git, logs, Linear, or PRs. Redact first, then attach only a sanitized evidence summary. If a command would print a secret, do not run it into `tee` or CI output.

## Verification record

| ISC | Evidence | Current status |
| --- | --- | --- |
| ISC-1 | HEY-134 squash commit and static migration verifier | Ready for local verification |
| ISC-2 | Pinned Arch runbook and local-only command constraints | Ready for local verification |
| ISC-3/4 | Environment matrix | Documented; production identity deliberately unknown |
| ISC-5 | Promotion and approval-packet templates | Documented; no shared action authorized |
| ISC-6 | No-secrets contract and review | Pending PR review |
| ISC-7 | CI decision recorded | Blocked on repository/GitHub administration decision |
| ISC-8 | Git diff, command history, and review | Pending final verification |

Assumptions: the existing Project Woof and Waldo-MVP refs are historical inventory identifiers; their ownership/access has not been revalidated in this ticket. No remote state was inspected or changed while authoring this discipline.
