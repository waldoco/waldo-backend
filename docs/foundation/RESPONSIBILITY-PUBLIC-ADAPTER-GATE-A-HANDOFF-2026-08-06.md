# Responsibility Public Adapter Gate A handoff

## Outcome and proof level

Gate A is complete at `adapter_conformance_passed` in the local/CI contract environment.
The public responsibility adapter, trusted owner-root route, canonical Supabase session
authority, fresh-schema migration wall, and exact-token revocation behavior are implemented
through the same interfaces used by production configuration.

This is not `cross_surface_acceptance_passed` or `operational_proof_passed`. No migration was
deployed to a hosted Supabase project, the Worker flag remains off by default, and no Kennel,
staging, or production request was exercised.

## What was built

- Feature-gated public Worker routes for v0.1/v0.2 responsibility capture and projection read.
- Exact media negotiation, online-only behavior, bounded raw bytes, duplicate-key and malformed-
  Unicode rejection, strict public response schemas, and non-enumerating problem responses.
- Trusted Supabase `/auth/v1/user` verification followed by the no-argument
  `waldo_responsibility_session_active()` RPC using the same bearer token and an empty body.
- A canonical migration for that stable, boolean-only `SECURITY DEFINER` predicate. It derives
  `auth.uid()` and JWT `session_id`, matches both against a non-expired `auth.sessions` row, pins
  an empty `search_path`, and revokes `PUBLIC`, `anon`, and `service_role` before granting only
  `authenticated` execution.
- One signed Worker-to-existing-`RunLoopDO` bridge. The DO recomputes the version-specific
  canonical envelope digest before the existing `WaldoCoordinator` writes canonical truth.
- Edge-source, authenticated-session, and owner rate limits; exact retry, digest conflict,
  cursor/snapshot, owner isolation, and eviction/reconstruction coverage.
- A real local Supabase Auth/REST integration proof. It signs in a temporary user with bounded
  admin authority metadata, successfully invokes public capture and projection, signs out the
  current session, reuses the exact still-unexpired access token, receives the content-free 401
  shape on both routes, and proves the adapter never resolves the owner root after revocation.
  The temporary user is removed. CI runs this proof after the standard repository wall.

No WorkUnit execution vocabulary, provider planning turn, Kennel integration, connector,
Evidence/Verification, Acceptance, OpenLoop, or ReEntry behavior was added.

## Verification ledger

### Passed

- `npx -y pnpm@10.34.4 install --frozen-lockfile`.
- `@waldo/contracts`: 57 files / 1,468 tests.
- `@waldo/runtime`: 36 files / 957 tests.
- Supabase schema: eight canonical migrations, 53 pgTAP assertions, migration-list/history
  freshness, transactional DROP rollback rehearsal, and no pending migration.
- Local security advisor: no warning-or-higher findings.
- Public-adapter exact-token revocation integration: one file / one test.
- `DOCKER_CONTEXT=desktop-linux npx -y pnpm@10.34.4 verify`: typecheck, frozen install,
  contracts, fresh Supabase reset, pgTAP, runtime, and all repository guards.
- `git diff --check`.

### Failed, then fixed

- The first pgTAP contract failed because the RPC did not exist; the migration made it pass.
- The first rollback query used multiple prepared statements; it was replaced with a single
  transactional `DO` rehearsal.
- Concurrent reviewer resets corrupted the disposable local Supabase initialization and caused
  EOF/duplicate-internal-index failures. Reviewer Docker activity was serialized, only the
  worktree-local test volume was removed, and the final uncontended from-zero wall passed.
- The first full runtime rerun included the Node-only integration test in the Cloudflare pool;
  the normal suite was pinned to `test/**/*.test.ts` and the integration received its own Node
  Vitest configuration. Both suites then passed.

### Unavailable or deferred

- Hosted Waldo and Waldo Staging Supabase projects were discoverable through the authorized app
  connection but reported `INACTIVE`. They were not restored or mutated. Hosted migration,
  sign-out retry, Worker deployment, and zero-DO-write inspection are unavailable.
- The Linear connection required reauthentication, so no issue/comment was written. The user
  explicitly overrode HEY-109 coordination on 2026-08-06 and authorized the migration directly
  in this clean worktree; this is an ownership exception, not a change to architecture authority.
- The rollback fixture proves the SQL DROP is transactional; an ordered deployed rollback drill
  (feature flag off, migration rollback, monitoring) is operationally deferred.

## Preserved architecture boundaries

- `RunLoopDO` and `WaldoCoordinator` remain the only owner root and canonical truth writer.
  There is no new DO, store, service, provider path, or production test RPC.
- Owner, actor, presence, authenticated session, policy revision, and routing derive only from
  verified server context. Clients cannot select them.
- The runtime carries a publishable key, not a Supabase secret/service-role key.
- A session decision admits a new request. Logout cannot retroactively erase a transaction that
  was already admitted, and it does not implicitly cancel already-authorized WorkUnit execution.
- Provider/session `DONE` still cannot mutate Outcome, Verification, Acceptance, OpenLoop, or
  closure.

## What Kennel can consume now

Kennel can implement against the version-pinned v0.1/v0.2 responsibility capture and projection
contracts and the documented 401/409/429/503 behavior. That is contract consumption only until
the public Worker and canonical migration are deployed in an authorized environment.

## Next phase

Gate B may begin in a new bounded session because Gate A's local contract and security wall pass.
Build one explicitly authorized, Outcome-bound, no-tools provider planning turn through the
existing RunLoop effect path. Keep the two candidate-plan scenarios on the same interfaces and
keep Outcome completion, Evidence/Verification, Acceptance, OpenLoop/ReEntry, connectors,
Kennel UI acceptance, staging, production, and operations outside any unsupported claim.

## Files changed

- `.github/workflows/verify.yml`
- `package.json`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/protocol/responsibility-handshake-v0-1.ts`
- `packages/contracts/src/protocol/responsibility-handshake-v0-2.ts`
- `packages/contracts/src/protocol/responsibility-http-adapter-v0-1.ts`
- `packages/contracts/src/protocol/responsibility-http-adapter-v0-1.test.ts`
- `packages/contracts/fixtures/responsibility-http-adapter/v0.1/*`
- `packages/runtime/src/index.ts`
- `packages/runtime/src/do-schema.ts`
- `packages/runtime/src/run-loop/do.ts`
- `packages/runtime/src/responsibility/*`
- `packages/runtime/test/responsibility-worker-adapter.test.ts`
- `packages/runtime/test/responsibility-public-do.test.ts`
- `packages/runtime/test/supabase-responsibility-authority.test.ts`
- `packages/runtime/test/trusted-run-loop.test.ts`
- `packages/runtime/integration/responsibility-local-supabase.test.ts`
- `packages/runtime/vitest.config.ts`
- `packages/runtime/vitest.integration.config.ts`
- `packages/runtime/wrangler.jsonc`
- `packages/runtime/README.md`
- `scripts/verify-supabase-migrations.mjs`
- `scripts/verify-supabase.mjs`
- `supabase/migrations/20260806180000_add_responsibility_session_authority.sql`
- `supabase/tests/schema_contract.sql`
- `supabase/fixtures/assert-canonical-migration-history.sql`
- `supabase/fixtures/assert-responsibility-session-authority-rollback.sql`
- `docs/foundation/NEXT-BACKEND-SESSION-PROMPT.md`
- this handoff
