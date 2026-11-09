# Learning the owner: the owner profile, noticing, and the owner look-up (26 October 2026)

Status: **candidate design, plus one built tracer slice behind `OWNER_PROFILE=0`.** Base: `beta-mvp` `e223d0d2`.
It reconciles three open issues and two designs that already cover parts of this ground:

| Source | What it already settles | What this note adds |
|---|---|---|
| #1533 (lane E) | An observation store ADR, a noticing job, questions, a weekly read-back | How noticing learns *without* that store, and what has to wait for it |
| #1534 (lane F) | The owner model's trust order, 30-day expiry, the LinkedIn and X import | Maps the trust order onto today's claims; one interim view built |
| [Memory v2](../proposals/MEMORY_V2_2026-10-25.md) and its [ADR draft](../proposals/ADR_DRAFT_MEMORY_V2_2026-10-25.md) | *About you*: a compiled `notebook_sections` page over claims, two trust-separated compiler calls, 4,000 characters | Its interim form, which needs no table, and so no ADR |
| #1548 (welcome constellation) | Inferred, digit-free support claims from health, calendar and mail. The web stage is `skipped` | Noticing reuses its admission rules; the look-up joins its web stage |
| #1547 (setup answers) | Setup answers become pinned owner claims | The profile ranks them first and stops them from hiding the owner's other words |

#1535 is lane G (proactivity evals), not the look-up. Its judgment evals are how noticing's raises get graded (§3.5).

The owner's direction for this note (26 Oct): learn about the owner from all aspects (onboarding, mail, name and so on): notice,
keep an owner profile, and look the owner up on the public web.

## 1. What exists today (verified at `e223d0d2`)

- **Claims are the one store of facts** (`memory/claims.ts`). Each has a kind, source, origin, `source_ref`, provenance, a supersede chain and pins.
  - Their writers:
    - `remember` in the turn;
    - the nightly claim ops (03:00 local, one auxiliary call per chunk, at most three chunks; `channels/episodes.ts:212-242`);
    - setup answers through `answer()` in `onboarding/first-run.ts`;
    - kept look-up findings through `findings.decide()`;
    - the welcome build (inferred supports);
    - owner actions (`claim.edit`, `claim.pin`, `node.*`).
- **Every turn reads `turnMemoryPrompt`**: `<owner_profile>` (1,500 characters) and `<owner_facts>` (2,500), then
  `<owner_constellation>` (1,200).
  - Once any claim is pinned, only pinned claims show. #1547 pins the setup answers, so an owner who answers setup loses
    every unpinned fact from every turn. Recall still finds them. The #1547 gate flagged this.
  - Owner-stated health readings ("On 22 Oct said resting HR was 52") are `health` claims and render on every turn.
- **Mail and calendar produce no claims.** Push only wakes the brief sweep. `readChanges` (`channels/update-cards.ts:115`)
  builds the "what changed" digest: events up to 2 days ahead and up to 10 new mails. The update sweep reads it as a machine job.
- **The owner look-up is built, and off.**
  - The skill `skills/owner-lookup/SKILL.md` uses `list_owner_findings`, `web_search`, `browse_page` and `record_owner_finding`.
  - A finding must cite a page read in the same run, and quote that page (`observeReads`, `onboarding/findings.ts`).
  - Findings live in `owner_findings`, apart from memory and out of every prompt, until the owner keeps or corrects one. That
    makes it an owner claim with `source_ref: owner, look-up <id>`.
  - An unconfirmed finding is deleted after 30 days (`APP_FINDING_UNCONFIRMED_DAYS_V1`).
  - Forget bars the text. Withdrawing consent erases every finding.
  - `list_owner_findings` returns `source_taint: 'external'`.
  - Both tools are allowed on `user_message` only (`contracts/src/tools/permissions.ts:288`).
  - The gate is `consent.active('owner_lookup')`, which needs `OWNER_LOOKUP=1` and the published notice.
  - No code path starts a look-up. The welcome web stage only reports whether findings exist (`welcome-sources.ts:149`).
- **Egress.** `EGRESS_READ_TOOLS` (`web_search`, `browse_page`, `read_mcp_tool`) are removed from machine-job workers and from
  unattended outside-text turns (`tasks/profiles.ts:20-21`, `check-back.ts:12-16`). They are kept for owner turns and
  owner-started tasks. No worker profile carries a memory tool, so a task worker cannot record a finding.
- **Proactive gates.**
  - `proactiveGate` (`channels/proactive-gate.ts`) handles the kill switch, opt-out, volume and quiet hours.
  - `computeAdmission` (`delivery-gate/gate.ts`) handles budget and cooldown.
  - The heartbeat has a 4-hour re-notify cooldown.
  - The response history that exists today is `update_cards.feedback` (useful or not useful) and `day_plan.outcome`.

## 2. The owner profile

**What it is.** The owner profile is a summary the model keeps current and the owner can correct: what Waldo knows about this
person, read on every turn. It draws on:
- setup answers;
- the owner's own words in chat;
- look-up findings the owner kept;
- Waldo's reads from mail, calendar, health and the constellation, kept apart until confirmed.

### 2.1 Where it lives: a view over claims, not a new aggregate

The end state is Memory v2's *About you*: one compiler writes `notebook_sections`, and every line cites claims. That is new
derived persistence, so it waits for the Memory v2 ADR.

Until then, the profile is a **view**: `ownerProfilePrompt` in `memory/owner-profile.ts`. It reads claims and writes nothing.

**Why a view is enough now:**
- Every input is already a claim with a source.
- Correct, forget and held topics already act on claims.
- A view cannot drift from the truth, because it has no copy.

**What a view cannot do:** phrase an understanding of the person ("a writer who protects mornings") rather than list facts.
That is the compiler's job, and the reason *About you* still needs its ADR. The view is that page's *New since* tail with
nothing compiled yet, so the compiler replaces it without changing callers.

### 2.2 Trust order (#1534), mapped onto claims

| #1534 tier | Claims today | Where it renders |
|---|---|---|
| 1. Owner words | owner-grounded, not `confirmed`, not a look-up ref. Setup answers rank first. | Profile: *In their own words* |
| 2. Kept findings | owner-grounded, `source_ref` `owner, look-up …` (`isLookupRef`) | Profile: *Kept from the web look-up* |
| 3. Imports | not built (§4.4). When built, an owner-kept import is an owner claim under its own ref | Profile, after tier 2 |
| — | owner-grounded, `source: confirmed` (Waldo's read that the owner agreed with) | Profile: *Waldo's reads they confirmed* |
| 4–7. Connected data, health patterns, observations, inferences | `inferred` with origin `agent` or `untrusted` (welcome supports, nightly reads, noticing) | Never in the profile. `<owner_constellation>` labels them *waldo's read*. Recall finds them |

**Ranking.** Pins come first: they must appear (Memory v2 rule 7). Then lines follow tier order, setup answers first, then
newest first. Lines fill the budget in rank order and are never cut. What does not fit is counted in one line, and recall finds it.

**Pins change meaning under the flag.** Today a pin is the only way onto every turn. Under the flag it means "must appear",
and unpinned owner facts still fill the budget. The nightly pass's pin rules (`PIN_RULES` in `memory/claims.ts`) were written
for the old meaning, so they need a wording pass before the cohort rollout.

Grouping by source is provenance, not judgment. No rule decides what matters: what to keep and how to say it stays with the
model, through `remember`, the nightly pass and, later, the compiler.

### 2.3 The one writer

The view writes nothing. Each fact keeps its existing writer, and no new writer is added.

When *About you* lands, its compiler is the one writer of `notebook_sections`, as the Memory v2 draft says. That is debounced
after a claim change, nightly, and never inside a turn.

### 2.4 How the owner sees, corrects and forgets it

The profile uses the existing actions; no new one is needed.

- **See.** The app's *What Waldo knows*: claims, findings and the constellation.
- **Correct.**
  - In the app: `claim.edit` or `node.correct`, both step-up gated.
  - For a finding: keep or correct.
  - In chat: every profile line starts with its claim id (`c12`), so `remember(replaces_id)` corrects exactly what the model read.
- **Forget.**
  - `forget_memory` and the topic barrier. The owner turn reads memory through `barrierMemory`, so a held topic leaves the
    profile on the next turn.
  - A forgotten finding deletes its claim.

### 2.5 Prompt context and budget

- The profile goes in the system prompt's sized `memory` slot. It honours the room the composer gives it.
- At most 4,000 characters (about 1,000 tokens) of lines, plus the header and two count lines.
- `<owner_constellation>` is unchanged (at most 1,200 characters).
- So the worst case is token-neutral against today's two blocks.
- The page is stable between claim changes, so prompt caching is unaffected.

### 2.6 Health

- **No numbers.** A claim whose text holds a numeric health value (`numericHealthIn`), or any digit in a `health` claim, is left
  out of the every-turn profile and counted: "2 health readings the owner stated are left out here; recall finds them, and
  get_health is current."
  - This is a hard data-safety floor, the same as the welcome admission's, not a judgment call.
  - Health *patterns in words* ("sleeps badly before long flights") stay.
  - Device data never becomes a claim (ADR-0081; `HEALTH_MEMORY_RULES`).
  - Live numbers are a separate, proposed destination: Memory v2's `<health_today>` amendment.
- **Readings themselves.** Whether stated readings should be kept at all is Memory v2 open question 6. This view does not
  change storage. It only stops readings riding every turn.

### 2.7 The built slice (`OWNER_PROFILE`, default `0`)

- `memory/owner-profile.ts`: `ownerProfilePrompt(store, question, maxChars)`, the same interface as `turnMemoryPrompt`.
- `OWNER_PROFILE` is `"0"` in both wrangler var blocks and listed in the alpha runbook.
- The flag reaches the owner turn through `OwnerContextIntegration.profileView` on all three owner-turn integrations in
  `owner-do.ts`:
  - app, which the console shares;
  - iMessage;
  - the remaining branch.

  The app path is tested end to end. That the remaining branch carries WhatsApp turns is inference from the selector; it is
  not tested here.
- Unset or `0`: byte-for-byte today's `turnMemoryPrompt`.
- **Paths that do not follow the flag.** The day-card machine call (`day-cards.ts:266`) and the background decision path
  (`owner-turn.ts:973`) stay on `turnMemoryPrompt`.
  - The decision path already reads owner-origin, non-health claims only.
  - Day cards are a machine call that does not need the owner's words grouped.
- **Rollback.** Set the var to `0`, or revert. Nothing is persisted.

## 3. Noticing

### 3.1 What it is

Noticing is one background pass that reads what changed across sources. The **model** decides two things:
1. what is worth learning (a proposed fact);
2. what is worth raising (a question or a heads-up).

No fixed rule mutes a kind or picks a topic (CLAUDE.md, #1533).

### 3.2 Where it runs

The welcome build's pattern, not a machine worker:
- the source reads run in code, outside any SQLite transaction;
- then one structured `ask()` per pass, with no tools, as an owner job on the serial queue;
- under a `memory_notice_*` purpose, so no text is traced (metadata-only, as the welcome calls are).

**Why not a #1496 machine job:**
- A worker's loop is unbounded, so a structured read is cheaper.
- Machine workers have no egress reads anyway.
- No worker carries a memory tool.
- The welcome build already proved this shape: a bounded per-stage budget, a late answer writes nothing, and a stage that fails
  settles alone.

#1355's worker layer stays the owner-started path for long research (§4.3).

**Inputs**, all pointers in the welcome build's limits:
- `readChanges`' calendar and mail digest: titles, times, attendee counts, sender display name, domain and subject, never bodies;
- the day's episodes since the nightly watermark;
- the profile view (§2);
- live Waldo's-read claims;
- the forget barriers;
- once the store exists, the owner's raise and response history (§3.4).

Health enters only as `HealthPattern` words once #1472 ships. Until then the pass gets no health input.

### 3.3 How it proposes a fact

The fact goes through the welcome admission: domain enum, length caps, no digit, no numeric health, pointers only from those
the pass was given, and no barrier hit. It is written as a claim:
- `kind`: `observation` or `pattern`;
- `source`: `inferred`;
- `origin`: `untrusted` for mail and calendar, `agent` for episodes;
- `source_ref`: `notice:<source>:<pointer>`.

The pass's confidence is not a new column. Its "how sure" goes in `evidence`, and confirmation is the owner's.

The fact shows as *waldo's read* in the constellation and app, never in the owner profile, until the owner confirms (which
owner-grounds it) or corrects it. A forget bars it.

This adds a **standing** producer of outside-text claims. The welcome ADR's rule 5 allows that once, at setup, so this needs an
amendment (§5, A3).

### 3.4 How it raises something without nagging

"Without nagging" is judgment, so it needs evidence the model can read: what Waldo raised, where, when, and what the owner did.
That evidence is #1533's **observation store**, and it needs an ADR.

**Until the store exists, noticing learns and does not raise.** Its learned facts reach the owner through surfaces that already
have gates:
- the Brief and day cards read the constellation;
- chat reads it every turn;
- the existing gates keep budget, quiet hours, cooldowns and opt-out.

Today's partial response history (`update_cards.feedback`, `day_plan.outcome`) can be given to the pass as evidence. It is not
a store for noticing's own raises.

**Once the store lands:**
- At most one question per natural moment (#1533 §3), chosen by the model, from the owner's response history.
- The weekly read-back card.
- Each raise goes through `proactiveGate` and `computeAdmission`, the same as every other card. No new gate.

### 3.5 Cadence and cost

| Trigger | Cost |
|---|---|
| Nightly, right after the nightly claim ops | One auxiliary-model call, about 6–12k input tokens `[inference]` (digest pointers plus profile, capped like the welcome stages) |
| On change: a mail or calendar push that moved the brief sweep, debounced to at most one pass in 4 hours `[proposed]` | At most 6 calls per day `[proposed]` |

The spend ceiling holds paid calls past the monthly cap, as for every owner job.

**Proof (lane G, #1535):**
- judgment evals where noticing must stay quiet, or must learn without raising;
- a fake-clock week that counts passes and raises.

## 4. The owner look-up skill (OSINT)

### 4.1 Built: keep, do not rebuild

The skill, its tools, quote grounding, the 30-day expiry, the consent gate, the forget barrier and erase-on-withdraw are all
built (§1). Findings are external text:
- they never enter a prompt until the owner keeps one;
- `list_owner_findings` is tainted `external`;
- the skill and tool descriptions say page text is data, never instructions.

Kept findings become owner claims, the owner's own act, and so tier 2 of the profile.

### 4.2 Learning "from all aspects": the seeds

Today the skill searches the owner's name plus the handles, sites and addresses the owner gave. These are the proposed seeds,
each a fact the owner already holds:

| Seed | Status |
|---|---|
| The name from setup (`NAME_REF`) | Today |
| Employer, role or city the owner stated or kept | Read from the profile view |
| The domain of the owner's connected Google address (the account's own address, not mail content) | Owner question 7 |
| The owner's own signature in mail they sent | Mail content as a seed. Owner question 8 |

These are skill-text and context changes. The model still judges whether a page is the owner's, and the owner judges each finding.

### 4.3 How a consented look-up runs

**An owner turn, never a machine job.**
- `record_owner_finding` is `user_message`-only.
- Grounding needs the read and the record in the same run.
- Egress reads are kept for the owner's own turns.

So the look-up runs when:
- the owner asks in chat; or
- the owner taps "Look me up" in the app after consenting. The tap admits an owner main-chat message, as the first look does
  (`FIRST_LOOK_TEXT`). The app change is additive; it uses the existing message route.

The welcome web stage keeps only reporting findings. If the owner wants the gift to include a look-up, the stage would offer
that tap; it would not run the look-up itself (owner question 6).

A #1355 reader task is **not** a look-up path:
- workers carry no memory tools;
- a worker's run key would not ground a finding;
- moving `record_owner_finding` into a worker would widen a write tool into an unattended context.

### 4.4 Never about third parties

- The skill and `record_owner_finding` already refuse any other person, and the five sensitive categories.
- Looking up another person happens only when the owner asks, as an ordinary `web_search` in their turn. It is never recorded
  as a finding and never kept as a claim unless the owner says "remember …".
- Noticing never starts a web read.

### 4.5 LinkedIn and X import (#1534 §2, owner ruled yes)

The owner's own archive is uploaded, parsed, the bytes are deleted, and only positions, education, skills, the bio and topics
are kept, as findings-like rows the owner keeps. DMs, address books and ads are dropped at upload.

This needs an ADR, a new upload route with limits, and a privacy-notice paragraph. It is not built.

## 5. ADR and contract review

| # | Item | Needs |
|---|---|---|
| A1 | *About you* compiler and `notebook_sections` (the profile's end state) | Memory v2 ADR, brain review |
| A2 | Observation store (raises, where, response; retention), questions, weekly read-back | #1533 ADR |
| A3 | Noticing as a standing producer of inferred claims from mail and calendar metadata | Amendment to the welcome ADR's rule 5 (outside-text exception), and a privacy-notice line |
| A4 | LinkedIn and X archive import | #1534 ADR, upload contract, privacy notice |
| A5 | "Look me up" tap | app.v1: none if it reuses the chat message route; posted on waldo-app first |
| A6 | Inferred-claim expiry at 30 days (#1534) | Owner ruling, then a claim-store change with the forget inventory checked |
| — | The built slice | **None.** No persistence, no contract (prompt text only), no grant, flag off |

## 6. Next slices, in order

1. **Turn `OWNER_PROFILE` on for the staging test owner.** Run the memory scenarios (`p01-knows-you`, `v01-wrong-fact`,
   `m05-forget-then-ask`, `h04-health-memory`) in recorded mode, then live once `WALDO_EVAL_*` is set.
2. **Noticing, learn-only.** Nightly pass, after A3, red first:
   - one writer;
   - only given pointers;
   - no digits;
   - a barrier holds;
   - a late answer writes nothing;
   - one call per night.
3. **The look-up seeds** (skill text) and the app's "Look me up" tap. Needs `OWNER_LOOKUP=1` after the notice is published.
4. **Raising**, after A2.
5. ***About you***, after A1.

## 7. Owner decisions

1. Turn on `OWNER_PROFILE` for the staging test owner once the gate reviews it?
2. Then turn it on for the cohort, after the recorded memory scenarios pass?
3. With the profile on, should stated health readings leave the every-turn block? Recall still finds them, and they stay
   stored (Memory v2 question 6, storage side unchanged).
4. Should all of Waldo's unconfirmed reads expire after 30 days, as #1534 says, and not only web findings?
5. Should noticing ship learn-only (proposing Waldo's-read facts) until the observation store ADR lands?
6. Should the welcome gift offer a "Look me up" tap, rather than run the look-up itself, once the notice is published?
7. May look-up seeds include the domain of the owner's connected Google address?
8. May look-up seeds include the signature in the owner's own sent mail? (This is mail content.)
9. Should noticing read mail metadata nightly (sender name, domain, subject; no bodies), as the welcome build does?
