# Waldo production deployment and secrets runbook (2026-09-24)

How the deployed agent runs for many owners, and where every key lives. Companion to OWNER_SETUP_2026-09-24.md (one-time credential collection); this doc is the steady-state operator view.

## Deployment shape and the Kubernetes/AWS question (2026-09-24, corrected)

Earlier this doc carried a "no Kubernetes, no AWS" hard constraint. That was a misread of an owner question as a ruling; corrected per the owner (14:32). This is the honest comparison he asked for instead.

Current shape: Cloudflare Workers + per-owner Durable Objects for compute, wrangler secrets for platform keys, Supabase function secrets for the connector proxy, Supabase Vault for user tokens, Supabase Postgres for shared tables.

Where Kubernetes/AWS would genuinely help:
- Long-running or heavyweight jobs (large audio/video processing, big batch memory work) that don't fit a Worker's CPU/wall-clock envelope.
- Multi-region active-active with custom networking, if beta outgrows DO placement.
- Managed secret rotation and audit trails (AWS Secrets Manager) if a compliance bar appears.

What it costs us today:
- A second control plane to secure, deploy and pay for, on a one-person team.
- Secret-custody sprawl: the hard line is user tokens only in Supabase Vault; an AWS secret store duplicates custody without strengthening it.
- Slower iteration on the exact surfaces (channels, memory, evals) where the product risk actually lives.

Call: stay on the current shape. Revisit triggers: a real workload Workers can't run, multi-region demand, or a compliance requirement. Secrets stay in wrangler secrets + Supabase function secrets + Vault regardless of where compute moves.

## Topology

- Cloudflare Workers: stateless entry. One worker codebase, deployed per environment.
- Durable Objects: one per owner (isolation is structural; owner state, conversation tree, memory and schedules live in that owner's DO sqlite).
- Supabase: Postgres (waldo schema, RLS forced) + Vault (all bearer/refresh tokens) + Edge Functions.
- connector-proxy (Supabase Edge Function): the ONLY code that touches provider tokens. The runtime holds connection ids, never tokens (guard-enforced: SUPABASE_SERVICE_ROLE_KEY cannot appear in runtime src).

## Environments

- staging: worker waldo-runtime-staging, its own DO namespace, staging Supabase project, OpenAI project with only nano enabled (mini/luna pending owner).
- production: separate worker name and DO namespace, separate Supabase project, separate OpenAI project. Production secrets are set fresh, never copied from staging.
- Deploy: wrangler deploy --env staging|production from the repo. DO sqlite migrations run per environment on first touch of each DO; the schema migrations are idempotent (CREATE TABLE IF NOT EXISTS / ALTER guarded).

## Secrets inventory and ownership

Worker secrets (wrangler secret put <NAME> --env <env>):
- OPENAI_API_KEY - provider billing key, shared across owners; spend is governed per owner by the ADR-0051 governor.
- TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET - bot identity and webhook verification.
- WALDO_ROUTER_HMAC_SECRET - signs runtime->Postgres routing calls; the matching value sits in Supabase Vault as waldo_router_hmac.
- LANGFUSE_PUBLIC_KEY / SECRET_KEY / BASE_URL - traces; text-retention decision is an open owner call before beta users.
- GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET - OAuth client for the connect flow (redirect: /oauth/google/callback on the same origin).
- ELEVENLABS_API_KEY (STT), BRAVE_SEARCH_API_KEY or TAVILY_API_KEY (search).

Worker vars (wrangler.toml [vars], not secrets): SUPABASE_PROJECT_URL, SUPABASE_PUBLISHABLE_KEY, WALDO_OWNER_TELEGRAM_ID (single-owner fallback until routing lands).

Supabase function secrets (supabase secrets set, scoped to connector-proxy): the service-role key and Vault access live here only. The runtime never sees them.

Codespace secrets (GitHub > Settings > Codespaces, repo waldoco/waldo-backend): CLOUDFLARE_API_TOKEN (deploys), SUPABASE_ACCESS_TOKEN (migrations). Build-loop only; the product never reads them.

## Rotation procedure (any secret)

1. Create the replacement at the provider.
2. Set it on the target (wrangler secret put / supabase secrets set / codespace secret update).
3. Verify one live path (staging: a real Telegram turn for OPENAI_API_KEY; a signed routing call for WALDO_ROUTER_HMAC_SECRET; /usage shows the hop).
4. Revoke the old value at the provider.
Never rotate two secrets in one step; never paste values in chat (vault links only).

## Scaling to many owners

- Isolation: per-owner DO means an owner's state is physically separate; a runaway owner cannot read or corrupt another's state.
- Token custody at scale is unchanged: every Google token lives in Vault, touched only by connector-proxy, which serves many owners by connection id. Adding owner N adds rows, not new trust surfaces.
- Rate/cost: the per-owner spend governor caps each owner; the shared OpenAI key is the billing pool. If one owner must not affect another's latency, move heavy owners to a separate OpenAI project (config, not code).
- Telegram multi-owner: the webhook routes by owner (waldo.route_presence); strangers stay behind one-time link codes until the invite beta opens.

## Known production gap (owner decision pending)

Gateway mode currently fails closed by design; staging runs the trusted/local composition. Production needs the gateway composition implemented or the trusted composition ratified as the production shape. This is on the finalization list before production cut, alongside the S4 invited-beta proof.
