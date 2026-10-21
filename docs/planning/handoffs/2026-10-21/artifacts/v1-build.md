
# Waldo v1 build
2026-10-19 · @Shivansh Fulper
## Verdict
Yes, this can be pulled off, because about two thirds of v1 already exists in beta-mvp. The remaining work is mostly wiring, production switches and three real builds: the Android Health Connect client, phone push, and iMessage through a provider. The risks that can sink it are outside the code: platform approvals and the unproven value of wearable data.
-
The shape: a general agent for work, life and health, known for acting on how you are. One simple app (onboarding, health sync, approvals, "What Waldo knows"). Chat on WhatsApp and iMessage. The console for laptops.
-
No new architecture: one brain per owner, split health scoring with the backend as authority, four new skills on existing tools.
-
Cost: about $1.55 a month for a typical owner and $9.68 for a heavy one with routing, against $26.80 without it.
-
Start today: WHOOP and Oura approval, Meta's WhatsApp review, Apple Messages for Business, the Play health declaration and Swiggy production access all run on other people's clocks.
-
The test: a 20-owner, 30-day pilot decides whether health is the wedge or a feature, and its results are what a follow-on raise rests on.
What would stop it: Meta or Apple refusing Waldo as "AI-first" or "health-first"; Health Connect background reads failing on common Android phones in India; or the pilot showing wearable days are no better than a one-tap question.
## The product
Waldo is a general personal agent for work, life and health. The welcome screen already says "a personal assistant for work, life and health". It is known first for one thing: it acts on how you actually are. Health is the wedge people remember Waldo for. Mail, calendar and chores are the general agent around it. Expansion follows the corridor: health, then the day, food, care, money dues, then everything else.
### At launch
| Job | Uses health | What Waldo does | Rail | | Morning Brief | Yes | Today's shape, one body line in zone words, and one recommendation | Push and chat | | Depleted-day replan | Yes | Low Form plus a heavy day: proposes moving one block and protecting a recovery window | Calendar, with approval | | Food fitted to the day | Yes | A prefilled cart for a light lunch or a protein restock | Swiggy and Instamart in India; a US partner is open | | Care loop | Yes | Refills, checkups and fasting lab tests, for the owner and a parent | Reminders, pharmacy deep links, UPI | | Evening Close | Yes | Tomorrow's first commitment and a suggested sleep window | Chat | | Inbox and calendar | No | Triage, drafts and scheduling, every send approved | Google | | Dues radar | No | Bills, renewals and refund windows from mail | Mail, UPI in India | | Forwards and saved links | No | Forwarded items become open loops tied to goals | WhatsApp, iMessage | ### Waits until after the pilot
Browsing-heavy errands, travel booking, shopping catalogues, money movement, phone calls to businesses, lab report storage (needs a contract review first), and anything that looks like therapy or diagnosis.
## Surfaces
People talk to Waldo on WhatsApp or iMessage. The app does four things only: onboarding, health sync, approvals for anything consequential, and "What Waldo knows". The console is the same agent on a laptop. Both messaging platforms reject AI- or health-first businesses, which favours the honest framing anyway: a general assistant for work, life and health.
| Surface | Job at launch | Work before launch | | App (iOS and Android) | Onboarding, background health sync, the Brief push, approval cards, "What Waldo knows" | Onboarding route. Push sending (only a contract and tables today). Android Health Connect client | | WhatsApp | Main chat in India and wherever owners live on WhatsApp; voice notes, forwards, button approvals | Graph v26.0, one approved utility template, buttons, PDFs, Meta review as a chore service | | iMessage | Chat for iPhone owners in the US and elsewhere | A managed provider for the pilot; iMessage turns must arm proactive jobs, which they never do today | | Console | Setup, chat and approvals on a laptop | Approve every kind of card, not only calendar changes | | Telegram | Team testing | None | ### iMessage: how to get in
-
Pilot: a managed provider. Photon is $25 a month for up to 100 users on shared lines; Sendblue is $100 per line a month ([Photon], [Sendblue]). Owners text first. Proactive messages go out only for things the owner opted into, with a kill switch, and a data agreement is signed before health-adjacent content flows.
-
Do not self-host. Lindy's own Mac and Apple ID were banned permanently after about 10,000 messages in 12 hours ([Lindy]). That also retires beta-mvp's self-run Mac host.
-
Scale: Apple Messages for Business. Apply now; Poke's approval took about two months ([TechCrunch]). The policy has three hard edges ([Apple]): Apple "is not onboarding businesses that primarily offer medical or health-related services", no "bot-only solution" (a live agent must be reachable during business hours), and no unsolicited messages.
## Onboarding
Keep [Suyash's onboarding flow] almost whole, and change one call. His flow:
-
uses an honest "I'm software" line;
-
starts at ask-first, widening one area at a time from day seven;
-
shows a first look at the day instead of a questionnaire;
-
says "still learning" rather than showing a weak number;
-
keeps health out of pushes and the lock screen.
The one change: health moves into the first run, as an optional step. His doc moves it out, since the research says health "comes later and in context". For a health wedge, that would hide the reason people came. There is also a practical reason. Connecting on day one lets the app pull past readings, so the first Brief can compare against a baseline instead of saying "give me two weeks".
### First run
-
Meet. "Hello. I'm Waldo." One promise, and the line that Waldo is software that asks before anything goes out.
-
Sign in or create. 18+ recorded on the account.
-
What should I call you? One field, skippable.
-
Let me see your day. Connect Google: what Waldo reads, what it always asks first, what it never does. "Continue without it" stays real.
-
Let me see how you're doing. Apple Health, Health Connect or a wearable account. The screen says what is read, that readings become zone words, and that nothing reaches a push or an outside service. Skippable.
-
First look. Today's meetings and what looks tight, plus one body line ("short night; the 4 pm block is the risk") or "still learning your baseline".
-
Where should I message you? WhatsApp or iMessage, verified with a code. The app stays for approvals and "What Waldo knows".
-
When should your Brief arrive? Quiet hours follow from the answer.
-
All set. "Your first Brief is at 7:30 tomorrow." Ends on Home, never on a permission prompt.
### First week
As in Suyash's doc: notifications are asked after the first Brief lands, there is one evidence-backed yes-or-no question a day, and on day seven a review ends with one scoped, revocable offer. One addition: on day three, Waldo shows the first pattern it can stand behind, or says plainly that it has none yet.
## Health data pipeline
Two phone sources and two cloud sources cover the pilot: Health Connect for India and most of Android, HealthKit for iPhone, and WHOOP and Oura through their cloud APIs. Every source lands in one health plane and goes through one scorer. Only zone words go past that point into Waldo's memory.
| Priority | Source | Why | Platform rule that bites | | 1 | Android Health Connect | India is about 94% Android; covers Samsung Health and Oura's export through one RMSSD record | Reads only 30 days back unless the app holds PERMISSION_READ_HEALTH_DATA_HISTORY; background reads need their own permission ([Android]) | | 2 | Apple HealthKit | US iPhone and Apple Watch owners | HRV is SDNN, not RMSSD. Since iOS 27 an owner can grant only a recent window, and the app must treat earlier time as unknown ([Apple]) | | 3 | WHOOP API | Recovery already uses RMSSD; webhooks | 10 members until WHOOP approves the app ([WHOOP]) | | 4 | Oura API | Rich sleep phases | Personal tokens were removed; 10 users until approved; access needs the owner's Oura subscription ([Oura]) | | Later | Garmin, Google Health API, Ultrahuman, Samsung SDK | Fast Garmin approval; Ultrahuman is strong in India | Google requires an annual security assessment and caps unverified apps at 100 users. Garmin's licence-fee terms conflict. Samsung and Ultrahuman need partner approval | ### Rules for the pipeline
-
Baselines are kept per source and HRV method. Mixing SDNN and RMSSD makes Recovery jump when an owner changes phones.
-
Missing time is unknown, never zero. A limited iOS grant or a 30-day Android window gives a partial baseline, which Waldo says out loud ("still learning").
-
Apply for WHOOP and Oura approval now. Both cap at 10 users until approved.
-
Sending health context to a model provider needs explicit consent on both app stores. Apple 5.1.2(i) covers sharing with third-party AI ([App Review]); Play applies Limited Use rules ([Google Play]).
-
Declare health and fitness on Play, not medical. Medical apps must publish from an organisation account.
## Where scores are computed
Split the work. The phone reads readings and sums them into hourly and nightly windows, and it may show a provisional "local estimate" at once. The backend computes the official Form, Recovery and Load once, in one deterministic module, for every source. Computing everything on the phone sounds safer, but it does not buy the compliance it seems to. A derived score is still health data under GDPR and DPDP, and phone-only scoring breaks cloud wearables.
| Option | Gains | Costs | | All on the phone | Readings never leave the device | WHOOP, Oura and Garmin data never touches the phone. Two implementations (iOS and Android). A formula fix needs an app release. No recompute when the formula improves. The scores are still health data once uploaded | | All on the backend from raw samples | One formula, easy recompute | More data held than needed; beat-level uploads waste battery and bandwidth | | Split (recommended) | One formula for all sources. The phone uploads only summaries. History can be recomputed. Matches ADR-0081, where a local estimate never triggers an action | The app still uploads health summaries, so consent, deletion and region rules apply | Most of this is already built. The ingest route accepts 14 signals, including hourly windows, not beat-level data. Recovery, Form and Load are computed in the Worker after each upload. Consent epochs, withdrawal purges and owner deletion are wired.
What compliance actually needs is data minimisation, consent per purpose, deletion that works, a stated region, and no health values in prompts, logs or pushes. The agent sees zone words only.
## The agent
v1 needs no new architecture. It points what already exists at the health wedge, keeping the shape from the [architecture plan]. That means one brain object per owner, with workers and a browser only when a job needs them. Judgment stays with the model: skills give it context and tools, not fixed rules.
| Building block | Today at 3a727acf | v1 change | | Brain (OwnerDO) | One per owner; holds memory, loops, approvals and schedules | None | | Skills | 16 bundled, including day-brief, meeting-prep, meal-activity-log-and-planning, weekly-review and inbox-triage-reply-draft | Add four: depleted-day replan, food fitted to the day, care loop, and evening close with a sleep window | | Standing orders | Live; every-turn orders sit in the prompt | Owner rules such as "after a short night, nothing before 10" | | Scheduler | Brief 08:00, Check-in 14:00, Close 21:30, re-planned daily by the cheap model; heartbeat every 30 minutes | Add a run when new health data arrives | | Memory | Claims, recall and pinned profile | Fix the correction bug and the post-chat flush (plan doc) | | Approvals | Cards in the app and Telegram; text replies on WhatsApp; the console approves calendar changes only | WhatsApp buttons; console approves every kind | | Connectors | Typed Google tools live; Google MCP reads in staging | General MCP client with OAuth, for Swiggy first | | Health tools | get_health (turn-only numbers), log_meal, log_workout, zone words in the prompt | get_crs is listed but has no handler: build it or drop it | | Workers and browser | No workers; browser staging-only | Not needed for v1 jobs; phase 3 | The four new skills only use tools that already exist: calendar proposals, reminders, open loops, health reads, and Swiggy once its MCP connector works.
## Models and cost
Keep the two OpenAI models already pinned, and add a router plus open models where they are cheaper. The router is the cheap model deciding which tier each turn needs, a judgment made by a model, not keyword rules. A heavy owner drops from about $26.80 to $9.68 a month. A typical owner costs about $1.55 once proactive jobs run on the cheap model. That is close to the roughly $1.77 that ₹199 a month leaves after GST, so ₹199 only covers light use; heavy owners need ₹399 or a usage cap. All figures are estimates.
| Task | Model | Price per million tokens or per minute | | Router and triage | gpt-6-luna | $0.10 in, $0.01 cached, $0.50 out | | Casual chat and routine tool use | gpt-6-luna | same | | Health-aware planning, consequential drafts | gpt-6.1-sol | $2.00 in, $0.10 cached, $10.00 out | | Brief, Close and other scheduled jobs | gpt-6-luna, as beta-mvp does today; Sol on Flex at half price for hard days | $1.00 in, $5.00 out on Flex | | Memory search embeddings | Workers AI bge-m3 (multilingual) | $0.012 | | English voice notes | Workers AI whisper-large-v3-turbo | $0.0005 a minute | | Hindi and other Indian-language voice notes | Sarvam saaras v4 | ₹0.49 a minute | | Outage fallback | gpt-oss-120b on Workers AI | $0.35 in, $0.75 out | Sources: [OpenAI pricing], [Workers AI pricing], [Sarvam pricing]. Beta-mvp today sends chat to Sol and machine turns to Luna. It has no fallback provider, and its transcription chain is ElevenLabs, then smallest, then OpenAI.
| Owner | Usage | Cost a month | | Heavy, no routing | 30 messages and 2 proactive jobs a day, all on Sol | $26.80 | | Heavy, routed | 80% of turns on Luna, 10% of those escalated; jobs on Sol Flex | $9.68 | | Typical, routed | 5 messages, 2 jobs and 1 voice note a day; jobs on Luna | about $1.55 | Assumptions: two model calls per turn, 16,000 tokens in and 800 out, 60% of input read from cache, and 45-second voice notes. Cache writes are 64% of a Sol turn's cost, so a stable prompt prefix matters as much as routing. Beta-mvp already keys the cache per owner.
### Guard rails
-
Trust the router only after Waldo's own labelled evals. RouteLLM routed near-randomly on MMLU until about 1,500 labelled examples were added ([LMSYS]).
-
Open models do not beat Luna in the agent loop at list price, because Luna's cached input costs $0.01 per million. They win on speech, embeddings, Indian-language translation and fallback.
-
Validate every tool call. An escalated retry must never fire an effect twice: one retry owner, intent before I/O.
-
No new provider sees health context before consent and a data agreement. Turn off AI Gateway logging and caching on health-bearing routes.
## What beta-mvp has and lacks
About two thirds of v1 exists in code. The missing third is mostly wiring and production switches, plus three real builds: the Android Health Connect client, phone push, and the iMessage route. Audited read-only at 3a727acf. No tests were run.
| Area | Works today | Missing for v1 | | Health ingest | App upload of 14 signals from Apple, Samsung and Health Connect; consent epochs, withdrawal purge, owner deletion | The migrations run on staging only. No Android client. No WHOOP, Oura or Garmin link. No retention sweep in production | | Scores | Recovery, Form and Load computed after each upload; zone words in the prompt | Bands are marked unaccepted. Form is labelled form.safte-fast.v1 but computed as form.candidate.v3. Sleep debt is computed but never served | | Proactive health | Brief, Check-in and Close carry one body line | No health-arrival trigger, depleted-day job, or pattern detection | | WhatsApp | Cloud API, signature check, owner binding, 24-hour window, forward labelling, voice notes | Graph v21.0 expires 21 Jan 2027. No knock template. Buttons and PDFs are not wired | | iMessage | Bridge object, pairing, shared "Waldo number" flow; staging only | The host is a self-run Mac proven only on a simulator, and it never arms proactive jobs | | App | Sign-in, chat, approvals, controls, health routes | No onboarding route. Push is a contract and tables only, so the Brief cannot reach the lock screen | | Console | Chat, Waiting, Memory, Settings; email-code and link sign-in | No health view; approves calendar changes only | | Models | Sol for chat, Luna for machine turns, per-owner prompt cache, per-call cost in the trace log | No fallback provider. The monthly cost ceiling code is unused. The Workers AI roster is dormant | | Connectors | Google typed tools | MCP OAuth for third parties; Swiggy | ## Build order
Four phases, each ending at a gate that has to pass before the next starts. The approvals start today, because WHOOP, Oura, Meta and Apple all review on their own clocks.
Phase 1 is mostly switching on and wiring what exists. Phase 2 is where Waldo becomes the agent that acts on how you are. The pilot thresholds are in [Health as Waldo's wedge].
## Open decisions
-
Health in the first run: this doc puts it back in; Suyash's onboarding doc moves it out. The two need to agree.
-
Pilot split: 10 US or Europe iPhone owners and 10 India Android owners, or all 20 in one market first.
-
Food partner outside India: Swiggy covers India only; pick a US partner, or keep food India-only for the pilot.
-
iMessage provider: Photon (cheapest for under 100 users) or Sendblue or Linq (dedicated lines). Also, who staffs the live-agent path Apple requires.
-
Scores on the phone or split: this doc recommends split, with the backend as authority.
-
Price: ₹199 for light use with a cap, ₹399 for heavy use, and a US price near $10.
-
Launch contract: the Brain launch contract makes health optional and defers commerce such as Swiggy; amend it for a health-first launch.
-
Lab reports: contract review before any lab value is stored.
## Sources
Pages opened 18–19 October 2026. Code read-only at beta-mvp 3a727acf; no tests or verify were run.
-
Waldo docs: [Suyash's onboarding doc], the [architecture plan], [Health as Waldo's wedge]
-
Health platforms: [Health Connect read rules], [HealthKit limited history], [App Review guidelines], [Play user data policy], [WHOOP app approval], [Oura authentication], [Google Health API]
-
Messaging: [Apple Messages for Business policy], [Poke's approval], [Lindy on its Apple ban], [Photon pricing], [Sendblue pricing]
-
Models: [OpenAI pricing], [Workers AI pricing], [Sarvam pricing], [RouteLLM]
GAPS: [] complete: True None
