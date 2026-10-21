# Personal agent experience research for Waldo

Verified 2026-10-11 (previous pass 2026-09-20; Dots addendum 2026-09-29). Scope: Meta Muse, Instinct, Poke, OpenAI Dots, Vellum Assistant, Folk (folk.com / Nozomio Labs). Grok Bot was not re-fetched this pass; its 20 September rows are retained unchanged and marked stale.

"Instinct" in this document is the competitor product (Spear Street Technology, Inc.), not the Waldo contributor lane of the same name. Research was run read-only by the audit lane's research agent on 2026-10-11; the audit lane reviewed the text and did not re-fetch the pages itself.

Provenance rules for this document:

- Every claim below is `[source states]` from a vendor page fetched on 2026-10-11 unless tagged `[press]`, `[search snippet]` or `[inference]`. Pages were read through a summarising fetch tool, not captured as raw HTML; short quotes are as that tool returned them.
- Vendor claims are product descriptions, not benchmarks. No product was exercised hands-on; no account was created; no form was submitted. Nothing here is a reliability or parity measurement.
- `[press]` is used only where the vendor has no reachable page for the claim, and is named as such. `[search snippet]` means a search engine's excerpt of a first-party page that itself returned HTTP 403 when fetched directly.
- Dots: the launch page was blocked again (HTTP 403 on every openai.com and help.openai.com path tried; see "URLs that could not be fetched"). What changed since 29 September is that OpenAI's own news feed (`openai.com/news/rss.xml`, fetched 2026-10-11) carries the item "Introducing dots", link `openai.com/index/introducing-dots`, pubDate 29 Sep 2026, with the description "Dots by OpenAI are proactive assistants that can keep working across complex projects and everyday tasks" / "Learn how dots help you stay in control while work moves forward." OpenAI authorship and launch date are therefore now first-party established. The feature-level claims still rest on the owner-supplied 29 September transcription plus search snippets of the help-centre FAQ, and remain qualified as such.

## Recommendation

[inference] Unchanged from 20 September. Build one personal assistant that remembers corrected understanding, owns a small set of active commitments, wakes from schedules/events, takes permitted actions, and returns with either verified progress or one meaningful decision. The strongest initial loop remains a health-aware day that adapts: learn priorities and energy, read permitted calendar/health context, propose a usable day, make narrowly authorized calendar adjustments, carry one follow-up to an exact send approval, watch for a response, and revisit the plan when facts change. No competitor page fetched this pass describes that loop; health signals appear only as Poke's Oura recipe (page still empty), Folk's Strava/meal-photo features, and Vellum's "Someday" roadmap items.

## Changes since 20 September

| Product | What is new on vendor pages (fetched 2026-10-11) | Press-only items (not adopted as fact) |
|---|---|---|
| Meta Muse | Launch post now shows "updated September 30, 2026". New newsroom post "Muse for Small Business" (published 29 Sep, updated 8 Oct): named connectors Asana, Box, Canva, Dropbox, Figma, Granola, HighLevel, Intuit QuickBooks, Klaviyo, Lovable, Notion, Shopify, Slack, Stripe, Zoom, plus Facebook/Instagram business accounts and Meta ad accounts; custom connectors supported; "nothing publishes, sends, or spends without your approval"; personal Muse "available in the US and Canada" (launch post still says US only). `security.muse.ai` now redirects to the research.meta.ai article. Confidential VM still "later this year". | iPad app 7 Oct, GitHub connector, retail checkout partners (Best Buy, Gap, Sephora, Walmart, Wayfair) `[press: TechCrunch 2026-10-07]`; Amazon blocked Muse on 20 Sep and Meta/Sierra announced a "Personal Agent Protocol" on 6 Oct with spec due later in October `[press]`. No about.fb.com page found for any of these; `about.fb.com/news/tag/muse/` is 404. |
| Instinct | Homepage unchanged (text or call; "uses a phone and computer in the same way that humans do"; five example errands; "Text Instinct" links to app login). Privacy policy and terms both "Last revised on August 26, 2026", now fetched: see table. `/faq` and `/blog` return title-only pages. | Private beta; dedicated email addresses for assistants since September; call placement rolling out; $1B raise in September `[press: TechCrunch 2026-10-10]`. Listed as a Personal Agent Protocol partner `[press]`. A competitor (Vellum) blog of 20 Aug cites `instinct.co/terms`; that domain's homepage mirrors instinct.com but does not name the company, so the two were not conflated here. |
| Poke | No vendor change. Release notes end at 23 Jul 2026 ("joining Cognition"). Docs now state surfaces as Apple Messages, Telegram, WhatsApp, RCS. Pricing Free / Pro $19 / Ultra $199 unchanged. Oura recipe page still renders no body. Recipes directory has a "Health" category but names no wearable. | Cognition acquisition closed July (low nine figures) `[press]`; nothing new since 20 Sep. |
| OpenAI Dots | First-party news feed confirms the 29 Sep "Introducing dots" item (see provenance note). Launch page and help-centre FAQ still 403. Search snippets of the help-centre FAQ add: Custom Rules let you say which supported actions the dot may take independently, which need approval, which it must not take; rules are viewable in settings; rules "cannot turn off core safety requirements", cannot alter "Autoreview" or "the restrictions on proactive research"; Activity View in the desktop app shows ongoing and delegated tasks, status and steps, and lets you add context, correct a misunderstanding, change direction or stop. | DevDay launch 29 Sep; GPT-6 Astra; 4,000+ apps; Pro / Business Premium / eligible Enterprise `[press, multiple outlets]`. One outlet names a different model; treat model naming as unsettled. |
| Vellum Assistant | Docs fetched in depth this pass (permissions model, channels, scheduling, memory, cloud hosting, pricing, roadmap). Homepage still says "runs locally on your machine by default" while scheduling and environments docs call Vellum Cloud the default/recommended; conflict persists. Roadmap shows "Health & wellness" and "Apple Watch" as Someday, iMessage In Progress, WhatsApp absent. Roadmap bug entries observed 28 Sep to 5 Oct report scheduled notifications recorded "ok" but not delivered, and a heartbeat silent for six days. `/docs/releases.md` has no dated entries. | None needed. |
| Folk | FAQ, pricing, memory and money docs fetched. WhatsApp "switching on country by country". Calls only to the user's verified number; 10 min/week Free, 120 min/month Pro. Pricing Free (3 background items) / Pro $9.99 or $99.99/yr, ~$5 regional / Max $100 (footer only). Memory dashboard ("lore"/"brain"): search, read, delete, "forget", CLEARMEMORY; memory import from ChatGPT/Claude. Money: read-only Plaid link (US, CA, UK, 17 EU); "never moves money and never cancels anything on its own". The connecting-apps page no longer mentions Cursor Cloud Agent delegation (it did on 20 Sep); the docs index does not mention coding delegation. | Beta launched May 2026; Pro quoted at $8.33/mo `[press: TechCrunch 2026-10-10]`, which matches the yearly price, not the vendor's monthly price. |

## Capability table

Each cell: what the vendor states, with page and fetch date 2026-10-11. "Not stated" means not on the pages fetched, not that the feature is absent.

### Meta Muse

Sources: [Design](https://introducing.muse.ai/) (dated September 2026), [Launch](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) (8 Sep, updated 30 Sep), [Small Business](https://about.fb.com/news/2026/09/introducing-muse-small-business/) (29 Sep, updated 8 Oct), [Security](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse) (8 Sep). `muse.ai` redirects to an auth page (307) and was not followed.

| Area | Vendor statement |
|---|---|
| Surfaces | iOS and Android app, web at muse.ai, WhatsApp; "coming soon to AI glasses" (Launch). One main chat plus side chats (Design). Voice not stated. |
| Proactive | Works in the background "on a schedule and in response to relevant events"; assesses whether a result is worth sharing and notifies "only when something is meaningfully new or needs your input"; user can turn proactivity off, down or up (Design). Returns "when something changes or when it needs approval" (Launch). Small Business: flags emails needing a response and writes first drafts. |
| Memory | Persists across conversations; "memory files can be read and edited directly by the user" (Design); users can "inspect, edit, and download their files, including Muse's memory" (Security); "forget" specific things on request; opt-out of training (Launch). No supersession or provenance semantics stated. |
| Rules / approvals | Standard browsing allowed by default; checks in before "critical or hard-to-undo actions" such as sending email or purchases; structured accept/reject cards; defaults can be made more or less cautious (Design). Sentinel is sole authority for connector actions and egress, returns allow/deny/ask; grants one-time, session, task, time-bounded or perpetual, "match the approved scope exactly"; approval dialogs "describe the exact action"; purchases show exact details every time; read/write split per service where supported; users can remove specific actions beyond OAuth scopes; read-only and low-risk actions proceed without prompts (Security). Email connector filters one-time codes and magic links. Undo not stated. |
| Activity / visibility | Avatar shows current work snippet; tap for "full activity log and approved permissions"; Goals and Ideas tabs (Design). "Complete audit trail of what it has done and what it plans to do" (Launch). |
| Health / wearables | Not stated on any page. |
| Connectors | Launch names email (read-only or send), 1Password, Shop Pay (coming soon), Instagram. Small Business lists 15 named third-party apps plus Meta business accounts; custom connectors; no total count. Google suite not named on any page. |
| Browser / actions | Own VM with file system, terminal, full browser that fills forms and "completes transactions"; books dinner, buys, loads carts (Design). Payments via Link by Stripe single-use card tied to one merchant, amount and time window; negotiates on user's behalf (Launch, Security). |
| Availability / pricing | US only (Launch); "US and Canada" (Small Business). Free "for most needs", subscriptions for heavier use, no prices on vendor pages. No waitlist stated. |
| New since 20 Sep | See table above. Confidential VM remains future work. |

### Instinct

Sources: [Homepage](https://instinct.com/), [Privacy](https://instinct.com/privacy-policy) and [Terms](https://instinct.com/terms) (both "Last revised on August 26, 2026"). `/faq` and `/blog` return title-only pages. Company: Spear Street Technology, Inc. d/b/a Instinct.

| Area | Vendor statement |
|---|---|
| Surfaces | "Text or call"; "no new interfaces to learn" (Homepage). Audio/voice data collected only if enabled (Privacy). App, iMessage, WhatsApp, web chat: not stated. |
| Proactive | Not stated on vendor pages. (The 20 Sep row's "proactive follow-ups" wording is no longer on the homepage as fetched.) |
| Memory | Not stated. Privacy: indexed external data deletable at app.instinct.com/workspace; disconnecting an integration "doesn't automatically delete data"; Google Workspace data deletable on revoke. |
| Rules / approvals | Terms: user authorizes the service "to take Actions on your behalf as the Services may deem are responsive to your Input" and appoints it as agent to enter binding agreements; the company "may add safeguards or confirmation requirements for some Actions but does not guarantee they will prevent errors"; users "must verify Actions and monitor them regularly"; "Actions may not always be reversible". No allow/ask/deny product surface stated. |
| Activity / visibility | Not stated. |
| Health / wearables | Privacy lists "health-related information, such as medical appointments or emails from your healthcare provider" as sensitive data it may collect. No wearable integration stated. |
| Connectors | Privacy names Google Workspace: Calendar, Gmail, Drive, Docs, Sheets, Slides, Tasks (metadata and event details); third-party AI model providers and a payment processor unnamed. No count. |
| Browser / actions | "Uses a phone and computer in the same way that humans do"; examples: dispute a bill, send gifts, order groceries, schedule doctor's appointments, plan a getaway (Homepage). Terms: purchases share user info and payment method with the provider; company is not party to the transaction. Calls by the service on the user's behalf: not in Terms. |
| Availability / pricing | 18+; operated in the US, not restricted to US users; one account per person; "some features require payment", USD, non-refundable; no price published (Terms). Waitlist/invite status not on vendor pages. `[press]` private beta. |
| New since 20 Sep | Vendor pages: none observable. `[press]` dedicated assistant email addresses (September), calling rollout, $1B raise. |

### Poke

Sources: [Homepage](https://poke.com/), [FAQ](https://poke.com/faq), [Docs](https://poke.com/docs), [Managing integrations](https://poke.com/docs/managing-integrations), [Usage](https://poke.com/docs/usage-and-resets), [Pricing](https://poke.com/pricing), [Release notes](https://poke.com/docs/release-notes), [Recipes](https://poke.com/recipes), [Oura recipe](https://poke.com/recipes/oura) (body empty). Company: The Interaction Company of California, "joining Cognition".

| Area | Vendor statement |
|---|---|
| Surfaces | Apple Messages, Telegram, WhatsApp, RCS (Docs); text or voice message input; channel chosen at poke.com/settings/messaging; one phone number per account (FAQ). Feb 2026 release note: Telegram offered while WhatsApp unavailable "except in Italy and Brazil"; current WhatsApp coverage not stated. No app or web chat stated. |
| Proactive | "Proactive ... right in your texts"; "automatically uses your integrated services and its memory to help out right on time"; reminders; Pro adds "real-time automations running in the background" (Homepage). Heavy usage "often driven by frequently firing automations" (Usage). Dec 2025 note: Poke prompts users to review unused recurring automations. How it decides what to interrupt with: not stated. |
| Memory | Referenced as "its memory" only. View/edit/correct/delete: not stated. Account deletion at poke.com/settings/privacy, up to 24 h (FAQ). |
| Rules / approvals | Not stated on docs/FAQ. Nov 2025 release note mentions a fix for "approval loops when drafting emails" `[inference: an email approval step exists]`. Undo not stated. |
| Activity / visibility | Not stated. Usage bar and reset date on subscription page (Usage). |
| Health / wearables | Oura recipe advertised on homepage ("sleep stages, readiness scores, and daily activity insights"); Fitbit and Strava in logo strip; Oura recipe page renders no content; recipes directory "Health" category names no device. |
| Connectors | Gmail, Outlook (mail, calendar, contacts); "no immediate plans" for iCloud/Yahoo (FAQ). 12 named first-party recipes (Linear, Todoist, Notion, Asana, GitHub, DeepWiki, Sentry, Vercel, Netlify, Supabase, Ramp, Webflow); custom MCP servers by URL plus optional key; no total count. 24 logos on homepage, not stated to all be live. |
| Browser / actions | Browser use not stated. Poke Human (Ultra) dispatches reservations, calls, orders, rides to a real person at cost; operators see task details only (FAQ). Website build/deploy at yourname.poke.com (Jun 2026). |
| Availability / pricing | Free $0; Pro $19/mo; Ultra $199/mo, credits 1 = $1, pay-as-you-go, monthly reset, no carry-over (Pricing, Usage). Regions not stated; "no bouncer or waitlist" since Mar 2026. |
| New since 20 Sep | None on vendor pages. |

### OpenAI Dots

Sources: [News feed](https://openai.com/news/rss.xml) (fetched; item "Introducing dots", 29 Sep 2026). Launch page `openai.com/index/introducing-dots` and help-centre article 20001529 "dots privacy security and safety faqs": HTTP 403 on every variant tried. Feature claims below are tagged by origin.

| Area | Statement and origin |
|---|---|
| Surfaces | ChatGPT, Slack, Teams, voice; texting later `[owner transcription, 29 Sep]`. Activity View "in the desktop app" `[search snippet of help-centre FAQ]`. |
| Proactive | "Proactive assistants that can keep working across complex projects and everyday tasks" `[feed, first-party]`. Read-only proactive app research `[owner transcription]`; "restrictions on proactive research" that Custom Rules cannot alter `[search snippet]`. |
| Memory | Learns from feedback `[owner transcription]`. View/edit/delete: not stated in any reachable source. |
| Rules / approvals | Custom Rules: which supported actions the dot "can take independently, which require your approval, and which it should not take"; viewable in settings; cannot turn off core safety requirements (e.g. hand-back for password changes), Autoreview, or proactive-research restrictions `[search snippet]`. Action review and approval `[owner transcription]`. Exact-content display and undo: not stated. |
| Activity / visibility | Activity View shows ongoing and delegated tasks, descriptions, status, steps taken; user can add context, correct a misunderstanding, change direction, or stop `[search snippet]`. |
| Health / wearables | Not stated. |
| Connectors | 4,000+ app plugins `[owner transcription; press]`. Google suite not named in reachable text. |
| Browser / actions | Separate cloud computer/browser; saved passwords not exposed to the model `[owner transcription]`. |
| Availability / pricing | Pro and Business Premium in eligible markets; Enterprise beta `[owner transcription; press]`. First-dot inclusion and allowances `[owner transcription]`; not comparable unit economics. |
| New since 20 Sep | Launch itself (29 Sep, first-party date now confirmed). |

### Vellum Assistant

Sources: [Homepage](https://www.vellum.ai/), [Permissions model](https://www.vellum.ai/docs/trust-security/the-permissions-model.md), [Channels](https://www.vellum.ai/docs/key-concepts/channels.md), [Scheduling](https://www.vellum.ai/docs/key-concepts/scheduling), [Memory](https://www.vellum.ai/docs/key-concepts/memory-and-context), [Cloud hosting](https://www.vellum.ai/docs/hosting-options/cloud-hosting.md), [Architecture](https://www.vellum.ai/docs/developer-guide/architecture), [Tasks](https://www.vellum.ai/docs/skills-reference/tasks.md), [Pricing](https://www.vellum.ai/pricing), [Roadmap](https://www.vellum.ai/roadmap). No page carries a publication date. Open-source (MIT) runtime.

| Area | Vendor statement |
|---|---|
| Surfaces | Desktop (macOS, Windows), CLI, web, iOS (iPhone/iPad), Android, Telegram (inline approval buttons), Slack, email (user Gmail or assistant-owned AgentMail inbox behind a feature flag), phone via Twilio/ElevenLabs. WhatsApp absent; iMessage "In Progress" (Roadmap). Notifications deliver to web, desktop, iOS push, CLI, Telegram, Slack; not to email or phone (Channels). |
| Proactive | One-shot and recurring schedules (cron/RRULE); heartbeats run `HEARTBEAT.md` on an interval (default 1 h, active-hours window), surfacing only items needing attention; watchers poll Gmail, Outlook, GitHub, Google/Outlook Calendar, Linear (min 15 s, default 60 s) with a watermark against duplicates; run modes execute / notify (no LLM) / script / workflow; missed one-shots fire on restart, recurring runs are not replayed (Scheduling). Roadmap bugs observed 28 Sep to 5 Oct: notifications recorded "ok" but undelivered; heartbeat silent six days. |
| Memory | Memory v3: linked wiki of concept articles; memory map, search, Create memory, Refine ("what's incomplete or wrong"), Ask about this; memory can be turned off; "corrections should replace outdated understanding rather than sit alongside it"; bounded per-turn recall separate from transcript compaction; captured from direct requests and background review. Per-memory provenance not described on this page; architecture doc references "provenance gates" in internal memory docs. Deletion not described. |
| Rules / approvals | Risk tiers Low/Medium/High; default tolerance auto-approves Low, prompts Medium and High; third-party skill tools always prompt; per-context defaults: chat Default, scheduled tasks Relaxed, automation/API Strict. Prompt shows plain-language description, risk badge with reason, "Show details" with full tool input, Allow / Deny / Allow & Create Rule. Rules: allow/deny/ask, scope (directory, project, everywhere), no expiry stated, deny wins at equal priority, edited in Settings > Permissions & Privacy. Cross-channel guardian grants are one-time, 5-minute. Undo not stated. Homepage: asks on high-stakes actions (emailing new contacts, modifying important files, spending credits) "until you mark them trusted". |
| Activity / visibility | Task queue with states queued / running / awaiting_review / done and priorities; followups skill tracks messages awaiting reply; schedule run history (status, duration, output, errors) via chat. No dedicated activity-log page in docs index. |
| Health / wearables | None shipped. Roadmap: "Health & wellness" and "Apple Watch" both "Someday". |
| Connectors | Google Workspace, Slack, Notion, filesystem built in; Gmail skill; MCP, plugins, custom skills; watcher providers listed above. No count. |
| Browser / actions | Browser and computer-use skills (computer use desktop-only); DoorDash, Amazon, agentic-payments docs exist (not fetched); homepage: orders groceries, watches fares, books reservations. Gateway enforces permissions and routes guardian approvals; Credential Execution Service holds secrets the assistant references by alias (Cloud hosting). |
| Availability / pricing | Free download / self-host; Cloud Mighty $30, Super $100, Ultra $200 per month, $10 platform fee on Super/Ultra, 1 credit = $1; computer-size naming inconsistent between plan cards and FAQ (Pricing). Deployment default stated three ways: local by default (Homepage) vs Cloud default (Scheduling) vs Cloud recommended (Cloud hosting). |
| New since 20 Sep | No dated vendor change; roadmap bug observations dated 28 Sep to 5 Oct. |

### Folk (folk.com, Nozomio Labs)

Sources: [Use cases](https://www.folk.com/use-cases), [llms.txt](https://www.folk.com/llms.txt), [FAQ](https://www.folk.com/faq.md), [Pricing](https://www.folk.com/pricing.md), [Memory](https://www.folk.com/docs/memory.md), [Money](https://www.folk.com/money.md), [Connecting apps](https://www.folk.com/docs/connecting-apps.md), [Docs](https://www.folk.com/docs). No page carries a date.

| Area | Vendor statement |
|---|---|
| Surfaces | iMessage and Telegram now; WhatsApp "switching on country by country"; not Signal, SMS, Discord or email as chat channels; outbound calls to the user's own verified number only (wake-up calls, urgent reminders, calling companies); no app store app, no self-host. |
| Proactive | Timed check-ins, streaks, "notices when you go quiet", nag mode, morning briefing (calendar, weather, inbox, watched items), 24/7 fare and shipment watching, price-drop watching after purchase, "texts you when something changes"; recurring check-ins are paid; Free allows 3 background items. Interrupt policy beyond these: not stated. |
| Memory | "Persistent memory graph"; dashboard "lore"/"brain" view grouped by people and topics: search, read, delete; "forget what I said about X" in chat; CLEARMEMORY or privacy settings erase all (confirmed, irreversible, keeps account and connections); group chats have separate memory; import from ChatGPT/Claude. Memory doc says delete or forget only; FAQ says "read, edit, or delete" at folk.com/dashboard/brain. Provenance labels not stated. |
| Rules / approvals | "Always checks with you before sending an email or inviting anyone to something" (Connecting apps). Money: "never moves money and never cancels anything on its own"; folk drafts, user says "send"; "cancel that" / "dispute it" count as approval; emails go from the user's Gmail. Booking: "want me to grab it?" example, no stated policy. Allow/deny rules and undo: not stated. |
| Activity / visibility | Background items visible in settings/billing; wins and running totals kept in the text thread; no activity log stated. |
| Health / wearables | Strava connection; calorie/protein logging from meal photos; fitness plans, sleep and screen-time coaching as text routines; "not a therapist", shares crisis resources. No wearable stated. |
| Connectors | Gmail, Outlook, Google Calendar, Notion, Slack, Todoist, Canvas, Strava, Canva, Excel, Calendly named, "hundreds more", unlimited on all plans; any MCP-compatible tool; secure sign-in link texted at point of need; folk has its own email address and phone number for sign-ups and calls. Bank: read-only Plaid in US, CA, UK, 17 EU countries. Cursor Cloud Agent delegation no longer appears (was cited 20 Sep). |
| Browser / actions | Own isolated cloud computer: browses, runs code, "writes and ships code", app builder, opens pull requests (Use cases); shopping to checkout; restaurant booking; flight rebooking and provider switching explicitly "not yet". |
| Availability / pricing | Free forever (unlimited messages, 3 background items, 10 call-min/week); Pro $9.99/mo or $99.99/yr (unlimited watchers, 120 call-min/mo), ~$5/mo auto-applied in many countries by phone number; Max $100/mo footer-only; 7-day trials; 13+. |
| New since 20 Sep | No dated vendor change; Cursor delegation wording gone from connecting-apps page. |

### Grok Bot (not re-fetched; 20 September rows retained)

Persistent cloud computer, connectors plus computer use, bot memory, multi-bot handoffs; skills distinct from routines; approvals guidance recommends narrow scope. [Overview](https://docs.x.ai/grok-bot/overview), [Skills/routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), [Approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy). Stale as of this pass.

## Five-bar scoring

Scored only on what the vendor states on pages fetched 2026-10-11. `stated` = the page describes the behaviour; `not stated` = no page fetched describes it; `contradicted` = a vendor page describes behaviour that points the other way. Bars from `INSTINCT_PATTERN_AUDIT_2026-09-27.md`.

| Bar | Muse | Instinct | Poke | Dots | Vellum | Folk |
|---|---|---|---|---|---|---|
| 1. Read-only until decision | stated: browsing default, check-in before send/purchase, Sentinel allow/deny/ask, read-only actions proceed without prompt | contradicted in Terms: service acts "as the Services may deem responsive"; safeguards "may" be added, not guaranteed; user must monitor | not stated (approval-loop fix note implies an email approval step) | stated `[search snippet + owner text]`: read-only proactive research; Custom Rules allow/ask/deny | stated, qualified: Low auto, Medium/High prompt, but scheduled tasks default to Relaxed and the prompt is per-tool, not per-decision | stated for email, invites, money; not stated for booking/checkout |
| 2. Proposals carry exact content | stated: approval dialog "describe[s] the exact action"; purchases show exact details each time | not stated | not stated | not stated (action review described, content level unknown) | stated: "Show details" exposes full tool input | stated by construction for email (folk drafts, user sends from own Gmail); not stated elsewhere |
| 3. Provenance on all state | not stated (audit trail of actions is stated; memory provenance is not) | not stated | not stated | not stated | partially stated: architecture doc names "provenance gates"; memory page gives no per-memory source | not stated (memory comes "from your conversations or from imports", unlabelled) |
| 4. Corrections replace | not stated (editable memory files, "forget"; no supersession rule) | not stated | not stated | not stated ("correct a misunderstanding" in Activity View is task-scoped) | stated: corrections "replace outdated understanding rather than sit alongside it" | not stated (delete/forget; FAQ and memory doc disagree on edit) |
| 5. Live reads over stale recall | not stated | not stated | not stated | not stated | not stated (watchers poll live; bounded recall; no rule against content copies) | not stated (nightly bank check is a live read for one feature only) |

[inference] Only Muse and Vellum publish text addressing more than two bars; neither addresses provenance-on-all-state or live-reads as product rules. No vendor page states all five.

## Architecture practices worth transferring

1. **The durable agent is not the computer.** Muse keeps durable state in Postgres outside the runtime cell and credential store, with continuous VM backup (Security). Vellum keeps conversation, delivery state, memory and schedules in the runtime, with a separate gateway as the only ingress and a separate credential service (Architecture, Cloud hosting). [inference] Unchanged guidance: persist commitments, memory, approvals, schedules and results outside any browser/session.
2. **One permission authority at the action boundary, with scoped grants.** Muse's Sentinel returns allow/deny/ask, grants are one-time/session/task/time-bounded/perpetual and "match the approved scope exactly", read/write are split per service, and users can remove individual actions beyond OAuth scopes. Vellum's gateway enforces permissions, rules carry decision + scope, deny wins ties, guardian grants expire in 5 minutes and never become rules. [inference] This maps directly to Waldo's "smallest per-turn capability manifest" and scoped, revocable grants; the transferable detail is that a grant is a record with scope and lifetime, not a boolean.
3. **Exact content in the approval card.** Muse: dialog describes the exact action, purchases always show exact details. Vellum: full tool input under "Show details". Folk: the user sends the drafted email from their own account. [inference] Waldo already does this for email (digest-bound MIME); extend the same shape to send_message and call_mcp_tool as planned.
4. **Proactivity needs a durable trigger, a cheap path, and an interrupt filter.** Vellum separates execute / notify / script run modes, uses watermarks against duplicate processing, and has heartbeats that surface only what needs attention. Muse states the interrupt test ("meaningfully new or needs your input") and lets users dial proactivity. Vellum's own open bugs (notifications recorded "ok" but undelivered; heartbeat silent six days) show the failure mode Waldo's honest-terminal-ambiguity rule exists to prevent: a scheduler must not record success it did not observe.
5. **Corrections replace; memory is user-visible.** Vellum states replacement semantics and a memory map with Refine. Muse and Folk expose memory as editable files / a searchable dashboard with delete and forget. None states provenance labels per memory. [inference] Waldo's stated/inferred/confirmed provenance plus dismiss-and-add replacement is beyond what any fetched page describes; keep it and make it visible in-app.
6. **Payments through single-use instruments, never raw cards in the model's reach.** Muse uses Link by Stripe single-use card numbers bound to merchant, amount and window; credentials are surrogate tokens swapped at the egress boundary. Folk's bank link is read-only and it "never moves money". [inference] If Waldo ever executes payment, copy the shape (single-use, bound, approved per purchase), not the vendor.
7. **Identify the agent to the counterparty.** Amazon's 20 September block of Muse and the Meta/Sierra protocol announcement are press-only, but the lesson is structural: browser errands that do not identify themselves can be cut off at any time. [inference] Treat site access as revocable and never a promise to the user.

## Smallest complete winning demonstration

Unchanged from 20 September (proposed acceptance scenario, not a statement that it currently works). No vendor page fetched this pass describes a health-adapted day plan with calendar adjustments under a narrow rule; the nearest vendor statements are Muse's school/calendar monitoring example, Folk's morning briefing and routines, and Vellum's "Start the Day" skill (page listed in docs index, not fetched).

## Claims to reject or qualify

- No basis to call health-aware assistance unique: Poke advertises Oura (page empty), Folk has Strava and meal-photo tracking, Instinct's privacy policy anticipates health-related content, Vellum lists wearables as "Someday". None describes health-aware planning. Waldo's claim must be demonstrated, not asserted.
- No basis to call personal-to-work delegation unique: Folk "writes and ships code" on its own cloud computer; Vellum has subagents, computer use and task templates; Dots and Muse describe multi-project cloud-computer work. Folk's specific Cursor Cloud Agent claim from 20 September is no longer on its page; drop it.
- Dots feature claims are still not from a fetched OpenAI page. The feed proves the launch and date; it does not prove Custom Rules, Activity View or read-only research as implemented. Search snippets are excerpts, not the page.
- Instinct has no public product documentation. Its Terms describe broad agency and non-guaranteed safeguards; they do not describe an approval UI. Do not credit Instinct with read-only-until-decision behaviour on vendor evidence.
- Vellum's deployment default is stated three different ways; do not cite a default.
- Vendor prices (Poke $19/$199, Vellum $30/$100/$200 + fee, Folk $9.99/$100, Muse "free for most") are not Waldo's cost basis; they bundle or subsidise compute and impose credit or background-item limits.
- No competitor parity claim is justified by this document. It is a checklist of vendor statements.

## Claims that cannot be verified without a hands-on test

- Muse: that approval dialogs show exact content for every connector action (not just purchases); that read-only and low-risk actions never trigger a write; that memory edits take effect in the next turn; interrupt-filter quality; US/Canada eligibility in practice; whether the activity log covers background work.
- Instinct: everything beyond text/call existence: proactive follow-ups, memory, any approval step, Google Workspace write actions, purchase flow, invite/beta status, pricing.
- Poke: whether an approval step exists for email sends and other actions; what memory stores and whether it can be corrected; Oura data path and what it produces; which of the 24 logos are live; WhatsApp coverage today; Poke Human turnaround.
- Dots: all of surfaces, Custom Rules semantics, Activity View contents, read-only proactive research, plugin coverage, approval content, regional availability, first-dot allowances.
- Vellum: whether the "Relaxed" scheduled-task default auto-approves Medium-risk actions; whether notification delivery failures are now surfaced (open roadmap bugs); iOS push reliability; memory replacement in practice; whether "provenance gates" are user-visible.
- Folk: whether booking/checkout asks before committing; whether individual memories are editable or only deletable; WhatsApp availability by country; call quality; background-watcher accuracy.

## URLs that could not be fetched (2026-10-11)

| URL | Result |
|---|---|
| https://openai.com/index/introducing-dots/ | HTTP 403 |
| https://openai.com/index/introducing-dots | HTTP 403 |
| https://openai.com/dots/ | HTTP 403 |
| https://openai.com/devday/ | HTTP 403 |
| https://help.openai.com/en/articles/dots | HTTP 403 |
| https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs | HTTP 403 |
| https://help.openai.com/is-is/articles/20001529-dots-privacy-security-and-safety-faqs | HTTP 403 |
| https://web.archive.org/web/2026/https://openai.com/index/introducing-dots/ | fetch tool cannot reach web.archive.org |
| https://muse.ai/ | 307 to auth.muse.ai sign-in page; not followed |
| https://security.muse.ai/ | 302 to the research.meta.ai article (already fetched) |
| https://about.fb.com/news/tag/muse/ | HTTP 404 |
| https://apps.apple.com/us/app/muse-personal-ai-agent/id6752976195 | HTTP 404 (guessed ID; no Meta page links the listing) |
| https://instinct.com/faq | 200, title-only page, no body |
| https://instinct.com/blog | 200, title-only page, no body |
| https://poke.com/recipes/oura | 200, empty section headers, no body |
| https://www.vellum.ai/docs/key-concepts/permissions | HTTP 404 (actual page is /docs/trust-security/the-permissions-model.md, fetched) |
| https://www.vellum.ai/docs/releases.md | 200, no dated entries; points to non-Markdown /docs/releases (not fetched) |
| https://techcrunch.com/2026/10/03/all-the-ai-agents-that-can-live-in-your-text-messages/ | HTTP 404 (permalink https://techcrunch.com/?p=3173132 fetched instead, dated 10 Oct) |

Fetched and used: introducing.muse.ai; about.fb.com (launch, small business); research.meta.ai (security); instinct.com (home, privacy, terms); instinct.co (home, mirrors instinct.com, company unnamed); poke.com (home, faq, docs, managing-integrations, usage-and-resets, pricing, release-notes, recipes); openai.com/news/rss.xml; vellum.ai (home, pricing, roadmap, llms.txt, docs: memory, scheduling, permissions model, channels, cloud hosting, architecture, tasks); folk.com (use-cases, llms.txt, faq.md, pricing.md, money.md, docs, docs/memory.md, docs/connecting-apps.md); app.folk.com/docs/connecting-apps. Press consulted only where noted: TechCrunch 7 Oct and 10 Oct; Vellum's 20 Aug Instinct breakdown (competitor source, not adopted).
