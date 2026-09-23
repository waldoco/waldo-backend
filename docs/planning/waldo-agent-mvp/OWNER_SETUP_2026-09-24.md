# Owner setup: credentials and keys (2026-09-24)

> Vocabulary: the owner settled all product words on 2026-09-24. [VOCABULARY_AND_BRAND_2026-09-24.md](VOCABULARY_AND_BRAND_2026-09-24.md) is the source; where this doc uses an older word (Afternoon check-in, update cards, Approve / Change / Skip, Weight as demand, Readiness), read it by that doc. Form / Load / Recovery are the body and day words; Weight is body mass only; Fetch is the sweep and its output is a fetch alert; Handoff is work Waldo offered or took on, tracked as an open loop.

Everything the build needs from the owner, in one list. The staging Worker is `waldo-runtime-staging` at https://waldo-runtime-staging.piyushfulper3210.workers.dev.

Secrets already set on staging:
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`

The codespace env also holds `CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN` and `SUPABASE_SERVICE_ROLE_KEY`. Those point at the legacy project, which the owner has ruled won't be used.

Never paste secret values in chat. Put them in the codespace secrets for waldoco/waldo-backend (GitHub, Settings, Codespaces secrets), or send them through a vault link. I set them on the Worker with `wrangler secret put`.

## 1. Needed now (unblocks W2, W3 and the live E2E)

### New Supabase project
Create a project in the Supabase dashboard. Region: Mumbai (ap-south-1) is closest to the owner. Then send:
- Project URL: goes in `SUPABASE_PROJECT_URL` (a var, not a secret).
- Publishable (anon) key: goes in `SUPABASE_PUBLISHABLE_KEY`.
- Service role key: goes in the `SUPABASE_SERVICE_ROLE_KEY` secret. It replaces the legacy one.
- A personal access token with access to the new project: goes in `SUPABASE_ACCESS_TOKEN`, so I can run migrations.
- In Auth, then Providers: turn on Email OTP. Set Site URL to the staging origin above.
- Vault is on by default in new projects. No action needed.

Until this lands I build against local Supabase (Docker works in the codespace). Those packets count as "locally verified" only.

### Google OAuth client (staging)
In Google Cloud Console:
1. Create a project (for example `waldo-staging`).
2. Enable these APIs: **Google Calendar API**, **Gmail API**, and **Google Tasks API** (optional; only if Tasks feeds Load).
3. Set up the OAuth consent screen: External, Testing mode. Add his own Google accounts as test users. Scopes are requested per feature in the code (W3), so only these are needed:
   - `openid`, `email`
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - optional: `https://www.googleapis.com/auth/tasks`
   The drive, docs, sheets, slides, contacts, gmail.modify and gmail.compose scopes the code asks for today will be removed in W3.
4. Create a Credentials, OAuth client ID of type Web application, with this authorized redirect URI:
   `https://waldo-runtime-staging.piyushfulper3210.workers.dev/oauth/google/callback`
5. Send the client ID and client secret. They become the `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` secrets.

Google verification is only needed before other users connect. Testing mode covers owner use (max 100 test users).

### Web search key: pick one
- **Brave Search API** (my recommendation for the default): its own index, plain results that go through our tool checks, $5 per 1k requests. Sign up at https://brave.com/search/api/ and send the key. Secret: `BRAVE_SEARCH_API_KEY`.
- **Tavily**: 1,000 free credits a month, then $0.008 per credit. Free while he's the only user. https://tavily.com. Secret: `TAVILY_API_KEY`.

Both go behind one seam, so switching later is a config change. If cost matters most right now, start with Tavily and add Brave later.

## 2. Needed soon

- **Speech-to-text key.** Voice notes are only transcribed when a key is set. Recommended: ElevenLabs, for Scribe v2 (best for mixed Hindi-English, about $0.004 per 60s note). Secret: `ELEVENLABS_API_KEY`. The alternatives, smallest.ai (`SMALLEST_AI_API_KEY`) or OpenAI, need no new key.
- **OpenAI key rotation.** The current key has been in use through the whole build. Rotating means creating a new key in the OpenAI dashboard, updating the codespace secret, and revoking the old one. I then run `wrangler secret put OPENAI_API_KEY`.
- **Langfuse.** Keys are set and traces flow. The rename item carries over from main's list; I don't have its details in my context.
- **Mac `.env` and the Pin4sf Actions items** carry over unchanged from main's list; I don't have their details in my context.

## 3. Optional or later

- **SMS provider for phone OTP**: MSG91 or Twilio. Only needed if phone sign-in is wanted. Email OTP covers the beta.
- **WhatsApp**: a confirmed Meta route (business verification plus a WhatsApp Business number). On hold until the route is confirmed.
- **For the app phase**: a physical iPhone and a Watch Series 12, to verify HealthKit.
- **Apple Developer and APNs .p8**, for app push. WaldoBrain lists it as a blocker for app notifications.

## 4. Decisions, not credentials

- The vocabulary rulings in VOCABULARY_AND_BRAND_2026-09-24.md.
- Langfuse text capture: how long it keeps owner text, and whether it stays on for beta users.
- Whether to mark Gmail and web content as untrusted in the prompt. I recommend yes: it's the first prompt-injection surface.

## W2 wiring, once the new Supabase project exists (I do these, not the owner)

- Apply the migrations. `20260924120000_waldo_owners.sql` creates the `waldo` schema: owners, presences, owner_settings, invites and link_codes, with RLS forced on each.
- In the dashboard (API settings), add `waldo` to the exposed schemas. Local dev does this through `supabase/config.toml`.
- The runtime never gets the service-role key (ADR-0052, enforced by guard-do-only-runtime). It calls `waldo.route_presence` and `waldo.redeem_link` with the publishable key. Each call is HMAC-signed with a secret stored in Vault as `waldo_router_hmac`. The Worker holds the same value as the `WALDO_ROUTER_HMAC_SECRET` secret, and it opens nothing else.
- Seed the existing owner with `do_name` set to his Telegram id. His Durable Object, memory and conversation keep their current name, so nothing has to move.
- Until the Worker has `SUPABASE_PROJECT_URL`, `SUPABASE_PUBLISHABLE_KEY` and `WALDO_ROUTER_HMAC_SECRET`, routing falls back to the single `WALDO_OWNER_TELEGRAM_ID` owner.
