# Owner step-by-step setup: every key and connection (2026-09-24)

One pass, six services, in the order that unblocks the most. Each section says what to click, what to copy, and the exact name to save it under.

## Where the values go

Put every value into GitHub Codespaces secrets for `waldoco/waldo-backend` (github.com -> your avatar -> Settings -> Codespaces -> Codespaces secrets, each one assigned to the waldo-backend repo). From there I push them to the staging Worker and the Supabase function secrets myself. Never paste a secret value into a chat message. If a service makes you paste something awkward, ask me for a vault link instead.

Nothing below needs Kubernetes, AWS, or any extra cloud service (your 12:39 ruling). Everything lands in: the Cloudflare Worker's secrets, Supabase's own secret store, and Supabase Vault.

## 1. Supabase - one new project (do this first)

One project total. The app and the agent share one backend; the old codespaces-era project is retired and its migrations get folded into this one.

1. dashboard.supabase.com -> New project. Name: `waldo`. Region: Mumbai (South Asia) - closest to you.
2. Set the database password it asks for. Save it as `SUPABASE_DB_PASSWORD`.
3. Project Settings -> API. Copy:
   - Project URL -> `SUPABASE_PROJECT_URL`
   - anon / publishable key -> `SUPABASE_PUBLISHABLE_KEY`
   - service_role key (click reveal) -> `SUPABASE_SERVICE_ROLE_KEY`
4. dashboard.supabase.com -> your avatar -> Account -> Access Tokens -> Generate new token -> `SUPABASE_ACCESS_TOKEN` (lets me run the migrations).
5. Authentication -> Sign In / Providers -> turn on Email OTP.
6. Authentication -> URL Configuration -> Site URL: `https://waldo-runtime-staging.piyushfulper3210.workers.dev`

Then tell me "supabase is in" and I run the migrations, expose the waldo schema, and seed your owner row.

## 2. Google OAuth client

1. console.cloud.google.com -> create a project, e.g. `waldo-staging`.
2. APIs & Services -> Library -> enable: **Google Calendar API** and **Gmail API**. (Google Tasks API optional.)
3. APIs & Services -> OAuth consent screen -> External -> fill the basics -> Testing mode -> add your own Gmail address(es) as test users. Add these scopes to the consent screen:
   - openid, email
   - `.../auth/calendar.events`
   - `.../auth/gmail.readonly`
   - `.../auth/gmail.send`
   - `.../auth/gmail.compose`
   You ruled consent is one combined ask for the Google services, not calendar-first-then-gmail. You just list all the scopes here; I'm reworking the code so Waldo asks once, combined, the first time any Google feature is turned on.
4. APIs & Services -> Credentials -> Create Credentials -> OAuth client ID -> type **Web application**. Authorized redirect URI, exactly:
   `https://waldo-runtime-staging.piyushfulper3210.workers.dev/oauth/google/callback`
5. Copy the client ID -> `GOOGLE_CLIENT_ID` and client secret -> `GOOGLE_CLIENT_SECRET`.

Testing mode covers you (up to 100 test users). Google's app verification only matters before other users connect.

## 3. Brave Search (settled: Brave, not Tavily)

1. brave.com/search/api -> sign up -> pick a plan (the paid tier is about $5 per 1,000 searches; free tier exists for a start).
2. API keys -> create -> save as `BRAVE_SEARCH_API_KEY`.

## 4. Smallest AI (voice - replaces the ElevenLabs ask)

Smallest AI covers both directions: speech-to-text for your voice notes and text-to-speech for Waldo's voice replies.

1. smallest.ai -> create an account.
2. Dashboard -> API Keys -> create -> save as `SMALLEST_AI_API_KEY`.

Then I build the adapter (transcription + synthesis behind the voice seam, where ElevenLabs was going to sit).

## 5. OpenAI

Cleanest: one key with all models enabled. In platform.openai.com -> your project -> either turn on access to the mini/luna-tier models for the existing project, or create a fresh key on a project that has them -> save as `OPENAI_API_KEY` (this replaces the current key; I'll rotate it onto staging).

If you'd rather have two keys for billing separation: make an all-models key and keep the nano-only one, save both, and label them. I wire the all-models one as primary and the nano-only one as fallback in code. Either way, the key with mini/luna access is what unblocks the model A/B.

## 6. WhatsApp (test number today; business verification in parallel, both yours)

1. developers.facebook.com -> My Apps -> Create App -> type **Business** -> add the **WhatsApp** product.
2. WhatsApp -> API Setup. Meta gives you a free **test number**. Add your own phone as a recipient (it texts you a code to confirm).
3. Copy: the temporary access token (lasts 24h - fine for the first live test) -> `WHATSAPP_ACCESS_TOKEN`; the phone number ID -> `WHATSAPP_PHONE_NUMBER_ID`; the WhatsApp Business Account ID -> `WHATSAPP_BUSINESS_ACCOUNT_ID`.
4. App Settings -> Basic -> App secret -> `WHATSAPP_APP_SECRET` (used to verify webhook signatures).
5. The webhook verify token: I generate it, nothing for you.
6. In parallel: Settings -> Business verification in Meta Business Suite. That plus a real number is what takes WhatsApp past the 5-recipient test cap, when we want it.

## The stated-vs-inferred memory decision (plain words)

Waldo's memory grades every fact three ways: **stated** = you said it, **confirmed** = Waldo guessed and you agreed, **inferred** = Waldo's own read, always offered to you as a guess.

When we move your existing memory into the new system, the entries written from your own words (your core facts, goals, follow-ups) get marked stated. The question is what to do with the entries that came from Waldo's old summary of you - things Waldo concluded, not things you said:

- **Mark them inferred** (my recommendation): honest, and nothing gets treated as truth that you never actually said. Cost: over the first days Waldo occasionally offers one back - "I read that you prefer mornings, right?" - and one yes from you confirms it forever.
- Mark them stated: faster, no offers, but some of Waldo's guesses would silently become facts about you.

Reply "inferred" or "stated" and it's settled.

## Suggested order

1. Supabase (unblocks the most: routing, memory-on-postgres, console sign-in)
2. Google OAuth (unblocks calendar + mail, the biggest daily surface)
3. Brave, then Smallest AI (search and voice)
4. OpenAI key with mini/luna (unblocks the model A/B)
5. WhatsApp whenever (design is done; code follows your test-number values)
