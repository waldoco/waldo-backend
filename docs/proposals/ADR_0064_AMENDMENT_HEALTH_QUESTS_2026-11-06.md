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
  - A quest keeps a health number only as the owner said it: every number in a reading must appear in a reading in the owner's own words, in their current or recent messages, with forwarded parts left out. A reading the model took from `get_health`, a wearable or outside content is refused on every turn, so measured values never reach the goals table, the tool ledger, the prompts or the app.
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
- **Forget:** the owner's forget redacts the topic from `description`, `baseline`, `target`, `progress` and `plan`, as it already did for the first four. A redaction that would grow a column past its 500-character CHECK is cut at 500 characters (never inside one), so the forget always lands.
- **Rows outside the quest shape:** a `goals` row another writer left with an id that is not `quest:…` is skipped by every reader, so it never reaches a prompt or breaks the app's day view.
- **While a forget is cleaning:** quest lines cross the forget barrier wherever they are read: with the standing orders on an owner turn, and as the job's context at the Brief and the Close. A quest that still holds the topic never reaches the model (tested in `forget-barrier-staging-env.test.ts` and `quests-owner-do.test.ts`).

## Not covered
- Personal experiments inside a quest (A2).
- An app control to change a quest. Quests change in chat.
- Check-ins outside the Close.
