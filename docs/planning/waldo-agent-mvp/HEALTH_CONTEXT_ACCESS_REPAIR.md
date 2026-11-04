# Derived health context access repair

PR #442 restores an already-applied historical table. Its exact-head CI replay succeeded, but seven schema-contract assertions failed because the table was missing from the contract and inherited broad Supabase table/helper privileges. A separate additive migration normalizes those ACLs; the historical restoration and its eight health-read assertions stay unchanged.

## Grant and RLS decision

- `anon` / `PUBLIC`: no table access.
- `authenticated`: explicit SELECT only, under the unchanged `auth.uid() = user_id` owner policy. No client write policy or table/column write grant.
- `service_role`: SELECT, INSERT, UPDATE only. These support the inspected reads and health-sync upserts. No DELETE, TRUNCATE, REFERENCES or TRIGGER grant.
- `public.set_updated_at()`: no direct EXECUTE for PUBLIC, anon, authenticated or service_role. Its existing BEFORE UPDATE trigger remains operational; PostgreSQL checks trigger-function execution authorization when the trigger is created, not for each triggering statement. The real-table trusted-upsert test verifies this behavior.
- RLS stays enabled and is explicitly FORCE RLS. Non-bypass table owners cannot bypass owner policy; Supabase's trusted service role has BYPASSRLS. The signed, owner-scoped health-read RPC remains unchanged. FORCE is verified separately from table-count updates.

## Companion app provenance and limitation

Source inspected at waldo-app `895ed6e4cb4a2e5f5a1f9dcba20eb271ceacf258`; these are source findings, not deployment or live writer proof:

- `runtime/waldo-worker/src/supabase.ts`, `SupabaseRlsClient.latestHealth`: owner JWT, publishable key and owner/day filter read derived context. This supports owner SELECT with RLS.
- `src/health/sync/healthSyncClient.ts`: invokes `health-sync`; the native client holds no service key and does not directly write this table.
- `supabase/functions/_shared/http.ts`, `adminClient` / `requireUser`: service-role client for trusted writes, authenticated user resolution for row scope.
- `supabase/functions/health-sync/index.ts`, `handleIngest`: calls `ensureConsent` before table upserts; a recorded revoked consent skips ingestion. The context write uses the resolved auth user and `user_id,day` conflict key. `supabase/functions/insights/index.ts`, `readTrend`, uses service-role SELECT with user/day scope. No inspected context path requires client writes or service DELETE.
- `src/health/sync/useHealthSyncPref.ts` flips the local upload preference and calls the server consent action. Local default enablement and the function's first-ingest auto-recording are existing app behavior; this repair does not certify them as sufficient consent.

There is an unresolved cross-repo consent-contract conflict. App `ensureConsent` / `handleConsent` use `user_consents.consent_kind`, `granted`, string version `v1`, `revoked_at` and auth-user IDs. Beta-mvp's canonical consent records use `consent_class`, `status`, integer versions, source/purpose/age evidence and internal public-user IDs; audit mutation is limited to withdrawal (`status`, `withdrawn_at`). The app also uses a different health_daily layout. This SQL repair does not adapt those writers or weaken beta-mvp consent controls. Trusted table privileges are capability, not health-processing permission; app ingestion readiness remains unverified and requires a separately reviewed contract integration.

## Verification and upgrade gate

Historical file SHA-256: `c5610730cde63e2ac675b40535dd98b4b08eff6981b4d676ef25126f69e910cb`. Excluding its final newline: `dd9d80c22875df74eaf5d1de4852a8169b6556833fc7951ba073ae9f7fd83561`. No historical migration is modified.

New version `20260930134308` is later than `20260930100000` and unique against the fetched beta-mvp and reviewed PR source. Both canonical lists include it. The exact schema matrix now covers 17 tables without exemptions for forbidden grants.

`waldo_health_context_access.sql` tests the real table's exact fourteen columns/defaults, constraints/indexes, trigger/helper, policy, FORCE RLS, role/column/helper ACLs, two synthetic owners on the same day, foreign-owner exclusion, anon rejection, rejected writes with zero row delta, trusted upsert/update trigger and the signed derived-only read shape.

The standard local verifier also resets only its local test stack through `20260930100000`, assembles the actual hardening SQL between transactional upgrade fixtures, proves seven preservation/isolation/trigger assertions, then applies pending local migrations and rechecks canonical history. Existing rows and column/constraint/index/trigger/helper definitions are compared before and after hardening; transaction fixtures roll back. The plain PostgreSQL test shim mirrors the real Supabase service role's BYPASSRLS flag; leaving it unset produced a demonstrated trusted-writer failure under FORCE RLS. Client roles remain non-bypass. No workflow changes or shared database operations are part of this repair.

Before merge, exact-head standard verify and Supabase CI must pass, followed by the technical and independent security/content gates. The separate Workers preview configuration lane owns its build failure.

After merge, any revised staging packet must pin the reviewed merged SHA and verify Waldo-MVP ref `togdshayyxycitzckpqv`. Its proposed pending set is `20260930060000`, `20260930070000`, `20260930100000`, plus `20260930134308`. This is a proposal for review, not permission to bypass the former three-only dry-run stop condition. No linked push, migration repair, shared/production database write or worker deployment is authorized by this PR.
