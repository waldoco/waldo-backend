# Waldo Dashboard + Onboarding — Product Spec v1
**Date:** 2026-09-24 · **For:** Shivansh review · **Author:** Instinct (task agent)

**Evidence base:** (1) live walkthrough of Folk's dashboard logged in as the user (cloud browser, 14 screenshots); (2) Instinct surface documented from the inside via Q&A with the main agent; (3) full extraction of Waldo Figma file `Dl0WP9uIvx6QbSzZi7cZQY` — onboarding (node 722-15216), old dashboards (269-5937, 297-5981), components (591-6560); (4) dashboard brainstorm doc (received as an attachment from the main agent). Backend claims about Folk and Instinct internals are labeled *inference*. Folk and Figma findings come from the live walkthroughs above; Instinct findings are relayed by the main agent with its grounded/inference labels preserved.

---

## 1. Reference teardowns — what each product does and why

### 1.1 Folk (walked live, logged in)

**Auth model (observed):** phone-number OTP only. Login page offers code delivery via SMS, iMessage, or Telegram. No email/password, no social OAuth seen. Session persisted across tabs in the same browser profile. Per-user outbound address exists (`sf@mail.folk.com` shown in settings) so Folk can email as the user. *Inference:* channel identity doubles as account identity, same pattern as Instinct.

**Surfaces and the intention behind each:**

| Surface | What it is | Intention (the job it does) |
|---|---|---|
| Dashboard home | Greeting + weather + location, streak counter, 6-step setup checklist with progress, "who folk is right now" character card, referrals ($25), lore link | Activation: give a new user 6 obvious wins and a reason to come back tomorrow (streak). The checklist *is* the onboarding, spread over days instead of one upfront flow |
| Skills | "Things folk can do for you on a schedule - some come with their own little app." 3 active (Daily brief, Habit streak keeper, Workout accountability), 20 category chips | Capability discovery: answers "what can I hand off?" as a browsable catalog, not a serendipity problem. Each skill is a recurring proactive job |
| Characters | "Make someone to text with - they take over your imessage or telegram thread until you say back to folk" | Play/persona layer; keeps the thread sticky without needing utility every day |
| Routines | Chat-first creation: you describe it in chat, Folk builds the schedule | Creation happens where the user already is; the dashboard only shows the result |
| Brain / Lore | "What folk knows about you - every line came from something you said. Tap one to see where." Filter chips (everything/you/work). Drill-down: "you told folk this on August 3" + **"that's wrong"** + **"forget this"**. 2D/3D graph view | Memory transparency + correction. The provenance line is the trust mechanism; wrong/forget are the control. This is Folk's strongest surface |
| Settings | Profile, "folk has been quiet for 46 days" re-engagement card, folk vault (NEW), activity log, personality (directive chips like "keep it short, no preamble", "be blunt, skip the hedging", "assume i'm technical" + "adapt to my writing style" switch), voice & calls, quiet check-ins toggle, connected apps, main-app radio (iMessage/WhatsApp/SMS), plan & billing, import memories, privacy, developer, referrals, groups, docs | Personality as tappable directives, not a prompt box. Quiet-hours control is one toggle, not a scheduler |
| Connected apps | Tabs: chats / apps / custom. iMessage + WhatsApp connected; Telegram "one tap, official folk bot" deep link + "link with a code instead (no permissions)" + "advanced - bring your own bot"; Discord; geolocation; 1000+ app integrations each with a one-line capability description; custom MCP servers | Tiered linking: happy path is one tap, paranoid path is a code, power path is BYO. Every integration says what it can do in one line |
| Meeting recaps | Toggle inside settings | — |

Not visited (walkthrough stopped on owner's call): plan & billing, privacy, import memories, developer, folk vault internals, activity internals.

### 1.2 Instinct (documented from the inside)

**Onboarding (grounded):** invite link → sign in with phone number. First run is *conversation-led on the messaging channel*, not a form: greeting by first name, one-line intro, then a live demo (three fresh screenshots personalized to the user's city: weather, newspaper homepage, flights), then "How can I help?". No forms, no permission checklist. Behind the scenes, onboarding counts as done when a real task has been delivered ("magic moment"), a long-term goal has surfaced, and a recurring check-in exists. Connections happen at the moment of need, not upfront.

**Surfaces (grounded):** the chat thread *is* the product (iMessage, WhatsApp, Slack, voice, in-app chat). The web app is thin: Preferences (name), Settings (training opt-out, delete external data, delete location data, delete account, clear screen history), a Trusted People page (i2i connections + invite links), vault fill pages (secrets via one-time links). No dense dashboard; no user-visible task board.

**Connection UX (grounded):** all linking happens in chat via one-tap links — OAuth connect links, vault fill links, trusted-people invites. The agent brings the link at the moment of need: "one link, one tap, done."

**Auth model (grounded + inference):** phone-number sign-in (grounded). Day-to-day there is no login — the messaging channel identity is the session (web session persistence *inference*). Three data classes: memory (agent-curated), observations (indexed connected-service data, never used for training), vault (user secrets). Deletion is scoped: external data, location, or whole account; no granular self-serve memory delete.

**Memory UX (grounded):** memory compounds but has *no user-facing browser/editor*; correction is conversational ("call me X").

**Proactivity (grounded):** reminders, watch results, timed nudges on the user's channels; cadence steered conversationally; no settings-page quiet hours.

**Known gaps (main agent's read):** (a) no memory transparency surface; (b) no granular self-serve deletion; (c) value invisible between touches — nothing shows what's being tracked; (d) capability discovery is serendipitous; (e) no visual work state — the thread buries what's in flight.

### 1.3 Waldo's own Figma (design exploration, file Dl0WP9uIvx6QbSzZi7cZQY)

**Onboarding (node 722-15216), 14 frames in 4 sections.** Every frame: Waldo dog mascot, one large serif headline in Waldo's voice, a muted italic sub-line, 4–5 tappable options, a free-text input with mic, black arrow button; progress bar ("Section N : name"), back arrow.

- **Section 1: Meet** — "Hello, I'm Waldo. I read the health data your device already collects - and quietly handle things for you." → "What do I call you?" (name + email, with the sub-line "only for my use; the email's for receipts and 'I forgot my password' moments").
- **Section 2: Your life** — "What does your day look like?" (9-5 flexible / back-to-back / deep work / unpredictable + free text); "What matters most right now?" ("I suggest you pick two" — energy / stress / schedule / sleep + free text); "When does your day usually start?" ("this decides when I bother you. choose wisely."); "When things go sideways... what does that look like for you?" (stress tells, multiple choice + free text); "How much rope do you want to give me?" (just tell me / suggest but I approve / move things around - I trust you). *This is the autonomy-grant question — the most important frame in the flow.*
- **Section 3: Connect** — "Which device are you wearing?" (Apple Watch / Oura / WHOOP / Ultrahuman); "A few things I'll need access to" — Apple Health connect or manual `export.xml` upload with a how-to link; variant B shows a "2/10 signal depth" indicator with Spotify/Todoist/Slack connect rows. Consent screen: plain-English data terms ("stored encrypted, never shared, delete everything from settings") + checkboxes (product updates opt-in pre-checked, 18+, terms).
- **Section 4: All set** — "Give me a few days. I need to learn your patterns before I start moving things around. Your first Brief arrives tomorrow morning - I'll reach out on WhatsApp, or right here if you check in." Sets the expectation contract: what happens next, when, and where.

**Old dashboard A (node 269-5937, desktop 1795×1241):** three-pane — left sidebar (logo, + New Chat, Connectors, profile "Suyash Pingale · 21% streaking", Fetches, Constellations, Your Chats, recent list), center chat, right panel with time tabs (Today/7D/30D/3M/12M) and cards. Brief variants show the voice register: "Morning. Bit of a rough night - your sleep was short by about 90 minutes. Nudged your 9am to 10:30 & 10am to noon. Nothing drastic, the rest of your day looks good. *cue World Hold On by Bob Sinclar*" — fact, action taken, reassurance, personality beat. Landing page hero: "Something's off. ChatGPT knows your tasks. your calendar knows your time. neither knows you slept three hours."

**Old dashboard B (node 297-5981, tall scroll 1788×6719) — the strongest artifact.** Scroll sequence top to bottom:
1. Overnight brief card (stacked cards, "scroll up to see overnight log; but you probably dont because Waldo handled it all").
2. **Today's Brief** — day plan in three blocks: Morning Window ("Form: 78. Your sharpest block. The brief is done. This is yours. → API architecture doc [hard task - put here]"), Midday ("Three meetings. Stack is heavy. Waldo moved Executive Sync to 10:30 to protect the morning."), Afternoon ("Circadian dip incoming at 2:30. Keep it light."). Each block pairs calendar reality with task-fit annotations.
3. **The Handoff** — "This is the plan. Want me to sync it? I'll move the meetings, draft the emails, block the focus windows, and check back at 2pm. You won't need to think about it." Buttons: **Sync it** / **Walk me through it first**. *This is the approval primitive.*
4. **Protected day plan** — timeline 09:00–17:00 with protected blocks, "confirmed · 8:45am".
5. Health cards with status chips + provenance timestamps: **Form** (Steady, radial 73, "last read · 8:32am"), **Load** (Steady, zone bars vs yesterday), **Sleep** (Steady, hypnogram, "You came out of deep sleep at 3:20am and didn't return. That's 40 minutes short of your baseline.").
6. **Insight cards** with category chips — Body: "Your deep sleep dropped 22% after back-to-back calls yesterday afternoon." Pattern: "Your HRV drops on mornings after late screen time. Not every time - but consistently enough that Waldo is paying attention." Schedule: "Three back-to-back Tuesdays with no protected window. That's not a coincidence." Each signed "**Waldo spotted this at 11:42 am**".
7. **Activity log** — 9:47am "The Fetch" [Health Alert chip]: anomaly detected, proactive nudge sent; 8:15am "Adjustment" [Calendar Flow chip]: "Waldo moved your 9:00am Executive Sync to 10:30am... negotiated the slot to protect your morning focus block."
8. **Intelligence Brief** — "Waldo sent your morning message. Curated headlines from FT and The Economist prioritized based on your Q4 Strategic Directives. Readiness 88. *as you requested yesterday*" — note the provenance line again.
9. Closer — "that's about it! Tonight at 9pm Waldo will check how the day landed... Ask Waldo..." + **New conversation** button.

**Components (node 591-6560):** light + dark color tokens (dark: Surface sunken ~#171616, Border default, Text secondary/tertiary, Accent subtle orange, Action blue ~#2D84FF; light-mode counterparts), brief-card variants (light/dark, with and without mascot glyph, "Option A/Option B" toggles), Buttons, Lists, rounded line-icon set, hover states.

### 1.4 Auth models compared

| | Folk | Instinct | Waldo (today, per brainstorm) |
|---|---|---|---|
| Login | Phone OTP (SMS/iMessage/Telegram delivery) | Phone number sign-in; channel identity = session | Email OTP via Supabase on the existing console |
| Session | Persistent browser session | No day-to-day login; channel is the session | Console session (Supabase) |
| Channel linking | Dashboard settings, one-tap deep link + code fallback + BYO bot | In-chat one-tap links at moment of need | Telegram webhook (owner-only bot today) |
| Account management | Full settings surface (export/import memories, privacy, billing) | Thin settings: scoped deletion, opt-outs, account delete | — (to be designed) |
| Data deletion | Not observed | Scoped: external / location / whole account; no granular memory delete | — (to be designed) |

---

## 2. Gap analysis — brainstorm doc vs the teardown evidence

The brainstorm doc proposed: console exists as server-rendered HTML from the owner DO with email-OTP Supabase auth; recommended architecture B (Vite+React SPA on Cloudflare Pages + JSON API on the existing runtime Worker + WebSocket/SSE from the DO, reusing console auth); surfaces = chat, memory explorer with provenance, open loops, day surface, usage & cost, connections with contextual vault links, settings; phases = read-only → mutations → chat → connections/vault → team.

| Brainstorm proposal | Verdict after teardown | Change |
|---|---|---|
| Memory explorer with provenance | **Validated, strengthen.** Folk's lore proves provenance ("you told folk this on August 3") plus correction ("that's wrong" / "forget this") is the trust surface. Instinct's #1 known gap is exactly this. Waldo's Figma already has the provenance pattern ("Waldo spotted this at 11:42 am", "as you requested yesterday") | Add correct/forget actions per memory item. This becomes the dashboard's differentiator, not a nice-to-have |
| Chat surface on dashboard | **Validated, re-scoped.** Instinct shows chat is the product; Folk shows routine *creation* happens in chat. Dashboard chat should be a first-class pane but not the primary creation surface — the channel is | Dashboard chat = same conversation, second screen. Prioritize read state + approvals over composing |
| Open loops | **Validated.** Maps to Instinct gaps (c) and (e). Figma sidebar names exist: Fetches, Constellations, Your Chats | Keep "open loops" as the work-state surface; adopt Figma naming if it fits the metaphor |
| Day surface | **Validated and upgraded.** Old dashboard B's Today's Brief + Handoff is a better home than a generic day surface: plan, approval, protected blocks, health context, one scroll | Make the Brief the dashboard home; day surface absorbs it |
| Usage & cost | **Keep, small.** Neither reference makes this prominent; user manages it | Simple page: runs, tokens/cost, per-connection activity |
| Connections with contextual vault links | **Validated, adopt Folk's tiers.** One-tap happy path, code fallback, BYO advanced. Instinct's "link at the moment of need" stays the channel behavior; the dashboard mirrors connection state and can *send* the link to the channel | Dashboard never hosts OAuth forms itself; it mints and tracks links |
| Settings | **Keep thin.** Folk's settings are a good inventory reference; Instinct proves thin works | Profile, autonomy level ("how much rope"), quiet hours (one control), personality directives, data & privacy (export, scoped delete, account delete), billing later |
| Email-OTP auth reuse | **Partially revised.** Fine for console parity, but the user's requirement is channel-minted session links, and both references use phone/channel identity | Primary: channel-minted one-tap session link. Secondary: email OTP. (Section 4.1) |
| **Missing from brainstorm** | **Onboarding spec** (this doc §3), **setup checklist activation** (Folk), **capability catalog / skills** (Folk's answer to Instinct gap d), **approvals queue UX** (Figma Handoff gives the primitive; build-order S7 already plans the API) | Added below |

---

## 3. Onboarding flow spec

**Principles (from the user + evidence):**
1. Value proof before setup (Instinct's magic moment; Folk spreads setup over days as a checklist).
2. Conversational, one question per beat, tappable options first, free text/voice always available (Figma pattern).
3. **Dynamic to the user's requirements** — the question path adapts: declared goals change which follow-ups fire and which connections get requested; nothing irrelevant is asked.
4. Connect at the moment of need, never as an upfront wall (both references agree).
5. Every data ask states the trade in plain language (Figma consent screen is the model).

**Flow (channel-first, because Waldo's first surface is Telegram/WhatsApp):**

1. **Hello / magic moment.** Waldo introduces itself by name and does one real, visible thing immediately (Instinct pattern; for Waldo: a first mini-brief from whatever signal already exists, even just calendar). No forms.
2. **The interview (Figma Sections 1–2, adapted to chat).** One message per question, quick-reply chips + free text:
   - What do I call you?
   - What does your day look like? (schedule shape)
   - What matters most right now? — "pick two" (goals; this drives everything downstream)
   - When does your day start? ("this decides when I bother you")
   - When things go sideways, what does that look like? (stress tells, for health-aware planning)
   - How much rope do you want to give me? — **the autonomy grant**: just tell me / suggest, I'll approve / move things, I trust you. Stored as the default permission level; every later grant refines it.
   - *Dynamic branching:* answers select follow-ups (e.g. "back-to-back meetings" → calendar connect prompt now; "sleep is bad" → health source prompt; "just tell me things" → skip approval-flow explanation).
3. **Connect (Figma Section 3), deferred by default.** Only the connections the interview made necessary, each as a one-tap link with a one-line capability statement and a code/no-permissions fallback (Folk tiers). Health device question only for users who picked health goals.
4. **Consent (Figma "Almost there").** Plain-English data terms, 18+, terms; product updates opt-in.
5. **The contract (Figma Section 4).** "Give me a few days... your first Brief arrives tomorrow morning." Set the cadence expectation and where Waldo will reach out.
6. **Dashboard arrival.** When the user first needs the dashboard (or taps a minted link), they land on a **setup checklist** (Folk pattern): 5–6 items with progress — e.g. connect calendar ✓, answer the interview ✓, set quiet hours, add a connection, try approving a suggestion. This replaces an upfront setup wizard.

**Backend note:** interview answers must persist as memory items with provenance from day one, so the memory explorer (§4.4) shows "you told Waldo this during onboarding" — the trust loop starts immediately.

## 4. Dashboard UI/UX spec

### 4.1 Auth and entry

- **Primary: channel-minted session link (user's explicit requirement).** Any channel text ("open my dashboard", or a button under a brief) makes Waldo reply with a one-tap link carrying a short-lived, single-use token → opens the dashboard pre-authenticated. Manageable from one place: the thread.
- **Secondary: email OTP** via Supabase (reuses console auth, per brainstorm).
- Sessions: durable browser session after first auth; dashboard shows "sign out everywhere" + active-session list in Settings.
- Account management surface: data export, scoped deletion (per connection, per date range, whole account — deliberately ahead of Instinct's gap b), connected accounts, autonomy level, quiet hours.

### 4.2 Information architecture

Design language: the Figma components as-is (serif display type, muted italic sub-lines, white/dark tokens, rounded line icons, status chips). Waldo speaks in first person; every proactive claim carries a timestamp.

```
Home (The Brief)        — today's plan + handoff approval + health/status cards (scroll, Figma 297-5981)
Loops                   — open loops: what's in flight, what's blocked, what's waiting on you (Fetches)
Chat                    — the same conversation as the channel, second screen; approvals inline
Memory                  — explorer with provenance + correct/forget (Lore)
Constellations          — grouped long-term goals/patterns (from Figma sidebar; houses insight cards)
Connections             — state of every channel/integration/vault item; mint links from here
Activity                — the ledger: every action Waldo took, with chip + timestamp (Fetch/Adjustment pattern)
Usage                   — runs, cost, per-connection activity
Settings                — profile, autonomy, quiet hours, personality directives, data & privacy, account
```

### 4.3 Home (The Brief)

The old-dashboard-B scroll, productized:
1. **Overnight/last-touch card** — what Waldo did while you were away; stacked cards for history.
2. **Today's Brief** — day blocks (morning/midday/afternoon) merging calendar + task fit + health context. Task annotations in brackets are suggestions, not commitments.
3. **The Handoff** — approval primitive: "Sync it" / "Walk me through it first". Ties to the autonomy grant: "move things" users see it pre-synced with an undo; "suggest" users see the buttons; "just tell me" users see the plan read-only.
4. **Status cards** — Form/Load/Sleep pattern generalized: a card = name, status chip (Steady/Watch/Act), one plain-language finding, one number/viz, "last read · time".
5. **Insight cards** — Body/Pattern/Schedule chips, "Waldo spotted this at T". Tap → Constellation detail.
6. **Activity** — latest ledger entries inline; full ledger in Activity.
7. **Closer** — "that's about it" + next touch time + New conversation.

### 4.4 Memory (the differentiator)

- Every item: statement, provenance ("you told Waldo this on Aug 3" / "inferred from calendar, Sep 12"), scope chips (you/work/health), and two actions: **that's wrong**, **forget this**.
- Filters: everything / you / work / source.
- Forgetting is immediate and visible (item greys, then leaves) — the forgetting mechanism is part of the MVP already.
- No graph view at launch (Folk's 2D/3D graph is decoration; the list + provenance does the work).

### 4.5 Loops (work state)

- Each loop: title, state (in flight / waiting on you / blocked / scheduled), last movement, next check-in time. Directly answers Instinct gap (e).
- "Waiting on you" items carry their approval card inline (Handoff primitive reused).
- Scheduled jobs (skills equivalent) live here with pause/edit — creation stays in chat (Folk routine pattern).

### 4.6 Connections

- Rows grouped: channels (Telegram/WhatsApp/iMessage), services (Google, Spotify, ...), vault items, health sources.
- Each row: state (connected / action needed / available), one-line capability, and the action = **send me the link** (minted to the channel) or **link with a code** fallback (Folk tiers).
- "Signal depth" indicator from Figma Section 3 variant B is worth keeping as a setup-quality nudge.

### 4.7 Settings (thin)

Profile · autonomy level ("how much rope", the onboarding answer, always editable) · quiet hours (one control) · personality (directive chips, Folk-style: "keep it short", "be blunt", "assume i'm technical" + adapt-to-my-style switch) · data & privacy (export, scoped delete, delete account) · notifications per channel · billing (later).

## 5. End-to-end dev loop

**Architecture (per brainstorm B, confirmed):** Vite + React SPA on Cloudflare Pages → JSON API on the existing `waldo-runtime` Worker → per-user DO holds state; realtime via WebSocket (fallback SSE) from the DO. Auth: Supabase (email OTP) + new minted-token endpoint for channel links. No new backend services.

**Work loop (how a slice ships):**
1. Slice defined from the phased plan below; API contract first (Worker route + DO method + types shared with the SPA).
2. Build against staging (`waldo-runtime-staging`); the owner DO already serves the console, so dashboard routes mount beside it.
3. Behavioral check from the channel: every dashboard slice must be verifiable from Telegram ("what's my form today?" reads the same store the card does) — chat and dashboard never diverge.
4. Visual pass against Figma tokens/components before merge.
5. Ship behind the owner account first, then design partners.

**Phases (brainstorm phases, re-scoped by the teardown):**

- **P1 — Read-only mirror (validate value):** auth (minted links + OTP), Home brief rendered from real DO state, Activity ledger read, Connections state read, Usage read. Exit: owner uses the dashboard daily for a week without touching the console.
- **P2 — Trust mutations:** approvals (Sync it / walk me through), memory correct/forget, quiet hours, autonomy level. All map to the S7 trust API (approvals queue, activity ledger, stop/undo). Exit: a moved-meeting suggestion approved from the dashboard lands on the calendar and shows in the ledger.
- **P3 — Chat parity:** dashboard chat reads/writes the same conversation store as the channel; session-link minting from any channel text. Exit: a conversation started on Telegram continues on the web with zero state loss.
- **P4 — Connections & vault:** one-tap/code/BYO linking flows, vault fill links minted from dashboard, signal-depth indicator. Exit: a new Google connection linked entirely from a minted link.
- **P5 — Loops & jobs UI:** open loops board, scheduled-job pause/edit, skill catalog (Folk-style "what can I hand off"). Exit: capability discovery no longer requires asking.
- **P6 — Team/multi-user (later):** shared policy, per brainstorm.

**Deliberate exclusions (don't over-complicate, per the user):** lore graph visualization, characters/personas, MCP server management in v1, in-dashboard OAuth form hosting, native-app onboarding parity (the app extends this spec later with health data, per the Figma flow).

## 6. Second-pass backlog (on owner's call)

Comparables teardown — Dot (new.computer), Kin (kin.ai), Nomi (nomi.ai), Replika fallback — public/signup surfaces only, same template: surfaces + intentions + auth model. Fold findings into §2 without changing the phased plan unless something contradicts it.

---

### Appendix: evidence pointers
- Folk screenshots: 14 frames in the task workspace (login page, OTP, home, skills, characters, routines, brain/lore, lore graph, lore drill-down, settings, connected apps ×3, personality modal).
- Figma screenshots: ~40 frames covering all four nodes at readable zoom, including full capture of the 297-5981 scroll sequence.
- Instinct answers: main-agent Q&A, grounded vs inference labeled (2026-09-24 16:45 IST).
