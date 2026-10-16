# Waldo website promises, cross-checked against the Audit ledger

Research note for the overnight orchestrator, 12 October 2026. Read-only: nothing was edited, committed, pushed, posted or merged in any repository.

## 0. Pins, sources and method

| Source | Pin | How it was read |
|---|---|---|
| Audit ledger | `docs/planning/WEBSITE_PROMISE_LEDGER_2026-10-10.md` on `origin/audit/ledger-takeover-20261011` @ `dec91152` (PR #1057), committed 2026-10-11T20:07Z | `git show`. Also read at the same SHA: `WEBSITE_PROMISE_PROBES_2026-10-11.md` and `lanes-2026-10-11/lanes/AUDIT-ledger-and-verification.md` |
| Live site | https://heywaldo.in, which redirects to https://www.heywaldo.in/, fetched 2026-10-11T21:41Z | Raw `curl`, not WebFetch, so the evidence is the exact served bytes. Covered the 9 routes, 6 blog posts, sitemap, robots, RSS and 23 JS chunks. Text came from the server-rendered HTML and the Next.js RSC payload. Client-only strings were checked inside the JS chunks |
| Landing source | `Pin4sf/waldo-landing` `origin/main` @ `830bfc2` (the same pin as the ledger) | `git show` only. The local clone is checked out on another branch with uncommitted edits, so it was not used |
| Landing PR #18 | Head `598e94b0`, branch `copy/gmail-reads-what-it-reads`, base `main` @ `830bfc2`. OPEN, mergeable, no CI | `gh pr view` / `gh pr diff`. Two commits: `4fcc6f20` (Gmail copy, 14 files) and `598e94b0` (Telegram lines, 6 files). 16 distinct files in total |

**Routes** [verified]
- `/features` redirects to `/how-it-works`, and `/home` redirects to `/`.
- These return 404: `/pricing`, `/faq`, `/app`, `/security`, `/status`, `/download`, `/ios`, `/privacy-policy`, `/changelog`.
- The sitemap lists `/`, `/how-it-works`, `/connectors`, `/support`, `/waitlist`, `/why-waldo`, `/kennel`, `/blogs` and 6 posts. `/privacy` and `/terms` are linked from the footer.
- `/design-system` serves 200 but is in neither the sitemap nor the nav. It is a visual-system reference page, so it is excluded from the count.

**Live = landing `main`** [verified]
- 870 distinct live text lines were tested with `git grep` against `830bfc2`.
- The 195 misses were sampled, and every sampled miss traced to text composed in JSX (strings split across tags, computed availability lines, entity-encoded apostrophes). No live string was found that `main` lacks.
- #18 is not published:
  - "read and send" is absent from the live JS, which still carries the Telegram "Example messaging service" entry;
  - the live How it works page still says "Talk to it on Telegram and the web today";
  - the live blog still has the metadata paragraph.

**How it works side panels** [verified]
- Only the first panel per group is in the server HTML.
- Every panel body is in the live RSC payload, and all 28 `status` values (`today` / `next` / `planned`) are delivered live.
- The label mapping ("Working today" / "Coming next" / "Planned") is in the live JS. So the labels below are verified live.

**Row IDs**
- The ledger has no row IDs. "Ledger ref" uses section-anchored names taken literally from the ledger: `§4 Health: Recovery`, `§5 Gmail`, `§6a #7` (the 15 numbered proposals under §6a), `§6b`, `§6c`, `§6`, `§7`, `D16`, ruling numbers.
- `WP-nnn` numbers exist only in this report.

**Tags**
- Promise and #18 cells are [verified]: I read them on the live site or in the diff. Anything that is not is tagged [inference].
- "Ledger rung / evidence" cells restate the ledger at `dec91152`. They are verified as ledger text, but I did not re-check the backend.
- "Live=src" is "yes" when the live page and landing `main` carry the same copy.

**Counting rule**
- One row per distinct claim. Carousel clones are deduplicated.
- Illustrative fixture scenes count as one row per capability they imply.
- The 27 profession routines are one row (WP-042), itemised in Appendix A.
- The 50-tool status list is one row (WP-076), itemised in Appendix B.

## 1. Bottom line

1. **There are 120 distinct promises across 16 user-facing areas.**
   - 94 map to a ledger row or ledger paragraph:
     - all 37 §4 rows;
     - the §5 connector rows;
     - all 15 §6a items;
     - the §6b and §6c lines.
   - 26 are NOT IN LEDGER.
2. **Live site = landing `main` @ `830bfc2` = the ledger's landing pin** [verified]. The ledger's pin is still current.
3. **Of 83 key phrases, one per ledger row, 82 are live.** The one miss is the `trust-panels.tsx:191` Gmail line, which the ledger itself already marks as unrendered [verified]. No ledger row's copy has disappeared from the site.
4. **The ledger's #18 pin is stale.**
   - The PR table records #18 "open at `4fcc6f20`, 14 files". The head is `598e94b0`, with 16 files.
   - The second commit is the D20 Telegram change, which the ledger records only as [reported] in §6b.
5. **Big promises the ledger has no row for:**
   - pricing: "Free while it's in beta";
   - waitlist access order;
   - "Android follows";
   - the terms-page gate: app launch and account access "should wait" for final terms and privacy policy;
   - no verified support contact;
   - lock-screen delivery of all six day moments;
   - a booked car;
   - Kennel-page claims that "Waldo for iPhone" is "Coming soon".
6. **The site contradicts itself in several places** (§5 below):
   - wearables "all work" vs "are coming";
   - "Undo it in one tap" vs two blog posts disclaiming a blanket undo;
   - the constellation shown on the homepage vs the blog's "next year's problem";
   - Telegram "Working today" vs the test-only ruling;
   - "write to us" vs no published contact.
7. **#18 fixes the Gmail trust-window label, the blog paragraph and the How it works Telegram line, and introduces two new conflicts:**
   - "Talk to it in the Waldo app" (present tense) vs the FAQ "iPhone ... come next";
   - "WhatsApp comes later" vs the connectors page "WhatsApp ... next".

   It also deletes the "iPhone notifications are coming next" promise. It leaves these unchanged:
   - "Gmail and Telegram work today";
   - the eight Telegram-delivered routines;
   - "Waldo batches your inbox";
   - the key-window Gmail tag;
   - the Calendar and Tasks "read only" tags.

## 2. Areas and counts

| Area | Rows | NOT IN LEDGER |
|---|---|---|
| A. Onboarding and sign-in | 4 (WP-001–004) | 4 |
| B. Chat | 10 (WP-005–014) | 1 |
| C. Memory and continuity | 8 (WP-015–022) | 3 |
| D. Proactive: Brief, day moments, heartbeat/Patrol, nightly | 17 (WP-023–039) | 2 |
| E. Reminders, routines and schedule | 4 (WP-040–043) | 0 |
| F. Approvals, actions and autonomy | 8 (WP-044–051) | 1 |
| G. Gmail | 7 (WP-052–058) | 0 |
| H. Calendar | 4 (WP-059–062) | 0 |
| I. Tasks | 3 (WP-063–065) | 0 |
| J. Other connectors and agents | 14 (WP-066–079) | 2 |
| K. Health: consent, ingest, scores | 14 (WP-080–093) | 1 |
| L. Privacy, deletion and data | 13 (WP-094–106) | 6 |
| M. Channels: app, Telegram, WhatsApp, iMessage, email | 6 (WP-107–112) | 1 |
| N. Push notifications | 2 (WP-113–114) | 1 |
| O. Pricing and access | 4 (WP-115–118) | 3 |
| P. Kennel (Ashish's product; the Waldo-related claims) | 2 (WP-119–120) | 1 |
| **Total** | **120** | **26** |

## 3. Promise table, by area

Columns:
- **Ledger ref**: the ledger section, or NOT IN LEDGER with the nearest anchor.
- **Page · section**: where the promise appears on the live site.
- **Promise**: a paraphrase, with key words in quotes of 15 words or fewer.
- **Ledger rung / evidence / probe**: the ledger's rung, evidence and probe at `dec91152`.
- **#18**: what PR #18 changes for this row.
- **Live=src**: whether the live site and landing `main` agree.

### A. Onboarding and sign-in

No live page promises sign-in, sign-up, invites or account creation. The only entry point is the waitlist ("Let Waldo in →") [verified by text search of every rendered page].

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-001 | NOT IN LEDGER (nearest §5 "Google connect from the app (G1)", §5 Kennel row) | Home · FAQ "Do I have to set everything up?" | Nothing to set up. Context follows you into other tools. "No. Connect what you already use." "Waldo brings your context into every tool it works with" | G1: deployed (unexercised). App Connections screen merged (app #55); connect, consent and return not run; probe Q5. Outbound context to other tools has no row [inference: nearest is §5 Kennel, rung none] | none | yes |
| WP-002 | NOT IN LEDGER (nearest §13 "In-app sign-up (O1)") | Blog "What a CLI agent actually is" | Setup needs no config. "There is no config file, no API key, and no JSON to repair." | §13: backend deployed; no invited address has signed up from the app; probe Q1 | none | yes |
| WP-003 | NOT IN LEDGER (enabler row §5 G1) | Connectors · hero | One connection, then Waldo acts. "Connect them once, and Waldo reads what each one knows about your day" | §5 G1: deployed (unexercised). The "connected" notice still goes to Telegram; app-only owners get nothing [ledger inference] | none | yes |
| WP-004 | NOT IN LEDGER | Connectors · key window, promise 1 | Explicit approval per tool. "You approve every tool. Nothing connects on its own." | No row [inference: holds for Google by OAuth consent]. The illustrated "Connect Oura? ... Allow" prompt is for a connector marked "next" | none | yes |

### B. Chat

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-005 | NOT IN LEDGER (core chat; nearest §13 "Main chat", §4 Talk: Full history) | How it works · "Talk to Waldo" header | Ask anything, any time; Waldo also starts conversations. "Waldo speaks first, but ask it anything, any time" | No row for send/reply itself. §13: real server data on app main; a Simulator run got 503 on main-chat history (app #68); #1068 logs a fixed code. [verified, commit timestamps] #1074 ("skip invalid rows" in the main-chat read) merged to `beta-mvp` at 21:08Z, after `dec91152` (20:07Z); deploy state not checked. Probe Q2 | none | yes |
| WP-006 | §4 Talk: Threads | How it works · panel "Working today" | Separate threads, each with its own context. "Keep each part of life in its own conversation" | Source (contract only). The C1 contract is deployed (#1067) but routes answer 404 until L2 W2–W4. Ruling 21: threads in app and console only. Probe "Threads" | none | yes |
| WP-007 | §4 Talk: Follow up on anything | How it works · panel "Coming next" | Follow-up thread from any Brief or Fetch. "Tap “Tell me more” on any Brief or Fetch" | Deployed (Telegram reply-quote only). The app send has no anchor. Probe "Follow up" | none | yes |
| WP-008 | §4 Talk: Quick replies | How it works · panel "Working today" | Suggested one-tap replies. "Answer Waldo in one tap. Most replies don’t need typing." | Source (contract only); no producer. Probe "Quick replies" | none | yes |
| WP-009 | §4 Talk: Charts in replies | How it works · panel "Working today" | Inline charts in answers. "the answer brings a small chart with it, right there in the message" | Source (contract only); no producer. Probe "Charts" | none | yes |
| WP-010 | §4 Talk: Full history | How it works · panel "Working today" | Full scrollable history, with reasons. "Every conversation is kept and scrollable, including the reasons behind each move." | Proven (Simulator): `before:` cursor, 20 per page. Machine prompts render as the owner's bubbles. No reason beside each move. App chat is not in the episodes index (§2). Probe "Full history" | none | yes |
| WP-011 | §4 Talk: Thumbs up / down | How it works · panel "Working today" | Rate any message; ratings shape later messages. "Rate any message. Waldo learns what’s worth telling you" | Deployed (Telegram update cards only). Ratings contract merged (#1067); routes 404; no app part. Probe "Thumbs" | none | yes |
| WP-012 | §6a #3 | Home · See card "Chat"; Home "Different hats" subtitle | Shows its work and sources per fact. "what he read, what he compared, and where each fact came from" | Source (receipts). Proposal: L3 G6 provenance part, L2 receipts, L4 `EvidenceRow` | none | yes |
| WP-013 | §6a #5 | Home · "Different hats" scene captions | Photos, voice notes, clips, screenshots, screen recordings and slides as inputs. "sending Waldo a photo, a voice note and a clip in WhatsApp" | None: speech in only; app send is text only and attachments throw (§2). Proposal: a later wave with an ADR first | none | yes |
| WP-014 | §4 Later: Voice + §6a #15 | How it works · panel "Planned"; Home See replies show a speak icon | Speak and hear replies. "Ask out loud, and hear the answer back." | Deployed (speech in on Telegram and WhatsApp). No TTS; the voice part has no producer. Unassigned by ruling (deferred). Probe "Voice" | none | yes |

### C. Memory and continuity

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-015 | §4 Rules: Say it once | How it works · panel "Working today". Also Home close card "Never makes you explain twice" and Home trust window beat 4, "He keeps a note. You can correct it." | Remembers people, preferences and corrections; everything is listed and editable. "Tell Waldo something once, and it sticks." "Everything it knows about you is listed in one place" | Deployed (chat and console): `remember` with `replaces_id`; forget by id. `update_memory` has no handler. No app memory view (approved parity item 2: no contract, host or screen). Probe "Say it once" | none | yes |
| WP-016 | NOT IN LEDGER (nearest §2 rule 3 "one state across surfaces"; §2 defect "App chat is not in the episodes index") | Home · "You can't keep up" carousel | Memory spans all chats and surfaces. "Waldo remembers across everything" | §2: app history is not indexed, so `search_episodes` and nightly consolidation cannot see app chat | none | yes |
| WP-017 | §4 Day: Patterns + D11 | How it works · panel "Coming next". Home See card "Spots and constellations" and Home "Longer he learns" map | Spots join into named patterns and constellations. "Spots that keep recurring join into a constellation" | Deployed (constellations, promoted nightly). `view=constellation` deployed (#1065); app renderer (#60) not wired. Numeric deltas need the §7 rule change. Probe "Patterns", Q9 | none | yes |
| WP-018 | §6c | Home · "Longer he learns, smarter he gets." | Deep self-knowledge over months. "Months in, Waldo gets to know you, more than you do." | Listed as a weak promise; no rung | none | yes |
| WP-019 | §6a #13 | Home · memory map and See spot labels | Spots from caffeine, meals, screen time and tool switches, e.g. "Coffee before food", "Late screen, light sleep", "Eleven tool switches" | None: no such inputs exist (HealthKit has dietary caffeine; screen time has no source). Owner decides scope | none | yes |
| WP-020 | NOT IN LEDGER (contradicts WP-017 and D11) | Blog "You are stuck in a loop and your AI cannot tell" | Says the Constellation does not exist yet. "Building this is next year's problem, not this month's" | No row. D11 puts constellations in the app this push | none | yes |
| WP-021 | NOT IN LEDGER (nearest WP-015, WP-011) | Home · FAQ "What if Waldo gets it wrong?" | Learns from corrections, mostly in the first week. "Waldo learns from every correction, and the first week is mostly it learning you." | No row | none | yes |
| WP-022 | §6a #11 | Home · close card "Shows how far you’ve come." | A long-run record. "Keeps the honest record: days, months, years" | None. Proposal: L3 G16 history range, with L1 because health retention caps how far back it can go | none | yes |

### D. Proactive: the Brief, day moments, heartbeat/Patrol, nightly

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-023 | §4 Day: The Brief | How it works · "Waldo through a day", 7:02. Blogs describe it | A morning Brief that has already adjusted the day. "Rough night, about 5h 40m. Nudged your 9am to 10:30." | Deployed (Telegram); app path untested. Cards arm only via `timezone.set` → nightly. D12 is ruled; #1066 (arming once the zone is confirmed) is open. The card prompt has no health source; no push. Probe "The Brief", Q3/Q4 | none | yes |
| WP-024 | §6a #2 + §6c | Home · See card "Daily brief"; the same brief scene, without the headline, renders on `/waitlist` | One brief that updates through the day, with yes/no decisions and an outbox held until you send. "One brief that follows your day." | None: one 08:00 card. `cards[].latest` contract (#1059) has no producer | none | yes |
| WP-025 | §6c | Home close card "Plans your day... Done before you're up"; How it works "Done before you’re up."; Connectors hero "Done before you were up" (moves a meeting and three tasks) | Overnight replanning with real moves you never see. "Waldo reads your night, then rebuilds the day around it." | No row. Depends on Patrol grants (none) and Three levels (enum only) | none | yes |
| WP-026 | §4 Day: The Window | How it works · day moment 7:15 | Blocks your sharpest stretch. "10:30–12:30 is your sharpest stretch. Blocked it." | None. Ruling 5 / §7: Form-driven; blocks only under a calendar `auto` grant. Probe "The Window" | none | yes |
| WP-027 | §4 Day: Prep | How it works · day moment 1:25 | Prep 35 minutes before a big meeting, with last time's open items. "Board call in 35 minutes. You're running lower than usual." | Deployed (Telegram, staging only; `CALENDAR_GROUNDED_PREP` 0 in production). 40-minute lead; exits on any non-Telegram channel; no open items. Probe "Prep" | none | yes |
| WP-028 | §4 Day: The Heads-Up | How it works · day moment 2:40 | Pattern-driven warning that moves a meeting. "This Tuesday is shaping up like the last three. Moved your 4pm" | Deployed as a 14:00 check-in card, not pattern-driven. Probe "The Heads-Up" | none | yes |
| WP-029 | §4 Day: The Close | How it works · day moment 6:48 | Evening wrap with counts and tomorrow. "Today: 3 things moved, 1 protected. Tomorrow looks lighter." | Deployed (Telegram). "Moved / protected" counts need Waldo's own moves. Probe "The Close" | none | yes |
| WP-030 | §4 Day: The Adjustment | How it works · day moment Friday 4:10 | Weekly rebalancing. "22 hours of meetings this week. Friday afternoon cleared." | None. Probe "The Adjustment" | none | yes |
| WP-031 | §6a #1 | How it works · Your schedule, Training, Follow up and Full history panels | The Fetch as its own moment, with its own switch. "Turn The Brief, The Fetch or The Close on or off, one by one." | None: `schedules` has no Fetch key. §7: the Fetch re-enters as a launch moment | none | yes |
| WP-032 | §4 Day: Fixed first, mentioned after (The Patrol) | How it works · panel "Working today" | Round-the-clock fixes within limits, reported after. "The Patrol runs around the clock, overnight included." | Deployed (list only: no model call, no effect). No standing grant (#932 unmerged); every loop L0. Probe "Fixed first" | none | yes |
| WP-033 | §6c / §14 A1 | Home · See card "Overnight" | Handles what it can overnight. "Overnight he handles what he can." | Covered by WP-032 (Patrol) and WP-113 (push) gaps | none | yes |
| WP-034 | §4 Day: Your best hours | How it works · panel "Coming next" (but the hats scenes and routines show it as current) | Learns and protects your sharpest hours. "Waldo learns when you’re sharpest, then keeps that time for the work" | None | none | yes |
| WP-035 | §4 Day: Fewer pings | How it works · panel "Coming next"; Home "speaks up when it matters" | Batches email into two blocks; sets Slack to Focus. "Waldo can batch email into two blocks a day, and set Slack to Focus" | None: fixed volume and quiet-hour gates only. Ruling 5: interruption judgment, no mail holding. Probe "Fewer pings" | none | yes |
| WP-036 | §4 Later: Tomorrow, today | How it works · panel "Planned" | Tomorrow's outlook the night before. "Find out how tomorrow will feel tonight" | Deployed (the Close's calendar preview); no forecast. Probe "Tomorrow, today" | none | yes |
| WP-037 | §6a #10 | Home · FAQ "different from ChatGPT or Claude?" | Outcome-driven; reports back when done. "works toward an outcome ... and comes back when it's done" | Deployed (Telegram). L2 routes Outcome closure to the app in P3a | none | yes |
| WP-038 | NOT IN LEDGER (D19 open) | Blog "Your health app is a mirror" | Afternoon stress nudge. "If stress keeps climbing in the afternoon, Waldo says so" | D19 (open): health-driven nudges wait on the owner confirming launch scope and grant | none | yes |
| WP-039 | NOT IN LEDGER (nearest D3 cap, WP-035) | Blogs "stuck in a loop" and "mirror" | Quiet by default; speaks only when there is something new. "Most days it has nothing new to say and says nothing." | D3: #915 default cap of 6 a day with a 30-minute cooldown until K (not started) | none | yes |

### E. Reminders, routines and schedule

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-040 | §4 Rules: Your schedule | How it works · panel "Working today". The same panel says quiet hours are "Coming next" | Set wake time, evening check-in, and switch each message on or off. "Pick when it speaks, and which messages you get." | Proven (Simulator; app Schedule screen). The app can set time zone and proactivity only. One `daily_brief` switch covers three cards. Quiet hours hold cards, heartbeat and Prep, not reminders or standing orders. The site understates quiet hours (§6). Probe "Your schedule" | none | yes |
| WP-041 | §4 Later: Your own routines | How it works · panel "Planned" | Recurring routines in your own words. "The things you ask for every week, written once. Waldo runs them on schedule." | Deployed (reminders and standing orders). App-only owners' reminders reach the app sink (#1034), shown in tests only; no routines UI. Probe "Your own routines" | none | yes |
| WP-042 | §6a #8 | Connectors · "Pick your job. The tools follow." (9 professions × 3 routines; Appendix A) | Profession presets of tools and routines. "Waldo starts with the tools and routines people like you rely on" | None. Proposal: L2 (standing orders) with console presets later; owner decides scope. 3 of 27 routines use only "Working today" tools; 8 deliver via Telegram [verified, Appendix A] | Unrendered comment only; Telegram scenes unchanged | yes |
| WP-043 | §6a #4 | Home · See card "Plan" | Watch-battery reminder. "Forerunner is at 18%. A charge reminder at 9pm" | None: no battery signal. The ledger proposes dropping it from scope | none | yes |

### F. Approvals, actions and autonomy

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-044 | §4 Rules: Always comes back to you | How it works · panel "Working today" | A protected list always asks first, even on "Just do it". "Whatever level you’ve set, some things always come to you first." | Deployed (routes). App screen merged (#54): Simulator list read; decisions against fixtures only. Console approves calendar only. WhatsApp approves by `a:<id>` text. No protected-action list; `secretKeys` never set. Probe "Always comes back", Q6 | none | yes |
| WP-045 | §4 Rules: Always comes back + §5 Gmail | Home · See card "To send"; trust window beats 2–3; routine "Nothing goes out until you send it" | Drafts are held; you see recipient and every word before sending. "You see who it goes to and every word before you send it." | Gmail send behind approval with Message-ID readback. App review shows up to 32,000 chars; Telegram up to 3,800. No real decision from the app on staging | none | yes |
| WP-046 | §4 Rules: Three levels, per area | How it works · panel "Working today"; Home "Your rules" | Tell me / Ask me / Just do it, per area. "Tell me, Ask me or Just do it, set separately for each area." | None (an enum only; every policy L0; no runtime consumer; #932 unmerged). Probe "Three levels" | none | yes |
| WP-047 | §6a #9 | Home · "Everyone’s day has its own rhythm" (three-week calendar scene) | Autonomy grows: asks, then moves with Undo, then moves silently. "Moved Team Sync to Thursday, like last week." | Source (enum). Proposal: L2 consumer, L3 G12, L4 Settings | none | yes |
| WP-048 | §4 Rules: The activity log | How it works · panel "Working today" | Every action logged with its reason and what was left alone. "Every move Waldo makes is written down with its reason" | Deployed (`controls?view=activity` served). No reasons, no "left alone"; the app Patrol screen is a placeholder. Probe "The activity log" | none | yes |
| WP-049 | §6 + §7 (undo) | How it works · "Your rules" header; Home FAQ | One-tap undo of any move. "Every move is logged. One tap takes it back." "Undo it in one tap." | Undo is calendar only (10 minutes). §7: per-action reversibility shown in receipts. Contradicted on the site by two blog posts (WP-104, §5) | none | yes |
| WP-050 | NOT IN LEDGER (§11 lists booking as outside website scope) | Home · "Different hats", Founders scene | Books a car. "a car’s booked for 9:40pm" | Ruling 14 / D10: no purchases until the owner sets spend limits. No booking capability is listed | none | yes |
| WP-051 | §6a #4 | Home · See card "Plan" (WhatsApp chip) | Messages a third party for you. "Text Mrs. Chen: eggs and toast by 8, lunch at 12:30" | None. WhatsApp is Ashish's (D7) | none | yes |

### G. Gmail

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-052 | §5 Gmail | Connectors · inbox line and status list | Gmail works today. "Gmail and Telegram work today." | Deployed: Primary read, search, threads 20 per page, bodies up to 32,000 chars, draft, approved send with readback. No archive, label or attachments; #919 unmerged. Probe "Gmail" | none (the line is computed from the untouched `connector-tools.ts`) | yes |
| WP-053 | §6b (conflicts with ruling 5) + §4 Fewer pings | Connectors · "Your inbox and messages"; key window Gmail "Changes: Batches and flags" | Inbox batching and quieting. "Waldo batches your inbox, goes quiet when it's too much, and flags what needs you." | No capability. Ruling 5: no mail holding | none (still rendered after merge) | yes |
| WP-054 | §6b + D16 | Home · trust window beat 1, and the Gmail tag "read only" | Gmail presented as read-only. "This example starts with read-only access." | The backend reads subjects, snippets and bodies up to 32,000 chars, and sends after approval. Scopes `gmail.readonly`, `gmail.send`, `gmail.compose` (restricted) | Beat 1 becomes "He reads first. Changes wait for you."; the Gmail tag becomes "read and send" | yes (pre-#18 live) |
| WP-055 | §6b + D16 | Blog "Nobody wants to explain their job to a computer" | Says message content is not read. "communication connectors use metadata, not the contents of your private messages" | Same as WP-054 | Rewritten: reads messages, subjects and text included; sends nothing until approved; `updated: 2026-10-12` | yes (pre-#18 live) |
| WP-056 | §6b | Connectors · key window Gmail "As you granted"; promise 3 | Access depends on your grants. "Email access depends on the permissions you grant." | §6b: stays true, but the per-tool tag must show Gmail as read and send | none (`key-window.tsx` untouched) | yes |
| WP-057 | §6a #7 + §5 Gmail gap "multi-account fan-out" | Connectors · "Work Gmail. Personal Gmail. Waldo knows which." | Several accounts per tool, kept separate, with work and personal rules. "Connect more than one account for the same tool, and Waldo keeps them straight." "Personal. Never touched during work hours." | None. The rules conflict with ruling 5; multi-account fan-out is missing | none | yes |
| WP-058 | §5 Gmail (draft) | Home · Sales scene; Connectors routines (Friday update, follow-ups) | Follow-ups drafted in Gmail. "The follow-up is drafted in Gmail before you hang up." | Draft deployed. The Granola and HubSpot inputs have no rung | none | yes |

### H. Calendar

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-059 | §5 Google Calendar | Connectors · "Your calendar" | Reads meetings; moves, blocks and protects time. "then moves, blocks and protects time, within your limits." "Google Calendar works today." | Deployed: reads any calendar (one named calendar per call). Writes are hard-wired to primary, approval-gated, with a 10-minute undo and readback. No attendee emails or invites. Probe "Google Calendar", Q6 | none | yes |
| WP-060 | §6b (Calendar and Tasks labels; owner decision with Suyash) | Home · trust window "Calendar read only"; key window "Read only" / "Read and change" | Calendar starts read-only; writes need a separate grant. "Moving an event also needs calendar write access and your approval." | The backend requests `calendar.events` and `tasks` (write-capable) up front | Beat 1 becomes "Sending an email or moving an event waits for your approval"; the Calendar and Tasks tags stay "read only" | yes (pre-#18 live) |
| WP-061 | §6a #14 | Connectors · "Weather and travel" scene | Weather moves an event. "34° by lunch, so your run moved to 7am, before the heat." | Source (#1043 not registered); D5 | none | yes |
| WP-062 | §5 Later | Connectors · calendar availability line | "Outlook is next. Apple Calendar and Calendly are planned." | None or contract only | none | yes |

### I. Tasks

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-063 | §5 Google Tasks + §6a #14 ("breaks big tasks down") | Connectors · "Your tasks" | Reorders by deadline and energy; breaks big tasks down. "reorders by deadline and energy and breaks big tasks down." "Google Tasks works today." | Deployed: reads all lists; create, edit, complete and reopen after approval; no delete; dead `write_task` / `update_task` names. Probe "Google Tasks" | none | yes |
| WP-064 | §4 Day: The right task, at the right time | How it works · panel "Working today" | Hard task in your sharpest hour; due-today stays put. "The hardest thing goes to your sharpest hour" | Deployed (reads and approved writes). Right-time ordering and the energy input are missing. Probe "The right task" | none | yes |
| WP-065 | §5 Later | Connectors · tasks availability line | "Todoist, Microsoft To Do and Linear are next. Asana is planned." | None | none | yes |

### J. Other connectors and agents

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-066 | §5 Apple Watch | Connectors · watch line; status list | Apple Watch works today. "Apple Watch and Health Connect work today." | Deployed (Simulator). The Watch app has no data path; the console says "Not built yet". Probe "Apple Watch" | none | yes |
| WP-067 | §5 Health Connect | Connectors · same line; status "Working today" | Health Connect works today | Deployed (backend only); no Android client (ruling 9) | none | yes |
| WP-068 | §5 Galaxy Watch | Connectors · status "Coming next" | Galaxy Watch next | Deployed (backend only); no Android client; Samsung partner approval [verify] | none | yes |
| WP-069 | §5 Later + §6 + §6c | Home · FAQ "Do I need a smartwatch?"; also the Waitlist FAQ, Connectors and the key-window Oura prompt | All major wearables work. "Apple Watch, Oura, WHOOP, Garmin and Fitbit all work." | Source (enums only; Fitbit not even that). The site contradicts itself: the waitlist says "are coming", the connectors page says "are next" | none | yes |
| WP-070 | §5 Weather, Location + §4 Health: Weather and daylight | Connectors · weather line | Weather and location with no setup. "Weather and Location work today. Nothing to connect." | Source (branch; #1043 not registered). D5: coarse location from the app with OS permission [inference: an OS prompt is some setup] | none | yes |
| WP-071 | §5 Codex, Claude Code, Cursor, OpenCode, Pi (via Kennel) | Connectors · "Your agents, on the same team"; status list | Five coding agents work today via Kennel. "Waldo gives them your context and checks what they deliver." "Working today, in Kennel’s open beta." | None (`DeterministicFakeExecutionEnvironment`; no Kennel client). Ashish owns Kennel; the backend seam is unassigned. Probe "Kennel" | none | yes |
| WP-072 | §6 ("Works with every agent", "all models") | Home · close card "Works with all models / agents."; Home carousel "works with every agent" | Runs any model or agent and returns one outcome. "Waldo runs them all and hands you back one outcome." | §6: the copy should state tested coverage | none | yes |
| WP-073 | §6 ("200+ tools") | How it works · Connectors teaser; Connectors request section | Large catalogue. "Growing to 200+ tools across 27 categories." | Reference only | none | yes |
| WP-074 | §5 Google Drive (the site understates it) + §5 Later | Connectors · "Your notes and files" | Reads documents you point to and assembles them before you need them. "Waldo reads the documents you point it to" (Drive marked "planned") | Drive deployed on staging only (8,192-byte cap; production off). Notion, Dropbox and Granola: none. Probe "Google Drive" | none | yes |
| WP-075 | §5 Later (GitHub inbound only) | Connectors · "Your work tools" | Reviews, comments and pipeline batched into focus time. "Waldo reads reviews, comments and pipeline pressure, then batches them into your focus time" | GitHub deployed (inbound push and PR events only). Linear, Figma, HubSpot and Jira: none | none | yes |
| WP-076 | §5 (all rows) | Connectors · "Don’t see yours? Tell us." status list (Appendix B) | 13 today, 13 next, 24 planned. "13 tools work today and 13 are coming next" | Of the 13 marked "today", per §5: Telegram is proven (development surface only). Calendar, Gmail and Tasks are deployed. Apple Watch is deployed (Simulator). Health Connect is backend only. Weather and Location are source. The five coding agents are none | none | yes |
| WP-077 | NOT IN LEDGER | Connectors · request form | Requests drive the roadmap. "The most-asked get built first." | No row. The form sends email, tool and note to Loops as an event (`actions/request-connector.ts`) [verified]; the privacy page mentions only the waitlist going to Loops | none | yes |
| WP-078 | NOT IN LEDGER (§6a #6 covers only places to talk) | Home · "Different hats" scenes and captions | Reads Granola, GitHub, Vercel, Linear, Calendly, Stripe, Notion, HubSpot and Oura as if connected. "Waldo reads your pipeline in HubSpot, your calendar and your best hours" | No row. The site's own status list marks these "next" or "planned"; the backend has only GitHub inbound | none | yes |
| WP-079 | §4 Later: Other agents ask Waldo | How it works · panel "Planned"; Connectors "Soon, your agents will be able to ask Waldo" | Other agents check your state before acting. "Your other agents will be able to ask Waldo how you’re doing" | Source (contract only; `trusted-coordination` export with no consumer). Probe "Other agents ask Waldo" | none | yes |

### K. Health: consent, ingest, scores

The live site makes no health-consent or withdrawal promise [verified: no "consent" or "withdraw" anywhere in the rendered text]. Ruling 11 (two separate agreements) and the "Consent withdraw" probe are internal. The site never mentions health in staging traces (§8).

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-080 | §4 Health: Recovery | How it works · Health carousel; Connectors watch line | Morning Recovery score. "Set each morning, from Sleep, HRV and Resting State." | Deployed (Simulator): `recovery.candidate.v1`, `candidate_unaccepted`. Shown on Health Stats and Home (#53, #57); console says "Not built yet". Chat needs both consents (`model_processing` is off on the owner's staging account). Probe "Recovery", Q8 | none | yes |
| WP-081 | §4 Health: Form | How it works · Health carousel | Live intraday Form. "Live all day, from Circadian, Motion and Stress." | Deployed (Simulator, `stale_inputs`). The app uploads in the foreground only; the fix is background delivery or relaxing the 6-hour fence. Probes "Form", "Background delivery" | none | yes |
| WP-082 | §4 Health: Weight | How it works · Health carousel | Live day-load score. "Live all day. Higher means heavier: meetings, messages, tasks and Load." | Deployed but always unavailable (`demand: null` → `calendar_demand_unavailable`). Probe "Weight" | none | yes |
| WP-083 | §4 Health: Sleep debt | How it works · panel "Working today" | 14-day weighted sleep debt shapes plans. "a running count of the sleep you’ve missed, weighted over the last 14 days" | Merged (computed, not stored; the write fence rejects `sleep_debt`; no contract field). Probe "Sleep debt" | none | yes |
| WP-084 | §4 Health: Quiet flags | How it works · panel "Working today" | SpO2, breathing rate and wrist temperature checked against your usual; gentle flags. "When one drifts, you get a gentle flag. Never an alarm" | Source (SpO2 and respiratory rate ingested but unused; no wrist temperature; no deviation logic). Probe "Quiet flags" | none | yes |
| WP-085 | §4 Health: Training | How it works · panel "Working today"; Health header | Workouts planned with meetings; tells exercise from stress. "a racing heart on a run from a racing heart in a meeting" | Source (partial: workouts only exclude Form stress hours; manual `log_workout`). §7 amends the stress rules. Probe "Training" | none | yes |
| WP-086 | §4 Health: Weather and daylight | How it works · panel "Working today" | Heat, UV, air and daylight in the plan. "Heat, UV and air quality where you are, plus how much daylight" | Daylight deployed (ingest; Form input). Weather is source (#1043). Probe "Weather and daylight" | none | yes |
| WP-087 | §4 Health: Your history | How it works · panel "Working today" | A 7/30/90-day dot history with a day view. "Look back 7, 30 or 90 days. Each day is a dot" | None (no range route; the producer writes only yesterday and today). Proposal: L3 G16 + L1 + L4. Probe "Your history" | none | yes |
| WP-088 | §4 Health: Bring your past | How it works · panel "Working today" | Apple Health import, so your usual is known from day one. "Import your Apple Health history, and Waldo has your usual from the first morning." | Deployed (Simulator). 90-day raw window; the app sends 30 days in the foreground; no background delivery. Probe "Bring your past" (physical iPhone) | none | yes |
| WP-089 | §4 Day: The Slope | How it works · panel "Coming next" | Six measures against four weeks ago. "The Slope sets today against four weeks ago." | None. Proposal: L1 + L3 G19 + L4 | none | yes |
| WP-090 | §6c | Home · carousel | Uses all your health data daily. "Waldo reads all of it, every day, and turns it into a plan." | Weak promise. Needs background delivery and backfill (§14 A3) | none | yes |
| WP-091 | §6c | Home · carousel | Knows a rough day from an easy one. "tells a rough day from an easy one and plans around it" | Weak promise | none | yes |
| WP-092 | §7 (medical-claim boundary; partial) | How it works · Health note; Home close card; Quiet flags panel | Non-diagnostic, not a medical device. "It isn't a medical device, and it doesn't diagnose anything." "Context, never a diagnosis." | A behavioural constraint. §7 says "never a diagnosis" for Quiet flags; there is no general row | none | yes |
| WP-093 | NOT IN LEDGER (nearest §4 Training, §6a #4) | Home · See card "Plan" ("A lighter run. For a reason.") | Training advice from sleep and recovery, then cross-tool effects after one yes. "he weighs your sleep, recovery and yesterday’s hills and suggests an easier run" | No row. Reads recovery "from WHOOP", a connector marked "next" | none | yes |

### L. Privacy, deletion and data

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-094 | §4 Rules: Yours, always (labelled "Working today"; body says "Under review") | How it works · panel | Export everything; delete the account. "Export everything any time. Delete your account, and it’s gone." | Delete is deployed (console and app route). The app Account screen (#56) was run only against an older Worker. `delete_owner` covers Vault, connections, sessions, health, the Auth user, the invite email and the push token; R2 is purged first (#1069, D18). The RunLoopDO root is left behind; backups, provider logs and traces are not certified; the console copy overclaims. Export: none. Probes "Yours, always", "Export", Q10 | none | yes |
| WP-095 | §6 + §6a #12 + §7 | Connectors · key window, promise 4 | Disconnect also removes what was learned. "One tap to disconnect. What Waldo learned from that tool goes with it." | None (no purge lineage; no per-tool read-only switch). §7: lineage purge belongs in the rights work | none | yes |
| WP-096 | §6b ("not a conflict") | Connectors · key window, promise 2 | Read-only by default; each tool shows its write access. "Read only, unless you say so." | Matches approval-gated calendar writes and Gmail send | none | yes |
| WP-097 | §6b | Connectors · key window, promise 3; Fewer pings panel; Privacy page | Data practices disclosed as still under review. "App data details are under review." | The final policy must name Gmail reading, approved sends, processors, trace capture and retention | none | yes |
| WP-098 | §6b (processors) | Home · trust window beat 5, "Where it goes" | Example processors: Supabase, Anthropic, Telegram. "Example model provider. Final provider list is pending." | Owner chat routes to the OpenAI provider (roster `gpt-6-luna`). Staging captures trace text for opted-in testers (§8) | Telegram entry removed; Anthropic stays | yes (pre-#18 live) |
| WP-099 | §6c | Home · hero | Transparency. "A personal assistant that meets all needs for life, work and health; with nothing hidden." | Weak promise | none | yes |
| WP-100 | NOT IN LEDGER (nearest §4 Activity log; §5 G1 Connections screen) | Home · carousel "Text agents run where you can’t see." | Shows access and actions; lets you revoke. "shows what he can access and what he does, and lets you take access back" | No row | none | yes |
| WP-101 | §6b (privacy page) | Privacy page | Not a final policy; don't connect personal accounts yet. "This page is not a final privacy policy." | Google restricted scopes need a published policy URL and a Limited Use statement. Publication is deferred (ruling 6, D3) | none | yes |
| WP-102 | NOT IN LEDGER | Terms page | Launch and account access gated on final terms. "The app launch and account access should wait for the final terms and privacy policy." | No row. The alpha cohort of 5–10 (ruling 18) is getting accounts | none | yes |
| WP-103 | NOT IN LEDGER | Support page | No verified support or security contact. "A verified Waldo support and security contact has not been published here yet." | No row. Conflicts with the waitlist "Write to us from the same address" | none | yes |
| WP-104 | NOT IN LEDGER | Blog "What we actually do with your data" | Disclaims the guarantees. "No encryption, on-device storage, training exclusion or universal undo guarantee is made here." | No row. Contradicts WP-049 | none | yes |
| WP-105 | NOT IN LEDGER (website only) | All pages · cookie banner | "No tracking cookies here. We only remember that you closed this." | No row (site behaviour, not backend). [verified] No common analytics or tag script (gtag, GTM, Vercel insights, Plausible, PostHog, Clarity, Hotjar, Segment, Mixpanel, Umami) appears in the fetched pages or the 23 JS chunks | none | yes |
| WP-106 | NOT IN LEDGER (website only) | Waitlist; Privacy page | Waitlist email goes to Loops; unsubscribe in every email. "Your email goes to Loops for waitlist updates." "Every email we send has an unsubscribe link." | No row | none | yes |

### M. Channels: app, Telegram, WhatsApp, iMessage, email

No live page offers email as a channel for talking to Waldo. No live page names "the Waldo app" as available today; #18 would be the first [verified by full read of the rendered text].

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-107 | §6 + §6b / D20 + §5 Telegram | How it works · "Talk to Waldo" body | Today Telegram and web; next WhatsApp and iPhone notifications. "Talk to it on Telegram and the web today." "WhatsApp and iPhone notifications are coming next." | Telegram is proven as a development surface only; ruling 12 makes it test-only. No ledger row for a web chat surface [inference: the console is web, but chat there is unverified] | Becomes "Talk to it in the Waldo app or on the web. WhatsApp comes later." That drops the iPhone-notification promise and moves WhatsApp from next to later | yes (pre-#18 live) |
| WP-108 | §5 Telegram + §6b / D20 | Connectors · status list "Working today: ... Telegram", inbox line; 8 of 27 routines deliver via Telegram | Telegram offered as a working channel. "Gmail and Telegram work today." | D20: the owner said change the Telegram lines; #18 defers these to an illustration follow-up | none (still rendered after merge) | yes |
| WP-109 | §5 Later: WhatsApp | Connectors · "Slack and WhatsApp are next."; status list; Home Founders scene in WhatsApp | WhatsApp coming next | Source (unwired). Ashish (rulings 8 and 13: text, images, PDF/TXT, sign-in links) | How it works line becomes "WhatsApp comes later", which conflicts with Connectors "next" | yes |
| WP-110 | §5 Later: iMessage (homepage) | Home · iMessage thread with agents; Investors scene | Talk to Waldo in iMessage (implied) | Source (unwired; #1017 draft). Ruling 13 | none | yes |
| WP-111 | §6a #6 | Home · "Different hats" scenes | Terminal, Apple Watch, a Figma comment and a Slack huddle as places to talk. "An engineer asking Waldo from the terminal" | None. Kennel and Watch are later surfaces; Figma and Slack are not connectors | none | yes |
| WP-112 | NOT IN LEDGER | Kennel · "Kennel is Waldo at work." roadmap | Waldo for iPhone, and messaging & browser, coming soon. "The same Waldo is coming to your iPhone" | No row. Conflicts with "Working today" labels for app features, and with #18's "Talk to it in the Waldo app" | none | yes |

### N. Push notifications

WP-107's "iPhone notifications are coming next" is the only explicit push roadmap line, and #18 deletes it.

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-113 | §6c + §14 A1 + §13 Push (S7) | Home · See card "Overnight" | One wake-time notification for the decision that needs you. "At 6:30 you get one notification: the one thing that needs your yes." | No APNs sender and no register route; `expo-notifications` is never imported. No rule releases an overnight decision as one wake-time push. The design system pushes a Needs You only near expiry. No probe named (S7) | none | yes |
| WP-114 | NOT IN LEDGER | How it works · "Waldo through a day" carousel | All six moments are drawn arriving on the lock screen: Brief 7:02, Window 7:15, Prep 1:25, Heads-Up 2:40, Close 6:48, Adjustment Friday 4:10. "The Brief arriving on the lock screen at 7:02" | No row; "lock screen" has zero hits in the ledger. Conflicts with the design-system rules in ledger §13: the Brief never pushes, at most 3 pushes a day. No push code exists | none | yes |

### O. Pricing and access

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-115 | NOT IN LEDGER | Waitlist · FAQ "When do I get access?" | Rolling admission, earlier joiners first. "We're letting people in a few at a time." | Ruling 18 is internal: cohort 5–10, at most 50 | none | yes |
| WP-116 | §6 (FAQ availability; reference list only) | Home and Waitlist · FAQ "What can I use today?" | Only Kennel is usable now; iPhone and messaging come next. "Kennel for Mac is in open beta now. iPhone and messaging come next" | §6: one availability statement, app-first. Conflicts with WP-107 | Not changed, but #18 makes it conflict with "Talk to it in the Waldo app" | yes |
| WP-117 | NOT IN LEDGER (ruling 9; §12 proposal) | Waitlist · FAQ "Is there an Android app?" | Android after iPhone. "iPhone comes first. Android follows." | No Android client. The owner decides whether Android is in the launch cut | none | yes |
| WP-118 | NOT IN LEDGER | Waitlist · FAQ "How much will Waldo cost?" | Free in beta; no charge without opting into a plan. "Free while it's in beta." "nothing will be charged without you choosing a plan." | No row. Ruling 18 sets an internal $25 per user per month ceiling; #915 L is not wired [inference: no billing code to check against] | none | yes |

### P. Kennel (Ashish's product; the Waldo-related claims)

| ID | Ledger ref | Page · section | Promise | Ledger rung / evidence / probe | #18 | Live=src |
|---|---|---|---|---|---|---|
| WP-119 | §5 Kennel row (partial) | Kennel · "Waldo holds it together."; "Turns your intent into an outcome." | Waldo shapes outcomes and supervises agent contracts. "Waldo shapes the outcome up front, keeps every contract in step" | The backend → Kennel seam: none (fake only). Ashish owns Kennel | none | yes |
| WP-120 | NOT IN LEDGER (Ashish's product) | Home announcement; Kennel page | Kennel is open source, free, local-first, and in open beta; a packaged Mac app is coming. "Kennel for Mac is now open source." | Outside the backend's scope | none | yes |

## 4. Live-site promises the ledger lacks

These are the 26 NOT IN LEDGER rows, in the ledger's terms. None of them is in §4, §5, §6a or §6b.

- **Pricing and access:**
  - WP-118, free in beta with no charge without a plan;
  - WP-115, admitted a few at a time, earlier joiners first;
  - WP-117, Android follows.
- **Legal and support gates:**
  - WP-102, the terms page says launch and account access should wait for final terms and privacy policy;
  - WP-103, no verified support or security contact.
- **Push:** WP-114, all six day moments drawn as lock-screen notifications.
- **Actions:** WP-050, a booked car (spend, booking).
- **Onboarding:**
  - WP-001, nothing to set up, and context carried into other tools;
  - WP-002, no config or API key;
  - WP-003, connect once;
  - WP-004, approve every tool.
- **Chat:** WP-005, the core promise ("ask it anything, any time") has no row of its own.
- **Memory:**
  - WP-016, "remembers across everything";
  - WP-021, "learns from every correction";
  - WP-020, the blog says the Constellation is "next year's problem".
- **Proactive:**
  - WP-038, the afternoon stress nudge (D19 is open, but there is no row);
  - WP-039, quiet by default.
- **Connectors:**
  - WP-077, the request form, "most-asked get built first", and its data going to Loops;
  - WP-078, the hats scenes read nine tools that are not "Working today" as if connected.
- **Health:** WP-093, the "lighter run" plan card.
- **Privacy:**
  - WP-100, "shows what he can access ... take access back";
  - WP-104, the data blog disclaims encryption, training exclusion and universal undo;
  - WP-105, the cookie banner;
  - WP-106, the Loops waitlist email flow.
- **Channels:** WP-112, the Kennel page says Waldo for iPhone and "messaging & browser" are coming soon.
- **Kennel:** WP-120, the product claims.

Pages the ledger never cites:
- `/waitlist`, apart from the shared FAQ line;
- `/terms`;
- `/support`;
- `/kennel`;
- four of the six blog posts (the ledger cites only blog 05).

## 5. Contradictions on the live site and with #18

Unless noted, the ledger does not record these.

1. **Wearables.**
   - The homepage FAQ says "Apple Watch, Oura, WHOOP, Garmin and Fitbit all work."
   - The waitlist FAQ says "Oura, WHOOP, Garmin and Fitbit are coming."
   - The connectors page says "Oura, WHOOP and Garmin are next."
   - The ledger has only the homepage line (§6, §6c).
2. **Availability.**
   - The homepage and waitlist FAQ say "Kennel for Mac is in open beta now. iPhone and messaging come next."
   - How it works says "Talk to it on Telegram and the web today."
   - The Kennel page says Waldo for iPhone is "Coming soon".
   - The ledger records the first two (§6).
3. **Undo.**
   - The homepage FAQ says "Undo it in one tap", and How it works says "One tap takes it back".
   - Two blog posts disagree: "a blanket undo guarantee would be misleading", and "No ... universal undo guarantee is made here."
4. **Constellation.**
   - The homepage has an interactive "Spots and constellations" map, and D11 puts constellations in the app.
   - The blog says "Building this is next year's problem, not this month's".
5. **Support contact.**
   - The waitlist says "Write to us from the same address".
   - The support page says no verified contact has been published.
6. **Telegram.**
   - It is "Working today" on the connectors page and delivers 8 routines.
   - Ruling 12, D15 and D20 say test surface only. #18 removes only the How it works and trust-window mentions.
7. **Status labels vs bodies.**
   - "Yours, always" is labelled "Working today" while its body says "Under review".
   - "Your schedule" is "Working today" while its own quiet-hours row says "Coming next".
   - Your best hours is "Coming next" but appears as current in the hats scenes and routines ("Oura has 9 to 11 as your sharpest hours").
   - The ledger notes the "Yours, always" one.
8. **Mail holding.**
   - "Waldo batches your inbox", the per-account rules and "holds Slack and Gmail while you're on the call" are all presented as working.
   - Ruling 5 says no mail holding. The ledger records the inbox line and the per-account rules.
9. **Lock-screen moments vs push policy.** Six moments are drawn as lock-screen notifications, while the design system says the Brief never pushes and caps push at 3 a day (ledger §13). The ledger covers only the homepage 6:30 notification.
10. **New contradictions #18 would introduce.**
    - "Talk to it in the Waldo app" vs the FAQ "iPhone ... come next".
    - "WhatsApp comes later" vs the connectors page "WhatsApp ... next".
    - Gmail "read and send" while the Calendar and Tasks tags stay "read only" against write-capable scopes (the ledger records this as a separate owner decision with Suyash).

## 6. Ledger rows whose copy no longer appears on the site

One key phrase per ledger row was tested against the live HTML and JS. 82 of 83 are live [verified]. The test file is `ledger_rows_live.tsv` next to this report.

- **The miss:** the `trust-panels.tsx:191` Gmail denial. The ledger already says `trust-panels.tsx` is imported nowhere.
- **Also unrendered** [verified: no live importer; strings absent from the live HTML and JS]:
  - `console-tour.tsx`, the Telegram "Not connected" row (the ledger also says it does not render);
  - `components/sections/security-section.tsx` ("Metadata only for email."). This is imported only by `components/page-layout.tsx`, which no page imports. #18 edits it, and the ledger never mentions it.
- **§5 "Google connect from the app (G1)":** the site label is "—". It is an enabler, not a site promise, so it is not counted as missing.

## 7. The ledger's own state and staleness

- The landing pin `830bfc2` is still current: live = `main` [verified].
- The #18 pin is stale.
  - The ledger's PR table says "open at `4fcc6f20`... 14 files".
  - The head is `598e94b0`, with 16 files. The second commit, "Stop offering Telegram as a way to talk to Waldo", is in §6b only as [reported] D20.
- **Self-contradiction:** ruling 10 ("Website copy stays as published"), D1, and §6 ("No landing edits are planned") are superseded in part by D16, D20 and #18. The ledger keeps both.
- **Numbering:** ruling 15 is titled "Zone bands (D7)", but §10's D7 is WhatsApp. The §10 table runs D1–D9, D12–D18, D20, D19, D11, D10. It is out of order, with no missing numbers.
- **Main-chat 503:** §2 and §13 say the cause is not identified. [verified, commit timestamps] `beta-mvp` @ `4bb040f5` now includes #1074 ("Pin a skipped row..."; handoff commit "its 503 fix is #1074"). Its merge commit `f74a2e38` is at 2026-10-11T21:08Z, about an hour after `dec91152` (20:07Z), so the ledger cannot record it. Deployment is not checked.

## 8. Ledger decisions and rulings that bear on delivery

One line each, as written at `dec91152`.

### Rulings 1–22

1. Scope is final: every promise ships, including "Coming next" and "Planned".
2. One writer: the owner and the owner's sessions write and merge the backend and app. Instinct takes delegated slices. Kennel and the WhatsApp adapter are Ashish's.
3. Omnipresence: one brain on any surface. Telegram is a development surface.
4. Connectors this push: Google Calendar, Gmail, Tasks, Drive; Apple Watch; Galaxy Watch; Health Connect; the 5 coding agents via Kennel; Weather; Location.
5. Rule and wording changes are approved (see §7 rule changes below).
6. Google OAuth: change scopes as features need; publish later.
7. Event wakes stay on the 10-minute sweep. Push wakes only where a promise needs lower latency.
8. WhatsApp is off the critical path; Ashish owns the adapter.
9. Android: the Samsung Health path is enough. A Health Connect client is built only if a promise needs it.
10. Website copy stays as published. Partly superseded by D16 and D20.
11. Health consent is two agreements, `storage_compute` and `model_processing`, withdrawn separately.
12. App first. Telegram is for testing only.
13. Ashish builds WhatsApp and iMessage in parallel: text, images, PDF/TXT, links. No buttons or menus.
14. The browser hold is lifted, but the S0 network-block test gates staging. No purchases until spend limits are set.
15. Zone bands come from the app's bands as `candidate_unaccepted`.
16. MCP and browser approvals are decidable in the app; query strings stay stripped.
17. Staging: deploy #1024; apply `20261010060000` with #1022, each after its own confirmation.
18. Alpha cohort is 5–10 (at most 50). The ceiling is $25 per user per month; #915 L is not wired.
19. Browser tasks can be requested from any surface and report back there.
20. Proactive messages go to the chosen surface, else the app. Telegram-only owners keep Telegram until L2 slice 1.
21. One main conversation per owner. Threads live in the app and console only.
22. The owner's sessions own app–backend integration. Instinct takes disjoint, reviewed slices.

### D1–D20

- D1: Labels stay as published. Superseded in part by D16 and D20.
- D2: The first slice is set in §12.
- D3: Scopes as needed; publication later. Proactive cap is 6 a day with a 30-minute cooldown until #915 K.
- D4: Event wakes, per ruling 7.
- D5: Open-Meteo for weather. Coarse location from the app with OS permission; commercial licence still to verify.
- D6: Rule changes, per §7.
- D7: WhatsApp is Ashish's.
- D8: Spotify is deferred until it has a stated job.
- D9: Lane conflicts are retired by ruling 2.
- D10: Cohort and the $25 ceiling. The launch gate and browser purchase limits are still the owner's to set.
- D11: Constellations go in the app (`claims[]` with text). L3's order: Brief `latest`, `view=constellation`, memory controls, "deliver to".
- D12: Arm proactive jobs at first app use after sign-in, with the sign-out fix first (#1060). The confirmed-zone hold is proposed, not approved.
- D13: The owner-set time zone wins, with a one-tap "use device zone". Conflicts with design-system page 19 (a fix for Suyash).
- D14: Threads C1 review comes before Constellations. Replay, media, `source` refs and rights are dropped from this wave.
- D15: App chat is the core, and the design system is the app's UI contract. Telegram is test-only.
- D16: Gmail: the site changes and the backend keeps reading (landing #18).
- D17: Staging browser starts, but the S0 check still fails. A guard exception and spend cap are proposed.
- D18: A failed R2 purge blocks deletion with 503 `rejected` (shipped in #1069).
- D19 (open): health-driven proactive nudges are unscheduled until the owner confirms scope and grant.
- D20: Telegram lines on the site change too. #18 carries the text; illustrations follow up.

### §7 rule changes

These are decided, and the ADRs publish in waldo-brain#34 first.

- Patterns get numeric health deltas, stored in the Supabase health plane, not DO memory.
- Form gets a stress part and Training a "racing heart at a desk" read, both from HR/HRV, consented, non-diagnostic and with workout attribution.
- Quiet flags measure deviation from the owner's own usual and are never a diagnosis.
- Fewer pings uses interruption judgment, with no Gmail holding.
- The Brief, Fetch, Close and Spots re-enter as launch moments.
- The Window and best-hours moves run under a matching standing grant, otherwise they are proposed.
- One-tap undo and disconnect-forgets become per-action reversibility plus lineage purge.

### §8

- Staging captures trace text, health included, for opted-in testers. Production never does.
- The opt-in must name this before outside testers join.

### §9 waves

- W0: converge and land. #998 is re-cut by path in 19 steps, plus the Google stack, closing superseded drafts, and one critical slice at a time.
- W1: the omnipresence seam. Surface-neutral parts, renderers, proactive delivery by preference, approvals from any surface, anchors and the APNs sender.
- W2: authority. #915 I (levels and grants), J (responsibilities), K (now/batch/silent), L (cost ceiling), the Patrol overlap detector, provenance.
- W3: the health plane. Consent, ingest, producers, the HR/HRV stress part, background delivery, backfill, Samsung, retention and purge, the history API.
- W4: the learning layer. Best hours, the Window, Heads-Up, numeric Patterns, the Slope, Tomorrow today, ratings, right-task ordering.
- W5: connector depth. Calendar lists and attendees, task writes, Gmail triage, Drive writes, weather and location, an operation ledger per operation.
- W6: later. App voice with spoken replies, other agents ask Waldo, the Kennel handoff, the later connectors.

### §6a proposals (owner approves; none assigned)

1. Fetch: L3 then L2 then L4.
2. Changing brief: L2 P3a and L4 BriefCard.
3. Provenance: L3 G6, L2, L4.
4. WhatsApp to a third party: Ashish. Drop the battery reminder.
5. Media inputs: a later wave, with an ADR first.
6. Terminal, Watch, Figma and Slack as places to talk: the owner decides.
7. Per-account mail rules: the owner decides copy vs rule.
8. Profession routines: L2 plus console presets.
9. Autonomy that grows: L2, L3 G12, L4.
10. Outcome closure in the app: L2 P3a, L4.
11. Long-run record: L3 G16, L1.
12. Per-tool read-only and disconnect-forgets: L3, L2, L1 purge.
13. Caffeine, meals and screen-time spots: the owner decides scope.
14. Weather (#1043): L2. Mail batching: ruling 5. "Breaks big tasks down": a scenario test.
15. Speak button: L4, later.

### §12 proposed lanes (owner approves)

- Your history: L3 + L1 + L4.
- Window: L2 + L4.
- Adjustment: L2 + L4.
- Best hours: L1 + L2 + L4.
- Fewer pings: L2 (#915 K).
- Patrol: L2, L3 G8, L4.
- Slope: L1, L3 G19, L4.
- Follow up: L2 W3, L3 G6.
- Quick replies and Charts: L2 producers, L4. Charts also take health series from L1.
- Thumbs: L2 W4, L4.
- Three levels: L2, L3 G12, L4.
- Activity log: L4 first, then L2 and L3.
- Tomorrow today: L2, L4.
- Kennel and other agents: Ashish, then L2.
- Galaxy Watch and Health Connect: L4 later. The owner decides whether Android is in the launch cut.
- Oura, WHOOP, Garmin and Fitbit: L1. The owner decides scope, because the site says they "all work".
- Outlook, To Do, Slack, Todoist and Linear: the owner decides scope first.
- Voice: unassigned.
- The ‡ rows go to Instinct briefs:
  - Weather → brief 02;
  - Calendar → brief 04;
  - Gmail → brief 03.
- Tasks and Drive writes go to L3. Production `DRIVE_READS` is the owner's call.

### §14 A-list (gaps against site promises)

1. No proactive message has been proven to reach the app, and push has no code.
2. Delete-and-recreate from the app is unproven, and the RunLoopDO root is left behind.
3. Health on a real device is unproven: Form is stale, Weight is unavailable, sleep debt is dropped, and there are no flags, Training or history.
4. The approvals, connections and scores screens have only Simulator reads.
5. There are no memory controls in the app, and Patterns and Spots are placeholders.
6. Threads and ratings routes answer 404. There is no producer for quick replies or charts. The session lasts 12 hours with no refresh. The 503 is unnamed. "Connect Google" from chat is dropped.
7. The three levels have no consumer; the activity log has no reasons; the console's deletion copy overclaims.
8. 15 published promises have no ledger row, and one privacy claim says less than the backend does.

### §14 B-list (new scope, owner only)

- Allow/ask/deny rules per scope.
- A memory dashboard.
- A delivery receipt for every scheduled job.

## Appendix A. Connectors "Pick your job" routines (WP-042)

[verified] from `components/site/put-to-work-data.ts` @ `830bfc2`, and present in the live JS. Tool statuses come from the site's own `connector-tools.ts`.
- TG means the routine delivers through Telegram.
- "All today" means every tool it names is "Working today".

| Profession | Routine (title) | Tools named (site status) | TG | All today |
|---|---|---|---|---|
| Founders | Start the day you actually have | Apple Watch, Google Calendar, Telegram (today) | TG | yes |
| Founders | Keep the investor call clear (holds Slack and Gmail; ruling 5 conflict) | Gmail, Google Calendar (today); Slack (next) | | no |
| Founders | Friday investor update, drafted for you | Gmail, Google Calendar (today); Linear (next); Stripe (planned) | | no |
| Engineers | Put the hard problem in your best hours | Apple Watch, Google Calendar (today); Slack (next) | | no |
| Engineers | Reviews waiting on you, batched into one block | Google Calendar (today); Linear (next); GitHub (planned) | | no |
| Engineers | Let your agent finish while you log off | Claude Code, Telegram (today); Linear (next); Kennel | TG | no |
| Designers | Clear hours for the hard screens | Apple Watch, Google Calendar (today); Slack (next) | | no |
| Designers | Figma comments sorted before crit | Notion, Slack (next); Figma (planned) | | no |
| Designers | Leave the feedback for tomorrow | Google Calendar (today); Notion, Slack (next) | | no |
| Product | Walk into standup knowing what moved | Telegram (today); Linear (next) | TG | no |
| Product | Customer calls become issues, with owners | Linear, Slack (next); Granola (planned) | | no |
| Product | Keep the hour for the spec | Apple Watch, Google Calendar (today); Notion, Slack (next) | | no |
| Sales | Prep for every call before you dial | Google Calendar, Telegram (today); HubSpot (planned) | TG | no |
| Sales | Your biggest call in your strongest hour | Apple Watch, Google Calendar (today); Salesforce (planned) | | no |
| Sales | Follow-ups drafted before you hang up | Gmail (today); Granola, HubSpot (planned) | | no |
| Investors | Five pitches, each one fresh | Apple Watch, Google Calendar (today); Calendly (planned) | | no |
| Investors | Notes pulled together before every founder call | Gmail, Google Calendar, Telegram (today); Notion (next) | TG | no |
| Investors | The day's pitches in one message | Telegram (today); Notion (next); Zoom (planned) | TG | no |
| Consultants | Client calls spaced so none gets the tired you | Apple Watch (today); Outlook (next); Calendly (planned) | | no |
| Consultants | Deliverables in an order you can do | Apple Watch (today); Asana (planned) | | no |
| Consultants | When a call runs over, the next one moves | Outlook (next); Zoom (planned) | | no |
| Athletes | Train for the body you woke up with | Google Calendar, Telegram (today); WHOOP (next); Strava (planned) | TG | no |
| Athletes | Training load and work load, balanced on one calendar | Google Calendar (today); Strava (planned) | | no |
| Athletes | Sleep for tomorrow's session | Google Calendar, Telegram (today); Oura (next); Strava (planned) | TG | no |
| Students | Revision in the hours you're clearest | Apple Watch, Google Calendar (today) | | yes |
| Students | Big assignments, one step a day | Google Calendar, Google Tasks (today) | | yes |
| Students | The night before an exam, your notes on one page | Notion (next); Google Drive (planned) | | no |

Totals: 27 routines. 3 name only "Working today" tools. 8 deliver through Telegram (the ledger's "14 mentions" are 14 lines across these 8 routines).

## Appendix B. Connectors status list (WP-076)

[verified] live, and in `components/site/connector-tools.ts` @ `830bfc2`. Each name is mapped to its ledger §5 rung.

- **Working today (13):**
  - Apple Watch: deployed (Simulator).
  - Health Connect: backend only.
  - Google Calendar, Gmail, Google Tasks: deployed.
  - Telegram: proven as a development surface only.
  - Codex, Claude Code, Cursor, OpenCode, Pi: none (fake).
  - Weather, Location: source.
- **Coming next (13):**
  - Oura, WHOOP, Garmin: enums. Fitbit: none.
  - Galaxy Watch: backend only.
  - Outlook, Slack, Todoist, Microsoft To Do, Linear, Notion, Spotify: none or contract only.
  - WhatsApp: source (unwired).
- **Planned (24):**
  - Google Drive: deployed on staging only; the site understates it.
  - GitHub: inbound events only.
  - Strava, Apple Calendar, Zoom, Calendly, Discord, Asana, Trello, ClickUp, Airtable, Dropbox, Jira, Vercel, Supabase, Figma, HubSpot, Salesforce, Zendesk, Intercom, Stripe, QuickBooks, Shopify, Granola: none.

## Appendix C. Evidence files (scratchpad, next to this report)

- `src/ledger.md`, `src/probes.md`, `src/audit-lane.md`: the ledger docs at `dec91152`.
- `src/pr18.diff`: `gh pr diff 18` at `598e94b0`.
- `live-html/`, `live-js/`: the raw live responses.
- `live-text/`: extracted text and RSC strings.
- `live_vs_main.tsv`: the 870-line live-vs-`main` check.
- `ledger_rows_live.tsv`: one phrase per ledger row, checked live.
- `tools/`: the extraction and check scripts, run with `python3 -I`.

**Unverified:**
- the backend state behind every ledger rung (taken from the ledger at `dec91152`, not re-checked);
- whether the console offers chat ("on the web");
- whether third-party scripts outside the fetched pages and chunks set cookies (none of the common vendors appears in what was fetched);
- deployment of #1074.
