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

## Default-deny egress, Kubernetes, Argo CD and vCluster (owner question, 2026-09-24 ~15:30)

The paradigm the owner wants: every outbound call from Waldo passes one controlled point with an explicit allowlist - default-deny egress, the sidecar/middlebox model.

**It does not need Kubernetes.** On the current shape the enforcement point is code, not a sidecar:

- **Code-level (works now, recommended)**: one egress module in the runtime - every outbound fetch (model API, Telegram, Google via connector-proxy, search, voice) goes through it, and it allows only an explicit host list. A repo guard (same family as the model-literal and service-role guards) fails the build on any raw fetch outside the module. This is default-deny with the allowlist in version control, reviewable like everything else. Cost: one module + one guard. No new infra.
- **Network-level**: Cloudflare One/Gateway does egress policy for enrolled devices and origins - it covers the owner's Mac, Kennel daemons, and any future container hosts. For Workers themselves there is no per-worker egress firewall product; on the edge, the code module above IS the enforcement point, which is fine because Worker code is fully ours and review-gated.
- **Kennels's relation**: Kennel's confinement model is the same paradigm on the consumer's machine - default-deny at the boundary, command admission before effects, device-initiated bridge with no inbound ports. Egress policy for a Kennel node belongs to its daemon policy + optionally Gateway; the Waldo cloud side keeps its own module. One paradigm, two enforcement points, each native to its environment.

**Where Kubernetes + Argo CD would earn it**: K8s NetworkPolicy and mesh egress gateways (sidecar/middlebox in the literal sense) are the natural enforcement when there are many long-lived container services to police, and Argo CD pays off when many services need declarative rollout across clusters. Waldo today is a Worker fleet + per-owner DOs + one Edge Function set - there is no fleet of long-lived containers to orchestrate, so the machinery would be securing a workload shape we don't have.

**vCluster (owner's addition)**: virtual clusters give per-tenant or per-stage control-plane isolation on a shared host cluster, and cheap dev/stage parity. That answers "many isolated Kubernetes control planes without cluster sprawl" - valuable only once a host cluster exists. It is a multiplier on the K8s decision, not a reason for it. Same revisit triggers as above: a workload Workers can't run, multi-region demand, or a compliance bar. If that day comes, the migration path is vCluster-per-environment on one host cluster, with egress policy as NetworkPolicy from day one - the code-level module stays regardless, because defense in depth on token-bearing egress is cheap.

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
