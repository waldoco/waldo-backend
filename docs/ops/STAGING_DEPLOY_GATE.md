# Staging deploy gate

Run this after every staging deploy. It answers three questions and changes nothing.

```sh
node scripts/staging-gate.mjs --expect-sha "$(git rev-parse HEAD)"   # from the repo root, after pnpm install
```

The `deploy-staging` workflow runs it as the last step of every `operation=deploy`, against the SHA it
just deployed. To run it alone, dispatch **Actions → deploy-staging** on `beta-mvp` with `operation=gate`,
and set `expected_source_sha` to the deployed SHA. `--expect-sha` is optional; without it the gate
reports what is running without comparing.

Each line is `PASS`, `FAIL` or `UNAVAILABLE`, then `GATE PASS` (exit 0), `GATE FAIL` (exit 1) or
`GATE INCOMPLETE` (exit 2: nothing failed, but a section had no credential).

## Is it healthy?

These probes send no credential. The staging Worker is `waldo-runtime-staging.piyushfulper3210.workers.dev`
and the edge function project is `togdshayyxycitzckpqv`.

| Check | Request | Passes when |
|---|---|---|
| `healthz` | `GET /healthz` | 200, `ok: true`, `release` is a git SHA (and matches `--expect-sha`) |
| `telegram-unsigned` | `POST /telegram/webhook`, no secret header | 403. A 404 means the webhook secret or owner binding is missing |
| `gmail-push-unsigned` | `POST /events/gmail`, no bearer | 403. A 404 means push ingress is not configured |
| `connector-proxy-unsigned` | `POST /functions/v1/connector-proxy`, no apikey or signature | 401 from the gateway, or 200 carrying the function's own `401 unsigned proxy call` |

With `--expect-sha`, `healthz` is tried up to 3 times, 10 seconds apart, so a deploy still reaching
every edge is not reported as a stale release.

A `release` of `unreleased` fails `healthz`: the Worker was deployed without `scripts/deploy-runtime.sh`,
so nothing ties it to a commit.

## What is deployed?

| Check | Needs | Reports |
|---|---|---|
| `worker-version` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Each live version id, its traffic share and the `WALDO_RELEASE` it was stamped with |
| `browser-binding` | same | Whether every live version binds `BROWSER` |
| `healthz-matches-version` | same | `/healthz` and the version's binding agree (single-version deployments only) |
| `edge-function <slug>` | `SUPABASE_ACCESS_TOKEN` | Version, status, JWT setting and update time of each function in `supabase/functions/` (except `_`-prefixed helpers) |
| `migrations` | `SUPABASE_ACCESS_TOKEN` | Last applied migration, and how many in this checkout are pending |

Only these fields are printed. Version bindings carry other vars, and deployments carry the deployer's
email; neither is printed. The reads are `wrangler deployments list`, `wrangler versions view` and
`GET` on the Supabase Management API.

## How do we roll back?

The gate prints the Worker command with the previous version filled in. It never runs it.

- **Worker:** `scripts/staging-rollback.sh <version-id> --confirm <version-id> [--message <reason>]`.
  It is pinned to `--env staging`. wrangler's own prompt answers yes without a TTY or under CI, so the
  script refuses unless the same id is repeated via `--confirm` or `ROLLBACK_CONFIRM`. A rollback restores code and bindings only, not Durable Object
  state, secrets, edge functions or migrations. Cloudflare's [rollback limits](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)
  apply. Run the gate again afterwards.
- **Edge function:** Supabase keeps no restorable earlier version. Check out the previous reviewed SHA
  and redeploy that function to `togdshayyxycitzckpqv`.
- **Migrations:** forward-only. Fix with a new reviewed migration through
  [REVIEWED_STAGING_MIGRATION_ROUTE.md](REVIEWED_STAGING_MIGRATION_ROUTE.md).

## When the deploy itself fails

### Cloudflare rejects it: "Script startup exceeded CPU time limit" (10021)

Cloudflare limits how much CPU a Worker may spend evaluating its script before the first event. The full
Worker builds every contract schema when its modules load. That cost sat close to the limit and varied
from one measurement to the next, so `wrangler deploy` was refused at random.

The deployed entries are `packages/runtime/src/entry.ts` (production) and `src/staging-entry.ts`
(staging). Each statically imports only `src/lazy-entry.ts` and `src/retired-durable-objects.ts`, and
loads the full Worker on the first event, once per isolate. Durable Object classes are forwarders that
build the real object inside `blockConcurrencyWhile`. Cloudflare measured startup at about 25 ms after
this change, against roughly 300 to 950 ms before.

If 10021 returns:

1. Find what crept into startup. `scripts/tests/runtime-bundle-startup.test.mjs` (part of
   `verify:guards`) checks that the entry's static imports are exactly those two files and names any
   module that got pulled in. `node scripts/startup-profile.mjs` gives the per-package breakdown.
2. Measure the built bundle. `wrangler check startup` ignores `--env`, so build the staging bundle
   first and pass it with `--worker`. The staging config serves `../dashboard-app/dist`, so on a fresh
   checkout run `pnpm --filter @waldo/dashboard-app build` from the repo root first. Then, from
   `packages/runtime`:

   ```sh
   npx wrangler deploy --dry-run --env staging --outfile /tmp/worker.bundle
   npx wrangler check startup --worker /tmp/worker.bundle
   ```

3. To ship while the cause is being fixed, upload the version and deploy it as a separate step. Upload
   is checked for startup too, so it can also be refused with 10021. Retrying works only while the cost
   sits near the limit; it is not a fix. Use a clean checkout at the reviewed SHA, since this path skips
   `deploy-runtime.sh`'s dirty-tree refusal. From the repo root, then `packages/runtime`:

   ```sh
   pnpm --filter @waldo/dashboard-app build
   pnpm --filter @waldo/dashboard-app verify:assets
   cd packages/runtime
   npx wrangler versions upload --env staging --var "WALDO_RELEASE:$(git rev-parse --short HEAD)"
   npx wrangler versions deploy <version-id>@100% --env staging --yes
   ```

   This path cannot ship a commit that adds a Durable Object migration. wrangler refuses
   `versions upload` then, and such a commit must go out with `wrangler deploy`. It also applies no
   trigger changes. Staging has a cron and a custom-domain route, so if the commit changes either, also
   run `npx wrangler triggers deploy --env staging`.

### Startup passes but the Worker fails on live traffic

Because the full Worker now loads on the first event, an error in that load does not show at upload.
It shows on the first request, alarm or message each isolate serves. A failed load stays failed in that
isolate until Cloudflare recycles it, so a bad version does not heal itself.

Nothing can be tested before traffic moves. Cloudflare generates no version URLs for a Worker that
implements a Durable Object ([Cloudflare docs](https://developers.cloudflare.com/workers/configuration/previews/)).
On 3 Nov 2026 the staging version subdomain answered 404.

So the check comes straight after the switch:

1. Deploy, then immediately run the gate with `--expect-sha`. `/healthz` is served by the full Worker,
   so a load error fails it.
2. If `healthz` fails, roll back at once with `scripts/staging-rollback.sh` (above), then run the gate
   again. With the Cloudflare credentials the gate prints the previous version id. Without them, find
   it with `npx wrangler deployments list --env staging`.
3. Read the cause with `npx wrangler tail --env staging` while sending one `GET /healthz`.

A load error inside a Durable Object's `blockConcurrencyWhile` should reset the object rather than leave
it half-built. No test covers this.
