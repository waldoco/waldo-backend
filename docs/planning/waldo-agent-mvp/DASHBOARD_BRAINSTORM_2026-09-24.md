# Waldo web dashboard: brainstorm and architecture (2026-09-24)

Owner ask: a full web dashboard experience (Instinct's as the reference), with tech stack across frontend / backend / deployment / scalability, and the per-user agent instance model. Builds on the console that already exists.

## 1. What exists today

The console (packages/runtime/src/channels/console.ts) is server-rendered HTML straight out of the owner's Durable Object: email-OTP sign-in (Supabase), cookie session + CSRF, form-POST actions (spot confirm/dismiss/forget, card pin, google disconnect, timezone, invites, telegram link), zero JavaScript framework, zero build step. It already proves the hard parts: owner auth, per-owner data isolation, and a same-trust-boundary UI.

Its limits are the point of this doc: full-page reloads, no live updates, no chat surface, and every render is computed inside the DO.

## 2. The dashboard as a product

The owner's window into his agent - and later every user's window into theirs:
- **Chat** with Waldo (same conversation as Telegram/WhatsApp - one conversation tree, many surfaces, per the session design).
- **Memory explorer**: claims with their provenance badge (stated / confirmed / inferred), spots awaiting confirmation, constellations, forget/undo.
- **Open loops**: every commitment Waldo is holding, its age, its next nudge.
- **Day surface**: brief / midday / close cards, fetch alerts, calendar.
- **Usage & cost**: the /usage telemetry as charts (tokens, cached share, USD per model per day).
- **Connections**: Google accounts, WhatsApp, search/voice keys - with contextual vault/credential links surfacing in-line when a connection is missing (the owner's enhance-vault ruling: links generated at the moment they're needed, no slash commands).
- **Settings**: proactivity dial, timezone, quiet hours.

## 3. Architecture options

**A. Evolve the console (keep server-rendering from the DO).** Cheapest by far; no new stack. But every page render runs inside one DO, live updates mean polling, and the experience ceiling is the one we already feel. Good enough for the owner this month; not the Instinct-class experience.

**B. Static SPA + JSON API (recommended).** Frontend: a small Vite + React (or Svelte) app, Tailwind, deployed to Cloudflare Pages - global CDN, free at our scale, same vendor we already run on. Backend: JSON routes on the existing runtime Worker (`/dashboard/api/...`), which read/write the owner's DO exactly like the console does today; the console's data paths get reused, not rewritten. Live updates: WebSocket or SSE from the DO (DOs support WebSocket hibernation, so idle connections are cheap). Auth: reuse the console's email-OTP session cookie so there is one sign-in system, not two.

**C. Separate backend-for-frontend service.** Real companies do this at scale; at one-to-one-hundred owners it adds a service, a deploy and a secrets surface for no user-visible gain. Rejected for now.

Recommendation: B, grown out of A. The console stays as the zero-dependency fallback; the SPA becomes the real experience.

## 4. Per-user agent instance model

Already built, and the dashboard doesn't change it: **one Durable Object per owner is the agent instance** - its memory, conversation tree, scheduler and ledger live inside it. The waldo schema in Supabase (owners, presences, invites, link codes, route_presence) routes any surface - Telegram, WhatsApp, console, dashboard - to the right DO. Scaling shape:

- DOs scale per-owner by construction; Cloudflare places them near the user. SQLite-per-DO (~10 GB) is far beyond a person's lifetime of claims and episodes.
- Pages serves the SPA globally; the Worker is stateless and scales horizontally.
- Supabase Postgres holds only cross-owner routing and settings - the small shared state.
- Cost per idle owner is near zero: DOs hibernate, Pages is static, no always-on server.

This is the same instance model Instinct-class products converge on: an always-on, per-person agent process with durable state - ours just happens to be a DO instead of a container, which is why it costs nothing when idle.

## 5. Phasing

1. **Read-only dashboard** (first slice): sign in, see memory explorer, open loops, today's card, usage charts. All read paths the console already has; no mutations, no websockets. Proves auth + API + Pages deploy.
2. **Mutations**: loop/spot actions move from form-POSTs to fetch() against the same actions - the console action list is the contract.
3. **Chat in the dashboard**: websocket to the DO, joining the shared conversation tree (cross-surface continuation per the session design doc).
4. **Connections & vault moments**: inline "connect Google" / "add your voice key" cards generated contextually - the enhance-vault standard, on the web surface.
5. **Later**: presence/team surfaces (multi-owner), only after beta.

## 6. What this needs from the current queue

Nothing blocked: phase 1 builds on the new Supabase project (owner auth) plus the runtime we have. Suggested position: after keys land and the combined e2e is green, before the deep intelligence-layer cycles - because the dashboard is also the owner's best seat for watching those cycles work.
