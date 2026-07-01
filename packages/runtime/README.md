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
