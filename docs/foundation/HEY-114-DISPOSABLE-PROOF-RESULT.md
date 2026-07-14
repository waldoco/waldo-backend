# HEY-114 Disposable Supabase Proof Result

Status: **NEEDS WORK**
Date: 2026-07-14
Branch: `hey-114-disposable-proof`
Repository revision used for every remote action: `fd663b65305973f19c318bb8acad067cc6798493`
Base: current `origin/main` at the same revision
Authorized project ref: `dxnyspxjcqejbykfcyxk`
MCP-observed project URL: `https://dxnyspxjcqejbykfcyxk.supabase.co`

This file is a sanitized summary derived from directly observed MCP and repository output. The
session trace is the primary per-call evidence; raw transcripts are not committed because the
repository contract permits only allowlisted summaries. No operator-attested result is used.

## Scope and stop conditions

- Only the project-scoped MCP connection whose URL contained the exact authorized ref was used.
- Project Woof, Waldo-MVP, production, PR #59, Supabase settings, billing, Branching, and hosted CI were not touched.
- No project reset, migration repair, migration-history edit, persistent `statement_timeout` change, or second migration application occurred.
- Synthetic values were non-sensitive and were transactionally rolled back or explicitly deleted in the same transaction.
- No raw command transcript containing credentials or user data is committed.

## Current-to-ideal contract

- **Module:** disposable verification evidence.
- **Interface:** project-scoped Supabase MCP.
- **Contract:** exact seven repository migration files, tenant-bound RLS, exact grants, stable migration history, advisors, and zero synthetic residue.
- **Seam:** MCP project identity plus `supabase_migrations` history.
- **Adapter:** Supabase MCP read, migration, SQL, and advisor operations.
- **Impact surface:** only disposable project `dxnyspxjcqejbykfcyxk` and this proof branch.
- **Anti-contract:** a target mismatch, unexpected baseline, destructive reset, secret exposure, or mutation of another environment stops the run.

## Baseline before migration

| Probe | Observed result |
| --- | --- |
| MCP project identity | Exact ref match |
| Application migration list | Empty |
| Public application tables | 0 |
| Public policies | 0 |
| Public app-role grants | 0 |
| Auth users | 0 |
| Storage buckets | 0 |
| Application migration-history table | Absent |
| Platform state | Only expected Supabase `auth` and `storage` schemas/tables |

The first aggregate baseline query referenced the absent application history table and returned SQLSTATE `42P01`. It made no mutation. The existence-safe retry returned the zero-state results above.

## Migration application

The files were loaded mechanically from the repository at the recorded revision and applied once in filename order without editing. SHA-256 values are recorded in `hey-114-disposable-proof-migrations.sha256`.

| Order | Canonical repository file | Observed MCP history name | MCP history version | Result |
| ---: | --- | --- | --- | --- |
| 1 | `20260709171312_0001_identity.sql` | `20260709171312_0001_identity` | `20260714105523` | PASS |
| 2 | `20260709171336_0002_health.sql` | `20260709171336_0002_health` | `20260714105525` | PASS |
| 3 | `20260709171359_0003_intelligence.sql` | `20260709171359_0003_intelligence` | `20260714105529` | PASS |
| 4 | `20260709171417_0004_comms.sql` | `20260709171417_0004_comms` | `20260714105533` | PASS |
| 5 | `20260709171953_0005_integrations.sql` | `20260709171953_0005_integrations` | `20260714105536` | PASS |
| 6 | `20260709172043_0006_harden_rls_auto_enable_execute.sql` | `20260709172043_0006_harden_rls_auto_enable_execute` | `20260714105538` | PASS |
| 7 | `20260710182949_reconcile_contract_spine.sql` | `20260710182949_reconcile_contract_spine` | `20260714105541` | PASS |

MCP generated new disposable-project history versions while retaining each exact canonical filename stem as the migration name. History was listed twice after tests and remained byte-for-byte stable. It was not rewritten to impersonate the repository timestamps. Because normal migration preflight compares version identifiers, this does **not** prove canonical repository-history compatibility: the repository versions may still appear pending to `db push`.

## Contract and adversarial results

| Item | Result | Captured observation |
| --- | --- | --- |
| Sixteen canonical public tables | PASS | Exact table set; every table initially contained 0 rows |
| RLS enabled and forced | PASS | 16 enabled; 16 forced |
| Canonical table grants | PASS | 12 authenticated SELECT grants; no authenticated writes; no anon table grants |
| Service-only tables | PASS | Authenticated read denied |
| Own-row isolation | PASS | Subject A saw one own user row and one own health row |
| Cross-user denial | PASS | Subject A saw zero explicit Subject B rows |
| Client write denial | PASS | Authenticated insert rejected |
| Consent, constraints, cascade, and tenant fixtures | PASS/LIMITED | Inference from the 42/44 aggregate plus independent isolation probes; MCP exposed only the final aggregate result |
| Existing 44-assertion pgTAP contract | **FAIL** | `42/44`; two function-ACL assertions failed |
| Public function ACL | **FAIL** | `anon` retained EXECUTE on `app_user_id`, `enforce_consent_audit_history`, and `health_daily_requires_consent` |
| Exact routine privilege contract | **FAIL** | Expected only authenticated EXECUTE on `app_user_id`; observed additional explicit role grants |
| Migration history stability | PASS | Same seven ordered version/name pairs before and after tests |
| Canonical migration-history compatibility | **FAIL** | MCP versions differ from all seven repository timestamp versions |
| Apply-again/history idempotency | **FAIL/LIMITED** | No second apply was authorized; version mismatch prevents a canonical no-pending claim |
| Data API grant posture | PASS/LIMITED | RLS/grants passed; MCP session did not expose the project Data API schema-setting value |
| Synthetic cleanup | PASS | 0 auth users and 0 application rows remained |

The two decomposed failures match the two missing pgTAP passes. The hosted project grants explicit default function privileges to `anon`, `authenticated`, and `service_role`; revoking only `PUBLIC` in the canonical migration does not remove those explicit grants. No migration was patched because the authorized run allowed only the canonical seven-file chain once.

## Advisors and settings observation

Security advisors returned four INFO-only `rls_enabled_no_policy` findings for the intentional service-only tables:

- `agent_logs`
- `notification_log`
- `oauth_tokens`
- `one_time_tokens`

Performance advisors returned these INFO-only findings:

- Unindexed foreign keys: `chat_messages_parent_message_id_thread_id_fkey`,
  `chat_messages_thread_id_user_id_fkey`, `chat_messages_user_id_fkey`,
  `chat_threads_user_id_fkey`, `notification_log_user_id_fkey`, and
  `one_time_tokens_user_id_fkey`.
- Unused indexes: `idx_patrol_entries_chain`, `idx_one_time_tokens_expires`, and
  `idx_feedback_trace`.

These are recorded observations, not accepted remediation work.

The project reported `statement_timeout = 2min`. It was read only and not changed.

## Remote action ledger

The session trace contains the `git rev-parse HEAD` output immediately before every row. Each
returned `fd663b65305973f19c318bb8acad067cc6798493`; this table is its sanitized transcription.

| Action | Repository SHA before call | Sanitized result |
| --- | --- | --- |
| Project URL identity read | `fd663b65305973f19c318bb8acad067cc6798493` | Exact ref match |
| Empty migration list | `fd663b65305973f19c318bb8acad067cc6798493` | 0 application migrations |
| Platform/public table inventory | `fd663b65305973f19c318bb8acad067cc6798493` | Platform-only state; 0 public tables |
| Initial baseline aggregate | `fd663b65305973f19c318bb8acad067cc6798493` | Safe read failed with `42P01`; no mutation |
| Existence-safe baseline aggregate | `fd663b65305973f19c318bb8acad067cc6798493` | All application counts 0; history table absent |
| Apply `0001_identity` | `fd663b65305973f19c318bb8acad067cc6798493` | Success |
| Apply `0002_health` | `fd663b65305973f19c318bb8acad067cc6798493` | Success |
| Apply `0003_intelligence` | `fd663b65305973f19c318bb8acad067cc6798493` | Success |
| Apply `0004_comms` | `fd663b65305973f19c318bb8acad067cc6798493` | Success |
| Apply `0005_integrations` | `fd663b65305973f19c318bb8acad067cc6798493` | Success |
| Apply `0006_harden_rls_auto_enable_execute` | `fd663b65305973f19c318bb8acad067cc6798493` | Success |
| Apply `reconcile_contract_spine` | `fd663b65305973f19c318bb8acad067cc6798493` | Success |
| Post-apply migration history | `fd663b65305973f19c318bb8acad067cc6798493` | Seven ordered version/name pairs |
| Public table inventory | `fd663b65305973f19c318bb8acad067cc6798493` | 16 RLS-enabled empty tables |
| Transactional pgTAP | `fd663b65305973f19c318bb8acad067cc6798493` | 42/44; rolled back |
| Static-contract decomposition | `fd663b65305973f19c318bb8acad067cc6798493` | Function ACL was the failing seam |
| Routine ACL inventory | `fd663b65305973f19c318bb8acad067cc6798493` | Three routines executable by `anon` |
| Transactional two-subject probe | `fd663b65305973f19c318bb8acad067cc6798493` | Own 1; cross-user 0; denials passed |
| Synthetic cleanup read | `fd663b65305973f19c318bb8acad067cc6798493` | 0 auth users; 0 application rows |
| History stability recheck | `fd663b65305973f19c318bb8acad067cc6798493` | Unchanged seven version/name pairs |
| Security advisors | `fd663b65305973f19c318bb8acad067cc6798493` | Four expected INFO findings |
| Performance advisors | `fd663b65305973f19c318bb8acad067cc6798493` | Nine INFO findings listed above |
| Data API/RLS/grant posture | `fd663b65305973f19c318bb8acad067cc6798493` | Grants/RLS passed; schema setting unavailable |
| `statement_timeout` read | `fd663b65305973f19c318bb8acad067cc6798493` | `2min`; unchanged |

## Cleanup and no-secret evidence

The post-test aggregate counted `auth.users`, `public.users`, `public.user_consents`, and
`public.health_daily`, plus all public application tables through `pg_stat_user_tables`. Every
remaining-row result was zero.

A repository scan of all three proof artifacts returned zero matches for database URLs, JWTs,
private-key headers, GitHub PAT prefixes, Supabase token prefixes, populated service-role or
password assignments, connection-string variables, and raw-health numeric-value patterns.
All seven manifest hashes were recomputed successfully. This is a captured local scan, not CI.

## Local verification wall

- Package-manager guard, frozen install, all workspace typechecks: PASS.
- Contract suite: 50 files / 1,207 tests PASS.
- Canonical seven-file static ordering: PASS.
- Full `pnpm verify`: LIMITED on Windows; stopped when the local Docker/Supabase daemon was absent.
- Local Docker/Supabase dynamic test: NOT RERUN on Windows, neither pass nor fail.
- Repository guards: PASS.
- Worker/runtime suite: LIMITED by an unrelated current-main tracer baseline; 25/26 files and
  715/718 tests passed, with three `packages/runtime/test/tracer.test.ts` sink-observation failures.
  This proof branch changes no runtime source, test, or snapshot.
- Standalone eval suite: absent; `/run-eval` triaged to the current wall.
- `git diff --check`: PASS after evidence finalization.

## Current Supabase guidance consulted

- Supabase changelog index fetched 2026-07-14; no migration/RLS/advisor breaking change altered this run.
- [Database migrations](https://supabase.com/docs/guides/deployment/database-migrations)
- [Database testing](https://supabase.com/docs/guides/database/testing)
- [Securing the Data API](https://supabase.com/docs/guides/api/securing-your-api)

## Verdict and remaining HEY-114 gates

This branch is **not ready for PR review as passing proof**. It is ready only for review of the captured failure. A separately reviewed forward migration must normalize explicit function grants on hosted Supabase, then a new clean disposable cycle would require separate authorization because reset/deletion/reapplication was not authorized here.

HEY-114 must remain In Progress. Still required separately:

1. Read-only Project Woof inventory.
2. Project Woof staging-promotion approval and evidence.
3. Identified production project ref and accountable owner.
4. Hosted-CI restoration follow-up HEY-168.
