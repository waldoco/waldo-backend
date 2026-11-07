# Proactive assistants and coaches: primary-source research (2 Nov 2026)

Source tags: **[fetched]** = I read the page. **[snippet]** = claim seen only in a search-result excerpt, page not read (openai.com, help.openai.com, WHOOP, Superhuman returned 403). **[inference]** = my reading, not sourced. "None documented" means the sources I read do not say; it does not mean the product lacks it.

Not researched: Martin, Howie, Dola, Apple Intelligence. Microsoft Copilot daily briefing: only third-party sources surfaced, so skipped. Sunsama's shutdown help page was not retrievable; the changelog is used instead.

## 1. ChatGPT Pulse (OpenAI, preview 25 Sep 2025, Pro first)
- **Triggers:** Runs overnight so reports are ready in the morning. Evening requests aim for next-morning inclusion. One refresh per day. [fetched: https://techcrunch.com/2025/09/25/openai-launches-chatgpt-pulse-to-proactively-write-you-morning-briefs/] [snippet: https://openai.com/index/introducing-chatgpt-pulse/]
- **Reads:** Memory and past chats (if memory on). With Gmail and Calendar connected, scans mail overnight and builds an agenda. Those connectors are off by default and toggled in settings. [fetched TechCrunch URL above; "off by default" is snippet of the openai.com page]
- **Channel:** A tab in the ChatGPT app, shown as visual cards. Opening a card lets you ask follow-ups. [fetched TechCrunch]
- **Questions:** None documented. Steering is by "curate" (request what you want in future editions) and thumbs up/down, with a viewable and deletable feedback history. [snippet: openai.com page]
- **Memory:** Draws on saved memories and chat history, which must be enabled. [snippet: https://help.openai.com/en/articles/12293630]
- **Acting:** Read-only research cards that cite sources. No actions documented. [fetched TechCrunch]
- **Interruptions:** A hard cap: it stops after a few cards with "Great, that's it for today." The product lead said this is intentional, to differ from engagement-driven apps. Items expire after 24 hours unless saved (the 24-hour expiry is from search summaries only). [fetched TechCrunch]
- **Failure modes (users, not OpenAI):** Old items (a 2023 paper), repeated topics requested months earlier, broken or mismatched links (arXiv/GitHub 404s), one suspected fabricated entry, thumbs feedback too coarse, a long unsolicited checklist judged "extreme and unnecessary." [fetched: https://community.openai.com/t/what-has-chatgpt-pulse-done-to-help-you/1371024]

## 2. Google CC and Gemini scheduled actions
**CC** (Google Labs, 16 Dec 2025, US/Canada waitlist, consumer accounts)
- **Triggers/channel:** A "Your Day Ahead" email every morning. Also reacts when you email it or add it to a thread via a +cc address. It only ever emails you. [fetched: https://blog.google/technology/google-labs/cc-ai-agent/ ; https://9to5google.com/2025/12/16/google-labs-cc/]
- **Reads:** Gmail, Calendar, Drive, web. [fetched blog.google]
- **Questions:** None documented. You teach it by replying: share details about yourself, correct it, save ideas, add to-dos. [fetched 9to5google]
- **Memory:** "Remember" requests via reply; the mechanism is not described. [fetched 9to5google]
- **Acting:** Prepares email drafts and calendar links; no auto-send documented. [fetched blog.google]
- **Interruptions:** Thumbs up/down in the daily email; disconnect anytime from account connections. [fetched 9to5google]

**Gemini scheduled actions** (rolled out 6 Jun 2025, Pro/Ultra and some Workspace plans)
- **Triggers:** Time-based only, using a prompt you write (examples: wake-up summary of calendar and unread mail). [fetched: https://blog.google/products-and-platforms/products/gemini/scheduled-actions-gemini-app/]
- **Channel:** Device notification on mobile; unread chat on web. Preparation starts within the hour before delivery, so fast-changing data goes stale. [fetched: https://support.google.com/gemini/answer/16316416?hl=en-GB]
- **Interruptions:** Max 10 active; pause without deleting; a schedule may auto-turn-off after inactivity; needs "Keep activity" on. [fetched Gemini help]
- **Questions/memory/acting:** None documented beyond edits made in the schedule's chat persisting.

## 3. Poke (The Interaction Company)
- **Triggers:** Daily ~8am overview (calendar, emails needing attention, notes); event-based alerts for important or human-sent emails; custom automations. [fetched hands-on: https://www.producthunt.com/p/general/a-week-with-poke-review-a-promising-start-for-a-proactive-ai-assistant]. Company: automations can check every incoming email. [fetched: https://techcrunch.com/?p=3110530]
- **Channel:** iMessage (via Linq), SMS, Telegram, WhatsApp only in some markets. [fetched TechCrunch] Official page: "Get started with just a text." [fetched: https://poke.com]
- **Questions/onboarding:** A "bouncer" negotiates your price and roasts you using details from your email. Setup asks you to connect email accounts. [fetched Product Hunt; fetched: https://tanishasrivatsa.substack.com/p/i-spent-30-minutes-arguing-with-a]
- **Memory:** Long-term memory across conversations (reviewer's observation, not a documented spec). [fetched Product Hunt]
- **Acting:** Reviewer's automation drafted and sent a reschedule email with no approval step. Poke "can reply on your behalf" per the reviewer. No approval flow documented. [fetched Product Hunt]
- **Interruptions:** Rate limits are plan-gated, not behavioral. No quiet-hours or budget controls documented. [fetched poke.com]
- **Failure modes:** Roasts drawing on email details (parents, alt accounts) felt unsettling; a cofounder admitted it "gets a little too mean"; Twilio flagged its links as scams, killing SMS replies. [fetched Substack]. Reviewer said it repeated itself and did not seem to learn (one commenter). [fetched Product Hunt]

## 4. Sunsama, Motion, Reclaim
- **Sunsama (triggers/questions):** Daily planning is a ritual you open. The beta agent asks "Tell me about yourself" at setup (plus theme days), then each session you say what matters today and obstacles. It asks only if it needs your shutdown time; unanswered, it continues. Planning takes 2-4 min. [fetched: https://help.sunsama.com/docs/daily-planning]
- **Sunsama (acting/memory):** "Judgement calls" are keep/move/discard; undo per action or whole run; standing "Rules" are saved. [fetched same]
- **Sunsama shutdown:** You set the time in morning planning; an in-app notification prompts review, reflection and wrap-up. Prompts and unfinished-task handling not documented in what I could read. [fetched: https://roadmap.sunsama.com/changelog/daily-shutdown]
- **Motion:** Auto-scheduling continuously updates when meetings, priorities or deadlines shift. Overrides, locking and recalculation frequency are not documented there. [fetched: https://www.usemotion.com/help/time-management/auto-scheduling/concept-auto-scheduling]
- **Reclaim:** Habits are placed on your calendar and moved automatically for conflicts (PTO, meetings), with per-habit windows, flexibility and priority. Locking not stated. [fetched: https://reclaim.ai/daily-habits]
- **Channel:** your calendar. Neither asks questions; the calendar is the interface. [inference]

## 5. Health coaches
- **Fitbit/Google coach (public preview, 28 Oct 2025):** A skippable 5-10 minute text or voice onboarding on motivations and goals. Weekly notification with plan recommendations; Today-tab updates after waking, after a workout and before bed. Adjusts for injury or a late day; remembers workout feedback; reads sleep, HRV, resting HR and more. Setting goals in conversation. [fetched: https://blog.google/products-and-platforms/devices/fitbit/personal-health-coach-public-preview/]
- **Oura Advisor:** User picks tone (conversational vs direct) and check-in frequency; stores "Memories" (e.g. knee surgery) viewable and deletable in Settings; offers goal-based plans. The official blog does not call it proactive; Readiness messages invite you into Advisor. "Thinks when you're not active" appears only in secondary coverage [snippet]. [fetched: https://ouraring.com/blog/oura-advisor]
- **WHOOP:** Announced (May 2026) "My Memory" (view/edit/delete personal context) and "Proactive Check-Ins" (automated recommendations from daily behavior, trips, sleep/recovery trends). Rollout was expected "this summer"; I have no confirmation it shipped. Channel, frequency and thresholds not specified. [fetched secondary write-up: https://www.digitalhealthnews.com/whoop-expands-health-platform-with-on-demand-clinician-access-new-ai-features]
- **Bevel:** Official help: schedule-driven check-ins you set (e.g. 8am morning report), daily/weekly/monthly summaries, can be asked to "check in later" to update a plan; long-term memory of goals, injuries, preferences. It explicitly lists real-time threshold notifications as a current limitation. [fetched: https://help.bevel.health/en/articles/11586817]. Third-party claim of proactive check-ins in v3.0 is unconfirmed. [snippet]

## 6. Others
- **Lindy:** Triages inbox, preps from past email/calendar, drafts replies "You review, and you send"; iMessage headline channel, shared memory across channels. Questions/approval settings not documented there. [fetched: https://www.lindy.ai/blog/lindy-assistant-launch]
- **Superhuman:** Auto Reminders resurface unanswered sent mail; Auto Drafts adds a follow-up draft before the reminder returns (Business plan). [snippet only: https://help.superhuman.com/hc/en-us/articles/40144492186515]

## Cross-cutting patterns
1. **Prepare in advance, deliver at a predictable time.** Pulse overnight; CC every morning; Gemini prepares in the hour before. (sources above)
2. **A visible end to the feed.** Pulse's "that's it for today"; Gemini caps 10 schedules and auto-pauses inactive ones.
3. **Steer by reply or low-friction feedback, not settings.** CC reply-to-teach; Pulse curate; Sunsama "say what matters." Pulse users still found thumbs too coarse.
4. **Memory the user can see and delete.** Oura Memories; WHOOP My Memory (announced); Bevel feedback-shaped memory.
5. **Draft, don't send, for outbound mail.** CC drafts, Lindy "you review." Counterexample: one Poke reviewer's automation sent on its own.
6. **Ask little, and in-flow.** Sunsama asks only when blocked and continues if ignored; Fitbit's interview is skippable. [inference: the pattern is "questions never gate the product"]
7. **Connectors opt-in, disconnectable.** Pulse Gmail/Calendar off by default [snippet]; CC disconnect anytime.
8. **Calendar engines act silently but reversibly.** Reclaim/Motion move blocks automatically; undo and lock semantics vary and are not documented in the pages read.

## Failure modes
- **Stale or repeated content, broken links, hallucination (Pulse):** community thread above.
- **Creepiness from showing off what it knows (Poke):** Substack above.
- **Channel fragility:** Twilio scam-flagging killed Poke SMS (Substack); CC links reportedly break in Gmail mobile [snippet: https://www.remio.ai/post/google-cc-review-is-this-the-ai-productivity-agent-your-inbox-needs].
- **Staleness by design:** Gemini warns prepared responses can be out of date. [fetched Gemini help]
- **Gap:** I found no primary data on notification fatigue or opt-out rates for any product. Bevel's "too many notifications" App Store review is snippet-only and unverified.
