# Waldo v1 key collection guide - 2026-09-24

Every name below is what the code actually reads (grepped from the beta-mvp tree) or the documented reserved name in OWNER_SETUP. No key values in this file. Save each key into `~/.waldo-mvp/env` as `NAME=value`, then push to the worker with the command pattern at the bottom.

Priority order: 1 -> 4 unblock the most build. 5-7 can trail.

## 0. Check what already exists

```bash
set -a; . ~/.waldo-mvp/env; set +a
cd ~/Developer/Pin4sf/waldo-backend-mvp/packages/runtime
npx wrangler secret list --name waldo-runtime-staging
```
Already set (today's wiring + earlier deploys): TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, LANGFUSE_*, WALDO_ROUTER_HMAC_SECRET, SUPABASE_PROJECT_URL, SUPABASE_PUBLISHABLE_KEY. Look for GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in that list - if they are there, step 1 is done.

## 1. Google OAuth client (platform-level)

Console: https://console.cloud.google.com
1. Create or pick the project (e.g. `waldo-staging`).
2. APIs & Services -> Library -> enable: **Google Calendar API**, **Gmail API** (Google Tasks API optional).
3. OAuth consent screen: External, Testing mode; add your own Google accounts as test users. Scopes (one combined consent ask, per your 13:31 ruling): openid, email, calendar.events, gmail.readonly, gmail.send, gmail.compose (+ tasks optional).
4. APIs & Services -> Credentials -> Create Credentials -> OAuth client ID -> type **Web application**. Authorized redirect URI, exactly:
   `https://waldo-runtime-staging.piyushfulper3210.workers.dev/oauth/google/callback`
5. Save as: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

While in this project, do step 5 (Maps) - same console, one extra API.

## 2. Brave Search API key (platform-level)

Console: https://brave.com/search/api/
1. Sign up, pick a plan (free tier exists; paid is $5 per 1k requests).
2. Generate an API key from the dashboard.
3. Save as: `BRAVE_SEARCH_API_KEY`.

Note: no live search tool exists in the code yet - the name above is the documented reserved name; the half-day tool slice wires it. (Tavily is the documented fallback: https://tavily.com, save as `TAVILY_API_KEY`.)

## 3. Speech-to-text: Smallest AI (platform-level)

Console: https://smallest.ai (sign up -> API keys)
1. Generate an API key.
2. Save as: `SMALLEST_AI_API_KEY`.

Notes: the code auto-selects the provider - with only SMALLEST_AI_API_KEY set, Smallest wins, no other config needed. `WALDO_STT_PROVIDER` (values: `smallest`, `elevenlabs`, `openai`) is only needed to override when several keys exist. Voice notes already transcribe today via the OpenAI fallback, so this is an upgrade, not a blocker. Optional: ElevenLabs (https://elevenlabs.io) key saved as `ELEVENLABS_API_KEY` - doubles for TTS voice replies later.

## 4. Meta / WhatsApp (platform-level) - START EARLY, external gate

Console: https://developers.facebook.com
1. Create a developer account, then a Business app.
2. Add the WhatsApp product; get the test number and a temporary token to start.
3. Complete **business verification** (this is the days-long part - only you can do it).
4. Later: a permanent system-user token, and your own number registered.
Save (when the channel slice lands - design doc WHATSAPP_CHANNEL_DESIGN_2026-09-24): the permanent token and a random webhook verify token you invent yourself. Exact env names get pinned in that slice; the design says the verify token is a random secret in the worker env.

## 5. Google Maps / Places key (platform-level, optional for dashboard)

Same Google Cloud project as step 1:
1. APIs & Services -> Library -> enable **Maps JavaScript API** and **Places API**.
2. Credentials -> Create Credentials -> API key. Restrict it to those APIs.
3. Save as: `GOOGLE_MAPS_API_KEY` (name reserved; wired when the dashboard home slice lands).

## 6. Discord bot token (platform-level, ~5 minutes, no gate)

Console: https://discord.com/developers/applications
1. New Application -> Bot -> Reset Token -> copy.
2. Enable the Message Content intent (Bot page) so Waldo can read messages.
3. Save as: `DISCORD_BOT_TOKEN` (name reserved; wired in the Discord channel slice, ~half day after WhatsApp).

## 7. Browser capability: Browserbase (platform-level)

Console: https://www.browserbase.com
1. Sign up (Developer plan, $20/mo, is enough to start).
2. Create a project; copy the API key and project ID.
3. Save as: `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` (names reserved; wired in the browser slice, 1-2 days).

## No key needed

- Weather for the dashboard greeting: Open-Meteo - free, no signup, no key.
- Per-user secrets (each user's Google tokens, future connections): land in Supabase Vault automatically through the connect flow - nothing for you to collect. Fill-only vault pages for arbitrary user secrets are a D5-7 build surface, not a key.

## Pushing a key to the worker (per key, after saving in ~/.waldo-mvp/env)

```bash
set -a; . ~/.waldo-mvp/env; set +a
cd ~/Developer/Pin4sf/waldo-backend-mvp/packages/runtime
printf '%s' "$GOOGLE_CLIENT_ID" | npx wrangler secret put GOOGLE_CLIENT_ID --name waldo-runtime-staging
```
Repeat with the matching `$NAME` / `NAME` pair for each key. No quotes, no trailing newline (printf '%s', not echo). After the last one, tell the lane - a redeploy picks them up and the live-verify runs.
