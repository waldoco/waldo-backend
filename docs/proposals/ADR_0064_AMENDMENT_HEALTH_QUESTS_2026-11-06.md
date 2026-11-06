# ADR-0064 amendment: health quests

Status: proposed with the A1 PR for #1980. Under the Wave 2 rule, a bounded, product-first amendment is pre-accepted and the gate confirms it at review.

## What changes
ADR-0064 kept goals as a contract with no runtime writer. This amendment gives the `goals` table its first writer and turns a goal into a **quest**: a goal the owner chose to work toward with Waldo.

- **New fields on GoalRecord.** All are additive and optional:
  - `plan`: the agreed plan, in the owner's words;
  - `state`: `active`, `ambient` or `completed`;
  - `check_in_days`: the check-in pace, from 1 to 28 days;
  - `last_check_in_at`.
- **`active` keeps its meaning.** It is false exactly when the state is `completed`. A goal written before quests carries no state and reads from `active` (`goalState`).
- **A deadline is a calendar day.** It is stored at UTC midnight of the owner's chosen day, so moving to another zone never shifts it.
- **Storage is unchanged.** Quests live in the owner DO's SQLite `goals` table:
  - DO migration 18 adds the four columns;
  - the quest book adds any missing column itself, because the OwnerDO runs no migration runner.

## Who writes and reads
- **Writer: `set_quest`.** It runs only on the owner's own chat turn (`user_message`), as ADR-0064's write rule already requires.
  - A turn that has read outside content gets the owner's approval card, the same as every write.
  - That turn never stores a health reading in a quest.
  - The owner's own stated targets are stored as stated, under ADR-0064's stated-target carve-out.
- **Readers:**
  - every owner turn, which sees the open quests by id beside the standing orders;
  - the Brief and the Close, through the job's context;
  - the app day view, at controls revision 18.
- **Check-ins:**
  - A quest is due when its pace has come round in the owner's local days.
  - The Close reads due quests marked as due.
  - Once the Close reaches the owner, they count as checked in, whether or not it spoke of them. Silence when nothing changed is the model's call.
  - On a surface where a send can wait (for example, WhatsApp outside its 24-hour window), that is when the held Close is delivered.
  - A Close that never reaches the owner (skipped, expired, lapsed) leaves the quests due for the next one.
  - With day cards off, no check-ins happen.
- **Bound:** at most 12 open quests per owner, so they always fit the prompts that carry them.

## Health plane
- **No readings in the goals table.** Wearable readings are never copied into a quest; they stay on the Supabase health plane and are read live.
- **What the model is told:** the quest prompts ask for zone words and never a reading or a score.
- **Traces:** `set_quest` sits in its own `quests` tool namespace, because the health namespace is at its bound of nine tools. The trace scrub withholds that namespace's hops whole, as it does the health namespace's.

## Retention and forget
- **Completed quests:** they stay in the table. The app lists them for 30 days, after every open quest.
- **Forget:** the owner's forget redacts the topic from `description`, `baseline`, `target`, `progress` and `plan`, as it already did for the first four. A redaction that would grow a column past its 500-character CHECK is cut at 500, so the forget always lands.
- **While a forget is cleaning:** quest lines ride the owner turn with the standing orders and cross the same forget barrier, so a quest that still holds the topic is dropped from what the model reads.

## Personal experiments (A2)
An experiment is one change the owner tries inside a quest, such as a caffeine cutoff, morning light or an earlier training slot. It runs for 7 to 28 days (14 by default) from the owner's local start day, and is then kept or dropped against their own usual.

- **Storage.** The owner DO's `experiments` table (DO migration 19). At most one experiment runs per quest at a time, so each change is judged on its own.
  - Fields: the change in the owner's words, the start day and length, the state (`running`, `kept`, `dropped` or `stopped`), the verdict's reason and day, and when a Close offered the verdict.
  - The quest book creates the table itself, as it does for the quest columns.
- **Writer: `set_experiment`.** It runs on the owner's own chat turn only, under the same taint and reading rules as `set_quest`.
  - The verdict's reason is the model's own summary, so it never holds a reading or a score, on any turn.
  - Completing a quest stops its running experiment, so no verdict is left due for a quest that no card reads.
  - It starts an experiment, records kept or dropped with the reason, or stops one early without a verdict.
  - It records a verdict only once the owner has said which.
- **The comparison is on the health plane.** A new signed RPC, `waldo.health_zones_read`, returns each day's Recovery and Form zone words over at most 57 local days. It:
  - requires live model-use consent;
  - never returns a score, reading or backfilled row (ADR-0081);
  - is used by the runtime to count days per zone for the trial so far, and for the same number of days just before it. A day with no zone counts as none.
  - A night's Recovery belongs to the morning it ended, so Recovery is counted from the morning after the start to the morning after the last trial day, against the mornings before, up to and including the start morning. Form is counted on the trial's own days.
  - Nothing here sets a threshold. Whether the change helped, and how sure that is, is the model's call from those counts and what the owner has said.
- **Readers.**
  - `review_experiment` returns the comparison on an owner turn, as turn-only output (never in the tool ledger or memory).
  - Owner turns read each experiment on its quest line: the day of the trial, a verdict due or offered, and the two latest verdicts.
  - The day after the trial ends, the Close reads the comparison and offers a keep-or-drop verdict, with its reason and its uncertainty, in zone words.
  - The verdict counts as offered once that Close reaches the owner, under the same delivery rule as check-ins. The experiment ids it offered travel with the card, so one that ends while a held Close waits is not marked.
  - A verdict due is not a check-in. It never moves the quest's own pace, and an ambient quest stays ambient.
- **Health plane.** Only zone-day counts leave Supabase, and only into the turn or the Close that asked. Experiment hops sit in the `quests` tool namespace and are withheld from traces whole.
- **Forget.** It redacts `change` and `reason` and keeps the row, as for goals. A redaction is cut at the column's bound (300 for `change`, 500 for `reason`).

## Not covered
- An app control to change a quest or an experiment. Both change in chat.
- Check-ins outside the Close.
- Sleep-debt and Load days in the comparison. Recovery already weighs sleep, and Load measures effort, not outcome.
