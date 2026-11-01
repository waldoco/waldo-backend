
# Waldo agent build plan
2026-10-18 ·
Waldo keeps one brain per user and adds a small set of worker objects for long jobs, untrusted reading and execution. Its first cohort is Indian, so launch centres on life chores run on India's own rails (UPI hand-off, Swiggy's official agent servers, email and SMS) rather than browser automation; the rest of the work is the harness, the memory fixes, and a browser stack sized to real usage.
## At a glance
Channels, memory and authority stay in one OwnerDO per user; task workers and the hands broker are replaceable and hold no authority.
## What changed in this revision
-
India first. The first cohort is Indian: an India launch pack of 18 chores (nine general, nine health), UPI payments the owner approves with their own PIN, Swiggy's official MCP servers for food, groceries and table bookings, and WhatsApp as the main chat channel in India on Meta's official API, with the app holding approvals and memory. Depth comes from one corridor: health, the day plan, food and care.
-
Chores and family, not productivity. Positioning follows the market read that most people want load off their life, not calendar optimisation; parents' bills and medicines are a core use.
-
Multiple objects per user, one brain. OwnerDO stays the only authority; per-job task workers and a per-user hands broker take the long, parallel, untrusted and execution work.
-
Memory is kept and fixed, not replaced. Claims rows in SQLite stay the source of truth; markdown files become rendered views; Cloudflare Artifacts is not used for personal memory because it cannot erase a single fact.
-
Connectors first: native APIs and official MCP servers, a connector broker for the long tail, and one Waldo connect page for every sign-in.
-
One escalation ladder with a cost per rung: memory, connector, email, fetch, browser, sandbox, owner's Mac, human.
-
Browser need revised down 7–15× to about 38–94 browser-hours a month for 50 users; Browserbase Developer with free TinyFish fetch first.
-
Proactive work is read-only. Heartbeat, triage and the nightly memory pass run in reader workers; the brain decides what to deliver or write.
## What Waldo does at launch
Launch on ten core jobs that run on official APIs and the owner's email, plus the India pack in the next section; booking, cancelling and checkout wait for partners or a browser handoff. Demand data points at everyday admin: owners have given agents access to email (36%) and calendars (27%), email drafting is a top use (47%), and managing meetings costs about 3 hours a week ([Menlo Ventures 2026], [Reclaim]). Menlo's finding on money and institutions: "Capability isn't the issue… The constraint is trust."
|
# |
Job |
How often |
Path |
Cost class |
|
1 |
Morning brief |
Daily |
Gmail/Graph + Calendar + derived health state + fetch for weather and news |
API |
|
2 |
Health-aware day planning |
Daily |
HealthKit / Health Connect / Oura derived state + Calendar; honest when health data is missing |
API |
|
3 |
Inbox triage |
Daily |
Gmail API / Microsoft Graph |
API |
|
4 |
Reply drafting, send on approval |
Daily |
Gmail drafts / Graph |
API |
|
5 |
Scheduling and rescheduling |
Weekly+ |
Calendar free/busy + email |
API |
|
6 |
Meeting prep |
Daily |
Calendar + email threads + Drive |
API |
|
7 |
Reminders and follow-ups from email commitments |
Daily |
Waldo scheduler + email |
API |
|
8 |
Bill and subscription radar; cancellation as a guided handoff |
Monthly |
Email parsing; Plaid later |
API |
|
9 |
Package tracking and return windows |
Weekly |
Email parsing + a tracking API |
API |
|
10 |
Health-admin radar: appointment confirmations, refill timing, drafted appointment requests |
Monthly |
Email + HealthKit Medications |
API |
Deferred: restaurant, doctor and salon booking, grocery checkout, form filling and cancellation execution. Each is partner-gated (OpenTable, Zocdoc, Instacart has no checkout tool) or needs a browser, a phone call or a human. They come in once the core is built and tested: through Waldo's own browser rung, partner APIs where they open, or a voice or concierge rung for businesses with no app.
## India first cohort
India is open for a capable personal agent: Meta's Muse is US and Canada only, Instinct is US-run and open to users, and Faff covers Bengaluru and Mumbai with human operators at ₹1,999 a month. Waldo wins it by running chores on India's own rails, keeping the owner's PIN on every payment, and caring for the family, not by optimising calendars.
### What Ishaan Preet Singh's thesis means for Waldo
From ["Personal Agents / Consumer is Back"] (Lightspeed India, 2026-09-21):
-
Chores, not productivity. "Work is the chore": most people don't want calendar optimisation or agents coordinating with each other. Pitch Waldo as taking load off life: bills, medicines, parents, home.
-
High-frequency needs speed. Food, groceries and going out need a fast path, so use Swiggy's official MCP servers rather than browsing.
-
Specialist depth beats horizontals. He names health, finance, travel, learning and shopping. Health is Waldo's vertical; Muse's health depth is thin: Wired's April 2026 test of Meta's Muse Spark model reported "terrible advice", and the Muse agent's health actions are records summaries, refill reminders and drafted doctor messages, US only.
-
Countries are a vertical. Indian apps often have no web app and many needs are multilingual, which favours APIs, deep links and Indic voice over browser automation.
-
Humans in the loop, later. A concierge rung for chores that need calls or judgment (Faff, Instinct Concierge).
-
Compute is the constraint. He puts it at $20–30 per active user today; pricing in rupees only works API-first with side jobs on cheap models.
### India launch pack
|
# |
Job |
How |
Rail |
|
1 |
Dues radar: card statements, utility bills, recharge expiry, rent, society maintenance |
Email and SMS forwards; reminder plus a UPI or app deep link |
Email, UPI hand-off |
|
2 |
Subscription and mandate audit: free AI years about to auto-renew, duplicate streaming plans, low balance before SIP or EMI debits |
Receipts and mandate emails |
Email |
|
3 |
Medicines for self and parents: refill calendar, checkup reminders, fasting lab tests in the day plan; never dosing advice |
Prescriptions and order emails, uploads |
Email |
|
4 |
House-help ledger: attendance, leave and advances turned into the monthly salary |
Chat or voice log; UPI hand-off to pay |
UPI hand-off |
|
5 |
Renewals and documents vault: insurance, PUC, passport, FASTag pass expiries; claim checklists |
Uploads now, DigiLocker later |
Uploads |
|
6 |
Refund and return chaser: return windows, refund dates, drafted escalations |
Order emails |
Email |
|
7 |
Tax and money calendar: Form 16, AIS, ITR deadlines, advance tax and SIP dates; a document bundle for the CA |
Email, uploads |
Email |
|
8 |
Food, groceries and table bookings: reorders, dine-out and health-aware meal suggestions; no health data is sent to Swiggy |
Swiggy Food, Instamart and Dineout MCP servers with OAuth |
MCP |
|
9 |
Travel and festival prep: Tatkal alarms (10:00 AC, 11:00 non-AC), saved passenger lists, occasion calendars and gift lists |
Scheduler and memory |
— |
|
10 |
Lab tests and annual checkup: home sample collection, fasting window in the day plan, report filed, retest date set; uses the ₹5,000 80D checkup allowance |
Lab emails and report PDFs; Waldo holds the morning slot |
Lab deep links (Healthians, Redcliffe, Orange Health, Thyrocare), calendar |
|
11 |
Sick-day cascade: "Mom has fever" becomes a teleconsult link, a pharmacy cart once there is a prescription, cleared meetings, light food, a leave email or school note, and an evening check-in; never a diagnosis |
One message; Waldo proposes the plan, the owner approves |
Teleconsult links (Practo, eSanjeevani, Apollo 24/7), calendar, Swiggy, mail drafts |
|
12 |
Doctor visit prep and follow-through: questions to ask and what changed since the last visit; afterwards the prescription photo becomes refill dates, a follow-up booking and tests |
Uploads and chat log; the owner shows the summary to the doctor |
Calendar, uploads |
|
13 |
Health insurance upkeep: every household policy (own, employer, top-up, parents) with renewal and portability windows, the cover gap on a job change, network-hospital check, missing-document checklist, pending-claim chaser, appeal drafts citing IRDAI rules, 80D receipts to job 7 |
Insurer and hospital emails, policy PDFs |
Email, uploads; WhatsApp claim channels where insurers offer them |
|
14 |
Children's vaccines and checkups: IAP schedule from date of birth, booking reminders, school medical forms |
Scheduler and memory |
Scheduler, uploads |
|
15 |
Body-aware day: after a short night or low recovery, move one block, protect a sleep window, find a walk slot; works with a wearable or a one-tap check-in |
Health zone words or a check-in |
Calendar, with approval |
|
16 |
Fasts and festivals: meals timed around Navratri, Ramzan or Ekadashi fasts, workouts shifted; medicine-timing questions go to the doctor |
Calendar and memory |
Calendar, Swiggy |
|
17 |
Bad-air and heat days: outdoor run moved indoors, masks or purifier filters restocked, a heads-up to parents |
An air-quality feed (commercial licence needed) |
Calendar, Instamart |
|
18 |
Parent daily check-in: a short WhatsApp check-in with an elderly parent; a missed reply alerts the child |
The parent's own WhatsApp, opted in; needs the consent design first |
WhatsApp |
Demand signals: 12.3 crore credit cards, recharges every 28 days, about 3.5 Blinkit orders per user a month, 20M+ UPI mandates revoked a month for low balance, ₹32,490 crore of SIPs a month, and only 25% of health-insurance claims fully paid first time (sources at the end).
### Health jobs: who does them today
Every health job already has a strong single-app player, and the hardest ones have human help desks. No product found reads the calendar or inbox and then finishes the job in another app. That cross-app follow-through is Waldo's opening.
|
Job |
Leaders today |
What they do |
Gap for Waldo |
|
3 Refills |
Truemeds, PharmEasy Plus, Tata 1mg, Apollo 24/7, Amazon Pharmacy |
Discounts, cheaper brands, delivery; ordering is manual |
Know when a medicine runs out, compare, reorder on the owner's yes |
|
10 Labs |
[Healthians] (₹263 cr FY25), [Redcliffe] (₹419 cr), Orange Health |
Book on request, home collection, report in their app |
Schedule around fasting and meetings, chase results, set the retest |
|
11 Sick day |
[Practo] (from ₹199), eSanjeevani (free) |
One consult |
Nobody chains consult, medicine, calendar and the note to work or school |
|
12 Visit prep |
[Eka Care], Aarogya Setu 2.0 |
Store records, AI summaries of records |
No pre-visit brief from records, symptoms and trends |
|
13 Insurance |
[Policybazaar] (2.45 lakh health claims supported in FY26), [Ditto], [Beshak], [ACKO], [Plum], [Loop] |
Human claim desks after you ask; insurer apps see one policy; group platforms see only employer cover |
One register of all household policies that acts before deadlines |
|
14 Vaccines |
U-WIN (government) |
SMS before each dose, slot booking |
Private-clinic doses and calendar fit |
|
15 Body-aware day |
WHOOP, Oura, Ultrahuman, [Lifestack] ($7 a month) |
Advice; Lifestack alone schedules around recovery |
No wearable maker moves the calendar |
|
16 Fasts |
Healthify (orders Swiggy meals in its own app), Fitterfly |
Diet plans |
Plans that know the fast, the owner's conditions and meetings |
|
17 Bad air |
SAMEER (pollution board), IQAir, [aqicn] |
Air-quality numbers and alerts |
Nobody moves the run or restocks masks |
|
18 Parent check-in |
[Anvayaa], [Samarth], Emoha, Khyaal |
Human care managers and check-in calls |
A cheap automated check-in that escalates to family |
### Which health jobs are worth most
Refills, insurance upkeep and lab tests come first. Many households have them, they recur, real money moves through them, and they share one build. That build is a household health register: medicines, policies, tests and their dates, filled from mail, uploads and chat, with reminders and prepared carts on top. One register serves three jobs, so build it once.
|
Job |
Who has it |
Money or pain |
Build |
Verdict |
|
3 Refills |
Every household with a chronic condition; 32% of Indians over 60 have diagnosed hypertension |
About 39% of Indians with type 2 diabetes don't take medicines as prescribed |
Small, on the register |
Launch |
|
13 Insurance upkeep |
Every insured household, plus employer cover |
Average claim ₹28,910; only 25% of claims paid in full the first time |
Medium: reading mail and PDFs, no insurer APIs |
Launch renewals and claim chasing; appeals after |
|
10 Labs |
Chronic patients quarterly, everyone yearly |
Lab spend; missed follow-ups |
Small, on the register |
Launch |
|
11 Sick day |
About 13% of people in any two weeks |
Stress, lost work days |
Medium: chains tools that exist |
Launch; the best demo |
|
15 Body-aware day |
Wearable owners, or anyone via a check-in |
Unproven |
Mostly built |
Launch as the differentiator, not the revenue |
|
14, 16, 17 |
Parents, people who fast, North India in winter |
Delight |
Small; air data needs a licence |
Cheap additions |
|
12 Visit prep |
Chronic patients |
Opens the doctor channel |
Needs a data review first |
After launch |
|
18 Parent check-in |
Families with elderly parents |
Families pay ₹8,000 to ₹15,000 a month for coordination |
Large: consent, a second person |
After the consent design |
### Where the money comes from, and the B2B path
The consumer subscription carries the core. Partner revenue comes from the rails Waldo needs anyway, and B2B follows once the loops prove themselves [inference].
|
Buyer |
Pays for |
Waldo's role |
When |
Watch-out |
|
Pharmacies and labs |
Orders and bookings: affiliate or revenue share |
Prepares carts and bookings |
Now; they are rails anyway |
Disclose it; never steer by margin |
|
Employers, through benefits platforms (Plum 600k lives, Loop 950k+, Onsurity 2M+) |
Employees and their parents using cover well, claims handled |
Benefits helper for each employee: claims, checkups, refills, parents |
First B2B pilot, after consumer proof |
The employer never sees health data, only usage counts. The vault ruled employers out as the first buyer for surveillance risk, so this comes second |
|
Insurers and brokers |
Renewals kept, cleaner claims, fewer complaints |
Renewal and claim upkeep |
After launch, with retention data |
Commission on selling a policy needs an IRDAI licence; stay non-selling or partner with a licensed broker |
|
Pharma and device makers |
Adherence programs (the Wellthy model) |
Refill and lab loop for one condition |
Later |
No promotion, no dose advice |
|
Elder-care services |
An automated layer for their members |
Daily check-ins and logistics; their humans stay |
Later |
The parent's consent |
|
Hospitals and clinics |
Follow-ups completed, prepared patients |
Visit prep, follow-up booking |
Later; doctors are a referral channel first |
AI may not counsel or prescribe under the telemedicine rules |
The largest B2B prize is employee benefits. Group cover already reaches millions, it renews yearly, and it extends to parents, so it spans most of the health jobs above [inference].
### Rails: ship, partner or blocked
|
Rail |
Status for Waldo |
Action |
|
UPI payments |
Waldo prepares a UPI intent link or QR; the owner pays in their own UPI app with their PIN; Waldo never asks for an OTP |
Ship |
|
Agentic UPI (Reserve Pay, NPCI agent registry) |
Closed pilots with ChatGPT and Claude through Razorpay; the registry is not launched |
Join early access; don't build our own payment path |
|
Swiggy Builders Club |
3 MCP servers, 51 tools; open to startups; free prototyping; production review about two weeks; OAuth ([site]) |
Prototype now, apply for production; matches the brain repo's April Swiggy note (03-References/blogs/swiggy-mcp-connector-ecosystem.md) |
|
Zomato MCP |
Redirects allowlisted only for Claude, ChatGPT and VS Code; the brain's April note rated it high priority, which no longer holds |
Blocked |
|
Bharat Connect bill payment |
Only through an agent institution; Setu offers a bill-pay MCP through sales |
Partner (Setu) |
|
Account Aggregator |
Waldo cannot be a data user without RBI, SEBI, IRDAI or PFRDA regulation |
Partner later; accept uploaded statements |
|
DigiLocker |
Requester access by application through API Setu |
Apply |
|
ABDM personal health record app |
Private apps allowed after NHA testing and a CERT-In audit; months |
Start now |
|
ONDC buyer app |
Heavy Beckn onboarding and grievance duties |
Defer |
|
IRCTC |
Licensed agents only; Tatkal needs Aadhaar OTP |
Preparation only |
|
Indic voice |
Hinglish works on current models; Sarvam speech-to-text ₹30 an hour, text-to-speech ₹30 per 10k characters |
Ship for voice notes |
### Channels in India
-
WhatsApp: Meta's ban on AI-primary providers applies in India; only Europe was reopened. The ban covers businesses whose primary product is the AI assistant; businesses that use AI to serve customers are allowed. Faff runs on WhatsApp because it presents itself as a task-execution service with human assistants, where AI is a means. Waldo can take the same route for chore updates and reminders, at Meta's sole discretion, with the app kept as the home for approvals and memory.
-
RCS: through a messaging platform (Tanla, Route Mobile, Sinch) with Google agent verification, about ₹0.15–0.35 per message.
-
SMS and calls: transactional SMS needs DLT registration; service calls must come from 1600-series numbers.
-
iMessage: iPhones are a minority of Indian phones, so not a launch channel for this cohort.
### Pricing and unit economics
-
Anchors: AI plans ₹199–399 (ChatGPT Go, Google AI Plus); Faff ₹399 for 8 human tasks or ₹1,999 unlimited; streaming ₹79–149. Free AI years from Airtel, Jio and OpenAI end from November 2026, which will show what Indians pay for.
-
Proposed: free tier with the dues radar and one vault; Waldo ₹199 a month or ₹1,499–1,999 a year; family plan ₹349–399 a month for 2–4 members covering parents' bills and medicines; billed by UPI AutoPay.
-
The gap: ₹199 is about $2.40, so a typical user's model and infrastructure cost must stay under about $1.50 a month. Phase 1 telemetry decides between ₹199 and ₹399, or routes more owner turns to the cheaper model.
### Compliance
DPDP Rules 2025 duties apply from 13 May 2027: itemised consent notices, verifiable parental consent for under-18s, and a breach report within 72 hours. Build the consent ledger, age gate and breach runbook now; they are cheap before launch and expensive after.
## WhatsApp in India
WhatsApp becomes Waldo's main chat channel in India, on Meta's official Cloud API. The app stays the home for setup, connections, memory review, live view, and any approval that needs more than a yes or no. Waldo applies to Meta as what it is: a service that does the owner's chores, bills and health planning, where the model is how the work gets done. Meta decides, so Telegram, RCS and the app stay ready if the number is refused or banned. One OwnerDO holds the conversation, so losing a channel loses no state.
### What WhatsApp carries
-
Owner-started chat: free. Inbound messages are free, and so is every reply inside the 24-hour customer service window ([Meta pricing]).
-
Proactive messages outside the window: a template the owner opted into. A utility template is charged per message outside the window and is free inside it. Reminders the owner asked for fit utility. A daily brief may be reclassified as marketing, so the brief goes to app push, and WhatsApp gets a one-line knock.
-
Approvals: reply buttons (up to 3) for reversible or low-value steps. Payments go out as UPI intent links, so the owner's PIN in their UPI app remains the real gate. Sending mail as the owner, orders above the owner's limit, and anything irreversible open a signed card in the app.
-
Forwards: any message carrying the Cloud API's forwarded or frequently_forwarded flag is content to file, never an instruction (see Forwards and saved links).
-
Voice notes in Hindi, Hinglish and regional languages go to the shared transcriber, then into the same turn.
### What beta-mvp already ships
|
Piece |
State at 3a727acf |
Gap before launch |
|
Cloud API send and receive, HMAC check on x-hub-signature-256, 7-day message-id dedup |
Wired (whatsapp-webhook.ts, whatsapp-api.ts) |
Client pinned to Graph v21.0, which Meta retires on 21 January 2027 ([versions]); move to v26.0 |
|
Owner binding: signed route_presence lookup plus a one-time waldo CODE from the console |
Wired; forwarded codes ignored |
None |
|
24-hour window: hold messages, send one knock template per closed window, deliver on the owner's next reply |
Wired (whatsapp-window.ts) |
Template name is empty in production and staging, so no knock is sent; create and approve one utility template |
|
Forward detection and labelling |
Wired and tested; a forward never runs as a command or an approval |
Forwards do not become backlog items yet |
|
Voice notes and captioned images in |
Wired |
Documents, video and button replies are skipped; accept PDFs (bills, prescriptions) |
|
Approvals |
Text replies (reply "a:p12") |
Native reply buttons and lists exist only in tests; wire them |
|
Files out |
Upload code exists, no caller |
Wire for bills, checklists and the CA bundle |
|
Proactive delivery |
Only when WhatsApp is the owner's only channel |
Route by owner preference: app push for the brief, WhatsApp for chores they asked about |
## Faff and Waldo
Faff shows that Indians will pay ₹399–1,999 a month to text chores to WhatsApp. Waldo should match its everyday breadth with agents and official rails, and beat it on what Faff lacks: health, connected accounts, memory the owner can correct, and acting before being asked. [Faff] describes itself as "an ai assistant that gets things done, and loops in real humans when it helps". It covers 30+ categories, is open across India (its terms still name Bengaluru and Mumbai), and reports 75k+ tasks. It costs ₹1,999 + GST a month for unlimited tasks, or ₹399 + GST for up to 8. It declines business work, house-help interviews, visas and house hunting.
|
Faff category |
Faff's examples |
Waldo's route |
Human or call needed |
|
Food, groceries, going out |
Weekly grocery restock, table for 6 |
Swiggy Food, Instamart and Dineout MCP |
No |
|
Bills and reminders |
Rent reminder, bills |
Dues radar from email; UPI intent link |
No |
|
Health |
Getting meds, doctor recs and appointments, checkup reminders |
Refill calendar, prepared pharmacy cart, Practo deep link, checkups in the day plan |
Clinics that only take calls |
|
Renewals and admin |
Car insurance renewal, tax |
Renewals vault, quote comparison by search, CA bundle |
No |
|
Shopping and refunds |
Sourcing, refund chasing, gifting |
Search, occasion calendar, drafted escalations |
Sellers that only answer calls |
|
Travel and transport |
Cab to the airport, flights, parcel to Bandra |
Search plus prefilled deep links; Tatkal alarms |
No |
|
Home repairs |
Plumber for tomorrow |
Urban Company and Snabbit have no web app |
Yes: calls or a partner |
|
Wake-up and nudge calls |
"Wake me up at 5am" |
App alarm or push |
A voice call only if asked |
### The general-agent bar
-
Take any chore in plain words or a voice note. Within a minute, say what Waldo will do, what it needs, and what it won't do.
-
Give every accepted chore a status and an end: done, handed back with what is left, or failed with the reason.
-
Pay without credentials: UPI intent or pay links, never a password or OTP in chat. Faff instead pays providers from a prepaid wallet.
-
Reach businesses with no app. This needs an outbound voice-call rung (Indic speech, owner-approved script) or a concierge partner. Waldo has neither today.
-
Work anywhere in India by using national rails (Swiggy, UPI, Practo, IRCTC preparation), not local supply.
### What only Waldo has
-
Health-aware planning: Form, Recovery and Load from wearables shape the day, meals and checkups (Deep verticals).
-
Connected accounts: mail and calendar reads find bills, orders, renewals and refund windows before the owner texts.
-
Memory the owner can see and correct: pinned profile and facts, edited in the app, used on every turn.
-
Family: a Trusted Relationship can carry a parent's refills and checkups without sharing either owner's memory.
-
Price: agents do the work and humans only take the rare rung, which keeps ₹199 a month viable.
## Deep verticals
Go deep on one corridor: health signals shape the day, the day shapes food, and food and care close the loop. Ishaan splits verticals into high-frequency ones that win on speed (food, groceries, going out) and specialist ones that win on data and rules (health, finance, travel). This corridor is both. Food is Waldo's daily surface, and health data is what no horizontal agent uses well. He wants a health agent that does more with the data: reading blood tests, linking Apple Health, sending a trainer. That is this corridor.
|
Vertical |
How often |
Waldo's edge |
Launch depth |
|
Health and the day plan |
Daily |
Form, Recovery and Load from wearables; calendar Load |
Deep: brief, moved blocks, walk and sleep windows |
|
Food and groceries |
Daily to weekly |
Meals fitted to the day and the owner's diet claims |
Deep: Swiggy Food, Instamart, Dineout |
|
Care: medicines, checkups, parents |
Monthly |
Refill dates, lab-test prep, Trusted Relationship for a parent |
Deep: refill carts, checkup reminders, fasting plans |
|
Money dues |
Monthly |
Mail reads and UPI hand-off |
Launch pack jobs 1, 2 and 7 |
|
Travel |
A few times a year |
Memory of preferences |
Preparation only: Tatkal alarms, packing, deep links |
|
Shopping, learning, investing |
Varies |
None yet |
Not at launch |
### Where the verticals meet
Signals stay inside Waldo. Each partner receives only what its order needs.
|
Signal |
What Waldo does |
Rails |
What leaves Waldo |
|
Short night and a heavy calendar |
Moves deep work to the morning peak and finds a 20-minute walk slot. Prefills a light, high-protein lunch for the 1 pm gap |
Calendar proposal, Swiggy Food cart |
Calendar times and a dish order |
|
Hard workout logged |
Adds curd, eggs and fruit to the next Instamart order and suggests a fuller dinner |
Instamart cart |
Grocery items |
|
Recovery low three days running |
Proposes moving the 7 am run, an earlier sleep window and a lighter Friday. If the owner reports symptoms, offers to book a checkup; never a diagnosis |
Calendar, Practo deep link |
Calendar times |
|
Fasting lab test on Saturday |
Plans a fasting window, holds the usual breakfast order, reminds the night before, and has breakfast ready after the test |
Scheduler, Swiggy Food |
A delivery time |
|
Parent's refill due in five days |
Builds the pharmacy cart, sends a UPI link, and tells the parent through their own Waldo |
Pharmacy deep link, UPI, Trusted Relationship |
The item list, to the pharmacy |
|
Navratri or Ramzan fast |
Suggests meals that keep the fast, shifts workouts, and moves dinner orders to after sunset |
Calendar, Swiggy |
Dish orders |
|
Friday out with friends |
Books a to-try place from the backlog, then plans a lighter Saturday breakfast |
Dineout |
A booking |
### Rules for this corridor
-
No health value, band or reason ever goes to Swiggy, a pharmacy or a calendar invite. Partners see only the order.
-
The prompt sees zone words, and get_health numbers stay turn-only, as built today.
-
Meal ideas are food choices, not clinical nutrition. Allergies and diets are claims the owner confirms. Medicines get dates and carts, never dose advice.
-
Lab reports go to the Supabase health plane, never DO memory. Waldo sees bands, not values. Persisting lab values needs its own contract review under ADR-0081.
## Forwards and saved links
"Forward it to Waldo" becomes the capture habit. Waldo reads the item and files it as an open loop with a type, a one-line reason and a goal link. It brings the item back when the owner can act on it. After 30 days untouched, Waldo asks once whether to keep or drop it, so the backlog shrinks instead of growing. People rarely return to what they save: one study found only 16% of bookmarked pages were later reached through the bookmark ([Bergman et al. 2020]). Pocket shut down in July 2025 ([Mozilla]). WhatsApp built "Message yourself" for notes, reminders and lists ([TechCrunch]), and Waldo can be that chat with follow-through.
### Capture and reading
|
Source |
How Waldo gets it |
How Waldo reads it |
State at 3a727acf |
|
WhatsApp forward |
Owner forwards to Waldo's number; the forwarded flag marks it as content |
Text as is; links go to the reader below |
Detection wired; filing missing |
|
Web article |
Shared link |
Search-and-fetch rung, then a cloud render only if the page needs JavaScript |
Page reads are staging-only |
|
X post or X Article |
Shared link, or the owner's bookmarks via X OAuth |
Official X API pay-per-use: $0.005 a post read, $0.001 for the owner's own bookmarks ([X pricing]) |
Missing |
|
YouTube |
Shared link |
Title and description through the Data API; a full transcript only where licensed |
Missing |
|
Instagram reel |
Shared link |
Only the caption the owner shares; Meta's oEmbed is for embedding ([Meta]) |
Missing |
|
Screenshot or photo |
WhatsApp or app |
The model reads the image |
Images wired |
|
Voice note ("remind me about that course") |
WhatsApp or app |
Transcriber |
Wired |
Waldo does not use FxTwitter in production. It works from logged-in X session cookies ([FxEmbed]), and X's terms forbid scraping without written consent ([X terms]).
### Filing
-
Type: to-do, to-read or watch, to-buy, to-try (a place or recipe), event, or idea.
-
Area: work, personal or family, so one list serves all three.
-
Goal link: each item ties to a goal claim ("run a 10K", "learn Spanish", "save for Goa"), or to none.
-
Store: the existing loops table, with a source kind for links and forwards beside the mail source. The owner's act of forwarding is the intent to file. Text inside the forward is never an instruction.
-
Forwarded claims: "Is this true?" on a forwarded health or news claim gets a sourced check.
### Follow-through
-
At the moment of use: a to-try restaurant returns when Friday dinner is planned (Dineout). A to-buy joins the next Instamart order. An event gets a calendar-hold proposal. A course returns at the weekly goals review.
-
Sunday review: five items ranked by goal, each with one move: do, schedule or drop.
-
Expiry: at 30 days untouched, one keep-or-drop question; a drop closes the loop as dropped.
-
Budget: at most one backlog nudge a day, outside quiet hours.
## Knowing the owner
Waldo learns about the owner from the owner. At onboarding it offers an opt-in "look me up" step that uses the handles the owner names, official sign-ins and the owner's own data exports. It shows every finding with its source, and the owner keeps, corrects or deletes each one. It does not scrape LinkedIn, X or Instagram, and it does not build profiles of other people. None of the agents checked documents a consented public-web self-research step. Poke's onboarding "roast" draws mainly on the inbox ([user account]), and ChatGPT memory draws only on the user's own chats ([TechCrunch]).
### Why consent, not the public-data exemption
-
India: DPDP s.3(c)(ii) excludes data "made or caused to be made publicly available by the Data Principal" ([Gazette]). It does not cover news or other people's posts about the owner. Merged with inbox or health context, the profile likely falls back in scope. Waldo therefore gives notice and takes consent (s.5, s.6), ahead of the duties that start on 13 May 2027.
-
EU owners: there is no public-data exemption. Art. 14 requires naming each source ([GDPR]). CNIL fined KASPR €240,000 for collecting LinkedIn data beyond what users would expect ([CNIL]).
-
Platform terms: LinkedIn bans scraping profiles ([User Agreement]). X bans crawling without written consent ([X terms]). Instagram bans automated collection without permission ([terms]).
### The flow
-
The owner opts in and names their own handles and sites.
-
Waldo reads through allowed routes only:
-
web search results for the owner's name and handles;
-
the owner's own X posts and bookmarks through X OAuth owned reads;
-
their LinkedIn data export (profile and positions, ready in minutes to 48 hours; [LinkedIn]);
-
Google Takeout for saved places and YouTube history ([Google]).
-
A reader worker drafts candidate facts ("product manager in Bengaluru", "runs 10Ks", "follows Indian startup news"), each with its source link.
-
The owner reviews the cards. Only kept items become claims with owner confirmed provenance; the rest are erased with their sources. This matches the existing rule that remember refuses evidence the owner did not author.
-
Waldo never infers health, religion, caste, politics or sexuality from public data. Meeting prep may use search results about a contact's public work role, and nothing about their personal life.
## Per-user object architecture
OwnerDO remains the single writer for memory, chats and approvals; workers run jobs and return only results or proposals. Cloudflare's Agents SDK supports this directly with subAgent() (child objects with their own SQLite, typed RPC, parallel execution; [docs]); plain Durable Objects work too.
|
Object |
How many |
Owns |
Never does |
|
OwnerDO (brain) |
1 per user |
Chats as rows, memory rows (claims, episodes) with FTS5, approval desk, schedule and heartbeat triggers, applying job results |
Run long jobs; hold browser or VM sessions |
|
TaskWorker |
1 per job, short-lived |
A sub-agent loop with a capability profile, its own alarm and checkpoints, a frozen snapshot of the context its task needs |
Write memory, send messages, approve actions |
|
HandsDO |
1 per user |
Control plane for execution: browser session allocation, at most 1–2 live browsers, daily spend budget, idle teardown, live-view links, sandbox lifecycle |
Sit in the data path (workers connect to the sessions it allocates); make decisions |
|
DeviceBridgeDO (exists) |
1 per paired Mac |
Signed WebSocket to Kennel; use_mac |
— |
|
IMessageBridgeDO (exists) |
1 per bridge |
HMAC-signed bridge and sender linking |
— |
### Worker profiles
-
reader: read tools only (mail, fetch, browse_page); returns a structured summary. Runs the heartbeat, inbox triage, background web reads and the nightly memory fold.
-
errand: browser actions through sessions from HandsDO; any submit becomes an approval card in the brain.
-
research: fans out to several reader workers in parallel and returns a sourced brief.
-
code: owns a Cloudflare Sandbox container with workspace files copied from R2.
### Job protocol
-
The brain writes the job row (goal, profile, budget, deadline, idempotency key) before any I/O.
-
The brain starts the worker with a frozen snapshot; the worker holds a lease and checkpoints each step.
-
The worker returns result or proposal events; the brain applies each once, by job ID.
-
Cancelling fences the job ID: late results are discarded and the worker releases its sessions through HandsDO.
-
Every worker has a TTL; the brain sweeps finished and abandoned jobs.
-
When a worker crashes, the brain sees the lease lapse and resumes the job once from its last checkpoint. The model decides whether to retry as is, split the remaining work across parallel workers, or move it to a heavier rung (owner's Mac or Kennel, concierge). Finished steps never run twice, because results apply once by job ID. After repeated crashes the job is parked, and the owner hears what finished, what is left and the options.
### What this unlocks
-
The owner keeps chatting while a 10-minute job runs; today the inbox drains one message at a time (owner-do.ts:490).
-
Real parallel subagents instead of delegate_task sharing one turn's budget.
-
Jobs longer than one 15-minute alarm call, and jobs that wait hours for a live-view login.
-
A crash or 128 MB memory overrun kills one worker, not the owner's turn.
-
A smaller brain tool surface: browsing, MCP and code tools live in worker profiles.
Chats stay rows in the brain; no per-chat object holds its own memory.
## Where beta-mvp stands
Audited read-only at commit 3a727acf. Production config switches most capabilities off; staging turns them on. Paths are under packages/runtime/src/ unless they start with contracts/.
|
Capability |
Status |
Evidence |
|
Brain: one OwnerDO per owner, alarm lanes, 30-min heartbeat, nightly memory pass |
Live |
channels/owner-do.ts |
|
Model + tool loop: gpt-6.1-sol for turns, gpt-6-luna for side jobs, up to 150 tool rounds, 5 subagents |
Live |
contracts/src/model/roster.ts:24, llm/time-budget.ts |
|
Approval cards for email, messages, calendar, MCP, browser submit |
Live |
channels/approvals.ts |
|
Gmail / Calendar / Tasks tools |
Live (secrets permitting) |
tools/live/google.ts |
|
Mac executor use_mac |
Live; needs the owner's Mac and Kennel |
devices/device-bridge-do.ts |
|
App threads and console chat sharing owner memory |
Live |
channels/app-threads.ts |
|
Workspace files, document render |
Staging only (production namespace is empty) |
channels/workspace-host.ts:60 |
|
Cloudflare browser (browse_page, browse_act) |
Staging only; a guard forbids a production binding |
channels/owner-browser-runtime.ts:76 |
|
Browserbase adapter |
Present; wired with undefined keys, allowBrowserbase: false |
channels/owner-do.ts:2906 |
|
Saved browser logins |
Tests only |
channels/browser-state-custody.ts |
|
Code execution / sandbox |
Absent; execute_code has no handler |
execution-environment/ is a fake |
|
iMessage |
Worker side in staging; Mac host not built |
channels/imessage/bridge-do.ts |
|
WhatsApp |
Official Meta API; no re-engage template |
channels/whatsapp-window.ts |
|
APNs push |
Contracts and tables only |
contracts/src/app/devices.ts |
|
RunLoopDO / WaldoCoordinator |
Enabled in no config; OwnerDO never calls it |
run-loop/do.ts |
|
Vectorize, Workers AI |
Bound in staging, unused |
wrangler.jsonc:121 |
|
Model provider fallback |
None (fallback: []) |
channels/owner-turn.ts:186 |
## Harness
The harness is the main drag on agent quality, and workers let the brain's harness shrink. Items marked verified were checked in source; token counts are estimates from schema sizes.
### What breaks the agent today
-
Dead end on tainted actions (verified): after any mail or web read, send_message, call_mcp_tool, use_mac and skills changes are blocked, and the error points to propose_action, which has no handler (hooks/registry.ts:584).
-
Opaque errors (verified): most refusals return hook halted or tool handler failed.
-
Context waste: 58 tools at ~15k tokens plus a ~6k-token prompt with 61 rules, about 21k tokens per round before history; the owner's message is repeated inside the system prompt, breaking the cache.
-
Speed: tool calls run one at a time (conversation/tool-loop.ts:176, verified); no streaming; compaction off; tool results dropped after 64.
-
Self-imposed weight: ~31k LOC of a dormant second brain and 16 guards for its protocol; ~17 parallel per-tool tables; 12 layers per tool call with duplicate ACL and zod checks.
-
Fixed rules making judgment calls: health keyword+number regexes blank the owner's own mail ("load 3", "form 16"); a keyword list decides "irreversible" browser actions; verbatim-quote and substring gates on memory.
### Fixes
-
Send every tainted action to the existing approval card; one error shape everywhere: {code, cause, fix, retryable}.
-
Brain tools: ~12 always loaded plus start_task and OpenAI tool_search; browsing, MCP and code tools move into worker profiles. Target under 4k tokens of tool definitions per brain round; strict: true schemas; one record per tool.
-
Parallel read calls, streamed replies, reasoning items carried across rounds, server-side compaction.
-
Byte-stable system prompt for caching; keep only the rules that change behaviour.
-
Replace in-turn delegate_task with task workers; taint follows what a worker actually read, not the whole turn.
-
Delete the dormant second brain and its guards; keep the Durable Object migration lineage.
-
Telemetry and evals from day one: tool chosen per turn, browser seconds, escalation reason, job duration and outcome; an eval suite built from real transcripts, with thresholds and ablations.
### What we take from open-source harnesses
|
Practice |
Who does it |
For Waldo |
|
Defer most tool definitions |
OpenAI tool_search with defer_loading; Claude Agent SDK; Pi |
Core tools loaded, the rest in namespaces |
|
Code mode through bindings |
Cloudflare Code Mode (2 tools, ~1k tokens), Pi codemode |
Read-heavy chains as one script in an isolate; writes stay direct calls on the approval path |
|
Durable task semantics |
pi-durable (requestId, replay: "safe", park after 5 restarts), Cloudflare fibers |
The task-worker job protocol |
|
Fixed subagent contract |
Hermes (max 10 concurrent, depth 1), Claude Agent SDK (budget caps, output scanned) |
Fresh context, summary-only return, leaves without memory or send tools, explicit caps |
|
Proactive-turn contract |
OpenClaw NO_REPLY, Hermes wakeAgent:false and [SILENT], active hours |
Data-changed check before waking the model; silence token; each recurring check its own job |
|
Serialized runs with a writer fence |
OpenClaw activeWriterRunId, steer / follow-up / interrupt queue modes |
Matches Waldo's cancellation fencing |
|
Compaction pipeline |
Hermes, OpenClaw, Goose, Responses compact_threshold |
Prune old tool output first, then a structured summary, then a memory flush |
|
Cheap models for side jobs |
Hermes model slots, Goose lead/worker |
Luna for titles, triage, flush, heartbeat |
|
Tiered approvals that fail closed |
Codex auto_review, OpenClaw, Hermes hardline blocklist |
Reviewer may only deny or escalate; approvals shown only in the app |
|
Skills with a budget |
OpenClaw, Hermes, Codex |
Capped description list, search for the rest; agent-written skills staged and reviewed |
Anti-patterns they have reverted: loading every tool schema up front; open skill registries running with agent privileges (341 of 2,857 ClawHub skills flagged malicious, [Unit 42]); treating per-command prompts as the security boundary; rewriting instructions mid-session; unbounded delegation. OpenClaw's WhatsApp path uses the unofficial Baileys client; Waldo does not copy it.
## Memory
Keep the current claims system and fix it. Mature systems converge on its shape: rows with provenance in one store, a small pinned core, text search, background consolidation and supersession. Graphs and vector stores do not clearly win: a plain file with search tools scored 74.0% on LoCoMo against 68.44% for Mem0's graph variant ([Letta], [Mem0 paper]), and a text-log approach scored 84.23 on LongMemEval against 80.05 for top-20 RAG ([Mastra], self-reported).
### Component decisions
|
Component |
Decision |
Change |
|
Episodes + FTS5 + search_episodes |
Keep |
Strongest piece: owner words split from quoted text, every hit readable in full. Add stemming; drop stop words from queries |
|
Claims with provenance decided in code (ground()) |
Keep, simplify |
Provenance becomes origin + source_ref + valid-from / invalidated-at + superseded-by; keep the verbatim-quote gate on remember |
|
Pinned profile and facts blocks |
Keep |
Show claim ids so the model can correct without a lookup; freeze at session start for caching; over the cap returns an error and the model consolidates |
|
Per-turn recall (12 claims + 8 episodes, fenced) |
Keep |
Merge read_owner_context into read_memory; one recall function |
|
Nightly pass |
Keep, fix |
Build correction refs with ownerSourceRef so corrections apply (today they never do, memory/claims.ts:1205); bound the prompt to the day's topics plus pinned claims; run it in a reader worker |
|
Constellations and pattern promotion |
Keep, prove |
Surface the top patterns as a short pinned line; if an eval shows no gain, stop the nightly promotion call |
|
Forgetting (scrub every source, content-free barrier, honest receipt) |
Keep core |
Delete the dead coverage state machine; clear stale incomplete topics that stall nightly learning; also scrub workspace files |
|
Legacy core-file migration |
Fix |
Let the owner confirm migrated items so they can be pinned |
|
Old post-turn edit |
Restore, durably |
After an idle chat, a reader worker proposes claim ops, code grounds them, the brain applies them; saving no longer depends on the reply model calling remember |
|
GoalStore, temporal recall gateway (~1,230 LOC) |
Drop |
Not on any live path |
### Rules
-
One writer: OwnerDO SQLite holds claims and episodes. USER.md, MEMORY.md and daily notes are rendered views for the owner's console and, if useful, the model; nothing writes them directly.
-
Corrections supersede; erasure deletes. A correction invalidates the old claim with a timestamp. A forget request hard-deletes the claim, its index rows, rendered views and anything derived from it, and leaves a content-free tombstone. Durable Object SQLite keeps 30 days of point-in-time recovery; document that residue in the owning contract.
-
Untrusted content is never promoted on its own. Facts that come only from mail or web pages need the owner's confirmation.
-
Health stays out of memory text as raw values, excluded by default as the Claude app does; derived state only.
-
Cloudflare Artifacts is not used for personal memory: its only documented erasure is deleting a whole repo, and snapshot retention is undocumented. Revisit it for eval forks and non-personal workspaces once purge semantics are confirmed.
-
Eval first: a synthetic suite modelled on LongMemEval (knowledge updates, time reasoning, abstention) with pass thresholds.
## Connectors and sign-in
Most launch jobs run on APIs, so connectors come before browsers: native adapters for the daily apps, Waldo's own MCP client for services with open sign-up, a broker for the long tail, and one Waldo connect page for every sign-in.
|
Source |
Use for |
Notes |
|
Native adapters |
Google (Gmail, Calendar, Drive, Contacts, Tasks), Microsoft Graph for consumer Outlook, Plaid later |
Gmail read scopes are "restricted" and need Google's annual CASA security assessment; the send scope does not |
|
Waldo's own MCP client (spec 2026-07-28) |
Notion, Linear, Todoist and other servers with open registration |
Client ID metadata document at https://<waldo>/oauth/client.json; PKCE S256; resource indicators; iss validation; pre-registered clients where required ([spec]) |
|
Connector broker: Composio first, Nango as the alternative |
Long-tail apps |
~$29/mo at 50 users, ~$89 at 1,000 (estimate at 3 connections and 300 calls per user per month; [pricing]); needs a DPA; no health data through it |
|
Partner-gated |
OpenTable, Zocdoc, Instacart checkout, Slack, Dropbox |
Needs partnerships or app review; many "official" servers allowlist only large hosts |
|
Browser with handoff |
No API exists |
Through HandsDO |
### Rules
-
One ConnectorBroker interface with native/MCP and broker adapters. Each connector entry records its kind, registration mode, scopes and risk tier; it feeds the per-turn capability manifest, and grants are rechecked before every dispatch.
-
Tokens live in Supabase Vault, keyed by owner, issuer and resource. OwnerDO holds only a connection handle and status; override the Agents SDK default that stores tokens in Durable Object SQLite.
-
Refresh is single-flight in OwnerDO, the one retry owner. invalid_grant shows a Reconnect card; disconnect calls the provider's revocation endpoint, then deletes the tokens.
-
Sign-in links: the model never builds an authorize URL. Waldo issues a short-lived, single-use https://<waldo>/connect/<opaque> link that requires the owner's Waldo session and a matching owner before redirecting; the app opens it in ASWebAuthenticationSession or Custom Tabs.
### Non-OAuth sign-in, safest first
-
An official API or MCP server with OAuth.
-
The owner completes the login in a live-view handoff, with screenshots paused while they type.
-
Password-manager autofill with per-use approval (1Password with Browserbase), so credentials never reach the model.
-
Stored-credential re-auth (Kernel managed auth) only under an explicit grant, for low-risk sites.
Never: codes or magic links pasted into chat (route them to the handoff), the agent reading login codes from the owner's inbox (injected emails have made assistants forward live 2SV codes, [arXiv 2605.04808]), or CAPTCHA solving services.
## Without a browser: MCP, APIs and commands
The architecture already has the right seams. The brain plans and holds state. An edge proxy attaches tokens so the model never sees them. Writes become approval cards, and an intent is pinned before I/O. What beta-mvp lacks is the general version of each seam. Its MCP client speaks only to servers set in deploy config, with a static token or Google auth. It never lists a server's tools. It runs a fresh initialize before every call. There is no sandbox anywhere, so Waldo cannot run commands.
|
Need |
beta-mvp at 3a727acf |
Build |
|
MCP with OAuth for third-party servers (Swiggy, Notion, Zoho) |
Not built; the code defers it to "the generic flow (RFC 9728)" (tools/live/mcp.ts) |
Discovery by protected-resource metadata (RFC 9728) and auth-server metadata (RFC 8414); client ID by metadata document; PKCE S256; RFC 8707 resource; issuer check. Tokens in Vault per owner, issuer and resource; the edge attaches them. |
|
Which servers an owner has |
Env JSON shared by all owners; production is [] |
A per-owner connections table written only by OwnerDO, with secrets in Vault |
|
Tool discovery |
None; the model calls call_mcp_tool(server, tool, args) and must guess names |
tools/list cached per server version (the 2026-07-28 spec makes it cacheable); names reach the model through tool_search with deferred loading; arguments checked against the schema before dispatch |
|
Read or write |
Google servers are allow-listed reads; any other call becomes a card |
A per-tool policy table owned by Waldo. A server's readOnlyHint is a hint from untrusted code, never the decision |
|
Call cost |
initialize, initialized and tools/call each time: 3 round trips |
Reuse the session, or one request on the stateless 2026-07-28 core |
|
Plain HTTP APIs |
Typed adapters (Google, Brave search) |
Keep one typed adapter per provider (Microsoft Graph, X API, IRCTC preparation). No raw HTTP tool for the model. Egress allowlist per adapter host; staging's "*" allowlist goes |
|
Linux commands |
Nothing |
Cloudflare Sandbox owned by the code TaskWorker, never the brain. A lite instance is 1/16 vCPU and 256 MiB ([limits]). No owner credentials in the box; egress allowlisted per job |
|
Model-written glue code without Linux |
Nothing |
Dynamic Workers run generated JavaScript in an isolate with chosen bindings and blocked network ([Cloudflare]). They suit code mode that loops and filters over typed tools, and cost less than a container |
### How it scales
-
Across owners: one OwnerDO per owner and no shared hot object, so owners add capacity linearly.
-
Within one owner: the inbox drains serially and tool calls run one at a time (owner-do.ts:490, tool-loop.ts:176). Run reads in parallel, and move any chore longer than a turn to a TaskWorker so a new message never waits behind it.
-
CPU: each request or alarm gets 30 s of CPU, raisable to 5 minutes, and waiting on I/O does not count ([limits]). MCP and API calls are mostly waiting. Large PDFs and long threads are parsed in workers, outside the brain's 128 MB isolate.
-
Sandboxes: the account limit is 1,500 concurrent vCPU, about 24,000 lite boxes. That is not the constraint for years.
### Context and agent rules for this path
-
Each turn loads the smallest set of tools: connected servers only, with schemas fetched when the model asks.
-
Every MCP and API result is data from outside, never an instruction. Writes after tainted input go to a card with frozen arguments.
-
Credentials never enter prompts, logs or job payloads; the edge holds them.
-
Each effect gets an intent ID and argument digest before I/O, one retry owner, and keyed reconciliation when the result is unknown.
-
Large results are paged or read in chunks inside the owner's authorization, never refused for size.
## Escalation ladder and unit economics
Every task starts on the cheapest rung that can do it, and the model climbs only when a tool returns a structured blocked result. Per-user daily budgets in HandsDO cap rungs 4–5. Costs are estimates per task, excluding the main model's own tokens.
|
Rung |
Example |
Cost per task |
|
0. Memory and reasoning |
Answer from context |
Model tokens only |
|
1. Connector (native API or MCP) |
Move a meeting, draft a reply |
~$0.001–0.01 |
|
2. Email parsing |
Bills, packages, booking confirmations |
~$0.001–0.01 |
|
3. Search + fetch |
Facts, prices, local information |
Free–$0.007 |
|
4. Cloud browser |
Logged-in form, cancellation |
~$0.05–0.50 including Stagehand tokens |
|
5. Sandbox |
File conversion, data analysis |
Cents of active CPU |
|
6. Owner's Mac |
Local apps, the owner's own identity |
Free |
|
7. Human handoff |
Phone calls, CAPTCHA, payment |
The owner's time |
Per-user monthly estimate at 50 users, excluding main-model tokens: browsing ~$0.60–1.50, connector broker ~$0.60, RCS reminders at ~₹0.15–0.35 a message for Indian owners, Telegram and push near zero. Main-model tokens are the largest unknown; phase 1 telemetry measures them against the repo plan's $25 per user per month ceiling.
-
Side jobs (titles, triage, the memory flush, heartbeat wording, Stagehand steps) run on gpt-6-luna; owner turns on gpt-6.1-sol.
-
A proactive run first checks deterministically whether anything changed; if nothing did, it ends without a model call.
## Browsing
Most web work needs no browser: plan for free fetch first, one warm browser session per user through HandsDO, and about 40–95 browser-hours a month for 50 users.
### How much users need
|
Bucket |
Estimated share of requests |
Typical tasks |
Evidence |
|
No web |
55–70% |
Drafting, advice, planning, reminders; for Waldo also calendar, inbox, memory, health-aware pacing (APIs) |
34.5% of ChatGPT queries used web search in Feb 2026 ([Semrush via MediaPost]) |
|
Search + read |
30–45% |
Facts, news, local places, research summaries, price comparison, travel options |
Seeking Information 24% of ChatGPT use ([OpenAI/NBER]) |
|
Interactive browser |
1–5% |
Logged-in account changes, forms, LinkedIn, job applications, cancellations, bookings |
77% of agentic-browser traffic is product/search pages, 2.3% checkout ([HUMAN Security 2026]) |
Measured time per browser task: 68 s to 5.5 min on Online-Mind2Web ([Browser Use]), 6–18 min on long live-site tasks. Waldo estimate (15 requests per user per day, 2–5% needing a browser, ~5 min each): 38–94 h a month for 50 users. Waldo has no real usage data yet; the telemetry in the harness section replaces this estimate.
### Tiers behind HandsDO
|
Tier |
Use when |
Choice |
|
0. Search + fetch |
Public page, content readable without interaction |
TinyFish search and fetch (free, renders the page; [announcement]) and OpenAI web_search |
|
1a. Public render |
Screenshots, PDFs, sites that allow verified bots |
Cloudflare Browser Run (always flagged as a bot by design) |
|
1b. Cloud browser |
Logins, forms, JS-heavy or protected sites |
Errand pilot: Browser Use V4 hosted agent (see below). Guarded path for final submits: Stagehand on Browserbase Developer (persisted contexts, live-view takeover, CAPTCHA); adapter exists in tools/live/browser.ts |
|
2. Computer |
Files, code, downloads |
Sandbox per code worker (next section) |
|
3. Owner's Mac |
Needs the owner's identity, passkeys, local apps |
use_mac |
-
The model picks the tier; tools return structured outcomes such as {blocked: "challenge" | "login_required" | "js_required"}.
-
HandsDO cuts use: fetch first, one warm session per user with an incognito context per task (connect(env.BROWSER, sessionId)), merged duplicate requests, a cap of 1–2 live browsers per user, idle teardown on its alarm, a short per-user cache of public pages. Estimated a third to a half fewer browser-hours (not measured).
-
Browser limits and billing are per account, not per object: 200 concurrent browsers, a start-rate cap, 10 included concurrency then $2 each on Cloudflare.
-
treg ([repo]) is a read router, not a browser; consider it only for structured platform data after a DPA review.
### Cost for 50 users
At expected usage, total browsing spend is about $30–75 a month: Browserbase Developer, Cloudflare's light tier, and model tokens. Monthly cloud-browser bill by vendor, list prices read 2026-10-17; the higher columns are stress cases with 10% of heavy tasks on a residential proxy at ~20 MB each.
|
Vendor (plan) |
Expected 40–95 h, 1–2 GB |
200 h, 6 GB |
625 h, 15 GB |
1,500 h, 30 GB |
Concurrent |
Notes |
|
Browserbase Developer ($20, 100 h) |
$20–32 |
$92 |
$251 |
$536 |
25 |
Adapter exists; CAPTCHA included |
|
Browserbase Startup ($99, 500 h) |
$99 |
$109 |
$212 |
$449 |
100 |
DPA/HIPAA only on Scale |
|
Kernel Hobbyist ($30) |
$30–32 |
$44 |
$95 |
$200 |
10 |
Idle and proxies free; 2 GB browser assumed |
|
Kernel Start-up ($200) |
$200 |
$200 |
$225 |
$330 |
150 |
SOC2/HIPAA only on Enterprise |
|
Anchor Starter ($50) |
$50 |
$66 |
$176 |
$375 |
25 |
+$0.10 per AI task; verified identity needs Team |
|
Steel Launch ($0) |
$14–30 |
$81 |
$215 |
$455 |
10 |
15-min session cap |
|
Steel Scale ($250) |
$250 |
$250 |
$291 |
$452 |
100 |
HIPAA BAA |
|
Hyperbrowser Startup ($30) |
$30 |
$80 |
$213 |
$450 |
25 |
Compliance not stated |
|
Browser Use Cloud |
$6–12 |
$34 |
$88 |
$180 |
10, then 50 |
Switch proxies off by default |
|
AWS AgentCore Browser |
$8–18 |
$47 |
$127 |
$275 |
AWS limits |
1 vCPU at 50%, 4 GB assumed; bring your own proxy |
-
Add Cloudflare: ~$5–12 a month (10 h included on Workers Paid, then $0.09/h).
-
Add model tokens: no plan includes them. Stagehand steps run on gpt-6-luna billed to Waldo's OpenAI key (tools/live/browser.ts:116): ~$0.01–0.03 per task, ~$5–35 a month at expected usage.
-
Proxy bandwidth is the trap: proxies on every heavy task would push Browserbase Startup to ~$1,450 a month at 625 h. Use them only on retry after a block.
-
Kernel's default browser memory and Anchor's credit mapping are not stated on their pages.
### Browser Use: where it fits
For the 1–5% of turns that need a logged-in, interactive browser, pilot Browser Use's V4 hosted agent. Don't adopt its CLI or Python library on the backend. Keep the current Stagehand path for final submits until a bake-off proves V4 on Waldo's own errands.
Correction to an earlier idea. Putting Stagehand on Browser Use's browser doesn't fit. Checked in beta-mvp at 3a727acf:
-
tools/live/browser.ts calls the hosted Stagehand API at api.stagehand.browserbase.com, which drives only Browserbase sessions.
-
Driving a Browser Use browser over CDP would need a driver in a container or sandbox, and beta-mvp has no sandbox code. The move would save about $10–20 a month at 50 users, not worth new infrastructure [estimate].
-
Public reads use @cloudflare/playwright 1.3.6 over the BROWSER binding, with Browserbase off for public reads (browser-public-read-configuration.ts: allowBrowserbase: false).
-
The interactive submit is approval-gated: the approval desk calls browserSubmit(proposal, approvalRef) only after the owner approves (channels/approvals.ts).
|
Option |
Plugs into the brain? |
What it gives |
Verdict |
|
Cloudflare Browser Run (public reads, staging) |
Yes, through the BROWSER binding |
Public renders |
Keep; move from staging to production |
|
Stagehand on Browserbase |
Yes, over HTTP |
Each step observed before it acts; the submit runs only after approval |
Keep as the guarded path for final submits |
|
Browser Use V4 hosted agent |
Yes, plain REST: send a task, get a result |
Saved logins through profiles and profile sync; stealth, CAPTCHA and 2FA handling; a live preview the owner can take over; passwords the model never sees (secretBindings.allowedDomains); zero-data-retention projects that never record; keepAlive of 120–14,400 seconds, so the browser stays open while an approval card waits |
Pilot it for errands |
|
Browser Use Browser API (CDP) |
No: needs a CDP driver in a container |
The cheapest browser Waldo would fully control |
Later, once a sandbox worker exists |
|
CLI 3.0 and Browser Harness |
No: an agent with a shell runs Python against Chrome, local or cloud |
Fits the owner's-Mac rung |
Later, on the desktop executor |
|
Python library 0.13.13 (OpenAI browser-tool and Anthropic drivers; Browser Use Actor with 18 tools and six optional actions) |
No: Python, needs a container |
Waldo's own model drives the browser, so Waldo stays the only brain |
A good shape later, with a sandbox |
Is it good for the tasks we measured?
-
Reading and research: usually not needed; search and page reads cover 30–45% of turns without a browser. On Browser Use's own research benchmark (BU_Bench_v2, 60 tasks; quality counts findings; costs exclude browser time and are a lower bound, per the [pricing page](https://browser-use.com/pricing)), the cheap tier finds about half of what a strong model finds. That is fine for "check slot availability", not for anything the owner relies on.
|
Model |
Quality |
$ per task |
Minutes per task |
|
GPT-6 Luna high |
53.9 |
0.155 |
25.9 |
|
GPT-6 Luna medium |
50.3 |
0.126 |
19.8 |
|
GPT-6 Astra medium |
80.6 |
8.867 |
31.7 |
|
Claude Opus 5.5 |
59.4 |
4.215 |
34.2 |
|
GPT-6 Sol medium |
66.8 |
1.203 |
13.5 |
-
Logged-in errands (cancel, book, refill, forms, refunds): this is where Instinct-class capability lives. Browser Use has every infrastructure feature these need; Browserbase plus Stagehand has some of them. How well its agent completes Waldo's errands is unproven. Its docs say is_successful is the agent's own report, so Waldo verifies completion itself.
-
Final submits: in a hosted agent, "stop before submit" is enforced only by the prompt. With V4, run to the review screen, hold the browser with keepAlive while the approval card waits, then submit in a narrow follow-up run and verify afterwards. After keepAlive ends, a follow-up gets a fresh browser with the same profile and no tabs. This is weaker than Stagehand's exact act-after-approval, so V4 handles only low-stakes submits until the bake-off. The docs also warn that a client timeout can leave a run active, so reconcile before any retry, which fits the one-retry-owner rule.
-
Health-adjacent errands (pharmacy, labs): no health values in browser jobs. These need a zero-data-retention project and a data agreement first. The pricing page lists SOC 2 Type II and HIPAA; the reports were not seen.
Cost. Browsers cost $0.02 an hour, billed per minute with a one-minute minimum. The residential proxy is $5 per GB and on by default; bring-your-own proxy is $0.20 per GB. Agent tokens carry a 20% fee on model rates. Concurrency starts at 10 browsers and rises to 50 after $100 in total payments.
-
Per errand: browser time about $0.002 for 1–5.5 minutes, cheap-model tokens about $0.01–0.03 [estimate].
-
The proxy dominates: a few tens of MB cost more than browser and model together. Turn the proxy off per session and on only for sites that block datacenter IPs [estimate].
-
The 38–94 browser-hours a month for 50 users cost about $1–2 of browser time plus proxy, against Browserbase Developer's flat $20–32 [estimate]. Price doesn't decide this; task success does.
Bake-off. About 20 real errand types (cancellations, bookings, forms, refunds), on test accounts first, with V4 and Stagehand on the same tasks. Measure verified completion, minutes, all-in cost including proxy GB, owner takeovers, and unapproved submits, which must be zero. Adopt V4 for an errand type at 80% or more verified completion, zero unapproved submits and $0.20 or less per errand; otherwise it stays on Stagehand [proposed].
Unverified: BU_Bench is vendor-run, measures research findings rather than errands, and its recorded costs are a lower bound. Whether @cloudflare/playwright can connect to an outside CDP browser is unchecked. Instinct's browser stack is unknown.
## Waldo's own computer
Start with a Cloudflare Sandbox container attached to each code-profile task worker; add an E2B desktop VM only if GUI tasks appear in telemetry. Code and desktop tasks are rare for consumer agents, and a Cloudflare Sandbox attaches to a single Durable Object, so one container per task worker is the natural unit.
|
 |
Sandbox per code worker (first) |
E2B Desktop (later, if needed) |
Owner's Mac (exists) |
|
What it runs |
Linux shell, files, code interpreter; no GUI |
Ubuntu desktop: shell, browser, GUI apps |
Shell, local apps, Claude Code / Codex sessions |
|
Persistence |
Disk wiped on stop; workspace copied in from R2 and results written back |
Pause keeps disk and memory; resume ~1 s |
The owner's machine |
|
Lifetime |
Stops at inactivity even mid-task, so the worker sends keep-alive pings |
24 h per run on Pro, resets on pause |
While the Mac is online |
|
Credentials |
Injected at egress by the Worker; never inside the container |
Vault or takeover only |
Native approval on every action |
|
Cost |
Active CPU only, Workers Paid |
~$0.17/h for 2 vCPU / 4 GiB; Pro $150/mo |
Free |
-
Give execute_code a real handler on the existing ExecutionEnvironment port, routed to the code worker.
-
Accept OpenAI's computer_call action vocabulary (click, type, scroll, screenshot…) and map it to the Sandbox, Browserbase, E2B or the Mac, so actions stay on Waldo's approval path whichever model drives.
-
Skip OpenAI's hosted Agents API computer: its harness would own the session and act as a second brain.
-
Open: E2B data residency, DPA terms and paused-sandbox billing are unverified.
## Channels and presence
The app is the primary presence and the only place approvals appear; every channel routes to the one OwnerDO, and proactive delivery stays a brain decision. For the Indian cohort the app plus push, RCS and email carry launch.
|
Channel |
Decision |
Next step |
Risk |
|
App + console |
Primary; approvals only here |
APNs and Android push, needed for the morning brief and dues reminders |
Proactive messages cannot reach the phone until then |
|
RCS and SMS (India) |
RCS through a messaging platform for reminders and replies; transactional SMS for alerts |
Google agent verification; DLT registration of entity, headers and templates |
Per-message cost (~₹0.15–0.35 for RCS) |
|
Telegram |
Keep as the free fallback and the team's test channel |
None |
Low |
|
WhatsApp |
Official Meta Cloud API; the main chat channel in India, applied for as a chore service; also where officially eligible (EEA and Italy) |
Approve one utility template; move to Graph v26.0; wire buttons and PDFs |
Meta may refuse or ban the number; the app, RCS and Telegram stay ready |
|
iMessage |
Later, for non-Indian owners: a managed provider behind the existing IMessageBridgeDO protocol; stop building the self-hosted Mac host |
Evaluate Photon and Linq; file the Apple Messages for Business application |
Apple's consumer terms forbid automation |
|
Email |
Gmail watch inbound; approval-gated send_email |
A Waldo agent mailbox later |
Low |
## Hard boundaries we keep
These protect people and data; everything else in the harness is open to cutting.
-
Authentication and owner checks on every route, tool and worker call.
-
Only OwnerDO writes memory, sends messages or approves actions; workers hold no authority.
-
Approval cards before any effect outside Waldo: email, messages, calendar, purchases, browser submits.
-
Egress allowlist; private, loopback and metadata ranges blocked.
-
Secret and canary scans; credentials never in prompts, logs, tool results or containers (vault, egress injection or takeover only). Browser session IDs and live-view links are treated as passwords.
-
Health scrub on memory writes and third-party sends; raw health values stay in Supabase (GDPR Art-9).
-
Platform terms: Apple for iMessage, Meta for WhatsApp.
## Parity with Muse, Instinct and Grok
Eight capabilities appear in at least three of the leading agents. That is the real bar, and Waldo's planned objects meet all eight without a computer per user. Muse ([Meta]), Grok Bot ([xAI]), OpenAI's dots ([OpenAI]) and Manus ([Manus]) each keep a cloud computer per user or per agent. Waldo keeps a Durable Object, which costs nothing when idle, and rents a browser or sandbox per job. Browsing is 1–5% of tasks, so per-job rental costs less than a standing computer.
|
Capability |
Who ships it |
Waldo at 3a727acf |
Waldo's version |
Paid per |
|
Work that continues while the owner is away |
Muse, Grok Bot, dots, Gemini, Perplexity, Manus |
OwnerDO alarms, heartbeat, Gmail and calendar push |
TaskWorkers with leases and checkpoints |
Model tokens |
|
Approval before sending or buying |
7 of 9 |
Cards in the app and Telegram; text replies on WhatsApp |
Fix the taint-to-card path; WhatsApp buttons |
Nothing |
|
Credentials kept away from the model |
6 of 9 (vault or take-over) |
Vault plus a connector-proxy edge that attaches tokens |
Same edge for MCP and Composio; live-view hand-off for sign-ins |
Nothing |
|
Scheduled and event-triggered runs |
6 of 9 |
Scheduler and reminders |
Reader-profile workers on the cheap model |
Model tokens |
|
Persistent memory |
7 of 9; only Muse documents "forget" |
Claims, FTS5 recall, pinned blocks, owner edits |
Fix corrections and the flush; forget is already real |
Storage, near zero |
|
Mail and calendar by OAuth; MCP |
5+ and 4 |
Typed Google tools; Google MCP reads in staging |
Generic MCP client with OAuth, per-owner registry |
Nothing |
|
A chat channel beyond the app |
6 of 9 |
Telegram, WhatsApp, iMessage bridge |
WhatsApp and RCS in India |
Template messages |
|
Usage that degrades instead of stopping |
6 of 9 |
$5 browser cap in staging |
HandsDO budget per owner; cheaper model and "ask first" past the plan |
— |
Three agents add an independent model that reviews risky actions: Muse's Sentinel, Grok's Auto Review ([xAI]) and OpenAI's sign-in review. Waldo's version runs the cheap model over a tainted action's frozen intent before the card. Deterministic hooks keep only the hard security checks.
### Where Waldo does not follow
-
A standing cloud computer per user: cloud browsers and sandboxes stay per job under HandsDO.
-
Virtual cards (Muse, Instinct): UPI intent links do this job in India, with the owner's PIN as the gate.
-
AI phone calls to businesses (Muse, Instinct, both in beta): a real need in India, so it is an open decision. Muse's tests needed human contractors ([Gizmodo]).
-
A network of agents between users (Instinct): Trusted Relationships cover family first.
-
A phone number and wallet per agent (Manus), on-device models (Perplexity), teach-by-demo (Grok): none fits launch.
### Pricing by actual use
An idle owner costs storage and a few alarm calls. A chore costs model tokens, plus browser minutes or sandbox seconds only when it needs that rung. So the ₹199 plan includes a token and rung budget that HandsDO meters. Past it, Waldo switches routine work to the cheaper model and asks before any paid rung. Nothing stops mid-chore. The per-user numbers are in Escalation ladder and unit economics.
## Industry moves to use
|
Move |
Date |
Use for Waldo |
|
Cloudflare Agents SDK sub-agents (subAgent()) |
Docs updated 2026-09-15 |
Ready-made base for task workers |
|
OpenAI DevDay: Dots (proactive agents are read-only) |
2026-09-29 |
Reader-profile workers for heartbeat and triage |
|
GPT-6 era API: tool_search, async tool calls, server-side compaction |
Sep 2026 |
Brain tool loading, long effects, cheaper routine rounds |
|
TinyFish free search and fetch |
2026-05-04 |
Tier 0 before any browser |
|
E2B "Sandboxes are dead" |
2026-10-16 |
Framing: agents need a platform (storage, network, secrets, browser), not a fast box |
|
iOS 27 App Intents as the only way into Siri |
2026-09-14 |
App exposes intents; backend serves them |
|
MCP spec 2026-07-28: stateless core, cacheable tools/list |
2026-07-28 |
Target this version; fits Workers |
|
Web Bot Auth (IETF draft) |
Sep 2026 |
Sign Waldo's browser traffic |
|
Scoped agent payment tokens (Visa, Mastercard, Stripe, AP2) |
Apr–Aug 2026 |
Later: grants plus a per-payment approval card |
|
Poke approved on Apple Messages for Business |
~2026-06 |
The official iMessage route exists; apply early |
## Build order
Phases 1–4 make the existing model visibly better and serve the ten launch jobs; browsing, the computer and the remaining channels then plug into the worker foundation. Two items run alongside from day one, and one has a hard date.
-
1. Harness, quick fixes and telemetry. Done when tainted actions land as approval cards, every refusal returns {code, cause, fix, retryable}, nightly corrections apply (ownerSourceRef), read calls run in parallel, replies stream, and every turn logs tool chosen, rung used, browser seconds and model tokens.
-
2. Task worker foundation. Done when the job protocol (job row before I/O, requestId, lease, checkpoints, apply-once by job ID, cancellation fence, TTL sweep, park after repeated crashes) passes its tests; the owner gets a reply while a 10-minute job runs; four parallel research workers return one merged brief; the heartbeat runs read-only with a data-changed check.
-
3. Brain tool surface. Done when ~12 tools plus start_task and deferred namespaces load up front and per-round tool-definition tokens drop from ~15k to under 4k on the eval suite.
-
4. Memory keep-and-fix. Done when pinned blocks show ids, the durable post-chat flush saves facts without a remember call, constellations reach the prompt or are switched off by eval, dead forget and goal code is gone, and the LongMemEval-style suite passes its thresholds.
-
5. India pack and connectors. Done when the dues radar, mandate audit, medicines, house-help ledger, documents vault, refund chaser and tax calendar run for a test cohort; UPI intent links hand off payments; Swiggy Food, Instamart and Dineout work through Waldo's MCP client with tokens in Supabase Vault; every sign-in goes through the Waldo connect page.
-
6. HandsDO and browsing tiers. Done when TinyFish fetch handles public reads, Browserbase Developer serves a logged-in task that survives across turns with live-view login, each user is capped at 1–2 live browsers, idle sessions close on time, and browser-hours are reported per user.
-
7. Computer per code task. Done when execute_code runs in a Cloudflare Sandbox owned by a code worker, workspace files round-trip through R2, and the container is gone when the job closes.
-
8. Channels and presence. Done when app push delivers the morning brief and dues reminders, RCS and transactional SMS are registered for India, and the WhatsApp number passes Meta's review for India, runs on Graph v26.0, and has one approved utility template.
-
9. Backlog and the deep corridor. Done when forwards and shared links file as typed loops with goal links, the Sunday review and the 30-day keep-or-drop run, X links read through the official API, and the Deep verticals jobs run for the test cohort with no health data in any partner payload.
-
10. General MCP client. Done when an owner connects a third-party OAuth MCP server from the connect page, Waldo discovers its tools through tools/list, reads run without a card, writes run only after one, and tokens never leave the edge.
-
Alongside: India partnerships. Swiggy production application filed; Setu bill-pay conversation started; early-access requests for UPI agentic payments sent; ABDM personal health record app onboarding started; DPDP consent ledger, age gate and breach runbook built.
-
Alongside: delete the second brain. Done when run-loop, coordinator, the responsibility protocol and their guards are gone, the Durable Object migration lineage is kept, and verify passes.
-
Alongside: production config. Done when the production flags, namespace and egress allowlist match a decision, and Google connects refuse when the connector proxy is missing.
-
By 2026-10-30: Fitbit. If any owner uses Fitbit, move them to the Google Health API before the Fitbit Web API shuts down.
## Open decisions for the owner
-
Launch contract and commerce: the brain's WALDO_PERSONAL_AGENT_LAUNCH.md defers commerce such as Swiggy to later milestones. Amend it to admit India pack job 8, or move that job to the first later milestone. Also refresh the brain's connector-ecosystem.md, which still lists Swiggy as having no public API.
-
India price point: ₹199 or ₹399 a month, decided by phase 1 cost telemetry; a family plan for parents' bills and medicines.
-
Gmail read access: budget Google's annual CASA security assessment, or launch on Gmail drafts and send plus forwarded bills and statements.
-
Data location for the Indian cohort: which Supabase region holds Indian owners' data, and how Durable Object placement is documented (there is no India jurisdiction option).
-
WhatsApp in India: apply now as a chore service, or wait until app push and RCS are live so a refusal costs nothing.
-
Human concierge: whether and when to add an outbound voice-call rung or a paid human partner for businesses with no app (repairs, clinics). Faff, Muse and Instinct all lean on humans or calls here.
-
Connector broker: Composio (cheapest, broadest, SOC 2 Type II) or Nango (more control over token custody, HIPAA BAA); either needs a DPA.
-
Amend CLAUDE.md and the launch contract: retire WaldoCoordinator/RunLoop as the canonical path and record the one-brain-plus-workers topology.
-
Workers on the Agents SDK or plain Durable Objects: subAgent() saves code but adds the agents dependency.
-
Reader scope: which content goes through reader workers versus full context in the brain.
-
Production flags: is the empty workspace namespace and the off switches for proactivity, Drive, MCP and browser intended, or a pending promotion?
-
Per-user limits: live-browser cap (1–2 proposed) and daily spend budget for browser and sandbox time.
-
Lab reports: a contract review for persisting lab values in the Supabase health plane before Waldo reads blood tests.
-
Public look-up at onboarding: ship the opt-in step at launch, or after the DPDP consent ledger exists.
-
Model provider fallback: the live path calls OpenAI with fallback: []; an OpenAI outage takes Waldo down.
-
Browser Use bake-off: run V4 against Stagehand on about 20 real errand types before V4 takes any final submit (Browsing, Browser Use: where it fits).
## Sources
Code evidence: waldo-backend branch beta-mvp at 3a727acf, read-only audit; no tests or verify were run. Vendor prices were read from vendor pages on 2026-10-17 and change often. Usage shares are triangulated estimates, not measurements.
-
[Cloudflare Agents sub-agents], [Browser Run FAQ], [Browser Run pricing], [reuse sessions], [Sandbox lifetime]
-
[Pi Durable on Cloudflare]
-
[Anthropic: Managed Agents], [Writing tools for agents], [Advanced tool use], [Code execution with MCP]
