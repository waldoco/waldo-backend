# Waldo vs Moonshot and the current personal-agent quality bar

**Date:** 2026-09-19

**Scope:** Public first-party evidence, the current Waldo G0-G4 plan, and concrete product-quality implications. No authenticated competitor account was used, no personal data was submitted, and no competitor runtime was benchmarked.
**Waldo baseline reviewed:** `docs/planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md` at the backend PR #138 worktree state available on 2026-09-19.

## Executive conclusion

Moonshot is genuinely early: its own pages call it an early-access iPhone app, a 100-seat founding beta for a small known group, and disclose a live storage migration, unfinished user-held encryption, incomplete recovery-record retention verification, one retired feature, and reliance on Composio for all Google access. That does **not** make it a concept-only landing page. Its current privacy policy describes a concrete product loop: ambient audio becomes transcript text, text becomes a durable `Mind` and commitment `ledger`, multiple model providers interpret selected context, and the app surfaces reminders, morning history, reviewed email/calendar actions, notifications, correction, forgetting, and deletion. The authenticated experience and reliability remain unverified, but the disclosed system is specific enough to treat Moonshot as a real early competitor rather than only marketing.

Moonshot's strongest insight is not “listen 24/7.” It is the product shape underneath that claim:

1. pay attention continuously enough to recover promises and open loops;
2. turn context into named, inspectable personal objects;
3. provide value before the user writes a new prompt; and
4. explain data handling more precisely than most early products.

Its strongest idea is also its largest liability. Remote ambient transcription retains the resulting text, captures nearby non-users, sends rich context to several suppliers, and relies on a broad bundled Google grant. Deletion is split between app and website records, historical copies can persist, and some retention limits are not yet verified. The homepage's absolute “Nothing leaves without your yes” language is therefore much less precise than the policy it links to.

Waldo should **not** respond by adding ambient listening, a broad connector catalog, or a generic browser before its current G0-G4 corridor works. The faster and better product path is:

- an excellent explicit-attention experience built from conversation, Calendar, user-approved Gmail/meeting context, and user-owned commitments;
- a simple `Today / Open Loops` view that proves Waldo knows the user's day without continuous surveillance;
- per-fact provenance, correction, forgetting, and deletion receipts;
- incremental connector authorization rather than one bundled Google grant;
- deterministic approval cards and source-verified receipts for every external effect;
- useful but controllable proactivity with `why now`, snooze, dismiss, dial-down, and quiet controls; and
- Trusted Relationships plus health-aware planning as differentiated capabilities Moonshot does not publicly establish.

The current Waldo plan is directionally stronger on authority, effect verification, account isolation, retry safety, and cross-owner boundaries. Its main gap is that those strengths are expressed as architecture and test contracts more clearly than as one legible, delightful user experience. The quality gates should now approve both layers.

## Source authority and limits

| Source class | Sources used | What it can establish | What it cannot establish |
|---|---|---|---|
| First-party legal/product disclosure | [Moonshot privacy](https://moonshot.computer/privacy), [Instinct privacy](https://instinct.com/privacy-policy), [Instinct terms](https://instinct.com/terms), [Poke privacy](https://poke.com/privacy), [Poke terms](https://poke.com/terms) | Vendor-stated current data handling, permissions, retention, controls, contractual restrictions, and acknowledged limitations | Independent security, runtime reliability, usability, or compliance in practice |
| First-party product/engineering material | [Moonshot homepage](https://moonshot.computer/), [Moonshot About](https://moonshot.computer/about), [Meta Muse launch](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/), [Muse security](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse), [Muse design](https://introducing.muse.ai/), [Grok Bot docs](https://docs.x.ai/grok-bot/overview), [Poke docs](https://poke.com/docs), [Instinct homepage](https://instinct.com/) | Product intent, documented UX, architecture claims, connector/action surfaces, and launch status | Independent proof that every claim works, measured quality, or general availability in every account/region |
| Local Waldo planning record | Current backend PR #138 plan | Waldo's accepted/proposed gate definitions and current evidence boundary | Shipped product quality or competitor parity |
| Authenticated competitor product | Not accessed | Nothing in this report | Actual onboarding, UI details, reliability, latency, or end-to-end action quality |

Confidence is **high** for what Moonshot currently states in its unusually specific privacy policy, **medium** for interpreting the intended product model, and **low** for actual experience quality because the authenticated beta was not tested.

## What Moonshot publicly establishes

### 1. Product and interaction model

**Observed vendor disclosure**

- Moonshot is an early-access iPhone app. Its [homepage](https://moonshot.computer/) says it listens continuously, builds context, notices promises/open loops and emotional or life trends, and tries to act before the user asks.
- Its [privacy policy](https://moonshot.computer/privacy) describes the operational sensing path: when listening is enabled, audio is split at the first quiet pause with a 30-second cap, sent through Moonshot's authenticated server to a private Google Cloud speech-transcription service, deleted when transcription finishes, and retained as transcript text.
- The transcript feeds named objects rather than only chat history:
  - `Mind`: people, projects, promises, preferences, and derived facts;
  - `ledger`: things the user said they would do;
  - pending notes and morning history;
  - standing orders; and
  - receipts recording what Moonshot did.
- Moonshot can speak replies through Fish Audio and uses push notifications. A one-bit Focus state is used to stay quiet.

**High-confidence inference**

The intended center of the product is ambient personal intelligence, not a blank-chat assistant. The emotional promise is “I noticed what you forgot,” and the interaction surface is meant to feel more like an attentive companion than a workflow tool.

**Unknown**

The public pages do not establish transcription accuracy, battery impact, background-listening reliability, notification quality, the frequency of false open loops, or whether the authenticated UI makes the system understandable rather than unsettling.

### 2. Memory and personalization

**Observed vendor disclosure**

- The `Mind` may contain facts derived from ambient transcripts, contacts, calendars, selected email details, Google Drive names/metadata, on-device photo analysis, place analysis, and sleep timing.
- Permanent Mind study runs through Anthropic Message Batches three times daily. The policy states that Anthropic batch results remain available for 29 days.
- Every Mind fact can be corrected or forgotten individually, and the whole Mind can be erased.
- Mind, ledger, pending notes, and morning history are mirrored for reinstall recovery. The recovery files are opaque to ordinary server processing, but Moonshot's privileged server can read their bytes; they are not encrypted with a key held only by the user.

**What this proves**

Moonshot has a stronger public memory product model than “we use vector search.” It names the objects, provides per-fact correction/deletion, and distinguishes local/recovery copies.

**Not established**

- source provenance for each fact;
- visible confidence or uncertainty;
- proposed-versus-accepted memory state;
- contradiction and temporal-update semantics;
- expiry rules;
- export/portability; or
- independent deletion/non-resurrection evidence.

### 3. Actions, connectors, and autonomy

**Observed vendor disclosure**

- One Composio “Google Super” authorization covers Gmail, Google Calendar, Google Drive metadata, Google Contacts display names, and verified Google identity. Google connection is required to finish initial setup.
- The underlying grants are broad, including full Gmail, Calendar, and Drive scopes, while Moonshot says its Composio configuration restricts the named tools it can invoke.
- Inbox import uses headers and snippets by default. Selected message text is a separate option that starts off; attachments are excluded.
- Drive access is restricted in product behavior to file names and metadata rather than file bodies.
- Gmail send/reply is reviewed and waits for a five-second confirmation bar. Calendar create/change/remove runs after confirmation.
- Reminders can be created and completed. The server stores standing orders and action receipts.
- Device sources include Apple Calendar, Contacts, Reminders, Photos, Location, HealthKit sleep, Focus, WeatherKit, microphone, and notifications.
- Calling is explicitly retired.

**Bounded interpretation**

Moonshot's current disclosed action layer is primarily Apple-native sources plus Gmail/Calendar/Reminders. Its site does not establish a general browser, cloud computer, transaction engine, broad SaaS catalog, or cross-user agent protocol.

### 4. Privacy and control

**Strong first-party commitments**

- no ads and no sale of user data;
- short raw-audio lifetime for ambient transcription;
- photos and precise routes remain on device, although derived facts may enter the Mind;
- optional app analytics and a separate invitation-analytics control;
- optional Gmail details off by default;
- per-fact correction/forgetting and whole-Mind deletion;
- a delete-all response that reports record counts or states that the server copy remains when unreachable;
- disconnect/revoke paths for Google and iOS permissions;
- material off-device data expansion promised as an in-app notice; and
- specific supplier disclosure rather than a generic “service providers” paragraph.

**Material limitations Moonshot itself discloses**

- transcript text survives after audio deletion;
- model requests can contain contacts' names, phone numbers and emails, calendar locations, reminder text, sleep timing, stored call turns, Mind content, and mail previews;
- Anthropic batch results can remain for 29 days;
- Fish Audio receives spoken-reply text, and Moonshot says Fish's terms permit training/improvement and publish no fixed retention period;
- Firestore is primary during a migration, while Supabase holds a recovery mirror;
- user-only-key encryption remains unfinished;
- historical database copies can persist for seven days;
- a Gmail watch can take up to seven days to expire;
- complete retention for deletion/recovery records is still being verified;
- app deletion does not remove the separate website application/conversation;
- website/iMessage records can persist for a year; and
- nearby non-users' speech and email written by non-users can enter the user's transcript and Mind, with an email removal request as the published remedy.

### 5. Onboarding and early-stage evidence

Moonshot's [About page](https://moonshot.computer/about) describes a 100-seat founding beta. Its [privacy policy](https://moonshot.computer/privacy) calls the cohort a small, known group and explains that the website beta chat, verified Google email, model recommendation, admission decision, and optional updates are stored. The app itself separately uses Sign in with Apple, binds a proved phone using App Attest, and then requires the Google connection.

This is meaningful evidence of an early product:

- early access and a 100-seat cohort;
- two different onboarding identities: Google for the beta door and Apple for the app account;
- required Google connection after app identity;
- a storage migration in flight;
- unfinished user-only encryption;
- unverified retention for some cleanup records;
- a retired calling feature;
- old builds that may have left a dated Google credential in Keychain;
- app and website deletion that are not joined; and
- email support instead of a public support/status knowledge base.

There is no public first-party evidence in the reviewed surfaces for pricing, App Store availability, user export, independent security certification, measured accuracy, a reliability/status history, Android/desktop support, accessibility, or medical/mental-health boundaries around claimed emotional-trend detection.

## Claims that need qualification

| Public claim | Evidence-based qualification |
|---|---|
| “Nothing leaves without your yes.” | When listening is enabled, every ambient chunk leaves automatically for transcription. “Yes” appears to mean an enabled permission/mode, not per-chunk consent. Waldo should not use an absolute statement like this unless every data path satisfies the ordinary-language reading. |
| “Server keeps no content copy.” | This is stated for the model relay, while separate server stores hold Mind, ledger, morning history, pending notes, snapshots and legacy call records. The scoped claim is compatible with the policy but easy to misread. |
| “We do not authorize any model provider to train.” | The same policy says Fish's public terms permit training/improvement on submitted spoken-reply text. The model-versus-voice-provider distinction is unlikely to be obvious to users. |
| “Sign in with Google” versus Sign in with Apple account | Google is used by the website beta door; Apple creates the app account; Google is then required as a connected service. The policy explains the split, but top-level onboarding does not make the identity model simple. |
| “Listens to you 24/7.” | The mechanism is disclosed, but sustained background reliability, battery impact, OS interruption behavior and capture accuracy are not publicly proven. |
| “Take actions on your behalf.” | Reviewed Gmail/Calendar actions and reminders are documented. The broader action inventory, standing-order limits, idempotency, rollback and recovery semantics are not. |

## Competitive product-quality comparison

This table compares documented product shapes, not measured winners. A marketing page establishes a target; it does not establish quality.

| Product | Strongest documented experience idea | Documented action/control bar | Public limitation or risk relevant to Waldo |
|---|---|---|---|
| Moonshot | Ambient attention becomes Mind, ledger, morning context and proactive help | reviewed Gmail/Calendar changes; per-fact forget; delete result; Focus-aware quieting | remote ambient transcription, bystander capture, broad bundled Google grant, split deletion, unfinished encryption/retention work, no public reliability proof |
| [Instinct](https://instinct.com/) | “No new interface”: text/call a personal assistant that uses a phone/computer and follows up | public privacy/terms acknowledge broad connected data, credentials/payment data and autonomous actions | internals and measured reliability are not public; default training uses non-Google materials unless the user opts out; terms put substantial action-verification responsibility on the user |
| [Poke](https://poke.com/docs) | contact-like assistant in Messages/Telegram/WhatsApp/RCS, recipes, reminders and broad integrations | integration management/disconnect, schedules and tier/usage controls | public docs establish catalog breadth more clearly than exact approval/recovery semantics; privacy permits training unless Maximum Privacy is selected; custom MCP/API-key paths raise supply-chain questions |
| [Meta Muse](https://introducing.muse.ai/) | one relationship-like conversation plus side chats, visible goals, ideas, avatar, artifacts and meaningful proactivity | out-of-chat structured approvals, full activity/permissions view, separate Sentinel, secret surrogation, isolated VM, visible browser takeover | very broad system; vendor states errors/prompt injection remain possible; training is opt-out and operator access remains possible until future Confidential VM |
| [Grok Bot](https://docs.x.ai/grok-bot/overview) | persistent named teammates, visible tool activity, steer/stop, cloud computer, teachable skills and routines | explicit approval boundaries, source/audit guidance, test-before-enable, routine history and secure takeover | all Bots in one account share files, browser sessions and CLI credentials; account-wide connector availability is not purpose isolation |
| Waldo current plan | governed personal continuity, compact memory, exact effects, Trusted Relationships, health-aware planning, India-specific corridors | typed proposals/approvals, immutable send snapshot, source read-back, receipts, account epochs, incremental grants and deletion proofs | most advantages are plan/contracts rather than accepted runtime evidence; the intended user experience needs a simpler visible shape |

### Important legal boundary for competitive testing

The existing Waldo plan proposes an owner-run Instinct parity harness. The current [Instinct Terms of Service](https://instinct.com/terms) prohibit use for benchmarking and development of competing products. The current [Poke Terms of Service](https://poke.com/terms) likewise prohibit use in competition, benchmarking, or competitive analysis. Possession of an ordinary paid or invited account does not remove those restrictions.

Therefore:

- do not run or publish systematic Instinct or Poke head-to-head benchmarks without written vendor permission or counsel-confirmed authority;
- do not scrape, automate, prompt-extract, load-test, or use non-public outputs for product development;
- use public first-party material and owner-supplied ordinary-use observations only as product signals, not parity proof; and
- keep Waldo's internal release evals scenario-based and vendor-independent. If a competitor allows a comparison in writing, add it as a separately authorized evidence lane.

This is a required correction to the current plan's §17.3 framing, not a reason to weaken Waldo's internal quality bar.

## Where Waldo can be the better product

### 1. Explicit attention instead of ambient surveillance

Moonshot buys context with microphone coverage. Waldo can earn a similar “it remembered what I forgot” outcome from explicit, high-signal sources:

- the user's own conversation with Waldo;
- Calendar;
- explicit commitments/Open Loops;
- selected Gmail threads;
- meeting notes with source links; and
- later, consented health planning signals.

This produces less raw coverage but a cleaner trust proposition. Ambient audio should remain out of G0-G4. It deserves a separate future threat model, bystander policy, indicator/pause UX, retention contract, battery/background proof, and physical-device acceptance gate if it is ever pursued.

### 2. One joined control surface

Moonshot's privacy policy is unusually candid, but the control story is spread across Apple permissions, an app Mind screen, Composio, Google revocation, website contact settings, email removal requests, and separate app/site deletion.

Waldo should make `Connections`, `Memory`, `Open Loops`, `Activity`, `Approvals`, and `Delete/export` one coherent control experience. A user should not need a privacy policy to discover which data left the phone, which provider saw it, why Waldo remembers it, or whether deletion is pending in a backup/retry lane.

### 3. Incremental Google trust

Moonshot's required one-shot Google Super grant is efficient for the company but cognitively and technically broad for the user. Waldo's Calendar-first design is a meaningful product advantage if it is visible:

- conversation works before any Google connection;
- Calendar can be connected alone;
- read and write abilities are separately explained where provider scopes permit;
- Gmail details remain off until the user enables the exact purpose;
- every active capability is inspectable and independently revocable where the provider contract allows it; and
- the UI says when a provider forces a broader OAuth scope than Waldo actually uses.

### 4. Provenance instead of mysterious intimacy

Moonshot promises deep attention but does not publicly establish source/confidence on each Mind fact. Waldo's Profile Claims should always answer:

- What does Waldo believe?
- Where did it come from?
- Is it user-accepted, inferred, stale, or contradicted?
- Which purposes may use it?
- Which model/provider classes received it?
- How do I correct, forget, or expire it?

This makes personalization feel earned rather than creepy.

### 5. Trusted Relationships and health as focused moats

Moonshot does not publicly establish a consented owner-to-owner agent protocol. Its ambient model can capture other people's words without making those people participants. Waldo's G3 can be qualitatively different: invite, accept, minimal-disclosure negotiation, independent approval, dual receipts, revoke/block/report, and no authority transfer.

Moonshot exposes read-only sleep timing. Poke advertises Oura context. Waldo's later physical-device HealthKit path can be better if it keeps health data purpose-bound, provenance/freshness-bearing, observational rather than clinical, correctable, and absent from general memory by default.

## Required additions to the Waldo G0-G4 quality gates

These are narrow amendments to the existing plan, not new architecture programs.

### G0 — approve the public trust contract, not only the backend boundary

Add these acceptance requirements:

1. **Live data-path register.** For every enabled source, publish and test: collected fields, purpose, device/server/provider destinations, model eligibility, retained copies, processor retention/training status, revocation, active deletion, backup expiry and unresolved limitations. Label each path `live`, `limited cohort`, `planned`, or `retired`.
2. **Joined identity deletion.** Account deletion must inventory and address app account, website/waitlist, marketing/update preferences, channel bindings, analytics identifiers, connector grants, support/application records and recovery work. The user-visible receipt distinguishes `deleted active`, `revoked`, `pending provider cleanup`, `backup expiry`, and `failed/retry required`.
3. **Truthful language test.** No absolute public phrase such as “nothing leaves,” “private,” “deleted,” or “only on device” passes unless the full provider and backup behavior satisfies an ordinary-language reading. Legal scope qualifiers hidden in a long policy do not repair a misleading product claim.
4. **No mandatory broad connector.** Authenticated conversation must work with zero external connectors. Calendar-only onboarding must not silently enroll Gmail, Drive or Contacts. If a provider forces a wider scope, show the mismatch and Waldo's narrower internal tool allowlist before consent.
5. **Device/account integrity.** Before external beta, prove authenticated device binding, stale-device/session revocation and replay resistance in addition to the existing owner/account-epoch tests. App Attest or an equivalent may be evaluated, but the acceptance criterion is the property, not the vendor mechanism.
6. **Non-user data policy.** Publish the rule for email participants, invitees, meeting participants and other people's information before any such source enters durable memory. The default is minimal extraction, purpose-limited retention and no independent profile of the non-user.
7. **No ambient-listening shortcut.** Microphone background capture is explicitly out of the G0-G4 claim. Adding it requires a separate gate rather than treating iOS permission as sufficient consent.

### G1 — approve “one person who remembers correctly” as an experience

Retain the existing publication, restart, capability-manifest and Profile Claim tests, then add:

1. **First-session value.** A new user can converse before connecting Google and reaches one grounded, useful personalized result without importing a life archive. Record time, turns, required permissions and abandonment.
2. **Memory card contract.** Every durable claim displays source, observed/inferred status, purpose, freshness, and correct/forget controls. Correction wins on the next eligible turn; deletion cannot resurrect from summaries, embeddings, caches or background jobs.
3. **Why-I-know disclosure.** When Waldo uses a personal fact unexpectedly, the response links to its memory provenance rather than presenting intimacy as magic.
4. **Multi-message control.** While a response/run is active, a newer owner instruction can steer or stop it; stopped work cannot publish later as success. This must be visible as a state transition, not inferred from chat prose.
5. **Personality without dependence pressure.** Longitudinal evals score usefulness, warmth and continuity alongside clinginess, coercive attachment, medical certainty, invented emotional insight and false confidence. “Feels like a person” cannot mean pretending to be human.
6. **Compact visible objects.** Use the existing Profile Claims and Open Loops; do not add a parallel `Mind` store. Give them a simple product surface so the user can see what Waldo knows and owes.

### G2 — approve a superior Calendar-first “knows my day” experience

Add:

1. **Calendar-only onboarding.** The user can grant only the Calendar capability, see the account and exact internal read/write affordances, and disconnect it without affecting unrelated sources.
2. **On-demand Today brief.** From Calendar plus explicit Open Loops, Waldo produces a cited `Today` view/brief with conflicts, commitments and missing information. This is manually requested in founder alpha; it does not require G4's proactive engine or ambient capture.
3. **Deterministic approval comprehension.** The approval card is outside free-form model prose and shows account, calendar, exact before/after fields, invite/notification behavior and expiry. Changed source state invalidates it.
4. **Trust-speed measurements.** Measure turns, elapsed time and user comprehension from “connect Calendar” to verified event result. Waldo must not win safety by making ordinary scheduling exhausting.
5. **Revocation experience.** Disconnect changes capability state immediately, cancels outstanding proposals/runs, explains retained receipts, and proves that a stale callback cannot restore the grant.

### G3 — approve the relationship moat and third-party boundary

Add:

1. **No ambient profile of the other person.** A relationship record contains only the consented identity, grants and shared protocol state. Messages or scheduling exchanges do not silently become a general personal profile.
2. **Recipient-visible purpose.** Invitations say who is asking, what minimum information can be exchanged, what actions each side may approve, how long the relationship lasts, and how to revoke/block/report.
3. **Independent deletion and revoke.** Either owner can end future exchange without deleting the other owner's lawful receipt. Revocation cannot reveal private decline reasons or prior calendar titles.
4. **Abuse and mistaken-identity exercises.** Wrong person, recycled address/number, forwarded invite, one-sided block, harassment/report and compromised-device scenarios are external-beta blockers.
5. **Public non-user policy.** The website/privacy surface explains relationship participants and incidental third-party data as clearly as it explains the owner's data.

### G4 — approve useful proactivity and low-friction exact effects

Add:

1. **Metadata-first Gmail.** Default catch-up operates on the minimum headers/snippets required for the admitted task. Full selected-thread/body retrieval is a visible per-purpose control; attachments remain excluded until separately admitted.
2. **Exact send card, not a countdown.** A five-second timer is not authority. Waldo shows immutable recipient, sender account, subject, body digest/preview, attachments, thread semantics and expiry; any changed approved field requires a new approval.
3. **Proactivity feedback loop.** Every unsolicited item says `why now` and which sources produced it. It offers done, snooze, dismiss, incorrect, dial down/off, and source-control actions. Quiet hours and Focus-like suppression must be deterministic.
4. **Nuisance-quality gate.** Repeated cohort trials record helpful, ignored, snoozed, dismissed, incorrect and too-sensitive interventions. The threshold is predeclared before acceptance; critical privacy/authority errors remain zero-tolerance regardless of aggregate usefulness.
5. **One Activity surface.** Pending actions, running work, waiting-on-user, completed/read-back, failed/indeterminate, routine history and delivery status are visible without reading the chat. Stop/pause/cancel are deterministic controls.
6. **Manual-first automation.** A reminder/routine is enabled only after the one-time task works on safe input. The user confirms owner, schedule/time zone, input source, result, approval boundary and missing/stale-data behavior. This aligns with the best documented parts of Grok Bot without importing its shared-computer model.
7. **Provider-visible privacy.** Connection details state which processors can see mail/meeting content and their retention/training posture. A “no training” claim covers voice, transcription, inference, analytics and subcontractors, not only LLM vendors.

## Joined product-experience gate

Before founder alpha or personal beta is called competitive, run the same internal synthetic scenario pack against successive Waldo candidates. This is the legal and reproducible benchmark even when competitor terms forbid head-to-head testing.

Measure:

- time/turns/permissions to first grounded personal value;
- usefulness and personality continuity across sessions;
- correct remember, update, contradiction, forget and provenance behavior;
- Calendar proposal comprehension, approval burden and verified result;
- Gmail minimum-data behavior, exact send approval and immutable effect;
- proactive precision, nuisance, sensitivity, quieting and cancellation;
- activity-state comprehension: what is happening, why, and how to stop it;
- connector-grant comprehension and revocation time;
- deletion coverage and user understanding of active deletion versus backup/provider expiry;
- third-party/minimal-disclosure behavior; and
- latency, cost and recovery after faults.

Zero-tolerance failures remain:

- cross-owner or cross-account disclosure;
- external action without current typed authority;
- fictional or unverified success;
- changed-content send after approval;
- deleted/corrected memory resurrection;
- proactivity during deterministic quiet/disabled state;
- non-user private data entering unrelated memory; and
- a public privacy claim contradicted by the observed data path.

For subjective experience, predeclare the cohort, tasks, trial counts and acceptance thresholds before running. Preserve redacted trajectories and deterministic source-of-record evidence. Do not tune the threshold after seeing the result.

## What should remain deferred

Moonshot does not justify changing the current critical path. Keep these out of G0-G4:

- ambient listening and emotional-trend inference;
- a second memory ontology modeled on `Mind`;
- broad Google Super authorization;
- generalized browser/computer use;
- credential/password/card vaults;
- provider proliferation for its own sake;
- voice I/O as a founder-alpha blocker;
- marketplace skills or arbitrary MCP endpoints; and
- a multi-agent fleet.

The earliest superior Waldo is still `G0 -> G1 -> G2`: a truthful app, a memorable and correct relationship, and a Calendar-backed view of the user's day. G3 then supplies a meaningful category differentiator; G4 supplies the proactive follow-through users associate with Moonshot, Poke, Instinct, Muse and Grok Bot.

## Final assessment

Moonshot is early, credible, and useful as a product-design signal. Its public disclosure quality is ahead of many startups, while its privacy architecture and account/control cohesion are unfinished in ways it candidly admits. It is not currently public evidence of a general-purpose action agent on the level claimed by Muse, Instinct or Grok Bot. Its real competitive pressure on Waldo is narrower and more important: it makes personal context, commitments and proactive help feel like one coherent promise.

Waldo can be better if it refuses the false choice between intimacy and governance. The product should feel attentive because it remembers explicit, source-backed things and closes loops—not because it collects the maximum possible life exhaust. The build plan already contains most of the hard authority and recovery contracts. The next improvement is to turn those contracts into a visible `Today + Memory + Open Loops + Activity + Connections` experience and to make that experience itself pass a repeatable gate.

## Primary sources

### Moonshot

- [Moonshot homepage](https://moonshot.computer/)
- [Moonshot privacy policy](https://moonshot.computer/privacy), last updated 2026-09-14
- [About Moonshot](https://moonshot.computer/about)
- [Moonshot contact page](https://moonshot.computer/contact)
- [Moonshot creator dashboard](https://moonshot.computer/creators)

### Competitor first-party sources

- [Instinct product](https://instinct.com/)
- [Instinct privacy policy](https://instinct.com/privacy-policy), revised 2026-08-26
- [Instinct Terms of Service](https://instinct.com/terms), revised 2026-08-26
- [Poke product](https://poke.com/)
- [Poke docs](https://poke.com/docs)
- [Poke integration management](https://poke.com/docs/managing-integrations)
- [Poke usage and resets](https://poke.com/docs/usage-and-resets)
- [Poke privacy policy](https://poke.com/privacy), updated 2026-09-11
- [Poke Terms of Service](https://poke.com/terms), modified 2026-03-17
- [Meta Muse launch](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
- [How Meta built safety into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)
- [How Meta designed Muse](https://introducing.muse.ai/)
- [Grok Bot overview](https://docs.x.ai/grok-bot/overview)
- [Grok Bot collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration)
- [Grok Bot computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)
- [Grok Bot skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)

## Retrieval limitations

- The authenticated Moonshot iPhone beta, Google/Apple sign-in, stored data and connector actions were not accessed.
- `door.moonshot.computer` was not retrievable through the text-fetch path used for this review; no login was attempted.
- The report treats Moonshot's privacy policy as a first-party commitment and architecture description, not independent verification.
- Competitor ordinary-use accounts were deliberately not used for benchmarking, especially because Instinct and Poke currently prohibit benchmarking/competitive analysis in their terms.
- “Not established” means absent from the checked public sources; it does not prove that the feature does not exist.
