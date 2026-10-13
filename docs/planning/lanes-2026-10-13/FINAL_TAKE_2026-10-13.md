# Final take for tonight: one agent, work split by usage

Mac orchestrator, 13 Oct 2026, 19:08Z. For the owner, the backend lead (Fable), Ansh's cloud orchestrator, the builder, the Google lane, Ashish and Suyash.

## Update, 19:20Z: the Mac owns most of the building, and reuse comes first

The owner's word after the take:
- the Mac has the most usage, so it owns most of the legwork;
- the cloud sessions' budgets go to design, review and coordination;
- existing PRs and drafts are reused before anything new is written;
- Ansh will start a new cloud session for this work.

Nothing starts until the owner says go. Where this update and section 1 differ, this update wins.

**The split, revised:**
- **Backend lead (Fable):** A's design, A0, review of every A slice, and the gate. For A1 onward, the default is that the lead posts each slice's spec and the Mac implements it as the single writer. The lead says on #1103 if it would rather write a slice itself.
- **Cloud orchestrator and Ansh's new session:**
  - independent reviews;
  - plan upkeep;
  - Ansh's owner steps;
  - coordination on #1103.

  The builder finishes what is in flight: #1149, #1180, #1186, items 3 and 4, the #1133 renumber, and #1108. New build work goes to the Mac.
- **Mac:** two build lanes at a time. A third starts only if usage stays under 50% after two hours.
  - **Core lane:** A slices to the lead's spec, in the `owner-do.ts` queue (section 2).
  - **Tools-and-proof lane:** M1 to M5, each starting from the reuse list below.
  - **This session:** gate pre-checks, deploy smokes, baseline re-runs, and coordination.

**How we coordinate, on #1103:**
- Claim before you start: the PR or branch, the files, and the `owner-do.ts` slot.
- Post when you stop or hand off.
- The Mac posts only when something changed.
- Anything urgent goes through the owner.

**Reuse before writing.** This list comes from PR titles and states; each lane reads the PR before building on it.

| For | Reuse | State |
|---|---|---|
| M1, eligibility | #1110 (admits the browser on the owner's binding) | Ready, the builder's; M1 builds on it |
| M2, the tool contract | #1155 (tool output is data; live results labelled) | Ready, in review |
| M2, small tools | #1043 (`get_weather`, Open-Meteo) | Draft, 11 Oct |
| Flaky Google tools | #1171 (refuse reads that fail their schema); #912 (circuit-break dead grants) | #1171 ready; #912 a draft on an old base |
| M3, scenarios | #1185 (nightly eval, 22 scenarios, independent judge); #1037 (task catalog and gold references) | #1185 ready, needs owner; #1037 ready |
| M3, the runner | #433, #436, #453 (native36 eval chunks) | Drafts, 30 Sep to 2 Oct; check them before building a runner |
| M4, the time budget | #1078 (counts the history each call leaves out); #931 (a stable static prompt block) | Drafts |
| M5, the deploy gate | #1081 and #1082 (pin workflow actions to SHAs); #460 (migration preflight dispatch, on `main`) | Ready |
| A, as reference | #915 (core loop spec, slices A–L) | Draft; the lead's seam design supersedes it |
| C | #711 (owner proactivity controls); #1072 (alarm retry in tests) | Drafts |
| G | #1083 (the Form v2 candidate) | Ready |

**Likely to close.** The lead or Ansh decides; the Mac closes nothing.
- #998: the Bible says stop its re-cut.
- #520 and #555: the skill host landed.
- #1042: [inference] #1117 supersedes it.
- #228: [inference] the roster already pins the model.
- #903, #910, #913 and #919: they sit on an old stacked branch.
- The 26 Sep to 8 Oct drafts that nobody claims.

**Read for this:**
- **Planning docs:**
  - the Waldo Agent Plan (rev 13);
  - Suyash's backend handoff (rev 9, 79 needs);
  - the Build Bible (rev 115): §6b, §7, §8 and the "Harness verification 13 Oct" tab;
  - my Instinct catch-up plan (`AGENT_CATCH_UP_PLAN.md`).
- **Posts on #1103:**
  - the lead's posts 6152354118 and 6152363180;
  - the builder's 6152271537;
  - the Phase 0 baseline 6152381089.
- **Code:** `beta-mvp` at `7ba2e7f9`.

**State:**
- Staging still serves version `e040a306` (`ea41bb0e`), checked at 19:06Z.
- Hand-off 2 is not deployed.

## The take, in six lines

1. **The design holds.** One admission, one responder, one conversation, one desk, and the surfaces as data. The lead's four corrections are right. Ansh's go tonight lets A0 start.
2. **Split by usage.** The lead and the cloud orchestrator have the smallest budgets, so they spend them on the core seam (A) and on independent review. The Mac has the most, so it builds:
   - the tool layer;
   - the eval runner;
   - the deploy-safety items.

   It also runs every test.
3. **This reverses my interim note,** which gave the browser and the tool definitions to Fable. The lead has declined C1–C4 and D through H, and A is the critical path that only the lead can carry. So:
   - the Mac takes the tool definitions;
   - the builder keeps #1110;
   - Ansh keeps the #1120 binding;
   - the Google lane keeps the flaky Google tools.
4. **One writer at a time on `owner-do.ts`,** in one posted order (section 2). The gate stays with the lead, and the Mac pre-checks every PR.
5. **Deploy hand-off 2 as written** (Worker `a9161905`), not head. Head carries three merges that had no gate review, and a migration version clash.
6. **Stay on OpenAI tonight.** Tool definitions become provider-neutral and strict, one tool at a time, with tests. Moving to Claude later is then a roster change plus an eval run.

## 1. Who does what tonight

| Who | Builds tonight, in order | Touches | Stops when |
|---|---|---|---|
| **Backend lead (Fable)** | 1. **A0:** the guard ratchet (`scripts/guards/guard-surface-neutral-core.mjs`)<br>2. **A1:** the canonical turn with authorship<br>3. **A2:** waits for #1108<br><br>Final say at the gate. | Guards, inbound turn types; `owner-do.ts` only in its queue slot | A1 is up for review, or its budget runs low (post a status line first) |
| **Cloud orchestrator (Ansh's)** | **Independent reviews:**<br>- #1149 at `c7f80fbc`<br>- #1186<br>- A0 and A1<br>- the Mac's PRs<br>- a post-merge review of #1178, next to the running #1017/#1162 review<br><br>**Also:**<br>- said yes to the builder's item 4 at 19:05Z, with conditions (6152969658);<br>- folds section 7's corrections into plan rev 14. | No code | The review queue is empty |
| **Builder** | 1. the #1149 fixes<br>2. #1180<br>3. #1186<br>4. item 3, the failure notice<br>5. the #1133 renumber, carried into #1177 (6152969658)<br>6. item 4, the check-back machine turn (yes, 6152969658)<br>7. #1108, before A2 needs it | Scheduler; `owner-do.ts` in its slot | As now |
| **Google lane** | 1. The flaky Google tools: #1171, #1165, #1174, #1150<br>2. #1185, once its keys land | Connectors, eval | As now |
| **Mac lane T (tool layer)** | M1, then M2 (below) | `tools/`, handler modules, the `llm/` adapter; `owner-do.ts` only if given a slot | M2's first PR is open with CI green and a review asked |
| **Mac lane P (proof)** | M3, then M4, then M5 (below) | `scripts/`, eval fixtures, `llm/` retries, `.github/workflows` (M5 merges only on the owner's yes) | M4 is up for review |
| **Mac orchestrator (this session)** | - gate pre-checks, including hand-off 3<br>- the post-deploy smoke and baseline re-run<br>- heartbeat and LOG | Docs | Morning |
| **Ashish** | The host's real send and the fixes from the post-merge reviews; then the staging round trip, once Ansh turns the connector on (owner step 7) | `waldo-imessage-host` | The round trip is proven, or it is blocked |
| **Suyash** | The UI/UX map. Nothing backend tonight | App | |

Suyash's #41 (live updates) rides A4 later.

### The Mac slices

**M1, tool eligibility.** Offer a tool only when it can work for this owner now. Sources:
- CLAUDE.md: "Resolve the smallest per-turn capability manifest".
- Bible §7 Phase 2: "make eligibility check the binding".

Evidence:
- **`browse_page`:** in S5 the model spent four `browse_page` calls that failed (`auth_failed`, `transient`), in a 72.9 s turn.
- **`use_mac`:** [inference] #1178's `use_mac` is offered to owners with no paired Mac.
  - It is in `ALWAYS_ON_TOOLS`, and it is registered with no condition at `owner-do.ts:2463`.
  - The Harness tab says all of the roughly 55 eligible tool schemas go out every round.
  - I have not read the code that builds the model's tool list. M1's first step is to find it.

Done when:
- a turn's trace shows neither tool for an owner who can't use it;
- an S5 re-run makes no failed browse calls.

**M2, the tool contract pass.** This is item 8 of the Harness tab, which gives it to the cloud child. The Mac takes it unless the builder has started it. Work one tool at a time, never in one sweep:
- **Descriptions** say when to use the tool, when not to, and what comes back. They also name the mechanism: S9 said "can't monitor inbox" while mail follow-ups were on.
- **Results carry the computed answer.** S2 got a free slot's length wrong because availability returns raw times.
- **Errors carry a code the model can act on,** instead of a generic sentence:
  - unavailable: don't retry;
  - transient: retry once;
  - needs the owner: ask.

  Validation errors name the issue path, redacted.
- **Strict schemas** in the OpenAI adapter, each with a valid and an invalid test and an eval re-run. Strict mode makes every field required, so a tool with optional arguments changes meaning.
- **A "tool output is data" rule,** plus a fence around live external results, with an injection scenario.

**M3, the scenario set and runner.** It covers:
- the nine baseline scenarios;
- six regression pins for what works: memory writes, asking before assuming, listening first, honest limits, zone-correct calendar reads, reminders on time;
- recall across sessions;
- the check-back.

It is written in #1185's format, so the nightly eval picks it up. It can also be run by hand on the Simulator app after each deploy. The judge is not the candidate model (Bible §7 Phase 4).

**M4, the time budget** (Harness item 22):
- model-call retries capped at 0 or 1, behind a per-turn deadline;
- a timeout per tool;
- p50 and p90 per hop.

The baseline found that most turn time isn't model time.

**M5, the staging deploy gate** (Harness item 19, plan D6):
- a green verify for the exact SHA;
- the guards;
- a `/healthz` smoke after deploy;
- a rollback runbook that states what DO class and in-object SQL migrations forbid.

It changes CI, so it merges only on the owner's yes.

**Deferred Harness-tab Mac items:**
- **Item 20:** staging's own R2 bucket and rate-limit namespace. It waits for Ansh to provision them.
- **Item 21:** one owner id in traces, and a trace key returned on app send. It waits for the app's re-pin, because the key is an app.v1 emit.

**The Mac's usage cap.** On 12 Oct, fanning out to many agents used up the shared window and stopped every lane for an hour. Tonight:
- no more than two build lanes;
- one open PR per lane;
- no fan-out inside a lane;
- each lane stops and posts a status line if the 5-hour window passes about 70%.

This session launches both lanes itself, after the owner's yes, as background agents in their own git worktrees. Nobody has to open a session. The lanes report to this session, which posts their status on #1103. The heartbeat and the gate pre-checks keep running.

### Where the Instinct catch-up stands

| Catch-up phase | Tonight |
|---|---|
| 0, the baseline | **Done:** 5 pass, 4 partial (6152381089). Re-run after hand-off 2 deploys. |
| 1, hand-off 2 | The owner deploys; the Mac smokes. |
| 2, context | #1149 (builder), then #1182 (owner), then B2 (lead, after A3). |
| 3, follow-through | Builder: #1180, #1186, the failure notice, the check-back turn. Proactive and approvals on iMessage go through the lead's queue. |
| 4, judgment | M2 and M3 now; #1185 nightly once it has keys; prompt changes only with a scenario. |
| 5, iMessage live | Ashish's real send, then the Mac's round-trip test. |
| 6, reach | #1120 (owner), then #1110 (builder); other reach after rulings. |

## 2. The `owner-do.ts` queue

The file is 3,123 lines at head, and at least nine open PRs touch it. The lead's terms apply:
- one writer at a time;
- the next writer branches after the previous merge;
- one slice per PR, open no more than a day, merged with a merge commit.

The order:
1. **Builder:** #1180, then #1186, then item 3 (in flight).
2. **Builder:** #1108; A2 depends on it.
3. **Lead:** A1, if it touches the file. A0 doesn't.
4. **Builder:** item 4, the check-back machine turn (yes from the cloud orchestrator, 6152969658).
5. **Builder:** the threads, #1173, then #1176, then #1179.
6. **Mac:** M1's wiring, only if the tool list can't be filtered outside the file.
7. **Lead:** A2 onward.

The lead owns this order and posts any change on #1103. A slice that needs the file and isn't listed asks for a slot first.

## 3. The gate

The lead keeps the gate, as it said at 17:22Z.

**The Mac's pre-check, for each PR:**
- the head SHA;
- CI on that head;
- an independent review on that head;
- the migration order;
- the PR's `owner-do.ts` slot;
- the advisor.

The Mac then posts "gate-ready", so the lead's merge is one step.

**When the Mac merges:** only under Ansh's 16:55Z rule, that is, when the lead posts that it is stopping. [proposed, for Ansh and the lead to accept] Also when a gate-ready PR has waited two hours with no post from the lead. The Mac never merges its own PRs.

**Nobody self-merges.** #1017, #1162 and #1178 merged without a gate review; #1178's description says it overrides the lane gate. The migration clash below is the cost.

## 4. Deploys and migrations

**Tonight: hand-off 2 as written.**
1. The edge `connector-proxy` from `a9161905`.
2. The migration `20261012000000_waldo_imessage_connector.sql`.
3. The Worker at `a9161905`.

It is forward-only, because of DO `v6` and `v7`. Apply migrations from that SHA's checkout, not from head.

**Not tonight: head `7ba2e7f9`.**
- #1178 added `20261013000000_waldo_device_bridge_v030.sql`.
- Open #1133 uses the same version (`20261013000000_app_session_thirty_days.sql`).
- [inference] Supabase keys migrations by version, so one of the two would be rejected or skipped.
- [verified] #1178 adds no DO class: both SHAs bind `DEVICE_BRIDGE_DO`, from `v5`.

**The fix.** The builder renumbers #1133, as the cloud orchestrator assigned at 19:05Z (6152969658):
- the smallest bump that keeps today's order, for example `20261013000100`;
- in both canonical lists, including `scripts/verify-supabase-migrations.mjs`;
- carried into #1177.

The Mac doesn't touch #1133.

The owner first confirms that no `20261013000000` migration has been applied anywhere.

**Hand-off 3.** The lead writes it (6152969658), and the Mac pre-checks it. It waits for:
- the #1178 post-merge review;
- #1149;
- M1.

It applies the migrations in this order:
1. `20261012000000`
2. `20261013000000`, the device bridge
3. #1133's new version
4. #1127's `20261013090000`

The edge goes before the Worker, and a smoke list follows.

**The A0 baseline.** The lead counted 45 and 13 at `89422cab`, but #1178 touched `owner-do.ts` after that. Recount at the branch point.

## 5. Tools and models

Each rule is tied to what the baseline saw:

1. **Offer only what can work for this owner now:** S5, and `use_mac`.
2. **Say when to use a tool and when not to, and name the mechanism:** S9; and S4, which searched the web before asking for the area.
3. **Return the answer, not raw material.** That means computed durations, names over ids, and "N more" instead of dumps (S2).
4. **Errors say what to do next:** S5's wasted retries.
5. **Strict, provider-neutral schemas.** One Zod source, with provider flags in the adapter, tool by tool with tests.
6. **Time is a budget:**
   - per-tool timeouts;
   - a turn deadline;
   - independent reads in parallel, and mutations in series (Bible §7 Phase 2).
7. **Every tool change ships with a before-and-after scenario.** Judgment stays with the model, with no regex rules (CLAUDE.md).

**Patterns from Claude Code's own harness** already have homes here:
- a scheduled check that runs a turn: C4, the builder's item 4;
- a task list for errands with several steps: C7, durable tasks;
- watchers: C8.

**Lazy tool loading** (Harness item 13, plan D3) is built but not wired. It is an always-on set plus a real `search_tools`. It comes after M1, which shrinks the list honestly first.

**Models.** The roster pins an OpenAI model, and nothing changes tonight. Moving to Claude becomes a roster change plus a nightly eval comparison once M2 and #1185 exist.

## 6. iMessage

**What is real** [verified]:
- the connector is merged default-off (#1017, #1162);
- staging runs the older `e040a306`;
- even at `a9161905`, the staging config has `IMESSAGE_CONNECTOR_ENABLED` at `0` and an empty policy, so the bridge stays off after hand-off 2 until Ansh sets both. That is a wrangler change. The policy is a set of limits plus a source id, and the code carries a proposed local test policy;
- the host's real send is off;
- no message has made a round trip.

**The order:**
1. hand-off 2;
2. Ansh turns the staging connector on: the flag and a policy;
3. the console onboarding run: pair a host, set the sender with the challenge, confirm;
4. the host's real send;
5. a staging round trip with a trace id;
6. proactive delivery (ruling 27), and the approval link with `approval: 'none'` (ruling 28).

If step 2 doesn't happen tonight, the round trip moves to tomorrow.

Step 6 touches `owner-do.ts:1517` and `:2133`, which are A5 and A6. The lead decides whether a small interim lands first, in its queue. Health text follows ruling 29.

## 7. Answer to the plan review (#1103)

**Is the split right?** Mostly. The design, A's ownership and the Mac's testing role all hold. Two changes:
- the Mac also builds (section 1), because it has the budget;
- the gate stays with the lead, where the plan has the Mac merging.

**Wrong or stale in plan rev 13:**

| The plan says | Now |
|---|---|
| The Mac merges reviewed PRs | The lead keeps the gate; the Mac merges only under the 16:55Z rule |
| #1178 is Ashish's draft | Merged at 18:26Z with no gate review; its migration clashes with #1133 |
| Hand-off 2 after #1172 | #1172 merged at 17:40Z; hand-off 2 excludes #1158 and #1178, so a hand-off 3 is needed |
| "Landed today": #1160, #1157, #1139, #1135, #1132, #1128, #1146, #1119 | None is on staging; the baseline saw none of them |
| `createTelegramResponder` builds the responder; a flat `channel ===` ban; WhatsApp in A2; A3 is a key change | The lead's four corrections: a 44-line shim, a ratchet, WhatsApp in A8, and a data backfill |
| Need #12 (threads) maps to A3 | Threads stay their own chains: #1173, #1176, #1179 (builder) |
| B2 cites PR 1078 | The compaction ADR is #1182 (needs owner) |
| Decision 16 is open | Ruled: a synthetic test owner, in #1185 |
| Nothing proactive reaches iMessage | Ruled at 15:13Z: the Brief, reminders and check-backs go to an iMessage owner |
| A6: a link or a numbered reply | An app link now; numbered replies after a security review |
| The Telegram copy turns off once push works | Telegram stays until iMessage has carried real use (ruling 21) |
| Judgment leans to assuming | The baseline found asking, listening and honest limits working; E4 must not regress them |
| Ten laws | The plan lists nine; the Bible (§6b) has ten |
| #36 is served by #1135 | Partly: sent, skipped, held and failed only |
| F7: Microsoft and iCloud (#45) | Suyash's #45 is Todoist, Slack, Outlook and Apple Reminders |
| "14 stale drafts" | 41 drafts are open among 94 PRs; which 14 is not stated |

**Missing from the plan:**
- **The baseline findings:**
  - tools offered that fail;
  - check-backs that replay text;
  - mechanisms the model doesn't know it has;
  - visible self-correction;
  - time that isn't model time.
- **Regression pins** for what works.
- **iMessage:** the rulings (27–29), an "iMessage now" slice, and the step that retires Telegram.
- **#1182,** and the `owner-do.ts` contention.
- **App freeze:** a rule for app.v1 emits while the app is frozen (owner steps).
- **Health:** the health-visibility conflict (owner steps).
- **G and H:** done-when lines.
- **Stale Bible exits:** the Bible's Phase 1 exits ("both founders' own phones by 19 Oct") predate the 14:15Z app stop and the Simulator ruling, and need restating.

**Suyash's 79 needs.** Every need depends on backend work, and every one maps to a workstream; none is app-only.
- **Weak mappings:**
  - #12: threads leave A3;
  - #13;
  - #21: C10 or the Google lane;
  - #36: partial;
  - #45: mislabelled;
  - six with only a letter: #39, #40, #68, #72, #74, #77.
- **Waiting:** [inference] B8, C10, G1–G5 and H wait for the memory and app-routes children, which haven't started. They resume after Suyash's map.

**Done-when, and how the Mac tests each:**

| WS | Test | When |
|---|---|---|
| A0 | A scratch commit adds a core `channel ===` compare and the guard fails; the counts can only fall | Tonight, on the PR |
| A | The same scenario from the Simulator app and from iMessage, with a trace id per surface. Telegram is diagnostic only (Bible law 10). A fact told on one surface is used on the other in the next turn | After hand-off 2 and the iMessage round trip |
| B | - Recall three of three in the eval<br>- S1's fact recalled in a new session, then forgotten<br>- a 200-turn conversation keeps its approvals after compaction | Recall after hand-off 2; compaction after #1182 and its build |
| C | - An S7 re-run whose trace shows a model call and a read tool at fire time, with a reply that says what was found<br>- a job failing three times says so once (a DO test with an injected failure) | After the builder's items 3 and 4 deploy |
| D | - M1 and M4 traces<br>- a forced model failure answered by the fallback<br>- a deploy that breaks `/healthz` stopped by M5 | As each lands |
| E | The scorecard moves from the baseline on each re-run; nightly once #1185 has keys | Baseline re-run tonight, after the deploy |
| F | An app owner's compare-prices question gets a cited answer with a screenshot; a submit phrase stops at an approval | After #1120 and #1110 |
| iMessage | - Owner text reaches the host, then the Worker, and the reply lands on the device with a trace id<br>- a Brief arrives on iMessage for an iMessage-bound owner<br>- an approval link opens the card in the app | After hand-off 2, the staging connector flag (Ansh) and the host's real send |
| G, H | Proposed: Body serves only what the health plane holds, with an unavailable reason otherwise; the owner is still signed in after day one without a code | After the app resumes |

## 8. Owner steps

**Before you sleep (these block tonight):**
1. **Ansh:** the go on the lead's design, so A0 starts.
2. **Ansh:** deploy hand-off 2: the edge, the migration `20261012000000`, then the Worker at `a9161905`. The Mac smokes it and re-runs the baseline.
3. **Shivansh:** sign in to Langfuse in this Mac's built-in browser, so the tests can read traces.
4. **Ansh:** share the Build Bible (§6b, §7) with the lead's account. Or say yes, and the Mac mirrors those two sections (rev 115) into the docs branch as a read-only copy.
5. **Ansh:** confirm that no `20261013000000` migration has been applied anywhere.
6. **Shivansh:** a yes or no on the Mac taking M1–M5.

   The builder's item 4 (the check-back machine turn) already has the cloud orchestrator's yes from 19:05Z, unless you or the lead object. It changes the heartbeat decision H1, which its PR names for Ansh.
7. **Ansh, optional:** to test iMessage tonight, turn the staging connector on (the flag and a policy). Without it, the round trip moves to tomorrow.

**These block later work:**
1. **Shivansh: #1182,** the compaction ADR (B2).
2. **Ansh: #1185:**
   - the eval keys, with a judge that isn't the candidate model;
   - the schedule;
   - the storage.
3. **Ansh: #1120,** the staging browser binding.
4. **Shivansh and Ansh: app.v1 emits during the freeze.** I recommend that contracts may land additive and unused, and that Worker emits wait for the app's re-pin, as #1138 and #1167 already do.
5. **Shivansh: health visibility.**
   - **The conflict:** the lead's A3 test says health-derived rows never reach a Telegram or iMessage context or reply, and Bible law 2 says they are "app-only by default". Ruling 29 allows health text in iMessage replies.
   - **My proposed reading:** `app_only` rows (Body cards, scores, health-log entries) never replay into another surface's context. Replies to the owner on iMessage or Telegram may carry the owner's own health text, per ruling 29.

   Your call. It blocks A3's wording, not A0 or A1.
6. **Ansh or Shivansh: M5 changes CI.** It merges only on a yes from one of you.

## 9. What we learned today

- **What works, so keep it:** memory writes, asking before assuming, listening first, honest limits, zone-correct calendar reads, and reminders on time.
- **What fails:**
  - tools offered that can't work;
  - check-backs that replay text;
  - mechanisms the model doesn't know it has;
  - arithmetic done in the reply;
  - wasted steps before asking.
- **Most turn time isn't model time.** Fix tool failures and retries before swapping models.
- **The plan doc went stale within hours.** #1103 and the posts on it are the record; the docs are maps.
- **Ungated merges cost real time:** three today, and one migration clash.
- **Hot files set the pace.** With nine PRs on one file, order beats parallel work.
- **Fan-out drains the shared window.** Cap the lanes and budget each one.
- **Stamp times from `date -u`.** Cross-session messages can be held, so the board carries everything.
