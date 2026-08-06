# Responsibility Public Adapter Gate A handoff

## Outcome and proof level

The repaired Gate A candidate is `adapter_conformance_passed` in the local/CI contract environment
at the current PR head. The exact full verification wall and independent Standards, Spec, Security,
and adversarial breaker reviews pass. The public responsibility adapter, stable owner-root route,
Supabase session authentication, Waldo-owned identity/Presence authority, upgrade-safe schema
migration, and exact-token revocation behavior use production interfaces, but the proofs are
layered rather than one composed end-to-end test. PR #76 remains unmerged.

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
- Supabase proves only the account subject and current Auth session. The owner ID/root is derived
  from that verified subject and does not include policy or routing revisions. Bounded admin
  metadata is an admission claim, never the final owner/Presence/policy/routing authority.
- The signed capture/projection admission establishes canonical account-subject, one public Presence,
  policy-revision, and routing state only when an owner root is empty or is a legacy V3 root with
  no authority columns populated. Thereafter `IdentityPresenceModule` rejects changed subject,
  Presence, policy, or routing claims while allowing bounded renewed-login session bindings to the
  same Presence. Capture revalidates this state inside the Outcome transaction; projection
  revalidates it immediately before its synchronous read. Bootstrap/refresh and the owner/session
  rate increments share one transaction; rejection rolls all of them back.
- V4 extends the already-merged V3 tables instead of rewriting V3. Upgrade tests preserve existing
  Outcome, event, idempotency, projection, and cursor rows and leave legacy roots unauthorized until
  signed admission; failure tests prove the V4 upgrade rolls back to intact V3 structure.
- One signed Worker-to-existing-`RunLoopDO` bridge. The DO recomputes the version-specific
  canonical envelope digest before the existing `WaldoCoordinator` writes canonical truth.
- Edge-source, authenticated-session, and owner rate limits; exact retry, digest conflict,
  cursor/snapshot, owner isolation, and eviction/reconstruction coverage.
- Executable version-pinned fixtures cover both capture versions, projection queries, raw duplicate-
  key/malformed-Unicode bodies, harness fault conditions, statuses, and exact problem responses.
- A real local Supabase Auth/REST integration proof. It signs in a temporary user with bounded
  admin claim metadata, successfully invokes the adapter contract for capture and projection,
  signs out the
  current session, reuses the exact still-unexpired access token, receives the content-free 401
  shape on both routes, and proves the adapter never resolves the owner root after revocation.
  The temporary user is removed. The integration and its Node configuration are TypeScript-
  checked, and the canonical repository `verify` wall runs this proof. It uses an adapter-contract
  fake owner root. Separate workerd tests cover the production signed bridge and real RunLoopDO/
  Coordinator persistence; no single test composes local Supabase Auth through the real DO.

No WorkUnit execution vocabulary, provider planning turn, Kennel integration, connector,
Evidence/Verification, Acceptance, OpenLoop, or ReEntry behavior was added.

## Verification ledger

### Passed

- `npx -y pnpm@10.34.4 install --frozen-lockfile`.
- `@waldo/contracts`: 57 files / 1,468 tests.
- `@waldo/runtime`: 37 files / 969 tests.
- Supabase schema: eight canonical migrations, 53 pgTAP assertions, migration-list/history
  freshness, transactional DROP rollback rehearsal, and no pending migration.
- Local `supabase db lint --level warning`: no schema errors.
- Node adapter integrations: two files / five tests (four executable fixture tests and one real
  local Supabase exact-token revocation test).
- `DOCKER_CONTEXT=desktop-linux npx -y pnpm@10.34.4 verify`: typecheck, frozen install,
  contracts, fresh Supabase reset, pgTAP, runtime, and all repository guards.
- `git diff --check`.
- Independent Standards, Spec, Security, and adversarial breaker reviews: PASS on the final source.

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
- External review found that routing-version metadata partitioned one owner into multiple DOs,
  Supabase metadata acted as final Waldo authority, authority TTL was unbounded, malformed Auth
  success mapped to 401, capture queries were ignored, integration code was not typechecked, and
  public problems were duplicated/string-mapped. Each lead was reproduced before repair: routing
  now depends only on the verified subject-derived owner, Waldo state revalidates authority,
  access-token TTL is bounded, malformed Auth success maps to 503, capture queries are rejected,
  the Node lane is in `verify`, and contract-owned problems/stable error names drive responses.
- Follow-up reviews caught a rewritten merged V3 migration, no production canonical-authority
  admission caller, permanent login-session binding, authority writes before rate limiting, and a
  Presence/session expiry race. V3 is now unchanged; additive V4 upgrade/rollback preserves data;
  signed capture/projection admission supports bounded renewed sessions; and authority plus both
  rate counters commit or roll back in one transaction.
- The first post-repair runtime wall failed because the exact RPC allowlist had not included the
  temporary authority RPC. The RPC was removed by the atomic-admission design, the allowlist remains
  narrow, and the final runtime wall passes.
- Breaker reviews found that the first owner-limit test hit the session limit and that raw-byte
  fixtures were vacuous. The final test uses a fresh fifth session to reach owner count 241 and
  compares all authority/rate rows; strict hash-pinned fixtures remain schema-valid under ordinary
  parsing and fail only when duplicate-key/fatal-UTF-8 protections are active.

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
- Supabase authenticates the account/session; `IdentityPresenceModule` is the canonical resolver
  for owner, actor/Presence, policy revision, routing generation, and active login-session binding.
  Clients cannot select them. Exact-shape admin metadata can bootstrap an empty or legacy owner
  root once, but cannot mutate established Waldo authority; user metadata is ignored.
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

Gate B remains closed while PR #76 is under review. It may begin only after this repaired Gate A
diff is merged. Then build one explicitly authorized,
Outcome-bound, no-tools provider planning turn through the
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
- `packages/runtime/test/identity-presence-module.test.ts`
- `packages/runtime/test/supabase-responsibility-authority.test.ts`
- `packages/runtime/test/trusted-run-loop.test.ts`
- `packages/runtime/integration/responsibility-local-supabase.test.ts`
- `packages/runtime/integration/responsibility-contract-fixtures.test.ts`
- `packages/runtime/vitest.config.ts`
- `packages/runtime/vitest.integration.config.ts`
- `packages/runtime/tsconfig.integration.json`
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
