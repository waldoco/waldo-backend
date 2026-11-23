# ADR-0081 amendment: the health inventory (first slice: `HEALTH_PARTIAL_CONTEXT`)

Status: draft for review. Ansh owns the health score rules and reviews it. Once accepted, waldo-brain's ADR-0081 carries it as a
dated amendment beside §3 (the field × destination matrix).

## The problem

The 16 November exercise reported that the model's health block was empty in about 500 of 650 staging reads over a week. When the
block is empty, the model reads "No derived health context is available for this invocation." and tells the owner that nothing is
available. This PR did not re-read those logs.

At `95acaa51` the reader gives no block in four cases. Each was checked in source, and three were confirmed by running the real
producer in `test/health-context-partial.test.ts`:

- **No row.** The read RPC returns no context when the owner has no row, or no live consent basis for it.
- **No Recovery zone.** Recovery needs last night's sleep and an overnight heart signal (HRV or resting heart rate). Form takes
  Recovery's reason whenever Recovery fails. So an owner with steps only, sleep and steps, or heart rate and steps gets a row
  with every pillar unavailable and no block at all. The producer writes that row because readings arrived for the day.
- **A row over three days old.** It counts as no row.
- **The missing list.** It was hardcoded empty, so the model was told nothing was missing even when something was.

The owner ruled on 16 November that Waldo must never hit a dead end on partial body data. Even daily steps are useful. Scores stay
computed on the backend, and a missing source should lead to what can still be said, with the model reasoning over it. Later the
same day he asked for the rules to be general rather than a narrow fix. This amendment states the general rule, and this PR builds
its first slice.

## The general rule: the health block is an inventory, not a verdict

Today the block is a verdict: a few zone words, or nothing. The rule this amendment proposes is that the block is a **map of the
body data that exists for this owner**. The model reads the map, then pulls what it needs with tools, the way a coding agent reads
a file tree and then opens the files that matter. The map is always words. Figures stay with the tools, in the turn.

### (a) What the inventory holds, in words

For each kind of body data:

| Item | In words | Source in the general form | In this PR |
|---|---|---|---|
| Whether it exists | e.g. "last night's sleep", "steps through the day" | A closed `present` list the producer writes at compute time | Only what the stored row already shows (below) |
| How fresh | fresh or stale; today, yesterday or an earlier day | The row's compile time and day | Yes |
| From which source | Apple Health, Oura, WHOOP, Samsung Health, Health Connect | The row's consent basis | Yes |
| At what grain | e.g. "hourly through the day", "one value a night" | The signal's stored shape | No (needs the producer's list) |
| What is missing | the pillar and the reason the engine stored | The row | Yes |
| The one step that fixes it | e.g. "wear the watch or ring overnight, and let Waldo read sleep" | A closed reason → step mapping | Yes |
| What each score could say | zone word, or why it could not be computed | The row | Yes |
| Where to read more | the tool and grain that answer the next question | The function list | A conditional pointer to `get_health` |

**What the stored row can show arrived today.** It records why each pillar is missing, not every reading. A steps-only row and a
heart-rate-plus-steps row are byte-identical (tested), so this PR names only:

- last night's sleep, when Recovery failed for its overnight heart signal or its baseline, since the engine checks sleep first;
- sleep across recent nights, when sleep debt has a figure or a share;
- the calendar or activity, as named in a computed Load's used signals;
- workouts, when the training load was computed.

Naming steps or daytime heart rate needs the producer to write a closed `present` list. That is a change to
`waldo.health_context_write`'s closed key list and the read RPC, so it is a migration owned by the producer session. It is the
next slice.

### (b) What grains the read tool should offer

`get_health` today answers by **local day** only: daily values or a summary, up to 31 days, one source per signal, turn-only. The
questions an owner actually asks need finer and longer grains:

| Grain | Answers | Today |
|---|---|---|
| The last few hours | "Am I wired right now?", "how was my afternoon?" | No: the store holds hourly windows, but the tool folds them into a day |
| Last night | asleep time, bed and wake times, the overnight heart signal | Partly: asleep minutes and the sleep midpoint by day; no bed or wake time |
| Bed and wake time | consistency and the timing of sleep | No |
| A 30-day trend against the owner's own usual | "Is this normal for me?" | Partly: daily values over 31 days; the model does the comparison |

**Two tools are declared but cannot run.** `get_crs` and `get_master_metrics` appear in the tool records, the trigger permission
lists and the argument registry, but no handler exists in `tools/live/`. The only reference is a scripted fixture in
`llm/run-loop-adapters.ts`.

Proposal:
- Either implement them as the grains above (`get_master_metrics` as the 30-day trend against the owner's usual, for example), or
  remove them from the permission lists.
- Whether a declared tool with no handler reaches the model's function list was not checked in this PR.

### (c) Can the model ask for a fresh sync before it speaks?

Not today. No backend tool or route asks the phone to upload now. The phone uploads on its own schedule, so the inventory's
freshness line is the model's only signal.

Proposal: a `request_health_sync` read that wakes the app, waits a bounded time for an upload to commit, then re-reads the
inventory, and says plainly when nothing arrived. It needs app work. iOS does not guarantee background delivery [inference], so
the tool must never imply that a sync happened when it did not.

### (d) Helper runs cannot read health

`conversation/subagent.ts` keeps `get_health`, `get_crs`, `get_master_metrics`, `list_health_logs` and `list_medications` out of a
child task's tools. A child's report reaches the parent as outside data, where Scribe withholds readings. So deep analysis, such as
"look at my last month of sleep against my training", cannot be delegated: the parent reads health itself, inside its own turn
budget.

Recommendation: keep this until the depth question below is ruled on. If health reads are opened to children, the child's report
must be words only through the same Scribe pass, and the parent must stay the only writer of anything kept.

### An open question for the owner and Ansh: words only, or more depth?

**The tension.** ADR-0081 §3 keeps raw values and derived figures out of the prompt, DO memory, R2, logs and traces. The always-on
block is therefore words only. Raw values live only in the health store. Yet the deeper answers the owner wants ("my resting heart
rate has crept up over three weeks") need figures or comparisons.

**What already exists.** `get_health` gives the model figures turn-only: they stay in the turn, and no value reaches the tool
ledger, memory, logs or storage. So depth is available on demand. It is not in the always-on block, and it is not available to
helper runs.

**Recommendation:**
- Keep the always-on inventory words only.
- Add a read-tool grain that compares a signal with the owner's own usual and answers in band words ("well below your usual for
  three nights"), computed in the health plane and seen only in the turn.
- Never store the result, and never put it in memory or a trace.

This needs an explicit ruling, because a comparison is a derived figure under §3 even when it is phrased in words.

## What this PR builds (the first slice)

Behind `HEALTH_PARTIAL_CONTEXT` (on in staging, off in production), the reader turns a stored row with no Recovery zone, or one more
than three days old, into a **partial view**: a third member of the derived view union, made of words only. It carries the
inventory items marked "Yes" in (a), plus any pillar that is honest on its own: Load's zone and baseline state, sleep debt in
words, and today's energy windows. The prompt renders it as one paragraph opening `Partial health context:`, which the trace health
scrub withholds whole.

With the same switch, a full Form or Recovery view also fills its missing list:

- `missing_components` comes from the signals the pillar says it used, when the row names them. These are HRV, plus, for Form,
  the circadian timing of sleep or daylight, and motion as movement or steps.
- The new optional `missing_pillars` names the pillars that view does not show, with their stored reasons.

A full row with every input renders byte for byte as it did with the switch off.

A full row without overnight HRV changes in exactly one line, from `Missing components: none.` to `Missing components: hrv.`. Such
a row is common on a Galaxy Watch through Health Connect, which scores Recovery from the night's resting heart rate. Mapping
Form v10's signals onto ADR-0081's four components is Ansh's to confirm:

- sleep timing or daylight count as circadian;
- movement or steps count as motion;
- daytime stress has no ADR-0081 component, so it is never named.

On full days the inventory is still thin: the zone lines, plus what is missing. Giving every day the full inventory (sources, what
arrived, grains) changes the full-day block for everyone, so it waits for the producer's `present` list and its own review.

### What the inventory must never do

- **No Recovery, Form or readiness word without its inputs.** The partial view has no zone field, and the contract rejects
  `recovery_zone`, `form_zone`, `trend`, `confidence_band` and any score. The narrative beside it is parsed with a schema that has
  no zone or Recovery descriptor. If a zone narrative rides beside a partial view, the composer fails the turn closed.
- **No invented score.** Nothing is computed in the reader. Every word comes from a stored field or a closed mapping of a stored
  reason.
- **Nothing without consent.** There is no block when the row is absent (the RPC already filters out rows without a live consent
  basis). There is also no block when any pillar carries `not_linked`, `consent_required` or `consent_withdrawn`, whatever else the
  row holds. A read that fails stays `unknown`, never "not shared".
- **No raw value and no derived figure.** Minutes, scores, counts and confidence numbers never leave the reader. The only digits
  that can reach the block are energy windows' clock times, as before.
- **No inferred presence.** A signal the row does not record is never named as present. The block points to `get_health` instead.

### An expired row

A row more than three days old still gives no zone, no pillar and no reason from its day (ADR-0081 §2: older data is
unavailable). With the switch on, the block now says the newest body data is more than three days old, names the step that brings
new readings (opening the app so the phone can send them, and checking that the wearable syncs), and points to `get_health`. This
is missingness and freshness, which the §3 matrix already allows in a trigger-scoped prompt. If the reviewer would rather keep an
expired row as no block, one branch in `toContextHealthMaterial` reverts it.

## Designs considered

| Design | What it does | Why not, or why |
|---|---|---|
| **A. An inventory in words from the stored row, with tools for depth (chosen)** | The reader maps stored reasons, sources and any pillar that is honest alone into words. The prompt renders facts plus one fix and a tool pointer. | No new read, no new store, no score change. It uses only fields the row already holds under the existing consent filter, and it is rolled back by one switch. Its limit: it cannot name a signal the row does not record, which the producer's `present` list fixes. |
| B. Read the health series on every turn to list present signals | Each turn calls the series read and turns "steps arrived today" into words. | It adds a signed read to every turn, and pulls raw values through Worker memory on turns that never needed them. `get_health` already does this when the model asks. Recording presence at write time is the cheaper structural fix. |
| C. Score from whatever exists, so there is always a zone | Recovery from sleep alone, or Form without Recovery. | A score-rule change Ansh owns. It is proposed in general form, with its trade-offs, in the separate section below. It doesn't replace the inventory: a degraded score still needs the map of what it stands on. |
| D. Only reword the "No derived health context" line to point at `get_health` | Same block, friendlier absent line. | The model still doesn't know what is missing or how to fix it. It also can't tell "no consent" from "no sleep", so it can't give the owner the one step that helps. |

## Impact surface

- **Contract (`@waldo/contracts`, additive).**
  - `partialHealthViewSchema` joins `derivedHealthDestinationViewSchema`.
  - New exports: `partialHealthNarrativeSchema`, `derivedMissingPillarReasonSchema` and `derivedMissingPillarsSchema`.
  - Both existing views gain an optional `missing_pillars`.
  - No field is removed, renamed or retyped. The union has no consumer outside this repository: waldo-app does not import it,
    as checked by search on 16 November. Inside the repository, the compiler found every reader that assumed two members.
- **Runtime.**
  - `channels/health-context.ts`: the reader, behind the option.
  - `context-composer/prompt.ts`: the renderer.
  - `context-composer/materials.ts`: the partial narrative and an empty summary skip the text sanitiser.
  - `context-composer/types.ts`: the material is a union of zone and partial.
  - `context-composer/admission.ts`: a cast.
  - `observability/trace-health-scrub.ts`: the new opening.
  - `channels/owner-do.ts`: the one wiring statement passes the switch, and logs `partial` apart from `present`.
  - `channels/telegram-webhook.ts`: the Env type.
  - `wrangler.jsonc`: the switch.
- **Prompt text.** A new paragraph for partial days; two optional lines ("Not computed: …", "Would fix it: …") on full days when
  the row names a missing pillar.
- **Privacy.** Words only. Sources are product names, reasons are closed words, and the scrub withholds the block from traces.
  Scribe passes the view on the system-prompt destination. No new store, retention or egress.
- **Other readers of the same book.** The switch is read once, where the owner's health book is built, so every reader of that
  book sees partial reads. Four readers treat "material present" as "the owner shares health":
  - the Brief's health protocol moves;
  - the announcement prerequisite;
  - the card capacity note;
  - the nightly capacity pass, which renders the block into its input.

  A partial read implies a live consent basis, so that meaning holds. These readers' behaviour still changes for partial-data
  owners when the switch is on.
- **Calendar egress check.** The word list that keeps health words out of calendar proposals already holds the Load zone
  whenever any zone exists (`healthTriggerView`). The one new zone word a partial block can carry is therefore already checked.
- **Not touched.** The producer, the migrations, the write function, `owner-turn.ts`, the day plan and the wake decision.

## Falsifier

The `health_context` read log now has three codes: `present`, `partial` and `absent`.

- **The design holds** if, after the switch is on in staging, most of the reads that were `absent` come back as `partial`.
- **It is falsified** if the `absent` share barely moves from about 500 in 650. Then most empty reads are missing rows: no
  readings arrived, no live consent, or the score write was refused. They are not rows without Recovery, so the fix belongs to
  the producer and the write path, not this block.
- **A second check:** in partial turns, the model should call `get_health` before saying nothing is available, and name the one
  fix rather than a readiness word.

## Rollback

Set `HEALTH_PARTIAL_CONTEXT` to anything but `"1"`. The reader is then exactly as before: tests pin that a row without Recovery
gives no block, and that a full row renders the same either way. The additive contract fields are inert when no view carries them.

## Next slices (not in this PR)

1. **The producer writes a closed `present` list** with each signal's grain. This needs a migration owned by the producer session.
   It unlocks naming steps and heart rate, and the full inventory on every day.
2. **Read-tool grains** from (b), and a decision on `get_crs` / `get_master_metrics`.
3. **`request_health_sync`** from (c), with the app.
4. **The depth ruling** above, and then (d).
5. **Day plan and wake decision.** Feeding the inventory into the scheduled day plan and the wake decision belongs to the session
   rewriting scheduled-run assembly.

## Separate ruling: scores degrade, they do not gate (Ansh)

This section is its own commit so it can be dropped without touching the inventory. It changes no code. Any score-rule change
waits for Ansh's ruling, and then needs its own versions, switch and producer work, which sit outside this PR's files.

### The proposed general rule

Every score is the best estimate the consented signals allow, stated with its coverage (which parts it stood on) and a confidence.
No pillar switches another off. When coverage is too thin to carry a zone word honestly, the score says so in words ("from
steps alone"), and the inventory carries the parts, rather than the score vanishing.

### Where the engine gates today (`health/scores/`, provisional engine)

| Gate | Effect |
|---|---|
| Recovery needs last night's sleep, then a resting signal (HRV or resting heart rate) with a baseline | No sleep, or no overnight heart signal, means no Recovery |
| Form takes Recovery's reason whenever Recovery fails (`form.ts`) | One missing pillar switches a second one off; this is the gate the rule removes |
| Form needs at least one day signal (daylight, movement, steps or stress) | Without one it is `baseline_immature` |
| ADR-0081 §2 for Form v1: sleep and HRV are required, and coverage below 0.925 is unavailable | The accepted bar this rule would amend |

Two pillars already degrade:

- **Load** (`weight.v5`) stands on any one component that has a baseline.
- **Sleep debt** has a `partial` state.

### The trade-off, plainly

- **A low-coverage score can mislead.** A Form zone such as "depleted" from steps alone reads as readiness, and the owner, or the
  model, may act on it. The zone words were built as readiness bands over a mix whose largest share (0.4) is Recovery.
- **No score is a dead end.** That is what the owner ruled out. The inventory in this PR removes the dead end without inventing a
  score, which is why it can ship first.

Coverage without Recovery, as a share of Form v10's full weight, for the three owners this amendment started from:

| Owner | Components left | Coverage |
|---|---|---|
| Steps only | steps | 0.2 |
| Sleep plus steps, no overnight heart signal | sleep timing, steps | 0.3 |
| Heart rate plus steps, no sleep | stress (at least eight awake heart-rate hours), steps | 0.4 |

### Recommendation

- **Adopt the rule.** No pillar switches another off: Form no longer takes Recovery's reason, and computes from the parts that
  exist.
- **Keep a coverage floor for the zone word.** Below it, the row carries the score's parts and the reason rather than a zone.
  0.5 of Form's full weight is a reasonable start, and none of the three owners above reaches it. The number is Ansh's call.
- **Name the basis wherever a zone shows at partial coverage.** For example "Form from the day alone, without last night". The
  version is new (`form.v11` or later) and is written `candidate_unaccepted` until accepted.
- **Recovery keeps requiring sleep.** A Recovery without the night is not a recovery estimate. Whether it may stand on sleep
  alone without a heart signal is a separate question for Ansh.

### What it needs beyond this PR

- a producer switch;
- a check that the write function's closed `used` signals list and the app's reader take a Form with no `sleep` signal;
- golden vectors for each coverage band.

## Rulings (Ansh, owner of the health score rules, 16 November)

The owner's direction of 16 November already settles the principle: every score is the best estimate from what exists, with a
stated confidence; no pillar switches another off; raw values stay in the health store; numbers a tool returns stay in the turn.
These rulings fix the details this draft left open.

1. **Scores degrade, they do not gate: adopted.**
   - Form no longer takes Recovery's reason. It computes from the components that have inputs, re-weighted over the weight
     present. Coverage is the present share of Form's full weight, and it lowers the confidence.
   - **No coverage floor**, on the score or on the zone word. The three owners this amendment started from sit at 0.2 to 0.4, so
     a 0.5 floor would rebuild the dead end for exactly them. Instead every score reaches the model with its confidence band
     (the existing thresholds: high from 0.66, medium from 0.33, low below) and its basis in words ("from steps only"). Whether a
     low-confidence Form is worth mentioning is the model's judgment, not a fixed cut.
   - **Recovery still needs the night.** It may stand on sleep alone, without an overnight heart signal, at lower confidence:
     sleep is the primary input of the SAFTE-FAST grounding (ADR-0011). Without the night there is no Recovery, and Form and
     Load still compute.
   - New algorithm versions, written `candidate_unaccepted`, behind their own switch (staging on, production off). Built in a
     separate pull request in the health lane; this pull request does not change.
   - When that lands, a row with a Form zone and no Recovery renders as a Form view, not as this partial view.
   - The app already receives `confidence` with each score; the app lane is asked to show it when it is low.
2. **An expired row gives the block.** Its age, its sources, the one step that brings new readings and the pointer to the read
   tool. This is freshness and missingness, which §3 already allows; absence would be the dead end the owner ruled out.
3. **The component mapping is accepted as written.** Sleep timing or daylight is circadian; movement or steps is motion; daytime
   stress has no ADR-0081 component and is never named. A full row without overnight HRV says `Missing components: hrv.`
4. **The reason and fix words are accepted, with one change.** For `conflicting_inputs` (a day stored twice with different
   values, or an unreadable time zone) no step by the owner fixes it, so the fix line now says so rather than sending the owner
   to the app.
5. **Depth.** Answered by the owner's direction: the always-on block stays words; `get_health` returns figures for the turn,
   never stored or logged. A comparison against the owner's usual returned by the read tool falls under the same rule. Helper
   runs stay without health reads for now; that is revisited only with a use that needs it.

## Slice 2: the inventory read and finer grains (Ansh, 16 November)

Built behind `HEALTH_INVENTORY` (on in staging with `HEALTH_PARTIAL_CONTEXT`, off in production).

- **A live read, not a producer `present` list.** `waldo.health_inventory_read` answers, per source whose storage and
  model-use grants are both live, each stored kind with readings in the owner's last thirty local days: its newest reading time
  and its days. No value, method, payload key or sample id leaves it (pgTAP through the real ingest). Chosen over the producer's
  `present` list (design (a) above) because it is current at every turn rather than at the last recompute, needs no change to
  `health_context_write` (which three open pull requests also re-create), and covers owners with readings but no score row.
- **In words.** The reader merges a kind across sources and renders each as its plain name, its grain (hourly, nightly, daily,
  per session, per reading), how recent its newest reading is, and how regularly it arrived. No digit reaches the block; the
  trace health scrub withholds it with the rest of the block; the composer's Scribe pass admits it.
- **No score row is no longer a dead end.** An owner with readings and no stored row gets a partial block made of the inventory
  alone, aged by its newest reading.
- **A failed inventory read** leaves the block as the row makes it and logs `health inventory read failed`; it never fails
  the turn.
- **Grains.** `get_health` takes `hourly` (each hour of a kind read by the hour, at most two days) and `nightly` (each night's
  reading with its local start and end: for sleep, falling asleep and waking). The names each takes come from the signal
  registry's grains; any other name is refused before the store is read. `daytime_hrv` reads `hrv_window`, the one stored kind
  the tool could not read.

## Slice 3: scores degrade, they do not gate (Ansh, 16 November)

Part of the provisional engine itself, with no switch of its own (owner ruling of 19 Nov: ship turned on); production follows `HEALTH_PROVISIONAL_SCORES`.

- **Recovery stands on the night's sleep** when no overnight heart signal arrived or none has a baseline yet: `recovery.v6`,
  written `candidate_unaccepted`, coverage 0.5 (sleep's share) times the source's confidence. Without the night there is still no
  Recovery.
- **Form stands on the day's own parts** when Recovery has none: `form.v11`, `candidate_unaccepted`, coverage the parts'
  share. A Form built on a sleep-only Recovery is also `form.v11`. Its existing data rules hold: the day's parts still need
  eight hours of the day and their own baselines, so a steps-only owner has a Form from mid-afternoon, not at noon.
- **Nothing changes for an owner with every input**: the same rows byte for byte (tested through the real producer).
- **The model** reads a Form without Recovery inside the partial block: its zone, the parts it stood on and its confidence
  band, never a reading on the night. A sleep-only Recovery reads as a Recovery view whose missing components name HRV.
- **The writer** needs no migration: versions are checked by pattern, and the used names are unchanged.

## The gate's notes at `e24b9009`, and what became of each

The blocker (yesterday's row said "last night's sleep") is fixed on #2158 at `d5ab9299`.

1. **The consent guard.** It is now tested where it alone decides: a readable Recovery reason beside a withdrawn Load or sleep debt gives no block. Without the guard, that test fails.
2. **`partial` with capture off.** Kept by the trace gate (#2158).
3. **The never-failing steps assertion.** It reads `In the row:` (#2158).
4. **What a partial block carries.** Besides the rows above, it carries the day summary (drivers, tags, the training-load sentence) and today's energy windows. Each is honest without Recovery: drivers are deviations from the owner's usual in words, and energy windows are clock ranges. A composer test sends both through the Scribe pass.
5. **Fix words.**
   - Missing sleep reads "no sleep has arrived for the night, either unrecorded or not synced yet".
   - The fixes name "the wearable" and no phone setting.
   - A missing calendar demand says what to do whether or not a calendar is connected.
   - Every distinct fix is given, once each.
6. **`healthZoneWords`' partial branch.** It stays. With scores that degrade (#2163), a partial view can carry a Form zone that the health trigger compares.
7. **"Missing components: none" on a row with no used list.** This is accepted for now. Only a non-provisional row lacks a used list, and the view cannot say "unknown" without a contract change. The provisional engine, on in staging, always names its signals.
8. **The empty-summary bypass.** It now applies to partial views only. A zone view's summary takes the path it always took.
