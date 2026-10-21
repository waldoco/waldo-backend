# @waldo/runtime — hermetic Gate-5 runtime substrate

Proves that real Workers/Durable-Object code executes inside the Workers runtime
(workerd via Miniflare), not a Node approximation. This is Gate 5 (hermetic
runtime) of the local-dev testing pipeline. It runs under
`@cloudflare/vitest-pool-workers`. Tests that need bare Durable Object SQLite storage use
the test-only `TestStorageDO` (`test/support/worker-entry.ts`, bound as `TEST_STORAGE_DO` in the
vitest configs, never in `wrangler.jsonc`). No product logic, no live services, no secrets.

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

- `WALDO_ENV` is required before the owner turn resolves provider adapters
  (`src/llm/run-loop-adapters.ts`). `test` and `local` may default to fake adapters; any
  undeclared environment fails closed instead of silently selecting fakes.
- `RUN_LOOP_PROVIDER_MODE=fake` is allowed only with `WALDO_ENV=test|local`.
  `RUN_LOOP_PROVIDER_MODE=gateway` is staging-only and additionally requires
  `RUN_LOOP_PROVIDER_LIVE=1`, `CLOUDFLARE_ACCOUNT_ID`, `AI_GATEWAY_ID`, and an
  `AI_GATEWAY_API_TOKEN` Cloudflare Secrets Store binding. The binding exposes
  asynchronous `get()` access; no token string belongs in environment variables or source.
- `RESPONSIBILITY_RATE_LIMITER` is the Cloudflare Rate Limiting binding declared in
  `wrangler.jsonc`; the channel ingress routes (console, app, Telegram link, iMessage, device
  connect) use it as their edge rate limiter. The name is historical.

Gateway mode currently wires a metadata-only Cloudflare AI Gateway adapter and a
fail-closed delivery/safety placeholder. It also fails before provider egress until HEY-99
supplies an auditable daily-spend reader. It is an adapter-readiness seam, not live channel
delivery or production dogfood.
