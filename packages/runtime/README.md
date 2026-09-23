# @waldo/runtime — hermetic Gate-5 runtime substrate

Proves that real Workers/Durable-Object code executes inside the Workers runtime
(workerd via Miniflare), not a Node approximation. This is Gate 5 (hermetic
runtime) of the local-dev testing pipeline. It runs under
`@cloudflare/vitest-pool-workers` and holds one test-only Durable Object
(`RuntimeProbeDO`) exercising DO SQLite durability, the single alarm slot, and
eviction survival. No product logic, no live services, no secrets.

## Confirmed `@cloudflare/vitest-pool-workers` pool limitations

These are the behavioural constraints of the Workers Vitest pool that shape the
test in this package:

- **Storage isolation is per test FILE**, not per test/block. Writes are undone at
  the end of each test file; multiple `test()` blocks in one file share DO SQL/KV/R2
  state. Use `reset()` / `evictAllDurableObjects()` or split files for a clean slate.
- **Always `await` every storage read/write** (DO storage, KV, R2, cache). Un-awaited
  I/O races the isolation teardown and silently drops.
- **Consume the entire response body** for every `fetch()` / `R2.get()` even when not
  asserting on it, or the pool can hang or leak.
- **Dispose non-primitive RPC results** with `using` when a DO/Service RPC returns an
  object or stream.
- **Native V8 coverage is unsupported** — use Istanbul-instrumented coverage instead.
- **Vitest fake timers do not apply** to KV/R2/cache simulators; you cannot expire keys
  by advancing fake time. DO alarms are driven via `runDurableObjectAlarm`, not timers.
- **Dynamic `import()` does not work** inside `export default { ... }` handlers or DO
  event handlers — use static top-level imports (this package does).
- **WebSockets with Durable Objects are unsupported** under per-file storage isolation
  (workaround `--max-workers=1 --no-isolate`; not used here — no WebSockets).
- `runInDurableObject` / `runDurableObjectAlarm` / `evictDurableObject` **only work with
  stubs pointing to DOs defined in the main worker** (`src/index.ts`).
- `ctx.exports` may miss entries under complex/virtual-module builds; the
  `additionalExports` pool option is the workaround (not needed for one directly
  exported DO).
- Module-resolution edge cases resolve via `deps.optimizer` bundling; global-setup
  imports run in Node, not workerd.

## Running

```sh
pnpm --filter @waldo/runtime typecheck
pnpm --filter @waldo/runtime test
```

## Local bindings

- `WALDO_ENV` is required before `RunLoopDO` resolves provider adapters. `test`
  and `local` may default to fake adapters; any undeclared environment fails
  closed instead of silently selecting fakes.
- `RUN_LOOP_PROVIDER_MODE=fake` is allowed only with `WALDO_ENV=test|local`.
  `RUN_LOOP_PROVIDER_MODE=gateway` is staging-only and additionally requires
  `RUN_LOOP_PROVIDER_LIVE=1`, `CLOUDFLARE_ACCOUNT_ID`, `AI_GATEWAY_ID`, and an
  `AI_GATEWAY_API_TOKEN` Cloudflare Secrets Store binding. The binding exposes
  asynchronous `get()` access; no token string belongs in environment variables or source.
- `RUN_LOOP_LOCAL_INGRESS_TOKEN` enables the fake-first `RunLoopDO` local ingress
  test seam. It is accepted only with `WALDO_ENV=test|local`, and ingress fails closed
  when the binding is absent or shorter than 16 characters. The Vitest pool supplies a
  non-secret synthetic value in `vitest.config.ts`.

### Responsibility public adapter

The responsibility HTTP adapter defaults off. `RESPONSIBILITY_PUBLIC_API_ENABLED=true`
enables only the version-pinned capture/projection routes; missing configuration fails
closed. Enabling it requires:

- `SUPABASE_PROJECT_URL` and the non-secret `SUPABASE_PUBLISHABLE_KEY`. Each request is
  verified against Supabase Auth's fixed `/auth/v1/user` endpoint and then against the
  no-argument `waldo_responsibility_session_active` PostgREST RPC. The RPC must derive the
  caller and `session_id` only from the verified user JWT, return exactly one boolean, and
  expose no session data. The owner root is derived only from the verified Auth subject and is
  stable across policy/routing revisions. Exact-shape admin-controlled `app_metadata` supplies
  only bounded bootstrap references for one Presence registration, policy revision, and the pinned
  routing version; user metadata is ignored. The signed capture/projection admission may establish
  those values in an empty or legacy owner root exactly once. `IdentityPresenceModule` then owns
  them: later
  metadata cannot change the subject, Presence, policy revision, or route, while a renewed Supabase
  login may add a bounded session binding to that same Presence. Capture and projection revalidate
  the Waldo-owned state. Public enrollment, multi-Presence onboarding, policy transitions, and
  Presence lifecycle endpoints are not implemented by this adapter.
- `RESPONSIBILITY_RATE_LIMITER`, the Cloudflare Rate Limiting binding declared in
  `wrangler.jsonc`. Its pre-auth bucket is derived only from Cloudflare's trusted
  `CF-Connecting-IP`; the owner Durable Object separately enforces per-session and
  per-owner limits. Canonical authority bootstrap/refresh and both counters commit atomically, so a
  rate rejection cannot leave authority or rate state partially changed.
- `RESPONSIBILITY_INGRESS_HMAC_SECRET`, provisioned with `wrangler secret put` (or the
  deployment platform's equivalent), never committed as a production variable. The Worker
  signs the owner/session/policy/operation/digest envelope before the existing RunLoopDO
  accepts it.

The runtime fails closed when the active-session RPC is absent, unavailable, unauthorized,
or does not return a boolean. Malformed successful Auth responses are treated as upstream
unavailability, not invalid credentials, and remaining access-token lifetime is bounded to two
hours at this seam. A local Auth/REST integration test proves active public capture and
projection, current-session logout, and exact still-unexpired-token retries returning the public
401 shape before owner-root routing. Separately, workerd tests exercise the production HMAC bridge,
canonical authority admission, RunLoopDO/Coordinator writes, retry, rate limits, and reconstruction.
These are layered conformance proofs, not one composed local Supabase-to-real-DO test and not proof
that the migration or Worker is deployed to hosted Supabase/Cloudflare, Kennel acceptance, staging,
or operations. Keep the deployment switch off until those independent checks pass.

The active-session decision governs admission of a new public request. A request already
admitted immediately before logout may finish; cancelling already-authorized agent work is
a separate Waldo WorkUnit lease/cancellation decision, not a side effect of logging out.

Gateway mode currently wires a metadata-only Cloudflare AI Gateway adapter and a
fail-closed delivery/safety placeholder. It also fails before provider egress until HEY-99
supplies an auditable daily-spend reader. It is an adapter-readiness seam, not live channel
delivery or production dogfood.
