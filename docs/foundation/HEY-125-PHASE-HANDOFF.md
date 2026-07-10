# HEY-125 Staging Prep -> ES256 Issuer Proof Handoff

Status: HEY-125 issuer and Data API proof complete; staging mint seam disabled.
Date: 2026-07-10 IST.
Branch: `codex/hey-125-es256-issuer-spike`.
Linear: HEY-125.

## What Was Built

- Project Woof 1 (`oqcjjcytjvrckvylagsl`) is now prepared with the Waldo HEY-9 Supabase schema/RLS baseline.
- Applied HEY-9 migrations from the reviewed historical schema lineage:
  - `0001_identity`
  - `0002_health`
  - `0003_intelligence`
  - `0004_comms`
  - `0005_integrations`
- Added one staging-prep hardening migration:
  - `0006_harden_rls_auto_enable_execute`
- Created a repo-local evidence artifact:
  - `artifacts/spikes/adr-0066/HEY-125-STAGING-PROOF.md`
- Assigned HEY-125 to Ashish in Linear, moved it to `In Progress`, and posted kickoff/progress comments.

## What Works (With Evidence)

- Project identity: verified through Supabase MCP `get_project_url`, result `https://oqcjjcytjvrckvylagsl.supabase.co`.
- Migration history: verified through Supabase MCP `list_migrations`, result includes `0001_identity` through `0006_harden_rls_auto_enable_execute`.
- Canonical public schema: verified through SQL/MCP, result: 16 expected public tables, 0 missing, 0 extra.
- RLS posture: verified through SQL/MCP, result: RLS enabled on 16/16 public tables and forced on 16/16 public tables.
- Client-readable policy posture: verified through SQL/MCP, result: 12 public RLS policies, matching HEY-9 client-readable table set.
- Authenticated grants: verified through SQL/MCP, result: authenticated has `SELECT` only on expected client-readable tables.
- Security advisor posture: verified through Supabase MCP `get_advisors`, result: 0 WARN findings after hardening.
- Expected advisor INFO items remain: `agent_logs`, `notification_log`, `oauth_tokens`, and `one_time_tokens` have RLS enabled with no policies because they are service-only tables.
- SQL-level RLS simulation: verified with a rollbacked synthetic probe, result: User A sees one own row in sampled client-readable tables and zero explicit User B `health_daily` rows.
- JWT subject mapping: verified in the same rollbacked probe, result: `auth.uid()` is the Supabase Auth UUID and `public.app_user_id()` maps it to `public.users.id`.
- Repo guard verification: `npx.cmd -y pnpm@10.34.4 verify:guards` passed.
- Whitespace verification: `git diff --check` passed.
- Artifact secret scan: focused scan found no service-role key, secret key, private key, raw JWT, or bearer header in `artifacts/spikes/adr-0066`.

## Proof Completion Update

- Generic Supabase Third-Party Auth registration is resolved for the dedicated HTTPS issuer/JWKS.
- Supabase resolved one ES256 public key and matched the deployed public `kid`, `x`, and `y` before minting.
- The authenticated staging mint seam derived `sub` from a verified Supabase Auth session and pinned `role`, `aud`, `iss`, `alg`, `kid`, and `actor`.
- Live Data API proof passed for A/B own-row reads and zero-row cross-user reads on `users` and synthetic `health_daily` fixtures.
- Expired, garbage-signature, wrong-kid, wrong-issuer, wrong-audience, service-role-shaped tampering, `alg:none`, malformed, and missing bearer probes were rejected.
- The proof route is disabled and returns 404. Discovery/JWKS remain healthy.
- All marked Auth, user, consent, and health fixtures are deleted. Temporary Auth settings are restored.
- Security reviewer and QA breaker both returned PASS.

## Architecture Decisions Made During This Phase

- Schema setup is now part of HEY-125 staging prep for Project Woof 1.
  - Why: the intended Supabase MCP project was blank at session start, so the ES256/RLS proof had no protected Waldo rows to exercise.
  - This does not change the Master Reference spec; it is staging preparation for an existing accepted schema baseline.
- HEY-125 remains a proof/evidence ticket, not production implementation.
  - No `db.forUser` wrapper, runtime code, production key rotation, or service-role data-plane path was built.
- JWT `sub` should be treated as the Supabase Auth user UUID for this schema.
  - Evidence: `users.auth_id = auth.uid()` and `app_user_id()` maps Auth UUID to app-local `users.id`.
  - This resolves the earlier `auth.users.id` vs `public.users.id` ambiguity for the HEY-9 schema shape.
- `public.rls_auto_enable()` execute grants were hardened in staging.
  - Why: Supabase advisors flagged a pre-existing `SECURITY DEFINER` function executable by `PUBLIC`, `anon`, and `authenticated`.
  - Action: revoked execute from public client roles, leaving `postgres` and `service_role`.
  - This is a staging security prep decision, not a product schema change.

## Hard-Won Lessons

- Confirm the Supabase MCP project ref before making any schema/RLS claims. Earlier results from a wrongly pointed project were invalid for HEY-125.
- Supabase schema readiness and issuer trust are separate gates. A green RLS schema does not prove Data API JWT acceptance.
- Do not generate ES256 private keys or JWTs until the issuer/signing-key trust path is confirmed. Otherwise the session creates secret-handling risk without moving the proof forward.
- The HEY-9 schema's user identity model is two-step: JWT `sub` -> `auth.uid()` -> `users.auth_id` -> `app_user_id()`.
- Supabase advisor INFO items can be expected and intentional when service-only tables have RLS enabled and no client policies; WARN items need explicit triage.

## Next Phase Boundary

HEY-125 no longer blocks the custom-issuer platform decision. The next production slice may design `db.forUser` and operational rotation separately. Do not promote the temporary proof seam, its per-isolate limiter, anonymous fixture setup, or local service-role cleanup path into production runtime code.

## Files Changed

- `artifacts/spikes/adr-0066/HEY-125-STAGING-PROOF.md`
- `docs/foundation/HEY-125-PHASE-HANDOFF.md`

## Commits

- `e880854 docs: add HEY-125 Supabase staging proof`

This handoff is expected to be committed as the follow-up docs closeout for the same branch.

## Remote State Changed

Supabase Project Woof 1 (`oqcjjcytjvrckvylagsl`) now has the following remote migrations:

| Version | Migration |
| --- | --- |
| `20260709171312` | `0001_identity` |
| `20260709171336` | `0002_health` |
| `20260709171359` | `0003_intelligence` |
| `20260709171417` | `0004_comms` |
| `20260709171953` | `0005_integrations` |
| `20260709172043` | `0006_harden_rls_auto_enable_execute` |

## Safety Notes

- No production Supabase project was touched.
- No production Cloudflare state was touched.
- No runtime files were edited.
- No private signing key, service-role key, raw JWT, auth header, provider secret, or raw health payload was committed.
- HEY-125 proof evidence is complete. The temporary proof route remains disabled.
