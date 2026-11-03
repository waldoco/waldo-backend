# What the runtime needs for the agent heywaldo.in describes

Status: **approved** by the owner on 3 Nov 2026 (section 6). It is a companion to
[PROACTIVE_CONCIERGE_2026-11-02.md](PROACTIVE_CONCIERGE_2026-11-02.md), which covers the day loop. This note covers the
machinery underneath: concurrency, background work, events, autonomy and the record of what Waldo did.

Claims are tagged [verified] (read in source at `beta-mvp` 62b0b1de9, or observed on staging), [inference] or [proposed].
Paths are under `packages/runtime/src/`.

## 1. The bar the website sets

These are taken from heywaldo.in, `/how-it-works` and the app mockups on 3 Nov 2026.

| Promise | Site wording |
|---|---|
| Works before you wake | "Done before you're up." "Overnight he handles what he can." |
| Acts first, tells after | "Fixed first, mentioned after." "Nudged your 9am to 10:30." "Blocked it." |
| Asks only what is yours | "Asks for a yes or no only on what's yours to decide." One notification at 6:30. |
| Shows his work | "Why this changed": each step marked Checked, Prepared or Watching, with sources. |
| Ready is not sent | Drafts are held, checked against other sources, corrected, then shown with recipients and every word. |
| A rhythm through the day | The Brief, the Window, Prep, the Heads-Up, the Close, the Adjustment. |
| You set how far he goes | "Three levels, per area." Every move logged, undo in one tap. |
| Runs other agents | "Codex takes the blocker, Claude the notes." |
| Learns and compounds | Spots and constellations. |

The mockup Brief has a fixed shape: two short sentences with linked items, then "Needs your yes or no" with one-tap rows
inside the same card, then "Why this changed" and "N more open".

## 2. What the runtime does today

**Observed Brief, 3 Nov 08:00 IST** [verified, staging console]:

> "Your calendar has one event today… The one thing that matters most: keep the morning clear, and book the SYNTH-OTHER
> room when you break for it."

It is a recap with no proposal and no question. It promotes a leftover open loop from an old staging test, and it repeats
a stale "waiting on you" item. At 08:51 the owner asked Waldo to withdraw a stale card. Waldo replied "I don't have a tool
to withdraw an approval card". The tool exists (`raise_approval` withdraw), but it is deferred behind `find_tools`
(`tools/records.ts:157`) [verified].

**The machinery** [verified unless tagged]:

- **One turn at a time per owner.**
  - All turns, on every surface and every thread, run on one promise chain (`channels/owner-do.ts:3319-3324`).
  - Reads inside a turn run in parallel (`conversation/tool-loop.ts:324-331`).
- **Background tasks exist.**
  - `start_task` queues a `TaskWorkerDO` job.
  - Profiles: `reader`, or `errand` (adds `browse_act`). `code` is refused (`tasks/profiles.ts`).
  - Limits: 3 running and 10 open per owner, 6 h deadline, 200 tool rounds.
  - Leases, checkpoints and apply-once results are in place.
  - Workers hold no memory, send or approve tools, and their results come back as one apply turn (`tasks/lane.ts`).
- **A worker cannot ask mid-task.** A step that needs approval stops the task as `blocked`, and the owner sees it only at
  the apply turn (`tasks/brain.ts:97-103`).
- **Tasks cannot wait.** `start_task` is always due now (`tasks/tools.ts:65`). "Follow up if no reply by Friday" becomes an
  open loop that the 30-minute heartbeat checks back on.
- **Proactive turns run on grids.**
  - The update sweep runs every 10 minutes and the heartbeat every 30.
  - Gmail and Calendar push only pull the sweep forward (`channels/calendar-push.ts:52-55`).
- **The Brief cannot propose a calendar change.**
  - A tainted job with no tool list is limited to reads plus `propose_action` (`owner-turn.ts:1045`).
  - `propose_calendar_change` is unreachable from the Brief, and `propose_action` refuses a tool that raises its own card.
  - The Brief prompt also tells the model it cannot raise a card (`prompt/day-cards.ts` `BODY_RULE`).
  - Reminders can only read (`channels/check-back.ts:11`).
- **Mid-turn messages.**
  - Telegram steers the running turn.
  - Every other surface queues behind it.
  - The fold, queue or stop design (`docs/proposals/WALDO_SECOND_MESSAGE_DESIGN_2026-10-31.md`) is not built.
- **Progress is thin.**
  - Owner tasks send at most two notes.
  - Machine jobs never send notes and settle silently when they park or fail.
  - A parked task is never retried automatically (`tasks/lane.ts:84`).
- **No autonomy levels.**
  - #1630 is design only; every loop policy is `L0` (`contracts/src/runtime/loop-policy.ts`).
  - Standing orders with `act_and_report` already act with no grant ledger, budget or undo (`channels/standing-orders.ts:110-115`).
- **No record of what Waldo checked.** There is no Activity, Evidence, Verification or Outcome model in the runtime or the
  contracts. Closing a loop is a model call with nothing attached.
- **External agents.**
  - `use_mac` drives `claude-code` and `codex` on the paired Mac, with a native dialog for each command.
  - The Browser Use errand engine has no caller.

## 3. The gaps, ranked by what the owner feels

1. **The Brief recaps instead of planning.** The prompt forbids proposing, and the job tool list leaves out calendar proposals. Lane `planning-brief`
   (concierge P1 and P2) is fixing it.
2. **Waldo goes quiet while it works.** A long proactive or task-report turn blocks chat, and a second message waits behind
   it with no acknowledgement.
3. **Background work drops out of sight.** Silent machine jobs, parked tasks with no retry, and blocked tasks surface late.
4. **Waldo cannot act first.** There are no autonomy levels and no calendar of its own, so every change is a card. The site
   promises "Nudged your 9am".
5. **There is no "Why this changed".** Waldo cannot show what it checked, so it cannot earn trust to act first.
6. **Events wait for a grid.** Real-time Google changes (#1840, switch off) triage pushes, but the owner object still wakes
   on fixed grids.
7. **Waldo cannot hold a task for later or on a condition.** "If Maya hasn't replied by Friday, chase her" has no runtime.

## 4. What changes [proposed]

The authority model stays: `OwnerDO` is the only writer, and workers return results for the brain to apply once. Every
change below keeps that.

### 4.1 Keep the brain's turns short; think in workers

- Proactive turns (sweep, check-back, Brief preparation, mail triage) do their reading and reasoning in a short-lived reader
  worker, as the update sweep and loop check-back already do. `OwnerDO` runs only the short apply turn.
- Owner messages take priority over queued machine apply turns. The serial chain stays, but its queue becomes
  owner-first [inference: no starvation risk, because apply turns are short and bounded].
- Build the second-message design on every surface: the model chooses to fold, queue or stop. Per the owner's 31 Oct
  ruling, the owner sees typing on every surface rather than a fixed acknowledgement line, and the model says it will get
  to the message next in its own words when it queues it.

### 4.2 Workers that can ask and resume

- A worker that reaches a step needing the owner checkpoints and enters a new state, `awaiting_owner`. The brain raises the
  card at once, not at the end.
- When the owner decides, the brain resumes the worker from its checkpoint with the decision as input. The lease, fence and
  apply-once rules stay as they are.
- Contract: one additive job state and a resume key. Approval replay already shows the pattern of running an approved card
  once.

### 4.3 Tasks that wait for a time or an event

- `start_task` gains `not_before`, and a `wake_on` condition from a closed list: a mail reply in a thread, a calendar change
  on an event, or a health score landing.
- The scheduler already multiplexes kinds onto one alarm, so a deferred task is a new kind. Event conditions are matched
  where the push lands (#1840's triage).
- The model still judges whether the condition is met when it wakes. Matching only decides when to look.

### 4.4 Event-driven wakes

- Arm the owner alarm for the next due item, not a grid. Re-arm on push or change. Lane `stop-wasted-wakes-and-un` is doing
  this.
- With #1840 on, a Gmail or Calendar push triggers a triage worker. The model judges importance and either stays silent,
  updates the plan, or proposes.

### 4.5 A visible task surface

- "What Waldo is working on" in the app shows each open task, its state (working, waiting on you, waiting until, parked)
  and its last note.
- Machine jobs send a note when they park, fail or block. Parked tasks retry once with backoff before asking the owner.

### 4.6 "Why this changed": an activity trail

- Every proactive item (card, draft, plan change) carries a short typed trail. Each step has a time, a verb (read, checked,
  found, prepared, watching) and a source reference, built from the tool calls the turn actually made.
- The app renders it under "Why this changed". The same trail is the evidence a loop close or outcome points to, which
  starts the missing Verification and Outcome record.
- Storage is in `OwnerDO` with the item. Health values stay out of it (ADR-0081), so a health step names the score, not a
  reading.

### 4.7 Act first, within levels the owner sets

- Build #1630: three levels per area (ask, act and tell, act quietly), with a grant ledger, a budget, undo and a recheck
  before each dispatch.
- Fold standing orders under it, so `act_and_report` stops being an unbudgeted grant.
- Waldo's own calendar (concierge 8.2) is the low-risk first area. Waldo places movable blocks there without a card, and
  anything on the owner's own calendars stays at "ask" until the owner raises it.

### 4.8 The day rhythm

- After P2, add the remaining day cards as owner-editable check-ins (concierge P2 and later): the Window, the Heads-Up and
  the Adjustment.
- Push all of them, not just the Brief, through the delivery gate and its daily budget.

### 4.9 What does not need to change

- **Cloudflare primitives.** Durable Objects with one alarm, SQLite, and short-lived worker DOs fit this. Cloudflare
  Workflows or Queues would duplicate the job book that already has leases, checkpoints and apply-once [inference]. Revisit
  only if a task needs fan-out beyond 3 per owner.
- **The one-brain rule.** Parallelism comes from workers, not a second writer.

## 5. Order

| Wave | Work | Needs |
|---|---|---|
| Now | Planning Brief (P1, P2); core tools loaded by default; next-due alarms; real-time Google (#1840); inbound mail turn that ends `interrupted` | Running or ready; no decision |
| Next | 4.1 owner-first queue and second message; 4.2 ask and resume; 4.5 task surface; 4.6 activity trail | Design review; app work for 4.5 and 4.6 |
| Then | 4.3 deferred and conditional tasks; 4.8 day rhythm | 4.2 and 4.4 first |
| Owner decision | 4.7 autonomy levels (#1630) and Waldo's own calendar | Owner yes; brain ADR for levels |

## 6. Owner decisions (approved 3 Nov 2026)

1. **Autonomy (#1630) is approved, with Waldo's own calendar as the first area.**
   - #1630's own recommended answers to its §11 questions A1–A6 stand as defaults, and each is cheap to reverse.
   - The site's "three levels per area" is how the app presents #1630's grants: no grant means ask; a grant means act and
     tell. The design keeps grants and adds no level store.
2. **Owner messages pre-empt queued machine work** (4.1).
3. **Workers may raise a card mid-task and resume** (4.2).
4. **The "Why this changed" trail is stored per item** (4.6). This needs an additive contract and app rendering by Suyash.
