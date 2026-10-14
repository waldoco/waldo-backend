# Staging deploy gate

Run this after every staging deploy. It answers three questions and changes nothing.

```sh
node scripts/staging-gate.mjs --expect-sha "$(git rev-parse HEAD)"   # from the repo root, after pnpm install
```

Or dispatch **Actions → staging-gate → Run workflow** on `beta-mvp`, with `expect_sha` set to the SHA you deployed.
`--expect-sha` is optional; without it the gate reports what is running without comparing.

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

A `release` of `unreleased` fails `healthz`: the Worker was deployed without `scripts/deploy-runtime.sh`,
so nothing ties it to a commit.

## What is deployed?

| Check | Needs | Reports |
|---|---|---|
| `worker-version` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Each live version id, its traffic share and the `WALDO_RELEASE` it was stamped with |
| `browser-binding` | same | Whether every live version binds `BROWSER` |
| `healthz-matches-version` | same | `/healthz` and the version's binding agree (single-version deployments only) |
| `edge-function <slug>` | `SUPABASE_ACCESS_TOKEN` | Version, status, JWT setting and update time of each function in `supabase/functions/` |
| `migrations` | `SUPABASE_ACCESS_TOKEN` | Last applied migration, and how many in this checkout are pending |

Only these fields are printed. Version bindings carry other vars, and deployments carry the deployer's
email; neither is printed. The reads are `wrangler deployments list`, `wrangler versions view` and
`GET` on the Supabase Management API.

## How do we roll back?

The gate prints the Worker command with the previous version filled in. It never runs it.

- **Worker:** `scripts/staging-rollback.sh <version-id> [reason]`. It is pinned to `--env staging`,
  and wrangler asks for confirmation. A rollback restores code and bindings only, not Durable Object
  state, secrets, edge functions or migrations. Cloudflare's [rollback limits](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)
  apply. Run the gate again afterwards.
- **Edge function:** Supabase keeps no restorable earlier version. Check out the previous reviewed SHA
  and redeploy that function to `togdshayyxycitzckpqv`.
- **Migrations:** forward-only. Fix with a new reviewed migration through
  [REVIEWED_STAGING_MIGRATION_ROUTE.md](REVIEWED_STAGING_MIGRATION_ROUTE.md).
