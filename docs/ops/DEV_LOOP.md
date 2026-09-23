# Dev Loop Handbook

How to run, inspect and change Waldo on a Mac. It's written for two readers: a human developer and a coding agent. Planned work is marked as planned. Only the "Built today" list describes what runs now.

## 1. Set up a Mac from scratch

Prerequisites:

- Docker Desktop, running
- Node 22
- pnpm at the version in `package.json` (`packageManager`)
- [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started)
- git and gh
- wrangler, if you deploy

Steps:

```sh
git clone --branch beta-mvp https://github.com/waldoco/waldo-backend.git waldo-backend-beta-mvp
cd waldo-backend-beta-mvp
pnpm install --frozen-lockfile
cp .env.example .env && chmod 600 .env
```

Fill in `.env` yourself. It's git-ignored. Secret values never go in the repo, chat or tickets. The names are `SUPABASE_URL`, `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OPENAI_API_KEY` and `WALDO_OWNER_TELEGRAM_ID`.

Use a separate checkout for this loop, so your other branches and local edits stay untouched.

## 2. Verify

```sh
pnpm verify
```

This runs, in order: install, typecheck, contracts tests, the Supabase schema check, runtime tests, the Supabase session-revocation test and the repo guards.

One quirk: `pnpm verify:supabase` leaves local Supabase running without its API gateway and REST services. The revocation test then fails with "local Supabase Auth/REST services are not running". Restart the full stack and rerun it:

```sh
supabase stop && supabase start
pnpm verify:supabase:session-revocation
```

Smaller loops:

- `pnpm --filter @waldo/runtime test` runs the runtime tests.
- `pnpm verify:guards` runs the guards.
- From `packages/runtime`, `npx vitest run test/<file>.test.ts` runs one test file.

## 3. Work on it as a human developer

Local services:

- `supabase start`, `supabase status` and `supabase stop` manage the local stack. `supabase status` prints the local URLs, including Studio, the database UI.
- `docker ps --filter name=supabase_` lists the containers.
- `docker logs -f <container>` follows a container's logs.
- `docker exec -it $(docker ps -qf name=supabase_db_) psql -U postgres` opens a SQL shell on the local database.

Staging Worker (`waldo-runtime-staging`):

- From `packages/runtime`, `npx wrangler tail waldo-runtime-staging --format json` streams live logs.
- Each Telegram turn logs one JSON line per hop, with a shared trace id `tg-<update_id>`. The fields are in [OBSERVABILITY.md](OBSERVABILITY.md).
- `npx wrangler deployments list --name waldo-runtime-staging` shows what's deployed.

Telegram, webhook or local runner:

- Staging receives Telegram through `POST /telegram/webhook`.
- Telegram sends updates to only one place, so while the webhook is set, polling fails. To run the bot from your Mac, delete the webhook first, then from `packages/runtime`:

```sh
set -a; . ../../.env; set +a
npx tsx scripts/telegram-listener-run.ts
```

When you're done, set the webhook again. Rollback and cleanup are in [TEARDOWN.md](TEARDOWN.md).

IDE and coding agents:

- Open the checkout in VS Code or Cursor. From another machine on the tailnet, use Remote-SSH to the Mac's tailnet address.
- Claude Code: run `claude` in the checkout. It reads `CLAUDE.md` and `.claude/` (rules, skills, settings).
- Codex: run `codex` in the checkout. It reads `AGENTS.md` and `.agents/skills`.
- Give an agent one bounded task. Ask it to run `pnpm verify` before it commits, and to cite the files and tests it changed.

Remote access from the Codespace:

- The build Codespace reaches the Mac over the owner's tailnet with its own SSH key.
- Its Tailscale state and key live in the Codespace home directory, so they survive restarts.

## 4. How changes land

- Work happens on `beta-mvp`.
- Each slice has to pass its gates before commit. After pushing, check the remote head with `git ls-remote origin beta-mvp` and confirm CI (`gh run list --branch beta-mvp`).
- `beta` and `main` only move on the owner's explicit say-so, with exact heads.
- Hardcodes and limits we find are filed under the `post-mvp-cleanup` label and fixed later.

## 5. Built today

- Telegram owner chat on the staging Worker. Updates arrive by webhook, go to a Durable Object, then to the model. It has the receipt, typing and final reactions, per-hop tracing, and honest replies for unsupported messages.
- Staging still uses fixture admission instead of real per-user sign-in. No tools are granted to the model. See [#144](https://github.com/waldoco/waldo-backend/issues/144).

## 6. Forward map

Memory slice (next, in progress):

1. Hot conversation state goes into the owner Durable Object's own storage, written after each turn and restored on wake. After this, eviction loses nothing.
2. Canonical long-term memory goes into the per-user Durable Object's SQLite. Four core files come first: MEMORY_CORE, MEMORY_GOALS, MEMORY_FOLLOWUPS and intelligence-summary.
3. Hybrid recall: full-text search in SQLite plus an external vector index (pgvector or Vectorize), fused by rank.
4. R2 archives for older conversation and files.
5. Supabase as the queryable layer for the app and dashboard.
6. A memory inspector with correct and forget. Wearable data stays on the phone, and only health summaries reach the agent.

Program after memory, in order ([ADOPTION_DIRECTION.md](../planning/ADOPTION_DIRECTION.md)):

1. Langfuse Cloud observability, instrumented with OpenTelemetry.
2. Multimodal input (images and files), plus a rigorous end-to-end test pass.
3. AG-UI projection, onboarding, and surfaces: the Waldo mobile app, Discord, then WhatsApp or iMessage where possible.
4. Web dashboard: connections, memory inspector, people and grants, activity and traces, approvals, usage.
5. Extended competitor matrix.
6. Secrets and vault.
7. Performance work throughout. Today the model call takes about 4.4 s of a 6.5 s reply.

Tools, hooks and adapters still needed (all planned, none built):

- Channel adapters: Discord (the threading test channel), then WhatsApp and iMessage on hosted phone infrastructure, with Slack threading later. Each follows the inbound contract in [MESSAGING_BEHAVIOR.md](../behavior/MESSAGING_BEHAVIOR.md).
- Real per-user admission and isolation, to replace the fixture.
- Tool grants through the existing tool dispatcher, one reviewed capability at a time. Mail and calendar come first, each with an independent read-back after any change.
- A per-user email identity for the agent.
- A Kennel bridge, so Waldo hands larger work to Kennel, and Kennel drives the owner's codebases and Claude Code.
- An OpenTelemetry exporter to Langfuse.
- Model input adapters for images and files.
- A browser worker and an isolated workspace, both later and behind Waldo's operation boundary.
- Vault storage for secrets, created by the agent and shared with the owner.
- A health-summary lane from the phone.
