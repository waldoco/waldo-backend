# HEY-125 ADR-0066 Staging Proof

Date: 2026-07-09
Project: Project Woof 1
Supabase ref: `oqcjjcytjvrckvylagsl`
Issue: HEY-125
Branch: `codex/hey-125-es256-issuer-spike`

## Summary

HEY-125 remains a staging proof, not production `db.forUser` implementation.

Project Woof 1 initially had no Waldo public schema, no Waldo migrations, and no public RLS policies. Schema setup was therefore added to staging spike prep. The HEY-9 baseline schema is now applied to Project Woof 1 and verified: 16 canonical public tables, RLS enabled and forced on all 16, 12 client-readable policies, authenticated grants matching the HEY-9 contract, and a rollbacked synthetic RLS probe showing User A sees own rows and zero explicit User B health rows.

The ES256 issuer proof is not complete yet. The remaining blocker is issuer/signing-key trust configuration: the current Supabase MCP and discovered CLI commands can inspect/apply database state and generate signing material, but do not expose a command/tool to register/import the dedicated ES256 issuer/signing key into Project Woof 1. No private key or JWT was generated because doing so before a confirmed trust path would create avoidable secret-handling risk.

## Source Packet

- Linear HEY-125: `[PROOF] ADR-0066 Supabase ES256 issuer staging spike - per-user RLS JWT custody`
- `docs/foundation/CONTRIBUTOR-ONBOARDING.md`
- `docs/foundation/NEXT-SESSION-PLAN.md`
- `packages/contracts/src/auth/mint.ts`
- Historical HEY-9 schema source: `origin/sql-schema:supabase/migrations/0001_identity.sql` through `0005_integrations.sql`
- Historical HEY-9 test source: `origin/sql-schema:supabase/tests/pr2_schema.sql`
- Supabase docs checked through MCP:
  - `https://supabase.com/docs/guides/auth/signing-keys`
  - `https://supabase.com/docs/guides/auth/custom-oauth-providers`
  - `https://supabase.com/docs/guides/api/securing-your-api`

## Run Contract

Current:

- Observed Project Woof 1 URL: `https://oqcjjcytjvrckvylagsl.supabase.co`
- Observed initial state before prep: no Supabase migrations, no public tables, no public RLS policies.
- Observed local branch: `codex/hey-125-es256-issuer-spike`
- Observed local main before branch: up to date with `origin/main` at `181e11a`.

Ideal:

- Project Woof 1 can prove a dedicated ES256 issuer mints per-user JWTs that Supabase Data API accepts, populating `auth.uid()` under RLS.
- Cross-tenant reads return zero rows through RLS, invalid JWTs are rejected, and HS256 remains non-production.
- Evidence is committed redacted under `artifacts/spikes/adr-0066/`.

Criteria:

- [x] ISC-1: Project Woof 1 has the Waldo HEY-9 schema/RLS baseline.
  - Falsifier: missing/extra public tables, missing forced RLS, missing client-readable policies, or wrong authenticated grants.
- [x] ISC-2: SQL-level RLS simulation maps JWT `sub` to `auth.uid()` and then to `public.app_user_id()`.
  - Falsifier: `auth.uid()` is null/wrong or `app_user_id()` does not map to the public user row.
- [x] ISC-3: SQL-level cross-tenant read probe returns zero User B health rows for User A.
  - Falsifier: User A can see User B rows.
- [x] ISC-4 Anti: Staging prep does not commit secrets, raw JWTs, auth headers, or raw health values.
  - Falsifier: artifact or diff contains secret material, bearer tokens, or health measurements.
- [ ] ISC-5: Data API accepts a dedicated ES256 issuer JWT and populates `auth.uid()`.
  - Falsifier: issuer cannot be configured, token is rejected, or `auth.uid()` is not populated.
- [ ] ISC-6: Data API rejects expired, garbage, and `none` algorithm JWTs.
  - Falsifier: invalid JWT reaches protected data.

## Staging Prep Applied

Applied through Supabase MCP `apply_migration` to Project Woof 1:

| Version | Migration |
| --- | --- |
| `20260709171312` | `0001_identity` |
| `20260709171336` | `0002_health` |
| `20260709171359` | `0003_intelligence` |
| `20260709171417` | `0004_comms` |
| `20260709171953` | `0005_integrations` |
| `20260709172043` | `0006_harden_rls_auto_enable_execute` |

`0006_harden_rls_auto_enable_execute` was added because Project Woof 1 had a pre-existing `public.rls_auto_enable()` `SECURITY DEFINER` function executable by `PUBLIC`, `anon`, and `authenticated`. The migration revokes execute from public client roles. Afterward, only `postgres` and `service_role` retained execute.

## Verification Evidence

Project identity:

```text
get_project_url -> https://oqcjjcytjvrckvylagsl.supabase.co
```

Schema table check:

```text
actual_tables:
agent_logs, chat_messages, chat_threads, crs_scores, feedback_signals,
health_daily, notification_log, oauth_tokens, one_time_tokens,
patrol_entries, spots, subscriptions, user_baselines, user_consents,
user_devices, users

missing_count: 0
extra_count: 0
rls_enabled_count: 16
rls_forced_count: 16
policy_count: 12
```

Authenticated grants:

```text
authenticated SELECT grants:
chat_messages, chat_threads, crs_scores, feedback_signals, health_daily,
patrol_entries, spots, subscriptions, user_baselines, user_consents,
user_devices, users
```

Security advisors after hardening:

```text
WARN: 0
INFO:
- public.agent_logs has RLS enabled with no policy
- public.notification_log has RLS enabled with no policy
- public.oauth_tokens has RLS enabled with no policy
- public.one_time_tokens has RLS enabled with no policy
```

The remaining INFO items match the HEY-9 service-only table design: RLS enabled, no client policies.

Rollbacked SQL-level RLS probe:

```text
probe: user_a_visible_counts
users_count: 1
consents_count: 1
health_daily_count: 1
chat_threads_count: 1
chat_messages_count: 1
explicit_user_b_health_count: 0
auth_uid_text: 00000000-0000-0000-0000-0000000000a1
app_user_id_text: 10000000-0000-0000-0000-0000000000a1
```

Interpretation:

- `auth.uid()` is the Supabase Auth user UUID from JWT `sub`.
- `public.app_user_id()` maps that Auth UUID to the app-local `public.users.id`.
- User A sees exactly one own row in the sampled client-readable tables.
- User A sees zero explicit User B `health_daily` rows.

## CLI Discovery

Local global Supabase CLI was not installed:

```text
supabase --version -> command not recognized
```

`npx.cmd supabase` worked:

```text
npx.cmd supabase --version -> 2.109.1
```

Discovered command shapes:

```text
supabase gen signing-key [--algorithm ES256|RS256] [--append]
supabase gen bearer-jwt [--role string] [--sub string] [--exp string] [--valid-for string] [--payload string]
```

No command was found in the available CLI help or MCP tools to register/import the dedicated issuer/signing key into Project Woof 1.

## Remaining Blocker

Blocked:

- Dedicated ES256 issuer/signing-key trust configuration for Project Woof 1.

Needed next:

1. Configure Project Woof 1 to trust the dedicated ES256 issuer/signing key through the Supabase Dashboard or an authenticated Admin API path that supports the current signing-key/custom-provider setup.
2. After trust is configured, generate a short-lived test JWT with:
   - `alg: ES256`
   - `kid` matching the trusted key
   - `sub` equal to the Supabase Auth user UUID
   - `role: authenticated`
   - `aud: authenticated`
   - `iss` matching the configured issuer
   - `iat`, `nbf`, `exp`
   - `actor: do-agent`
3. Call the Data API with a publishable `apikey` header and a bearer-token authorization header.
4. Record redacted pass/fail for:
   - own-row read
   - cross-tenant zero-row read
   - expired JWT rejection
   - garbage JWT rejection
   - `none` algorithm rejection
   - HS256 not used except as explicitly marked non-production contingency

## Secret Handling

No private signing key, service-role key, raw JWT, auth header, raw health payload, provider secret, or production project reference is included in this artifact.
