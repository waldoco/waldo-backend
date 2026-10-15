# Experimental Worker runbook

`waldo-runtime-experimental` is a second non-production Worker for trying unmerged
branches. `waldo-runtime-staging` is not touched by anything here and stays the
known-good rollback. Config: `env.experimental` in `packages/runtime/wrangler.jsonc`;
`scripts/guards/guard-wrangler-local-bindings.mjs` enforces the rules below and
`guard-wrangler-experimental-regression.mjs` attacks them.

Every step marked **OWNER STEP** needs Cloudflare, GCP or Supabase credentials. Agents
prepare; the owner runs. Commands run from the repository root unless a `cd` says otherwise.

## What is isolated and what is shared

| Surface | Experimental | Why |
|---|---|---|
| Durable Objects (owner memory, run loop, device and iMessage bridges) | Own namespaces (new Worker name) | Fresh owner state; nothing read from staging DOs |
| R2 `ARTIFACTS` | `waldo-artifacts-experimental` | Artifact bodies never mix |
| Vectorize `VECTORIZE` | `waldo-recall-experimental` | Recall never mixes. No runtime source reads `VECTORIZE` or `AI` today; the binding is kept for parity |
| Rate limiter | namespace `1003` (staging/prod `1001`, previews `1002`) | Own signup throttle counters |
| Cron (health retention sweep) | None | One sweep over one Supabase is enough |
| Telegram | Not wired | One bot webhook can point at one Worker |
| iMessage bridge | Off (`IMESSAGE_CONNECTOR_ENABLED: "0"`) | One bridge, on staging |
| Browser spend ledger | Own (DO storage) | Copying `COMMON_BROWSER_REGISTRATION` gives a second, independent cap |
| **Supabase project** | **Shared with staging** | See "Shared staging Supabase" |
| **Langfuse project** | Shared if the same keys are set | Traces carry `environment: staging`; only `release` (git SHA) tells them apart |

### Vars and why they look the way they do

- `WALDO_ENVIRONMENT: "staging"`. Every staging-only gate in the runtime compares this with the
  literal `"staging"` (Cloudflare browser, `/probe/turn`, runtime readiness/diagnostics,
  browser owner binding, common browser registration). Any other value turns those paths off;
  `"production"` would also force trace text capture off. The guard rejects anything else.
- `WALDO_OWNER_DO_NAMESPACE: ""`, and it stays empty. `waldo.workspace_owner_binding` admits one
  namespace per (owner, environment), first claim wins. With `environment = staging` on both
  Workers, a filled experimental namespace either gets `null` for every owner staging already
  mapped, or claims the mapping first for an owner staging has not mapped yet and locks the
  staging Worker out of that owner's workspace. The runtime tolerates the empty value: the
  workspace host and the Telegram browser binding report `unavailable`, readiness skips the
  workspace check, and nothing is written to `waldo.workspace_owner_mappings`. Consequence:
  owner-workspace files (uploads, saved browser screenshots and downloads) do not work on
  experimental. There is no second deploy step to fill the namespace.
- `WALDO_OWNER_TELEGRAM_ID: ""`. Nothing fails at startup without it or without
  `TELEGRAM_BOT_TOKEN`; Telegram sends fail per call and are logged. Leaving it empty also makes
  `/probe/turn` return 503. If you want the probe suite against experimental, set it to your
  Telegram user id **and** set `WALDO_PROBE_TOKEN`; capture-mode probes send nothing to Telegram.
- `WALDO_RELEASE: "unreleased"`. `scripts/deploy-runtime.sh` restamps it with the short git SHA
  on every deploy (`wrangler deploy --var WALDO_RELEASE:<sha>`), exactly as for staging.

## Hazard: never give experimental the staging Telegram bot token

The owner DO re-registers the Telegram webhook to the origin of the request it is serving
whenever `TELEGRAM_WEBHOOK_SECRET` is set and the stored origin changes
(`packages/runtime/src/channels/owner-do.ts`, `setWebhook`). With the staging
`TELEGRAM_BOT_TOKEN` present, the first owner request on experimental would repoint the staging
bot at `waldo-runtime-experimental` and staging Telegram would go silent. Without the bot token
that call fails harmlessly. Set `TELEGRAM_WEBHOOK_SECRET` (it also signs the Google consent
state) to a **fresh** random value, never staging's.

The same "one webhook" rule applies to WhatsApp (`WHATSAPP_*`) and Gmail Pub/Sub push
(`WALDO_EVENT_SOURCES`): leave them unset.

## Shared staging Supabase

The experimental Worker uses the staging Supabase project and the same
`WALDO_ROUTER_HMAC_SECRET` (Supabase verifies router signatures with its stored copy, so a
different value means every signed call fails). It therefore has the full router authority
staging has. An owner is the same owner on both Workers: same `waldo.owners` row, same
`do_name`, same Vault-held Google grant, same health plane. Only the DO memory is fresh.

What that means in practice:

- Experimental can read **and act on** the owner's real Google account (mail drafts/sends,
  calendar events, tasks) through the shared Vault grant. Treat experimental turns as real.
- Connecting Google on experimental replaces the shared grant (`proxy_store`); disconnecting
  (`connection_revoke`) deletes it for staging too.
- Account deletion on experimental (`delete_owner`) deletes the owner everywhere, health data
  and auth user included.
- Calendar watch channels started from experimental push to the experimental host.

Supabase writes the runtime makes, by RPC (from `supabase/migrations`):

| RPC | Writes |
|---|---|
| `signup_owner_for_auth`, `owner_for_auth` | `waldo.owners`, `waldo.owner_settings`, `waldo.invites` (and Supabase Auth users via OTP sign-in) |
| `set_owner_settings` | `waldo.owner_settings` |
| `console_session_open` / `_touch` / `_revoke`, `console_signout_all` | `waldo.console_sessions` |
| `console_auth_throttle` | `waldo.console_auth_attempts` |
| `issue_link_code`, `issue_provider_link_code` | `waldo.link_codes` |
| `unlink_presence` | `waldo.presences` |
| `issue_member_invite`, `admin_invite`, `admin_revoke` | `waldo.invites` |
| `connect_session_resolve` | `waldo.connect_sessions` |
| connector-proxy `exchange`/`adopt` (`proxy_store`), `proxy_access` | `waldo.connections`, `vault.secrets` |
| `connection_revoke` | `waldo.connections`, `vault.secrets` |
| `proxy_idem_claim`, `proxy_idem_store` | `waldo.proxy_idempotency` |
| `health_log_add` | `waldo.health_logs` |
| `issue_device_pairing_code`, `issue_device_pairing_code_owned` | `waldo.device_pairing_codes` |
| `device_touch`, `revoke_device` | `waldo.devices` |
| `device_bridge_throttle` | `waldo.device_bridge_throttle_keys` |
| `app_push_revoke_session` | `waldo.app_push_devices`, `vault.secrets` |
| `delete_owner` | `waldo.owners`, `waldo.connections`, `waldo.connect_sessions`, `waldo.console_sessions`, `waldo.health_logs`, `waldo.invites`, `public.health_context_daily`, `public.users`, `vault.secrets`, `auth.users`, `auth.sessions`, `auth.refresh_tokens` |
| `workspace_owner_binding` | `waldo.workspace_owner_mappings` (not reached while the namespace is empty) |

Not reached on experimental: `imessage_*` (bridge off), `health_retention_sweep` (no cron).
Reads only: health context/series/consent, routing, owner and app-session authority.

A branch that adds a Supabase migration still needs the reviewed staging migration route
(`docs/ops/REVIEWED_STAGING_MIGRATION_ROUTE.md`); experimental has no database of its own, so
a schema change tried on experimental is a change to staging.

## OWNER STEPS: first setup

1. **Create the R2 bucket.**
   ```bash
   cd packages/runtime
   npx wrangler r2 bucket create waldo-artifacts-experimental
   ```
2. **Create the Vectorize index with the same shape as `waldo-recall`.** The repo records
   768 dimensions, cosine (`docs/planning/waldo-agent-mvp/PACKET_V3_2026-09-25.md`). Confirm
   against the live index first and copy any metadata indexes it has.
   ```bash
   npx wrangler vectorize get waldo-recall
   npx wrangler vectorize list-metadata-index waldo-recall
   npx wrangler vectorize create waldo-recall-experimental --dimensions=768 --metric=cosine
   # for each metadata index listed above:
   # npx wrangler vectorize create-metadata-index waldo-recall-experimental --propertyName=<name> --type=<type>
   ```
3. **First deploy** (clean tree, from the repository root; builds the dashboard and stamps the SHA).
   ```bash
   grep -q '"experimental": {' packages/runtime/wrangler.jsonc && scripts/deploy-runtime.sh --env experimental
   ```
   The pinned wrangler (4.135) already refuses an unknown `--env` while other environments
   exist; the `grep` keeps that from depending on the wrangler version, since a fall-through
   would deploy the top-level (production) Worker. Unverified: Cloudflare applying the full DO migration
   history v1 to v7 (including the v6 `TelegramOwnerDO` to `OwnerDO` rename) to a brand-new
   Worker in one deploy. If the deploy rejects the rename, stop and report the exact error;
   do not edit the staging or top-level migration lists.
4. **Set secrets** (names only below; values come from your own store). List what staging has:
   ```bash
   npx wrangler secret list --env staging
   ```
   Then for each name you copy:
   ```bash
   printf '%s' "$VALUE" | npx wrangler secret put <NAME> --env experimental
   ```
   - Same value as staging: `SUPABASE_PROJECT_URL`, `SUPABASE_PUBLISHABLE_KEY`,
     `WALDO_ROUTER_HMAC_SECRET`, `OPENAI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
     and whichever of these staging has set: `AI_GATEWAY_ID`, `AI_GATEWAY_API_TOKEN`,
     `CLOUDFLARE_ACCOUNT_ID`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`,
     `BRAVE_SEARCH_API_KEY`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`,
     `ELEVENLABS_API_KEY`, `SMALLEST_AI_API_KEY`, `WALDO_STT_PROVIDER`, `WALDO_TOOL_OFFLOAD`,
     `WALDO_ENV`, `WALDO_OWNER_TIMEZONE`, `COMMON_OWNER_TASKS`,
     `RESPONSIBILITY_PUBLIC_API_ENABLED`, `RESPONSIBILITY_INGRESS_HMAC_SECRET`,
     `RUN_LOOP_PROVIDER_LIVE`, `RUN_LOOP_PROVIDER_MODE`, `RUN_LOOP_LOCAL_INGRESS_TOKEN`.
   - Fresh random value: `TELEGRAM_WEBHOOK_SECRET` (required for Google connect),
     `WALDO_PROBE_TOKEN` (only if you want `/probe/turn`).
   - Optional, decide explicitly: `COMMON_BROWSER_REGISTRATION` (a second $10 test / $5 month
     browser cap, independent of staging's).
   - **Never set**: `TELEGRAM_BOT_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`,
     `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WALDO_EVENT_SOURCES`,
     `IMESSAGE_CREDENTIAL_WRAPPING_KEY`. Do not set `LANGFUSE_CAPTURE_TEXT` or
     `WALDO_MCP_SERVERS` as secrets; they are vars in `wrangler.jsonc`.
   - Separate traces (recommended): use keys for a separate Langfuse project instead of
     staging's, so experimental traces do not land in the staging project.
5. **GCP: add the Google OAuth redirect URI.** The consent redirect is
   `<request origin>/oauth/google/callback` (`GOOGLE_CALLBACK_PATH`, built in `owner-do.ts`),
   so the experimental host must be an authorized redirect URI on the same OAuth client:
   `https://waldo-runtime-experimental.<your workers.dev subdomain>/oauth/google/callback`
   (staging's subdomain is `piyushfulper3210.workers.dev`). Console sign-in uses Supabase OTP
   codes, so no Supabase Auth redirect URL is needed.
6. **Health check.**
   ```bash
   curl -s https://waldo-runtime-experimental.<subdomain>.workers.dev/healthz
   # expect {"ok":true,"release":"<short sha you deployed>"}
   curl -s https://waldo-runtime-staging.piyushfulper3210.workers.dev/healthz
   # staging release unchanged
   node scripts/staging-gate.mjs
   # staging gate still green
   ```
   With the staging bot token in your shell, confirm the staging webhook still points at staging:
   `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"`.

## Deploying an experimental branch

```bash
git fetch origin
git checkout <branch>        # e.g. exp/integration
git status --porcelain       # must be empty
grep -q '"experimental": {' packages/runtime/wrangler.jsonc && scripts/deploy-runtime.sh --env experimental
curl -s https://waldo-runtime-experimental.<subdomain>.workers.dev/healthz
```

The branch must contain `env.experimental` (build it on top of `claude/experimental-worker-env`
or a base that has it merged). Test through the console and the app API on the experimental host.

Durable Object migrations a branch adds are applied to experimental for good. If that branch
later changes or reorders them before merge, the experimental DO history no longer matches;
tear down and recreate rather than editing applied tags.

Rollback of experimental itself: `npx wrangler deployments list --env experimental`, then
`npx wrangler rollback <version-id> --env experimental` (from `packages/runtime`). Staging is
never the rollback target of these commands.

## Teardown

1. `cd packages/runtime && npx wrangler delete --env experimental` (deletes the Worker and its
   Durable Object data; irreversible).
2. Empty and delete the bucket: `npx wrangler r2 bucket delete waldo-artifacts-experimental`
   (delete its objects first if the command refuses).
3. `npx wrangler vectorize delete waldo-recall-experimental`.
4. Remove the experimental redirect URI from the GCP OAuth client.
5. Supabase: rows the experimental Worker wrote live in staging and are not tagged by Worker.
   Owners created through experimental signup, revoked connections and health logs stay as
   they are; review them in the staging project if needed.
6. Repository: remove `env.experimental` from `wrangler.jsonc`, its rule block in
   `guard-wrangler-local-bindings.mjs`, and `guard-wrangler-experimental-regression.mjs`.
