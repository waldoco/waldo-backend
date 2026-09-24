# Waldo Dashboard + Onboarding — Product Spec v2
**Date:** 2026-09-24 · **Status:** owner-reviewed, decisions applied · **For:** build

**What changed in v2:** the owner reviewed v1 (GitHub `DASHBOARD_SPEC_2026-09-24.md`, hosted page) and made his calls. This version applies every one. Teardown evidence (Folk live walkthrough, Instinct from the inside, Waldo Figma extraction) is unchanged and lives in §1; product decisions from §2 onward are now his.

**v1 product frame (his words, applied):** a person spins up their own Waldo with the dashboard, on WhatsApp, Telegram, and Discord. No health context in v1 — health cards stay app-exclusive. Later: Kennel handoff, then the app (Meta Muse parity line). Chat is one surface; the point of the agent is proactivity.

---

## 1. Reference teardowns (evidence, unchanged from v1)

### 1.1 Folk (walked live, logged in)
Phone-OTP login only (SMS/iMessage/Telegram delivery); channel identity doubles as account identity (*inference*). Surfaces and their jobs: dashboard home = activation (greeting, weather, streak, 6-step setup checklist); skills = capability discovery as a catalog; characters = play/stickiness; routines = chat-first creation; brain/lore = memory trust through provenance ("you told folk this on August 3") plus correction ("that's wrong" / "forget this"); settings = personality as directive chips, quiet check-ins toggle, main-app radio; connected apps = tiered linking (one tap / code fallback / BYO bot), 1000+ integrations with one-line capabilities.

### 1.2 Instinct (from the inside, grounded/inference labels preserved)
Onboarding is conversation-led on the messaging channel: greeting, one-line intro, live personalized demo, "How can I help?" — no forms, value proof first, setup later (grounded). The chat thread is the product; the web app is thin: preferences, scoped data deletion, account deletion, trusted people, vault fill pages, file pages (grounded). All linking happens in chat via one-tap links at the moment of need — OAuth connect links, vault fill links, invite links (grounded). Sign-in by phone number; the channel identity is the day-to-day session (grounded; web session detail inference). Data classes: memory, observations, vault; deletion scoped, not granular. Known gaps: no memory transparency, no granular deletion, value invisible between touches, serendipitous capability discovery, no visual work state.

### 1.3 Waldo Figma (design exploration)
Onboarding: 4 sections (Meet, Your life, Connect, All set), one serif question per frame in Waldo's voice, tappable options + free text with mic, black arrow button. Pivotal frame: "how much rope do you want to give me?" — the autonomy grant. Old dashboard scroll (297-5981): overnight brief, Today's Brief (morning/midday/afternoon with task-fit), the Handoff approval ("Sync it" / "Walk me through it first"), protected day plan, Form/Load/Sleep cards, insight cards ("Waldo spotted this at…"), patrol activity log (Fetch/Adjustment with flow chips), intelligence brief, day close. Components: light/dark tokens, card variants, rounded line icons.

### 1.4 Auth models compared
| | Folk | Instinct | Waldo (target, §4) |
|---|---|---|---|
| Login | Phone OTP | Phone number; channel = session | Phone OTP (Supabase) + channel identity |
| Linking | Settings, tiered | In-chat one-tap at need | In-chat one-tap at need (owner-confirmed) |
| Account mgmt | Full settings | Thin, scoped deletion | Thin + scoped + granular deletion |

---

## 2. Product decisions (owner, 2026-09-24 ~5:15 PM IST)

1. **Web app stays thin** — exactly: preferences, scope, data deletion, account deletion, trusted people + vault, file pages. Do not overscope it.
2. **Dashboard is denser** than the web app, in Waldo's branding/taste — simple, minimal, easy to navigate.
3. **Dashboard home (Folk pattern, adapted):** proper greeting, weather, setup checklist updated to what Waldo can do. Skills: later, customized to Waldo's need and character.
4. **Brief stack IN:** overnight brief card, Today's Brief, swipeable brief cards, the Handoff (what Waldo did/will do, calendar updated, tasks created, windows planned from form), protected day plan. **Health card OUT — app-exclusive.**
5. **Insight card IN. Patrol activity log IN (important — show it). Intelligence brief and day close IN.**
6. **Constellations + Spots together = the memory explorer** (his addendum): Spots cover short-term memory, Constellations cover long-term memory. Proper memory explorer confirmed. Waldo terminologies and branding throughout.
7. **Open loops across the user's life** — departments, use cases, lifestyle — kept updated on the day surface.
8. **Onboarding:** conversation-led is the pattern to beat; Waldo's onboarding runs the Figma mobile-app frames on the dashboard at first run — form-based or chat-based, both acceptable. Onboarding loop should be really good; trust loop from day one stands.
9. **Linking:** Instinct's exact behavior — one-tap links in chat at the moment of need (OAuth connect links, Waldo invite links, vault fills). Phone sign-in; channel identity as the session.
10. **Chat surface:** chat across WhatsApp, Telegram, Discord, in-app. Chat-first for now is fine, but proactivity (cards, dashboards, app updates) is the product; chat is one surface.
11. **Auth model + account management + connection authorization: spec it properly** — best, scalable, secure, trusted; external service allowed (§4).
12. **Usage & cost surface IN.**
13. **Settings page, connected apps, other Waldo-specific surfaces IN.**
14. Gap analysis from v1 agreed. Dashboard surfaces from v1 approved as the base. Keep P1/P2/P3 phasing; build now.

---

## 3. Onboarding flow (v2)

Runs **on the dashboard at first run**, using the Figma mobile frames as the screen designs. Form-based or chat-based rendering of the same beats — pick per build cost; the beats are fixed:

1. **Meet** — "Hello, I'm Waldo." Name ("what do I call you?") + email (receipts and recovery only).
2. **Your life** — day shape; what matters most (pick two); when the day starts ("this decides when I bother you"); when things go sideways. Answers drive which connections get requested — nothing irrelevant is asked.
3. **The rope** — autonomy grant: just tell me / suggest, I approve / move things, I trust you. Stored as the default permission level, always editable in settings.
4. **Connect, deferred** — only the connections the interview made necessary, each a one-tap link with a one-line capability and a code fallback. Never an upfront wall.
5. **Consent** — plain-language data terms, 18+, terms; product updates opt-in.
6. **The contract** — "Give me a few days. Your first Brief arrives tomorrow morning," on WhatsApp, Telegram, or Discord.
7. **First dashboard visit onward** — the setup checklist (Folk activation pattern) drives the rest: connect a channel, connect calendar, set quiet hours, approve a first suggestion.

**Trust loop from day one (confirmed):** every interview answer persists as a memory item with provenance; the Constellations memory explorer shows "you told Waldo this during onboarding" immediately.

## 4. Auth, account, and connection authorization — decision spec

**Recommendation (scalable, secure, trusted; external services where they earn their place):**

- **Identity: Supabase Auth, phone OTP primary, email OTP secondary.** Supabase is already the verified stack (console auth, staging smoke-tested); phone OTP is a provider config, not new infrastructure. Web session = Supabase JWT with refresh; "sign out everywhere" and active-session list in settings.
- **Channel identity as the day-to-day session (owner-confirmed):** WhatsApp/Telegram/Discord messages arrive with transport-verified sender identity. Each channel links to the account once via a one-tap signed link; thereafter the channel IS the session. No per-message auth.
- **Dashboard entry from any channel:** Waldo mints a short-lived, single-use, signed session link in the thread ("open my dashboard" or under any brief) → pre-authenticated dashboard. Phone OTP on the web as the fallback. This is the manage-everything-from-one-place requirement.
- **Connection authorization: Nango (external service, already in the build order as the connector spine).** Hosted OAuth flows, token storage and refresh, per-connection scopes for Google etc. Waldo's own DB never stores raw OAuth tokens. Non-OAuth secrets (BYO bots, API keys) go to the vault via fill links — Waldo never sees the value. Channel bots: one-tap official-bot link, code fallback (no permissions), BYO advanced (Folk's tiers).
- **Account management (thin web app + dashboard settings, mirrored in chat):** preferences; scope (what Waldo may see/do, per connection); data deletion scoped per connection AND granular per date range (deliberately ahead of Instinct); whole-account deletion; trusted people + vault; file pages.
- **Alternatives considered:** Clerk/WorkOS — faster enterprise SSO later, but a new vendor and migration cost against an already-verified Supabase stack; defer until team phase. Fully custom JWT auth — rejected, never roll own auth.

## 5. Dashboard surfaces (v2, approved base + his deltas)

Design language: the Figma tokens and components, Waldo voice, simple and minimal.

```
Home        greeting + weather + setup checklist (Folk pattern, Waldo-adapted);
             overnight brief, Today's Brief, swipeable brief cards, the Handoff
             approval (Sync it / walk me through it first), protected day plan,
             insight card, patrol activity log, intelligence brief, day close.
             NO health card (app-exclusive). Skills: later.
Loops       open loops across his life - departments, use cases, lifestyle -
             with state (in flight / waiting on you / blocked / scheduled),
             last movement, next check-in; approvals inline.
Chat        one conversation across WhatsApp, Telegram, Discord, in-app;
             second screen for the channel. Proactivity is the product;
             chat is one surface.
Constellations  long-term memory explorer: statement, provenance, scope chips,
             that's-wrong + forget-this.
Spots       short-term memory explorer: the same pattern over recent,
             fast-decaying items. Spots + Constellations together = the
             memory explorer (STM + LTM).
Connections channels, services, vault items: state, one-line capability,
             one-tap link / code / BYO. Authorization via Nango (§4).
Activity    the patrol ledger: every action, flow chip, timestamp, reason.
Usage & Cost runs, tokens/cost, per-connection activity (owner: important).
Settings    profile, autonomy level, quiet hours, personality directives,
             data & privacy, notifications per channel, billing later.
Web app (thin, separate)  preferences, scope, data deletion, account
             deletion, trusted people + vault, file pages. Nothing more.
```

## 6. End-to-end dev loop (phasing kept: P1/P2/P3)

Architecture unchanged: Vite + React SPA on Cloudflare Pages → JSON API on the existing waldo-runtime Worker → per-user DO; WebSocket realtime (SSE fallback); Supabase auth + minted-token endpoint; Nango for connection authorization. Every slice: API contract first, build on staging, verify from the channel (chat and dashboard read the same store), visual pass against Figma tokens, owner first then design partners.

- **P1 — Read-only mirror:** auth (minted links + phone OTP), Home brief stack from real DO state, patrol activity, connections state, usage & cost. Exit: owner uses the dashboard daily for a week without the console.
- **P2 — Trust mutations:** the Handoff approvals, memory correct/forget in Constellations, quiet hours, autonomy level, scoped + granular deletion. Exit: an approved calendar move lands and shows in the patrol log.
- **P3 — Chat parity + channels:** dashboard chat on the shared conversation store; WhatsApp, Telegram, Discord live with one-tap linking; session-link minting from any channel. Exit: a conversation started on Telegram continues on the web with zero state loss.
- **After P3 (not in v1):** skills catalog, health cards (app), Kennel handoff, team/multi-user.

**Deliberate exclusions (his "don't overscope"):** lore graph visualization, characters/personas, MCP management UI, in-dashboard OAuth hosting, health anything, skills in v1.

**Build-state inventory and time estimate** (his closing ask — what is built/verified/coded-not-connected/blocked/untested, and the critical path to "working Waldo on par with Instinct and Folk by end of today"): owned by the MVP lane; this spec does not duplicate it.
