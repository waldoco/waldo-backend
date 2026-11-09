# Waldo: what we have built, what the website promises, and where the gaps are

Written Oct 10 2026, ~2:30 IST, from source reads, PR pages, the live website and public docs. Facts are tagged [fact] (read in source, a PR page or a fetched page) or [opinion]. Stage tags: local / pushed / merged / deployed / live-proven. beta-mvp tip: ed686308. Staging /healthz release at last read: eaa2469a, so anything merged after it (#985, #988, #990, #991, #992) is merged, not deployed. Nothing below is production. Kennel items: Ashish's lane.

## 1. What Waldo is and the mission (my words) [opinion, built from the site and the repo's own docs]
Waldo is a personal agent that looks after a person's day. It reads the calendar, mail, tasks and, when connected, the body (sleep, recovery), works out what kind of day this is, proposes or makes the small changes that fix it, and drafts what needs saying. It acts only inside permissions the owner can see and take back, and it never sends or changes anything consequential without the owner's yes. The mission, as I read the site: replace the hours people spend telling each tool who they are and what they are doing, by being one agent that remembers across everything, speaks first when it matters, shows its work, and keeps the owner in control.

## 2. What the website promises (fetched live Oct 10 2026, all reachable pages)
Pages read: https://heywaldo.in (home), /features (same content at /how-it-works), /connectors, /kennel, /waitlist, /privacy, /terms. /about, /pricing, /faq, /blog, /security, /health, /memory return not found; sitemap.xml could not be fetched as text. FAQ content lives on the home, waitlist and kennel pages. Every scene is marked sample data: home and waitlist say "An illustrative scenario. The names, amounts and readings shown are samples, not your data."; the home page says "Interactive example · sample data · no real account connected". Quotes are verbatim.

Home (https://heywaldo.in)
- "Life happens. Waldo handles it." / "A personal assistant that meets all needs for life, work and health; with nothing hidden."
- "Waldo reads all of it, every day, and turns it into a plan." (watch, WHOOP, Oura)
- "Waldo remembers across everything, speaks up when it matters, and works with every agent."
- "Waldo shows what he can access and what he does, and lets you take access back."
- "Ready isn't the same as sent... You see who it goes to and every word before you send it."
- "Ask why. He has the context. Ask about any change and he shows his work: what he read, what he compared, and where each fact came from."
- "Everything he notices is remembered as a spot. Spots that keep recurring join into a constellation."
- "Undo it in one tap. Waldo learns from every correction."
- "Do I need a smartwatch? ... Apple Watch, Oura, WHOOP, Garmin and Fitbit all work." (the connectors page below says Oura, WHOOP, Garmin and Fitbit are "next", so the home FAQ overstates)
- "What can I use today? Kennel for Mac is in open beta now. iPhone and messaging come next."
- "Context, never a diagnosis."

Features / how it works (https://heywaldo.in/features)
- Three scores. "Recovery: Set each morning, from Sleep, HRV and Resting State." "Form: Live all day, from Circadian, Motion and Stress." "Weight: Live all day. Higher means heavier: meetings, messages, tasks and Load." Sample values 63, 76, 84.
- "Sleep debt. Working today ... a running count of the sleep you've missed, weighted over the last 14 days."
- "Your best hours. Waldo learns when you're sharpest" and suggests another time for an invite that lands in it.
- "Talk to it on Telegram and the web today. WhatsApp and iPhone notifications are coming next."
- "Threads. Keep each part of life in its own conversation."
- "Three levels, per area. Tell me / Ask me / Just do it, set separately for each area." "Every move is logged. One tap takes it back."
- "New tricks, coming soon": Voice, your own routines, "Other agents ask Waldo".
- "Waldo uses health signals as context for planning your day. It isn't a medical device, and it doesn't diagnose anything."

Connectors (https://heywaldo.in/connectors)
- "Working today (13): Apple Watch, Health Connect, Google Calendar, Gmail, Telegram, Google Tasks, Codex, Claude Code, Cursor, OpenCode, Pi, Weather, Location."
- "Coming next (13): Oura, WHOOP, Garmin, Fitbit, Galaxy Watch, Outlook, Slack, WhatsApp, Todoist, Microsoft To Do, Linear, Notion, Spotify." Planned (24) includes Google Drive, GitHub, Figma, Shopify, HubSpot, Stripe, Granola.
- "Read only, unless you say so." "You approve every tool. Nothing connects on its own." "One tap to disconnect. What Waldo learned from that tool goes with it."
- "Work Gmail. Personal Gmail. Waldo knows which." (multiple accounts per tool, separate handling by work hours)
- "Waldo reads sleep, heart rate, HRV, stress and movement, works out Recovery, Form and Weight."
- "Your inbox waits for a better moment. Waldo batches your inbox... Email access depends on the permissions you grant."
- Profession starts (founders, engineers, designers...) and recurring jobs such as "Every Friday at 4, draft my investor update".

Waitlist (https://heywaldo.in/waitlist): "Free while it's in beta." "iPhone comes first. Android follows." "Which watches work? Apple Watch works best. Oura, WHOOP, Garmin and Fitbit are coming."
Privacy and Terms (https://heywaldo.in/privacy, /terms): "Waldo app data practices, provider details, retention, export and deletion controls are still being reviewed. This page is not a final privacy policy. Do not connect personal accounts based on the illustrative screens on this website." "Final terms for the Waldo app have not been published here."
Kennel (https://heywaldo.in/kennel): Ashish's lane.

Two things in the site that matter for the build [opinion]: (a) it promises three scores (Recovery, Form, Weight), while the owner's ruling makes Recovery the only Stage 1 score, so Form and Weight are Stage 2 by decision and the site runs ahead of the product; (b) the site's "working today" list names Apple Watch, Health Connect, Weather and Location, none of which has a backend ingest or tool in waldo-backend today.

## 3. What is built across the board
| Area | What exists [fact] | Stage | Evidence |
|---|---|---|---|
| Agent runtime | Owner Durable Object turn pipeline, run loop with checkpoints, Scribe sanitiser at every model boundary, canary/secret/health checks, hooks | merged, deployed (eaa2469a) | packages/runtime/src/run-loop/do.ts, scribe/sanitiser.ts; CI 6/6 each PR |
| Channels | Telegram owner chat (live on staging), app channel /app/v1 (email-code sign-in, session, signout, main chat history #982, app send #983) | merged; Telegram live-proven on staging by the test lane; app routes not live-proven | test traces tg-9049584xx (staging 44fc58ca); beta-mvp |
| Tools: Google | query_calendar (primary calendar only), propose_calendar_change, read_thread, search_communication, get_communication, draft_email, send_email with approval, recovery after partial failures (#990) | merged; #990 not deployed; calendar read live-proven | packages/runtime/src/tools/live/google.ts |
| Tools: other | read_drive, web_search, get_tasks, get_context, search_episodes, MCP read/call, connect_service, workspace_list/read/write/search/render | merged, deployed except noted | tools/live/*.ts |
| Memory | Claims and spots, constellation, forget flows, admission gate, console review (confirm, dismiss, forget); episodes search | merged, deployed | channels/console.ts, memory/claims.ts |
| Health plane | Health logs as agent tools; owner readings now allowed to the model and the owner reply, egress and memory still deny (#992); Recovery-only Stage 1 amendment (#991); OpenAI store:false (#988) | merged, NOT deployed | PR pages; HEALTH_PLANE_AMENDMENT.md |
| Health ingest | No ingest route, no consent tables, no wearable read tool, derived view schema is Form-only (contracts health/crs.ts:51) | not built (design only) | source read |
| Browser | Retained Cloudflare browser sessions, owner semantic interaction, approved download (#985 merged), upload (#987 open draft, base not retargeted), login and MFA handoff (#984) | merged mostly; deployed through #984; #985 not deployed; live acceptance on Cloudflare pending | PR pages |
| Compute | Bounded Linux to private owner files (#973) | pushed, draft, held for owner "final" | PR #973 head 698bc7dd |
| Wakes/proactivity | Scheduler heartbeat, briefs, proactivity quiet hours/volume, schedule prefs, standing-grant eligibility slice (#932 open draft) | merged core; deployed; end-to-end brief quality: partial | console actions proactivity.set, schedule.set |
| Approvals | Waiting page approve/skip/undo; send and calendar writes gated | merged, deployed; live approved-send trace to the owner's own address still owed | channels/approvals.ts |
| Console | Overview, Waiting, Setup, Connections, Spots, Constellation, Your day, Memory, Files, Usage, Activity, Settings/sessions, Admin, Invites | merged, deployed | /downloads/waldo-console-feature-inventory-eaa2469a.md (read from source, not rendered) |
| Native app | The app agent builds it in a separate repo; backend routes exist; HealthKit ingest and screens unverified by me | local/unknown from my side | #982, #983 |
| Testing lane | Separate test agent runs staging scenarios through Telegram Web: overload planning (usefulness 1/2), calendar read (primary only), health with no data (honest "no data"), newest-mail grounding probe in progress | live-proven results for those scenarios | traces tg-904958482/84/85/91 |
| Kennel (Mac bridge, iMessage, WhatsApp connector) | Ashish's lane | n/a | handover pack |

## 4. Gap table: promise vs built vs missing [percentages are my opinion; revised after reading every page]
| Promise (page) | Built in waldo-backend | Missing | Rough % |
|---|---|---|---|
| Reads your health every day, turns it into a plan (home, connectors) | Owner readings may reach the model (#992, merged, not deployed) | Ingest, consent, Recovery view, read tool, retention, deploy; Apple Watch/Health Connect "work today" is not true in the backend | 15% |
| Recovery, Form and Weight scores (features) | Form pipeline exists from app-supplied context; Recovery is the Stage 1 target | Recovery compute path, Weight; owner ruled Form/Weight not Stage 1 | 15% |
| Sleep debt, 14-day weighted, "Working today" (features) | Not found in waldo-backend TS; may live in the app or health SQL, unverified | Compute, storage, planning use | 5% |
| Best hours learned, invites moved out of them (features) | Not found | Learning loop and calendar suggestion | 5% |
| Rebuilds the day around the night; moves the hard meeting (features, home) | propose_calendar_change with approval; schedule prefs, briefs | Health-driven planning, calendar enumeration (primary only), reduced-slice plans (overload test 1/2) | 30% |
| Remembers across everything; spots and constellations (home) | Claims, spots, constellation, forget, console review | Item-level withholding for pins; cross-channel shared chat | 60% |
| Threads per topic (features) | Single main chat; shared-chat work not started | Thread model in app and runtime | 10% |
| Three autonomy levels per area, log, one-tap undo (features) | Approvals, undo, activity log; standing-grant slice #932 open draft | Per-area Tell me / Ask me / Just do it setting end to end | 40% |
| Draft, never send without seeing every word (home) | Draft and approve flow, send gated | Live approved-send readback trace | 70% |
| Ask why, with sources (home) | Traces and run proofs | User-facing explainer | 25% |
| Reads what it needs, read-only by default, approve every tool, one-tap disconnect with learned data removed (connectors) | Connections page, google connect/disconnect, forget flows | Per-tool read/write toggle; disconnect-removes-learned-data end to end | 50% |
| Working today: Google Calendar, Gmail, Telegram, Google Tasks (connectors) | Calendar (primary only), Gmail, Telegram, tasks source | Calendar enumeration; Gmail multi-account journeys (#919 draft) | 65% |
| Working today: Weather and Location (connectors) | Not found in the tool registry | Both | 0% |
| Working today: Codex, Claude Code, Cursor, OpenCode, Pi (via Kennel) | Ashish's lane | n/a | n/a |
| Work Gmail vs personal Gmail with work-hours rules (connectors) | Account-bound Gmail work in draft PRs | Merge, per-account policy | 15% |
| Inbox batching, goes quiet, flags what needs you (connectors) | Mail reads, heartbeat | Batching policy and delivery timing | 20% |
| Coming next: Outlook, Slack, WhatsApp, Notion, Linear, Oura, WHOOP, Garmin... (connectors) | WhatsApp, Kennel: Ashish's lane; rest not built | Everything else | 5% |
| Voice, routines, other agents ask Waldo (features, "coming soon") | Not built | Stage 3 | 0% |
| Native app, iPhone first, free beta (waitlist) | Backend routes #982/#983; app in separate repo | Working screens and device proof | 25% |
| Privacy and terms (privacy, terms) | Pages say under review | Policies, App Store/DPDP/residency/purge: hard gate before any outside user | 10% |
Overall, opinion: about 25-30% of what the site says works today is actually reachable end to end in the backend (calendar and mail chat core, memory, approvals, console). The site is further ahead of the product than my first reading showed: it lists Apple Watch, Health Connect, Weather, Location, sleep debt and best-hours learning as working today, and I found none of them in waldo-backend.

## 5. What we are missing compared with mature agents and personal agents
Sources read: OpenAI Help Center "ChatGPT agent" (https://help.openai.com/en/articles/11752874-agent; page says agent mode is no longer available and points to ChatGPT Work and a cloud browser, so treat it as superseded), OpenAI intro (http://openai.com/index/introducing-chatgpt-agent), Manus features (https://manus.im/features/cloud-computer, https://manus.im/features/automations, https://manus.im/docs/features/scheduled-tasks), OpenClaw (https://openclaw.ai/, https://docs.openclaw.ai/heartbeat, https://docs.openclaw.ai/concepts/memory), Claude Cowork (https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork, https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork). Instinct is compared by capability only.

Facts from those pages [fact]: ChatGPT agent navigated sites, worked with uploaded files and connectors and paused for confirmation. Manus offers a persistent cloud computer that runs 24/7 and scheduled or triggered automations. OpenClaw runs from WhatsApp, Telegram or any chat app, keeps memory as plain Markdown files the user can read, and runs a periodic heartbeat turn that surfaces what needs attention without spamming. Claude Cowork runs sessions remotely, takes recurring scheduled tasks and uses connectors and local files.

Ranked by how much each gap matters to the website promise [opinion]:
1. Real data in: wearables and health ingest. The site's headline differentiator has no inflow. Mature agents have no equivalent, so this is where Waldo can lead, but today it is empty.
2. Breadth of connectors. Others connect many apps or accept any MCP server. Waldo has Google plus generic MCP; the site lists Slack, Notion, Outlook, Linear, Oura, WHOOP as next, not working today, so this gap is real but matches the site's own roadmap. Same-query evidence: calendar reads only the primary calendar, because no calendar list exists (test trace tg-904958485).
3. Proactive quality. OpenClaw's heartbeat and Manus schedules show recurring turns are table stakes. Waldo has a heartbeat but its planning answer on overload scored 1/2 (tg-904958482): no concrete reduced slice, timebox or restart dates.
4. Explainability UI. "Ask why" and "what he can access" are sold on the site. Others show action logs; Waldo has traces but no user-facing explainer.
5. Always-on workspace and compute. Manus's cloud computer and ChatGPT's browser are shipped. Waldo's browser is merged but live acceptance is pending and compute (#973) is held.
6. Interface reach. OpenClaw and Instinct-style agents meet users in messaging apps; Waldo has Telegram live, WhatsApp and iMessage in Ashish's lane, and no working native app proof.
7. Memory legibility. OpenClaw's plain-file memory is readable; Waldo's memory has a console review surface but pins and item-level withholding are not done.
8. Delegation to other agents. The site promises running Claude and Codex as workers; there is no code for that.
Where Waldo is already ahead or equal [opinion]: approval-gated writes with undo, a sanitiser at every model boundary, owner-visible console, forget flows. Where the test lane showed honesty working: health with no data answered honestly (tg-904958484).
Same-query live evidence limits: calendar enumeration (primary only) and overload planning (1/2) are from traces I read. The inbox sample probe (newest GitHub Actions failure email) passed in the test lane per the parent's relay: the selected-email read matched the baseline and the follow-up correctly refused to name the test or recommend a revert. I did not read the trace myself.

## 6. What to do next, ordered, matching the two-stage plan [opinion]
Stage 1, health plus chat demo:
1. Deploy the merged queue to staging (#988, #990, #991, #992, #985): Dalda, via the parent.
2. recovery.v1 derived view schema with volatile_run and trigger_prompt eligibility; ADR-0081 registry update (me, red-first).
3. Ingest/consent design note to the owner, then staging-only migrations after his approval; POST /app/v1/health/ingest; bounded wearable read tool; 90-day raw / 24-month aggregate retention.
4. Calendar-list tool so "my calendar" covers all calendars (me, red-first; scope question first).
5. Prompt/context fix so overload planning gives a reduced slice, timebox and restart dates.
6. Staging trace with synthetic wearable data end to end, then a trace with the invited account in the app.
Stage 2, structured parity:
7. ADR-0024 item-level withholding and pins; shared main chat across channels (tree-interleave) after the design question on shared vs per-channel chats.
8. User-facing "why" explainer and per-scope read/write toggles.
9. Connectors: Slack, Notion, GitHub via MCP or native, in the order the owner uses them.
10. Compute (#973) at the owner's "final"; browser live acceptance.
11. Hard gate before any outside user: App Store, DPDP, residency, purge.
12. Owner decision for the site: either bring the product up to the 'working today' list (Apple Watch/Health Connect ingest, Weather, Location, sleep debt, best hours) or edit the site to match. The home FAQ also contradicts the connectors page on which watches work.
