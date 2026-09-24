# Key verification runbook - 2026-09-24

Companion to KEY_COLLECTION_GUIDE_2026-09-24.md. Keys live in TWO places on the Mac (CORRECTED 7:07 PM after the first verification pass found this): the collected third-party keys in ~/.waldo-mvp/env, and the three WIRING secrets (SUPABASE_PROJECT_URL, SUPABASE_PUBLISHABLE_KEY, WALDO_ROUTER_HMAC_SECRET) in the repo-root .env at ~/Developer/Pin4sf/waldo-backend-mvp/.env - owner_wire_supabase.sh reads them from there (line 7), not from ~/.waldo-mvp/env. Nothing reads that file except Mac-side scripts (ship.sh, gates.sh, owner_wire_supabase.sh); the worker and the Supabase edge function only see secrets set ON them. So every key must be pushed to the right place before it can work.

## Step 0 - does ship.sh sync secrets automatically?

```bash
grep -n "secret" ~/.waldo-mvp/ship.sh
```
If ship.sh has a secret-sync loop, saving to ~/.waldo-mvp/env + a redeploy is enough and the per-key `wrangler secret put` lines below are redundant. If not, use them. (owner_wire_supabase.sh only ever pushes its own 3 wiring secrets; it will not pick these up.)

`wrangler secret put` creates a new worker version by itself - no redeploy needed for a secret to go live.

## 1. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (verifiable TODAY)

Needed in TWO places: the worker (builds the consent URL) and the connector-proxy edge function (exchanges the code for tokens - it reads its own env: connector-proxy/index.ts line 6).

```bash
set -a; . ~/.waldo-mvp/env; set +a
cd ~/Developer/Pin4sf/waldo-backend-mvp/packages/runtime
printf '%s' "$GOOGLE_CLIENT_ID" | npx wrangler secret put GOOGLE_CLIENT_ID --name waldo-runtime-staging
printf '%s' "$GOOGLE_CLIENT_SECRET" | npx wrangler secret put GOOGLE_CLIENT_SECRET --name waldo-runtime-staging
npx supabase secrets set GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" --project-ref togdshayyxycitzckpqv
```

Live proof: ask the bot for the Google connect link (or hit the /console connect redirect) - the Google consent screen must load with NO `invalid_client` error. Complete the consent once; success = the calendar grant exists and a later calendar question answers from real data. If the consent screen errors, the client ID/secret or redirect URI is wrong - recheck the redirect URI is exactly `https://waldo-runtime-staging.piyushfulper3210.workers.dev/oauth/google/callback`.

## 1b. connector-proxy must be DEPLOYED before Google consent can complete (ADDED 7:07 PM - first pass found the gap)

The consent SCREEN loads with only the worker secrets, but completing consent fails: the code exchange runs in the connector-proxy edge function, and the function is not live until deployed. It also needs the router HMAC secret in its OWN env (connector-proxy/index.ts line 6 reads WALDO_ROUTER_HMAC_SECRET from the edge function env; SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are reserved names Supabase provides automatically).

```bash
cd ~/Developer/Pin4sf/waldo-backend-mvp
set -a; . ./.env; set +a   # repo-root .env, NOT ~/.waldo-mvp/env - wiring secrets live here
npx supabase functions deploy connector-proxy --project-ref togdshayyxycitzckpqv
npx supabase secrets set WALDO_ROUTER_HMAC_SECRET="$WALDO_ROUTER_HMAC_SECRET" --project-ref togdshayyxycitzckpqv
```

Then re-run the section-1 consent proof end to end: consent screen -> complete consent -> calendar grant exists -> a calendar question answers from real data. mint-agent-jwt stays undeployed on purpose - nothing consumes it yet; do not deploy unused attack surface.

## 2. BRAVE_SEARCH_API_KEY (key verifiable TODAY, in-product after the search-tool slice)

Terminal probe, no worker needed:

```bash
set -a; . ~/.waldo-mvp/env; set +a
curl -s -o /dev/null -w '%{http_code}\n' -H "X-Subscription-Token: $BRAVE_SEARCH_API_KEY" "https://api.search.brave.com/res/v1/web/search?q=waldo&count=1"
```
200 = key works. 401/403 = key bad. 422 = key fine, params off.

Then push it so the search tool slice finds it when it lands:

```bash
cd ~/Developer/Pin4sf/waldo-backend-mvp/packages/runtime
printf '%s' "$BRAVE_SEARCH_API_KEY" | npx wrangler secret put BRAVE_SEARCH_API_KEY --name waldo-runtime-staging
```

## 3. SMALLEST_AI_API_KEY (verifiable TODAY, end to end)

```bash
set -a; . ~/.waldo-mvp/env; set +a
cd ~/Developer/Pin4sf/waldo-backend-mvp/packages/runtime
printf '%s' "$SMALLEST_AI_API_KEY" | npx wrangler secret put SMALLEST_AI_API_KEY --name waldo-runtime-staging
```

Live proof: send the bot a short TELEGRAM VOICE NOTE. With only this STT key set, the code auto-selects Smallest (no WALDO_STT_PROVIDER needed); the bot answering the voice note's content proves the key, the provider, and the media path in one shot. If it falls back or errors, the worker tail shows the transcribe hop. (Direct API smoke alternative: POST a small wav to `https://api.smallest.ai/waves/v1/stt/` with the key as the bearer token - the code path does exactly this.)

## 4. BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID (key verifiable TODAY, in-product after the browser slice)

Terminal probe, no worker needed - create and close a session per the Browserbase quickstart (https://docs.browserbase.com): expect a 200 with a session id; 401 = bad key, 402 = plan/quota. Keep the exact request shape from their docs, not from memory.

Then push both for the browser slice:

```bash
cd ~/Developer/Pin4sf/waldo-backend-mvp/packages/runtime
printf '%s' "$BROWSERBASE_API_KEY" | npx wrangler secret put BROWSERBASE_API_KEY --name waldo-runtime-staging
printf '%s' "$BROWSERBASE_PROJECT_ID" | npx wrangler secret put BROWSERBASE_PROJECT_ID --name waldo-runtime-staging
```

## Summary table

| Key | Push targets | Cheapest live proof | When |
|---|---|---|---|
| GOOGLE_CLIENT_ID/SECRET | worker + supabase edge fn | consent screen loads, no invalid_client | today |
| BRAVE_SEARCH_API_KEY | worker | terminal curl probe -> 200 | today (key); search-tool slice for in-product |
| SMALLEST_AI_API_KEY | worker | telegram voice note transcribed | today |
| BROWSERBASE_API_KEY/PROJECT_ID | worker | session create per docs -> 200 | today (key); browser slice for in-product |

Deferred per his call: Discord, Maps, Meta/WhatsApp (verification gate).
