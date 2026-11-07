<!-- Snapshot of https://claude.ai/artifact/J1CnxUzs8KZDstptVXCmaD read 21 Oct 2026 -->


# Waldo build handoff: backend, harness and personality
 ·
**The core is being cleaned and hardened; the wedge and the voice come next.** Ashish's 19 draft PRs (all green, none merged) delete the old second brain, add a second model provider, fix memory corrections and give every tool one refusal shape. After they land, the work is: the harness and voice, then the worker layer, then the health trigger, wearables and channels that make Waldo "the assistant that acts on how you are".
-
**Personality:** Suyash's north-star doc fits Waldo's philosophy and should go into the product. Adjust four lines so the voice doesn't limit capability, and add the missing health voice.
-
**Backend:** worker layer with crash recovery, a health trigger that proposes changes when a zone change meets a coming decision, WHOOP, Oura and Health Connect, Photon for iMessage, WhatsApp production switches, the cost cap, connectors and consent.
-
**Harness:** byte-stable prompt with a versioned voice block, parallel reads, compaction, rule pruning, and evals that judge replies against the personality's six tests.
-
**First step:** merge wave 1 in Ashish's order, and confirm the personality doc's open items.
**Decided 21 October (Shivansh):** the launch is global-first for wearable owners, and the agent stays able to serve India through per-market rails. Health connect goes into the first run. Owner look-up is an agent skill the agent may use on its own, shown with sources in "What Waldo knows" and disclosed in the privacy notice. CLAUDE.md and the repo rules move to one brain plus task workers. Every other open PR is resolved before wave 2. The repo's docs/planning/BUILD_DIRECTION_2026-10-21.md holds the decisions and the proof ladder.

## Where the build stands
Ashish's first wave is 19 draft PRs into waldoco/waldo-backend beta-mvp, all open, all green, none merged. Checked on GitHub on 21 October: every PR's check runs passed (verify, four runtime test shards, Supabase migrate-from-zero and pgTAP; #1323 adds the recorded nightly eval). Nothing was deployed, no migration applied, no secret set. All beta-mvp PRs sit on base commit b3fe8891.
Stack
PRs, in merge order
What it changes
Old-brain deletion (B-1)
#1326 → #1332 → #1336; #1334 last
Deletes RunLoopDO, the coordinator, the responsibility API, TracerDO and their guards and generators: about 125,900 lines. One brain (OwnerDO) plus task workers becomes the recorded shape. #1334 removes the old Durable Object classes and is marked **do not merge** until a read-only check shows their hosted storage is empty
Telemetry and evals
#1320 → #1322, then #1323 and #1324
Turn-event schema v9 with provider, fallback, latency and rung fields; a per-owner daily cost ledger (off until a flag is set); recorded nightly evals in CI with a threshold gate; the M0 baseline (194 of 194 scenario tests pass)
Memory
#1318, #1327, #1329, #1330, any order
Corrections now apply from every channel (before, every one was dropped); the stalled nightly pass is unblocked; claim ids show in pinned blocks so the model can correct a fact; dead memory code is deleted
Harness
#1321 → #1331, then #1325
One refusal shape for every tool (code, cause, fix, retryable); a tainted privileged action becomes one approval card that replays exactly once; the health scrub stops blanking "Form 16" in the owner's own mail
Model resilience
#1319 → #1328 → #1333 → #1335
Anthropic as the second provider; owner replies fall back primary → Anthropic → an honest template, side jobs cheap model → small Anthropic model; one circuit breaker per owner; 12 fault-injection cases and a game-day plan
Two cautions from the check:
-
**#1322 targets ****beta-mvp**** but says it is stacked on #1320.** Its diff probably carries #1320's commits, so merge #1320 first.
-
**Green CI covers only the checks that ran on each head.** Stacked PRs ran against their parent branch, not beta-mvp, and nobody checked branch-protection rules or clean merges.
Ashish's gap analysis and core build plan (9 areas, 76 items, milestones M0 to M5) could not be opened from this account. This handoff uses his written summary and the PRs themselves.

## Personality doc review
Waldo personality: north star (Suyash, 20 October) fits Waldo's philosophy almost line for line and should go into the product. It turns rules we already hold (ask first, no success without a receipt, health never on a lock screen, judgment over fixed rules) into a character people will remember. Most of it is already half-built: the live prompt (prompt/messaging-behavior.ts) and docs/foundation/WALDO_PERSONALITY_AND_VOICE.md already say silence by default, one suggestion, "Morning." and no exclamation marks. Four lines need adjusting so the voice doesn't shrink what Waldo can do, and one gap matters for the health wedge.
**What fits and strengthens the product**
Personality rule
Waldo principle it matches
"Done" only when done and confirmed; "I couldn't confirm it went through"
No success without a receipt; honest terminal ambiguity
Asks almost nothing; one yes-or-no with the evidence attached
Ask first, widen slowly; the onboarding research's no-questionnaire rule
One recommendation, not a menu; completed staff work
The agent decides and proposes; the owner approves
Owns mistakes in the first word, apologises once, fix already under way; never retries blindly
One retry owner, reconcile before retry
Use only what you gave him; nothing pieced together from outside
Memory is correctable context, not permission; minimum purpose-bound context
Discretion by surface: health only on screens you chose
Health never in pushes, logs or other channels
Honest that he is software; drafts for others go out in your voice
Never impersonate a person
Voice changes are tested and announced
Contract safety: a character is a promise
"Habits to avoid, not banned words"
Judgment belongs to the model, not word filters
**Where it could constrain the product, and the change to make**
Line in the doc
The risk
Proposed change
"He is an assistant, not an agent"
Read literally, it caps capability. The live prompt says "personal agent", and the product must match Muse and Instinct on errands
Keep "assistant" as the word owners hear; say plainly that he acts on their behalf. Voice, not scope
"Silence is the default… interrupts only when waiting would make things worse"
Could mute the wedge: acting before you ask on how you are
Count "a decision is coming and your state changes it" as waiting-makes-it-worse. Health-aware proposals ride the Brief, Check-in and Close unless a decision is due sooner
Length: "a few words", detail one tap down
On WhatsApp and iMessage there is no "tap down"; and an approval card must show exactly what will be sent
Short replies stay short. Approval cards always show the exact recipient, content, time and undo, however long. On chat, "one tap down" becomes "say more"
British spelling, Alfred, "he"
Fine for India and the UK; half the wearable market is in the US
Keep the character; let spelling follow the owner's locale. Gender is a founder call; keep it consistent
Supersedes the design-system line "a calm, trusted friend who happens to have a medical degree"
No risk: that line invites diagnosis
Retire it as the doc proposes
One conflict to settle: the Build Plan's opt-in "look me up" at onboarding breaks "use only what you gave him". The personality rule should win; public research about the owner happens only when they ask.
**What the doc is missing**
-
**How he talks about how you are.** This is the wedge, and the doc is silent on it. Zone words, never raw numbers in chat or notifications; compare to your own normal; "still learning you" when the baseline is thin; never alarm, never diagnose. A short night is a reason to move the 8 am, not a health warning. (The live prompt already has "compare to the owner's own normal".)
-
**What he says near medicine.** "That's your doctor's call; want me to book them?" One warm line, then help with the day. No dose talk, ever.
-
**The outage line.** The build has an honest floor reply ("I can't reach my model right now"). In his voice: "I can't answer properly right now. I'll come back to you by 10." It goes live only with the parked retry that keeps the promise.
-
**Languages.** Hinglish and other Indian languages on WhatsApp, and what of the character survives translation.
-
**Groups and family.** When he speaks in a family thread or to a parent, discretion by surface applies to people, not only screens.

## Updates to the agent backend
The backend keeps one brain per owner and gains the worker layer, the health trigger that makes the wedge real, and production-ready channels. Code references are from a read-only audit of beta-mvp at 3a727acf; re-check them against b3fe8891 or later before building.
Area
Update
Why, with evidence
Plan item
Brain and workers
Jobs table and job protocol, TaskWorker objects, worker profiles, start_task, background work moved to reader jobs
Long and parallel jobs without blocking chat; today the inbox drains one message at a time
B-2 to B-6
Crash recovery
Resume once from the last checkpoint; the model then chooses retry, split across workers, or a heavier rung; park after repeated crashes and tell the owner what finished and what is left
Now step 6 of the Build Plan's job protocol
B-7
Model fallback
Parked retry, which switches on the honest floor reply
The floor reply promises a retry, so it waits for this
R-4
Health trigger
After each upload, compare zone words with the last ones; if a zone change meets a decision coming up, run one agent turn that proposes a change with an approval card. Otherwise nothing runs. An hourly floor while the owner is awake; nothing real-time
The recompute already skips unchanged uploads (channels/app-health.ts:127–131), but no agent turn follows new health data
Launch job (health-aware day)
Wearables
WHOOP and Oura app approval; the Android Health Connect client; Apple's limited-history grants treated as unknown time; baselines per source and HRV method
First owners are wearable owners; WHOOP and Oura cap apps at 10 users until approved
Launch job, onboarding
Score labels
Fix Form being labelled form.safte-fast.v1 while computed as candidate.v3; serve sleep debt
Honest labels before owners see zone words
Health pipeline
iMessage
Photon as a new transport behind the existing iMessage bridge; fix iMessage owners never getting scheduled jobs (owner-do.ts:2747 resolves only the browser)
Without the fix the Brief never arrives on iMessage
Channels
WhatsApp
One approved template and approval buttons (the client already calls Graph v26.0, since #1312 merged on 18 October) (built in channels/surfaces/whatsapp.ts, never imported)
Production use outside the 24-hour window
Channels
Console
Approve every card kind, not only calendar changes (channels/console.ts:275)
Laptops are an approval surface too
Channels
Cost
Wire the per-owner cap into chat (spendCapExceeded exists; owner-turn.ts:242 passes no spend state); turn on the cost ledger
Price on measured cost, not estimates
T-2 and a small fix
Connectors
MCP client with OAuth, the Waldo connect page, tokens in Supabase Vault; food partners per market
Errands beyond Google
C-1 to C-5
Health admin
Refills, appointments, tests and renewals tracked from mail. An owner-written medicine list is new health data, so it gets a short contract review under ADR-0081 first
Build Plan job 10
Launch job
Consent and onboarding
Consent ledger per purpose; onboarding that seeds the routine (Brief time, quiet hours, wearable connect, chat channel)
Brief times are fallbacks today (prompt/day-cards.ts:11)
O-1 to O-8
Browser
On hold while the team redrafts. When it resumes, follow the Build Plan's Browser Use pilot and bake-off
E-3 to E-6 and E-10 paused
Execution ladder
Production data
Apply the health and cost-ledger migrations with a rollback plan, under sign-off
Migrations are staging-only today
Ops

## Updates to the harness
The harness work is mostly Ashish's next wave, plus the personality wired in as a tested, versioned part of the prompt. The repo rule holds throughout: judgment belongs to the model. Voice, length and tone are prompt guidance checked by evals, never word filters. Only hard boundaries (health in notifications, approval content, dosing) are enforced in code.
**From the build plan's next wave**
-
**H-4, a byte-stable system prompt.** The owner's text moves out of the instruction layers, and the voice block becomes a fixed, cached part of the prefix. This also makes "his voice stays steady" enforceable. Account for H-2's mid-turn tool-list change.
-
**H-5, parallel read calls.** Faster turns when Waldo checks calendar, mail and memory together.
-
**H-8, compaction on.** Long threads stay within budget.
-
**H-9, rule pruning with the T-6 ablation runner.** The live prompt has grown long. Each rule must earn its place by changing eval results, and the personality's six tests should replace several overlapping voice rules.
-
**Memory, M-4 then M-5 to M-11.** A durable post-chat flush so facts save without a remember call; then the memory eval suite.
**Personality in the loop**
Change
How
Enforced by
One voice source
Merge the north-star doc into the live voice block (prompt/messaging-behavior.ts) and WALDO_PERSONALITY_AND_VOICE.md; keep the product vocabulary block
Prompt, versioned
Voice is a contract
A version number on the voice block; any change goes through the eval gate (T-4) and a short changelog
CI eval gate
The six tests as the judge
The eval judge scores replies against the six tests and the doc's sounds-like pairs
Evals (T-4, T-5)
Wit and boldness grow with tenure
Give the model the owner's week number, so he is quieter in week one and drier later
Prompt context, model judgment
Discretion by surface
Each outgoing message carries its surface (chat, notification, approval card, message to a third party). Health detail never reaches a notification or a third party
Code, already a privacy boundary
Approval cards stay complete
Short voice everywhere except the card itself, which shows exact recipient, content, time and undo
Code, card template
Health voice
Zone words, own normal, "still learning", never alarm or diagnose; a short night is a scheduling reason
Prompt, evals
Near-medicine replies
"That's your doctor's call" plus help with the day
Existing dosing evals, plus new cases
Honest floor reply
Rewritten in his voice; ships with the parked retry (R-4)
Code
Proactive judgment
A coming decision plus a changed state counts as "waiting makes it worse"; otherwise it waits for the Brief
Model judgment, evals
**New eval cases to add** (all synthetic values, no real health data):
-
the doc's twelve sounds-like moments;
-
a low-recovery morning with a hard meeting, with and without a wearable;
-
a dose question;
-
an uncertain effect ("I couldn't confirm it went through");
-
his own double-booking mistake;
-
a week-one preference question;
-
a stressed owner, where any joke fails the case.

## Next waves, in order
Five waves, each starting when the one before has merged, so nobody rebases over 125,000 deleted lines twice. Each wave is one session per item, as before.
-
**Land wave 1.** Merge in Ashish's order: deletion stack, then telemetry, memory, harness and resilience; #1334 last, after the storage check. Set the Anthropic key on staging and run the failover game day. Set the eval secrets and decide where the live nightly eval runs (scheduled workflows run only from main).
-
Needs: Ashish's review and merges.
-
**Harness and voice.** H-4, H-5, H-8, H-9; merge the personality doc into the voice block with its eval cases; M-4 durable flush. In the same wave, fix the two small bugs: the iMessage scheduling bug and the unwired cost cap.
-
Needs: founder confirmation of the personality doc's Proposed and New items.
-
**Worker layer.** B-2 to B-7 (jobs table, TaskWorker, profiles, start_task, reader jobs, crash recovery and parking), then R-4 parked retry with the honest floor reply.
-
Needs: the call on plain Durable Objects or the Agents SDK for workers.
-
**The wedge.** Health trigger with replan cards, wearables (WHOOP and Oura approval, Health Connect client), Photon iMessage, WhatsApp production switches, onboarding and the consent ledger (O-1 to O-8).
-
Needs: WHOOP, Oura, Photon and Meta approvals, started now, and the amended launch contract.
-
**Connectors and launch jobs.** C-1 to C-5, health admin from mail, the launch jobs J-0 to J-7; browser work when the team's redraft is done, starting from the Browser Use bake-off.
-
Needs: the Gmail security-assessment budget decision and food partners per market.

## Decisions waiting
**Shivansh and Suyash (product and voice)**
-
Confirm, edit or drop each Proposed and New item in the personality doc, plus the four adjustments above (assistant vs agent wording, proactive health proposals, approval-card length, locale spelling).
-
Add the missing sections to the personality doc: how he talks about how you are, near-medicine replies, the outage line, languages, family and groups.
-
Answer the doc's calibration question: what would Waldo gently give you grief for?
-
Drop "look me up" from onboarding, or keep it strictly on request, so it agrees with "use only what you gave him".
-
Amend the launch contract in waldo-brain: one brain plus task workers, wearable owners first, the full assistant, Swiggy as a per-market add-on.
**Ashish (engineering)**
-
Merge wave 1 in order; run #1334's storage check first.
-
After a tainted read, should an MCP write need one approval card or two? One is better for the owner if the frozen intent covers both.
-
Allow "Form 16"-style text in memory writes, or keep H-3 to reads only.
-
Side jobs and the defer floor: change the routing contract or keep failing back to the caller.
-
Workers on plain Durable Objects or the Agents SDK.
-
Budget Google's security assessment for gmail.readonly; Microsoft Graph scope (ADR-0040).

## Sources and what was not verified
-
Waldo personality: north star, read in full (rev 12)
-
Waldo Agent Build Plan, rev 73, including the new job-protocol step 6 and the Browser Use section
-
Waldo launch brief
-
Ashish's session handoff of 21 October (pasted into this session)
-
GitHub: waldoco/waldo-backend PRs #1318 to #1336, states and check runs read on 21 October
-
Code, read-only at beta-mvp 3a727acf: prompt/messaging-behavior.ts, docs/foundation/WALDO_PERSONALITY_AND_VOICE.md, channels/owner-do.ts, channels/app-health.ts, channels/console.ts, owner-turn.ts
Not verified:
-
Ashish's gap analysis and core build plan could not be opened from this account; the work-item IDs come from his handoff.
-
File and line references are at 3a727acf, older than the PRs' base b3fe8891.
-
Nobody has run the PRs against live models, staging, or a merged beta-mvp.