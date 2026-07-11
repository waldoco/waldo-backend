# HEY-134 Canonical Migration Reconciliation

Status: implementation evidence for HEY-134. This document does not authorize a shared-environment migration.

## Run contract

- **Current:** HEY-9's reviewed five-file schema lineage existed only on historical branches; Project Woof recorded those five migrations plus the HEY-125 RLS-helper hardening migration; `origin/main` had no canonical migration directory or database contract gate.
- **Ideal:** a fresh, unlinked Supabase database applies the complete ordered history, passes tenant/RLS/grant/constraint pgTAP contracts, and exposes no app or service-only data beyond the approved contract.
- **Gap closed here:** re-land the five reviewed migrations byte-for-byte, preserve the Project Woof migration versions, add transitional `0006` behavior for fresh databases, and reconcile only contract-spine differences in a forward migration.
- **Remaining external gap:** Project Woof alone contains the opt-in `public.rls_auto_enable()` helper. HEY-114 owns read-only drift detection followed by an explicitly approved convergence decision. HEY-134 does not mutate that project.

## Deep-module boundary

- **Module:** canonical Supabase schema lineage under `supabase/`.
- **Interface:** ordered SQL migrations plus the app-facing read contract.
- **Contract:** `packages/contracts`, ADR-0066 identity/JWT mapping, ADR-0073 consent records, and the pgTAP suite.
- **Seam:** `public.app_user_id()` maps JWT `sub` (`auth.uid()`) to `public.users.id`; child tables remain keyed by internal `user_id`.
- **Adapter:** the Supabase CLI applies and tests the schema in an isolated local stack.
- **Impact surface:** migration history, tables/constraints, grants, RLS policies, service-only posture, and CI verification. Worker, Durable Object, provider, delivery, Spots semantics, projection code, and shared Supabase environments are excluded.

## Reconciliation table

| Surface | Historical HEY-9 / Project Woof | Current contract or app evidence | Canonical HEY-134 decision |
|---|---|---|---|
| Migration identity | Five HEY-9 files; Project Woof records timestamp versions plus `0006` | CLI compares timestamp versions | Preserve Project Woof timestamp filenames and ordering; `0001`–`0005` content is byte-for-byte historical |
| Tables | 16 public tables | waldo-app contains overlapping and additional runtime tables | Keep exactly the 16 reviewed tables; do not copy app runtime/projection tables or create `app_feed_v1` |
| Identity | `users.auth_id -> auth.users.id`; children reference `users.id` | ADR-0066 proves JWT `sub` mapping | Preserve `auth.uid() -> users.auth_id -> users.id -> app_user_id()`; never authorize from user metadata |
| Primary/foreign keys | Internal user UUIDs, tenant-bound composite chat FKs, cascading user children | App inventory sometimes references `auth.users` directly | Preserve historical PK/FK design and composite chat tenant/thread constraints |
| Client grants | Authenticated receives SELECT only on 12 tables; anon receives none | Current Supabase may require explicit Data API grants | Keep explicit SELECT grants separate from RLS; no app-role mutations |
| RLS | All 16 tables enable and force RLS; 12 tenant-bound SELECT policies | Security invariant requires ownership, not role-only authorization | Preserve `TO authenticated` plus `app_user_id()` ownership; no policies on service-only tables |
| Service-only tables | `agent_logs`, `notification_log`, `oauth_tokens`, `one_time_tokens` | App inventory does not define canonical service access | Keep RLS enabled/forced with no client policies or grants; preserve restricted service-role grant matrix |
| Views/functions | No client view; invoker identity/consent functions | Client views would require `security_invoker` | Add no views and no permission-workaround `SECURITY DEFINER` functions |
| Consent | Legacy boolean/policy-version audit columns | ADR-0073 requires class/source/purpose/version/status/timestamps/18+ evidence | Add nullable canonical columns without fabricating legacy evidence; make audit rows append-only except for withdrawal; require re-grant as a new versioned row; active consent gates health writes by source and purpose |
| Raw health | `health_daily` is isolated and service-written | Contract requires health-processing consent | Preserve read-only tenant access and exact active-consent trigger; do not broaden client writes |
| Trace IDs | Historical UUID columns | Contract trace identifiers are opaque strings | Widen persisted trace IDs to text in the forward migration |
| Notification idempotency | Historical unconstrained text | Contract uses 64-character lowercase hexadecimal keys | Add the exact format constraint; `notification_log` remains a service log, not an app feed |
| CRS persistence | Historical columns lacked contract checks | Contract fixes the composite and four Form pillars at 0–100, zone thresholds, and confidence bounds | Add composite/pillar bounds, zone, score/zone agreement, and confidence checks; leave unrelated historical Recovery/Weight/Load fields unchanged pending their owning contracts |
| `0006` hardening | Project Woof had an opt-in `SECURITY DEFINER` RLS helper executable by client roles | Fresh databases do not contain the helper | Transitional conditional revoke: never create it; no-op when absent; revoke PUBLIC/anon/authenticated when present; test both paths |

## Migration list

1. `20260709171312_0001_identity.sql`
2. `20260709171336_0002_health.sql`
3. `20260709171359_0003_intelligence.sql`
4. `20260709171417_0004_comms.sql`
5. `20260709171953_0005_integrations.sql`
6. `20260709172043_0006_harden_rls_auto_enable_execute.sql`
7. `20260710182949_reconcile_contract_spine.sql`

## Verification boundary

The PR verification wall uses a pinned Supabase CLI on an isolated GitHub-hosted Ubuntu runner. It starts an unlinked local database, applies the chain from zero, runs pgTAP, checks the exact migration list, and separately replays `0006` after installing a CI-only legacy-helper fixture. Every database command is local; the workflow has read-only repository permissions, supplies no Supabase access token, requires no project secret, and performs no staging or production action.

HEY-114 owns durable environment inventory, linked staging promotion, drift convergence, preview-branch feasibility, secrets, and production approval gates.
