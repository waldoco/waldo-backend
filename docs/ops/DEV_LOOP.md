# Dev Loop

The owner's Mac runs the full verification wall, including the Supabase gates the Codespace cannot run.

## Setup

- Checkout: `~/Developer/Pin4sf/waldo-backend-beta-mvp` on `beta-mvp`. Other local checkouts are left alone.
- Needs: Docker Desktop running, Node 22, pnpm at the version pinned in `package.json`, and the Supabase CLI.
- Secrets: `.env` at the repo root, mode 600 and git-ignored. The owner fills it in on the Mac. Values never go into the repo or chat. Names: `SUPABASE_URL`, `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OPENAI_API_KEY`, `WALDO_OWNER_TELEGRAM_ID`.
- Remote access: the Codespace reaches the Mac over the owner's tailnet with its own SSH key.

## Verify

```sh
pnpm verify
```

`pnpm verify:supabase` leaves local Supabase running without its API gateway and REST services. The session-revocation test then fails with "local Supabase Auth/REST services are not running". Restart the full stack and rerun:

```sh
supabase stop && supabase start
pnpm verify:supabase:session-revocation
```

## Telegram

Staging receives Telegram through the webhook (`POST /telegram/webhook` on `waldo-runtime-staging`). Read its logs with `npx wrangler tail waldo-runtime-staging --format json` from `packages/runtime`.

Telegram delivers updates to one place: while the webhook is set, `getUpdates` polling fails. To run the local runner instead, delete the webhook first, then from `packages/runtime`:

```sh
set -a; . ../../.env; set +a
npx tsx scripts/telegram-listener-run.ts
```

Set the webhook again when done. Rollback and cleanup steps are in [TEARDOWN.md](TEARDOWN.md). Log fields are in [OBSERVABILITY.md](OBSERVABILITY.md).
