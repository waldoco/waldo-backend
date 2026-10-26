# One owner backlog: open loops across work, life, health and goals (26 October 2026)

Status: design note, docs only. No runtime, contract or migration change in this PR. The ADR draft is
[`ADR_DRAFT_OWNER_BACKLOG_2026-10-26.md`](ADR_DRAFT_OWNER_BACKLOG_2026-10-26.md). Owner decisions are in §11; nothing is
built until the owner answers them.

## 1. Problem

The owner asked whether Waldo now tracks their backlog: what they owe, plan and want across work, personal life, health and
goals. It does not. The pieces exist, but they live in four places and none of them holds the owner's own items:

| Piece | What it is today (verified at `beta-mvp` `51b0c2fd`) | Gap |
|---|---|---|
| `loops` (`channels/loops.ts`) | Live. Statuses `open`/`done`/`dropped`. Written only by `open_loop`/`close_loop`, whose description says "something you took on for the owner". Nudged by the heartbeat (`heartbeat.ts`, past-due loops with no mail source) and check-back (`check-back.ts`). Mail follow-through binds a loop to observed mail (`observed_mail`, `loop_mail_sources`, `reviewDue`). Shown in `/ledger`, the reply prompt (`openLoopsPrompt`) and the Close card via `promptLedger`. Forget redacts titles and drops open rows. | Waldo's promises only. There is no owner-held item, area, check time separate from due, goal link, waiting state or candidate state. |
| `responsibilities` (`channels/responsibilities.ts`) | Richer states (`open`/`waiting`/`done`/`dropped`/`uncertain`), `next_check_at`, close needs evidence, steps with worker fencing, `adoptLoops()`. | No runtime caller builds `responsibilityBook`; only tests import it. Its four tools are still named in `TOOL_PERMISSIONS`, `tools/records.ts:150-153,221`, `hooks/registry.ts:255-258` and the prompt's ACL ceiling, which says ceiling entries without a live handler are not callable. Forget marks both of its tables as a `gap`. |
| `goals` table (`do-schema.ts:317-336`, migration version 2) and `GoalRecord` (`contracts/src/runtime/goal.ts`, ADR-0064 accepted) | No reader or writer. Forget redacts it (`LITERAL_REDACTED_STORES`, `RECORD_STORES`). The "Active goals: unavailable in this phase" line is in `prompt/reasons.ts`, which has no live importer. | Goals actually live as claims of kind `goal`, plain text, shown in the profile's "Goals" section. |
| `followup` claims (`memory/claims.ts:11,1032`) | Memory writes follow-ups as claims; the profile has a "Follow-ups" section. | A second writer for the same thing as loops, with no due, state or closure. |

The surfaces are just as split:
- The app contract has `carrying` and `open_loops` (`contracts/src/app/controls.ts:108-127`), but the day projection
  (`dashboard-controls.ts`) never fills them.
- Draft #1138 fills them, but it reads `responsibilityBook`. It is held for the app re-pin; waldo-app's source does not
  read either field yet.
- Draft #1282 is a read-only console "Tasks" view of open loops, so the console Backlog view is half-built.
- Google Tasks is read by `get_tasks` and changed only through `propose_google_task_change` cards. `write_task` and
  `update_task` have no handler. Tasks are not reconciled with loops; `comingItemsFrom` lists both side by side.

Product theory in waldo-brain (`02-Knowledge/open-loop.md`) is clear:
- an inferred item is a **candidate** until the owner confirms it, with provenance and an easy reject;
- closure is the owner's trusted resolution (completed, released, superseded, invalid, transferred), never agent activity;
- follow up when the owner asked Waldo to care, and stay quiet when they did not.

The research note (`waldo-real-life-workflow-continuity-and-open-loops-2026-07-17.md`) adds: explicit capture first, and
no blanket inbox reading.

**Acceptance bar.** The owner can say "I need to renew my passport by March" in chat and see it in the app, the console
and the Close card until they close it. Waldo's own promises keep working as today. Something Waldo infers from mail is
never put on the owner's list without their yes. There is one table, one writer and one tool family.

## 2. Decision: extend `loops`, retire `responsibilities`

`loops` is the aggregate. The owner DO is its only writer, through the loop tools and the mail follow-through.
`responsibilities` is deleted.

Why `loops`:
- It is the live one. Heartbeat, check-back and its `closable` fence, mail follow-through, the `source_bound` taint
  exemptions (`records.ts:147-148`), the ledger, the Close card, the health trigger's `comingItemsFrom` and forget
  (`purged`) all read or write it. Moving all of that to another table is a rewrite with no gain for the owner.
- The useful ideas in `responsibilities` are three fields: a waiting state, a check time and closing evidence. They port
  as columns.
- Its steps (`responsibility_items`, worker revision fencing) duplicate the worker layer that merged in #1355
  (`start_task`, task jobs, crash recovery). Multi-step work belongs to tasks. A loop can point at a task, but it does
  not carry steps of its own.
- It is a forget gap today. Deleting it closes the gap instead of building forget for a table nobody writes.

**Deleting it** removes:
- `channels/responsibilities.ts`;
- `contracts/src/tools/schemas/responsibilities.ts` and its exports;
- the four names from `TOOL_PERMISSIONS`, `records.ts` and `hooks/registry.ts`;
- `test/responsibilities.test.ts`, plus the references in `permissions.test.ts`, `tainted-write-gate.test.ts` and
  `task-apply-outside-text-owner-do.test.ts`;
- the prompt-builder snapshot line;
- the two `gap` rows in `forget-store-table.test.ts`.

Removing exported tool schemas from `packages/contracts` is a contract change. A grep of waldo-app at `origin/HEAD` finds
no use of these names. The same check is needed in waldo-types before the PR merges.

No live DO should hold the two tables, because nothing builds the book outside tests `[inference]`. The removal PR
therefore adds no `DROP`. Any stray empty table is harmless and is named in the forget inventory as "retired, never
written".

ADR-0079 (proposed, "commitments") said to create prospective-commitment state when a real flow needs it. `loops` is that
state. The ADR draft lands 0079's semantics on the extended `loops` and marks 0079 superseded, so there is no third home.

## 3. Fields

All columns are additive on `loops`. They follow the guarded `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` pattern used in
`approvals.ts:444-446` and `day-cards.ts:29`.

| Column | Type | Meaning | Who sets it |
|---|---|---|---|
| `holder` | `'owner' \| 'waldo'`, not null, default `'waldo'` | Whose move it is. Every existing row is Waldo's promise, so the default is exact. | Model, in the tool call. |
| `area` | `'work' \| 'personal' \| 'health'`, nullable | Where it belongs in the owner's life. Null means unsorted. | Model judgment. No keyword rules. The owner can change it. |
| `status` | adds `candidate`, `waiting`, `rejected` to `open`/`done`/`dropped` | See the lifecycle below. Still a `TEXT` column with no `CHECK`, so no table rebuild. | Tools. `candidate` is set by the harness (§5). |
| `check_at` | local `YYYY-MM-DD[THH:MM]`, nullable | When Waldo looks again or nudges. Separate from `due`, which is the deadline. | Model, from the owner's words or Waldo's own promise. |
| `goal_ref` | integer, nullable | The claim id of the owner's goal this serves (§4). | Model; the owner can change it. |
| `origin` | `'chat' \| 'mail' \| 'calendar' \| 'meeting'`, not null, default `'chat'` | Provenance channel. Mail keeps its existing `loop_mail_sources` row for the exact source. | Harness, from the turn's trigger and taint, never the model. |
| `origin_ref` | text, nullable | The main-chat history row id the loop came from (chat), or the event or meeting id (later). Ids only, never content. | Harness. |
| `closed_by` | `'owner' \| 'waldo' \| 'expired'`, nullable | Who closed it. Evidence stays in the turn's receipts and is not copied into the row. | Harness, from the turn. |
| `updated_at` | integer | For ordering and staleness (§6). | Harness. |

Lifecycle, a deliberately small subset of `open-loop.md`:

```
candidate --owner yes--> open <--> waiting
candidate --owner no / 14 days--> rejected
open|waiting --> done (completed) | dropped (released)
```

- `superseded` and `transferred` are not built. A superseded loop is closed `dropped` with a new loop opened. Transfer is
  later.
- `close()` today only matches `status = 'open'`. It must match `open` and `waiting`, and close a `candidate` only as
  `rejected`.
- Only one new free-text value exists: the title, which is already redacted by forget. Every other new column is an enum,
  an id or a time. Forget gains `origin_ref`, as an id, in its exempt list.

**Health titles.** `loops.open` runs no sanitiser on `title` today, and the rows live in DO SQLite. Adding a health area
makes a title like "check back on HRV 32" more likely, which breaks ADR-0081 and the CLAUDE.md rule against raw health
values in DO memory. The fix reuses claims' deterministic check (`numericHealthIn` / `readingBeyondOwner` from
`scribe/sanitiser`): a title that carries a reading is refused with a message asking for words without the number. This
is a hard safety boundary, not a judgment rule. The same check should be added to today's `open_loop` whatever the owner
decides about the rest, so it is filed as a current gap.

## 4. Goals: claims, not the ADR-0064 table

Recommendation: **goals stay claims of kind `goal`**. The empty `goals` table is retired by an ADR-0064 amendment.

- Claims already give goals provenance (`stated`/`inferred`, `owner-grounded`), pinning, the profile's "Goals" section,
  correction, supersede and forget.
- A second goals store would duplicate them, and it would need its own writer tools, prompt block, app surface and forget
  path.
- ADR-0064's state-home rule (per-owner DO SQLite, single writer) holds either way. `GoalRecord` can stay as a contract
  and become a projection of goal claims if a surface needs that shape.

**The link.** `goal_ref` stores a goal claim id. A supersede writes a new claim row with `supersedes_id`, so a read
follows the chain to the active head. Rules:
- If the head is forgotten or purged, the link reads as none, and forget sets `goal_ref = NULL` on the loops in the same
  pass.
- If the head is no longer a `goal`, the link also reads as none.
- The loop itself is never closed because its goal went away.

**Costs to name.** The amendment must say what happens to migration version 2 and the `goals` entry in
`LITERAL_REDACTED_STORES` / `RECORD_STORES`.

The proposal keeps both until a later cleanup, because dropping an empty DO table gains nothing, and they are cheap to
keep. The forget entry stays for the same reason. Owner decision D3.

**Follow-up claims.** A follow-up is a commitment with a time and a closure, not a fact about the owner. Memory v2's
rule, "claims remain the only truth for facts about the owner", does not cover it.

Recommendation:
- memory stops writing new `followup` claims;
- the extractor's instruction sends "the owner said they need to X" to the loop path, as a candidate (§5);
- existing `followup` claims stay readable history in the profile until Memory v2 decides their fate.

This touches the Memory v2 lane and is owner decision D4.

## 5. Capture paths, and who confirms

The rule is deterministic where it must be and the model's call where it can be:

- **Owner's own turn, untainted, the owner's words.** The model judges that the owner stated something they mean to do,
  or asked Waldo to track. It opens the loop `open`. The owner's turn is the confirmation, which is ADR-0079's
  "user-message" writer. The reply says it went on their list, in one line, so a wrong capture costs one word to undo.
  Whether the model asks first instead is owner decision D1.
- **Anything else** opens as `candidate`: a turn that has read outside text (taint, per #1365's merged gate), a machine
  turn (nightly memory, card jobs, check-backs), or a loop the model inferred without the owner saying it. The harness
  sets the status from the turn's taint and trigger. That is a security boundary, so a deterministic rule is allowed.
  The model cannot open an owner-held `open` loop from there.
- **Waldo's own mail follow-ups** (`source_bound`, "completion unknown") are not owner commitments. They stay
  `holder = waldo`, `origin = mail`, and open directly as they do today. The owner's follow-ups switch
  (`set_proactivity followups`) remains their consent for the category.

| Path | Today | This design | Cohort? |
|---|---|---|---|
| Chat (app, iMessage, console) | Waldo's promises only | Owner loops open on the owner's words; inferred ones are candidates | Yes |
| Mail sweep | Waldo watch loops on observed mail | Unchanged. An owner-owed item seen in mail ("you promised Priya the deck") is a candidate with `origin = mail` and its `loop_mail_sources` row | Yes |
| Calendar | None | Candidate from an event that implies prep or follow-up, `origin = calendar` | Later (D6) |
| Meetings (Granola) | None | Candidate per action item from meeting notes, `origin = meeting` | Later (D6) |

**Confirming a candidate.** In this cohort it happens in chat, on any surface. The Close card lists up to three
candidates ("Want me to keep these?"), and the owner answers in words. The model calls `update_loop` to set `open`, or
`close_loop` with `rejected`.

The confirm transition is owner-turn-only, enforced like `ownerTurnOnly` in `records.ts`. A tainted turn cannot confirm.
The console Backlog view (§7) adds Keep and Drop buttons. Candidates not answered in 14 days close as `rejected` /
`expired` and are never proposed again for the same `origin_ref`.

**Why a row status and not an approval card per candidate** (owner decision D2):
- A mail sweep can find several items at once. One card each is noise; a list is reviewable in one pass.
- A rejected candidate needs to be remembered so it is not re-proposed.
- Cards remain right for consequential effects, such as sending or calendar changes. A candidate is not an effect; it
  only asks for attention.

**#1431's radar ledger.** The radars' design rejects reusing loops and routes everything through owner cards. With
candidates in `loops`, a radar finding the owner should act on can be a loop candidate instead of a fourth queue. The
radar's dedupe ledger stays its own, since it records what was seen, not what is owed. The two designs must agree before
either is built, so this is named in D2.

## 6. Review: the Close card, and a weekly review

The Close card (`prompt/day-cards.ts`, `card:close`) already says "Carried over: what is still open, said plainly and
without guilt". It reads `promptLedger`, which today lists only Waldo's loops. Under this design `loopsSection` carries,
in that order:

1. owner loops due or checked today;
2. Waldo's loops;
3. up to 3 candidates to keep or drop;
4. up to 3 stale loops (open, no `updated_at` change in 7 days) with "keep, change or let go?".

The instruction keeps the care contract: no guilt, no streaks, release is a fine answer. The heartbeat's nudge rules
change in one place:
- Waldo's loops nudge on `COALESCE(check_at, due)` as today.
- **Owner** loops nudge only when `check_at` is set, meaning the owner asked Waldo to check. A due date alone shows in
  the Brief and Close but sends nothing on its own.

A **weekly review** would be a new schedule kind or day card, which is new machinery. The daily Close already covers
candidates and staleness, three at a time. Recommendation: no weekly review in this cohort. Revisit if the owner finds
the Close too crowded or stale items pile up. Owner decision D5.

## 7. Surfaces

**App (first surface)**
- This is a rework of #1138, not a new PR. The day projection fills the two optional, already-pinned fields from `loops`
  only.
- `carrying` holds loops with `holder = waldo` and status `open` or `waiting`. `state` maps directly; `uncertain` is
  unused. `next` is `null`, because loops carry no steps. `check_at` is `COALESCE(check_at, due)`.
- `open_loops` holds loops with `holder = owner` and status `open` or `waiting`. `due` maps directly. `source` is `gmail`
  for `origin = mail`, else `chat`.
- Candidates appear in neither until the app has a confirm action. The app sees them through the Close card text.
- This is additive-only (no contract change). It still waits for the app re-pin that #1138 is held on.
- The `source` enum is closed to `gmail|chat`. Calendar and meeting candidates, once built, need `calendar` and `meeting`
  added to app.v1. The app lane must be told before the Worker emits them; until then those capture paths stay off (D6).
- `area` and `goal_ref` are not in the app contract. Adding them is an additive revision for the app lane to schedule.

**Console:** rework #1282's Tasks view into **Backlog**:
- tabs Open / Candidates / Done; grouping by area; Waldo's and the owner's items labelled;
- Keep, Drop and Done buttons that call the same loop book through console actions;
- Google Tasks shown in its own read-only section;
- console session auth as for other owner settings. These are reversible changes, so no step-up.

**iMessage stays lean:** no list dumps. "What's on my plate" gets the few most pressing items in words and a link to the
app's Backlog. Long lists and bulk review belong to the app and console, per the 25 Oct "app first, most leeway"
ruling.

## 8. Google Tasks

Recommendation: **no sync and no mirror.**
- Google Tasks is the owner's own external list. Waldo reads it (`get_tasks`) for planning, the Brief and Close, and the
  console shows it read-only.
- Changes to it stay on `propose_google_task_change` cards.
- A loop is never copied into Tasks, and a task is never copied into loops. Either copy would create two writers for one
  item and a reconciliation problem with no owner benefit yet.
- If the owner asks Waldo to "put it in my Google Tasks", that is a card for the task. The loop, if any, closes as
  `dropped` with the reply naming where it went.
- `comingItemsFrom` already lists tasks and loops separately. The day cards' instruction asks the model not to say the
  same thing twice, which is judgment, not a dedupe rule.
- Two-way sync is later and owner decision D7.

## 9. Tools

The loop tool family stays three tools, and four responsibility names leave. That is a net −1 in the ceiling and frees
bytes in the tool budget.

- **`open_loop`** gains optional `holder`, `area`, `check_at`, `goal_ref`. Its description is rewritten:
  - it covers the owner's own items as well as Waldo's;
  - it should be used when the owner states something they need to do, or asks Waldo to keep track;
  - it should never be used for facts or for things the owner only mentioned.
- **`update_loop`** (new) changes title, due, `check_at`, area, holder, goal, or status between `open` and `waiting`. It
  can confirm a candidate (`candidate`→`open`) only in an untainted owner turn.
- **`close_loop`** `outcome` grows from `done|dropped` to `done|dropped|rejected`. `rejected` is valid only for a
  candidate.

The check-back `closable` fence and the `source_bound` taint exemptions are unchanged.

## 10. Migration, tests, falsifiers, rollback

**Migration (DO SQLite, inside `loopBook`'s setup)**
- Guarded `ADD COLUMN` for each field in §3, all with defaults that describe today's rows exactly: `holder = 'waldo'`,
  `origin = 'chat'`, or `'mail'` where a `loop_mail_sources` row exists; nulls elsewhere.
- `updated_at` is backfilled from `COALESCE(closed_at, created_at)`.
- No data moves between tables, and no Supabase migration.
- `responsibilities` is removed as code only (§2).

**Tests**
- TDD per behavior, in `loops.test.ts` and the owner-DO integration suites.
- Contract `valid + invalid` pairs for the extended `openLoopArgsSchema`, the new `updateLoopArgsSchema` and
  `closeLoopArgsSchema` with `rejected`.
- Candidate set by taint: a tainted owner turn calling `open_loop` gets `candidate`. A machine turn gets `candidate`. A
  clean owner turn gets `open`. A tainted turn calling `update_loop` to confirm is refused.
- Heartbeat: an owner loop with `due` past and no `check_at` sends nothing. With `check_at` past, it sends once per
  cooldown, as today's loops do.
- Numeric-health refusal on titles, for `open_loop` and `update_loop`.
- Forget: titles redacted, `goal_ref` nulled when the goal claim is forgotten, the inventory updated, and the two
  responsibilities gaps gone.
- App projection: `carrying` and `open_loops` parse against the pinned schema, candidates are absent, totals count every
  item, and paging stops at 20.
- Expiry: a 15-day-old candidate closes `rejected` / `expired`, and the same `origin_ref` is not re-proposed.
- Eval:
  - the rewritten `open_loop` description must capture "I need to renew my passport by March";
  - it must not capture "my passport is blue", or "I might repaint the kitchen someday" without asking;
  - it must not open owner loops from a mail body. This goes through the eval gate (`run-eval`) before merge.

**Falsifiers.** Any of these sends the design back.
- The owner finds candidates noisy: more than half rejected over the first week of a tester's use.
- An owner says Waldo put something on their list they never said.
- A loop title with a health reading reaches DO storage.
- The Close card grows past one screen on iMessage.
- A tainted turn moves a candidate to `open`.

**Rollback.** Old code reads only `status = 'open'`:
- `list()` defaults to `'open'`;
- `close()` matches `status = 'open'`;
- the heartbeat scan uses `l.status = 'open'`;
- `reviewDue` uses `l.status = 'open'`.

So a reverted Worker treats `candidate`, `waiting` and `rejected` rows as closed, and ignores the extra columns.
Reverting the Worker is safe with no data change. Two costs:
- `waiting` loops disappear from the old ledger until it is re-deployed. The owner sees fewer items, never wrong ones.
- The app projection reverts to unfilled.

Deleting `responsibilities` is reverted by restoring the files; it held no data.

## 11. Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| D1 | When the owner states something in chat, does Waldo add it and say so, or ask first? | Add and say so in one line ("On your list: renew passport, by March"). Undo is one word. |
| D2 | Inferred items: a candidate status on the loop (reviewed in the Close card and console), or one approval card each? Also: should #1431's radar findings use the same candidate list? | Candidate status, and yes, radars feed the same list. |
| D3 | Goals: keep them as claims and amend ADR-0064 to retire the unused `goals` table, or build the table out? | Claims, with an amendment. The table stays inert until a cleanup. |
| D4 | Follow-ups noticed by memory: stop writing `followup` claims and propose candidate loops instead? | Yes, coordinated with Memory v2. Old follow-up claims stay readable. |
| D5 | A weekly review now? | Not now. The Close card carries candidates and stale items, three each. |
| D6 | Calendar and meeting capture in this cohort? These need the app enum widened first. | Later. This cohort is chat and mail. |
| D7 | Google Tasks: read-only beside the backlog, or two-way sync? | Read-only beside it; no sync. |
| D8 | Areas: `work`, `personal`, `health`, or a different set? | Those three plus unsorted. Goals are a link, not an area. |

## 12. Scope

**This cohort**
- the extended `loops` table, tools and lifecycle;
- owner loops from chat;
- the existing mail follow-ups, plus candidates from mail;
- the numeric-health title guard;
- the Close card carry-over;
- the heartbeat rule for owner loops;
- #1138 reworked onto loops;
- #1282 reworked into Backlog;
- `responsibilities` deleted;
- `followup` claims redirected (if D4).

**Later**
- calendar and meeting capture (app enum);
- an app confirm action, and area and goal in the app contract;
- a weekly review;
- transfer and supersede states;
- Google Tasks sync;
- loops tied to task jobs (`task_ref`).

**Launch-contract amendment.** The pinned contract already promises "commitments, goals" understanding, "durable
profile/episode/commitment memory", "reminders/follow-ups", an M4 row for "goals, prospective commitments", and a
`review-goals` skill. It does not say:

1. that commitments include the **owner's own** open items, not only Waldo's promises, across work, personal and health;
2. that items inferred from mail, calendar or meetings are **candidates** until the owner confirms them, and that
   confirmation is not a grant to act;
3. that goals live in governed memory (claims), not a separate store;
4. that the backlog is not a general life ledger: Waldo tracks what the owner said or confirmed, not everything it can
   infer.

These four lines go into the contract's §2 and the M4 row in a waldo-brain PR, with this design and the ADR, before the
build starts.
