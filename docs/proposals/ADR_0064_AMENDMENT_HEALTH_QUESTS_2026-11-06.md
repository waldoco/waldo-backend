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
  - the app day view, at controls revision 17.
- **Check-ins:**
  - A quest is due when its pace has come round in the owner's local days.
  - The Close reads due quests marked as due.
  - Once the Close goes out, they count as checked in, whether or not it spoke of them. Silence when nothing changed is the model's call.
  - With day cards off, no check-ins happen.
- **Bound:** at most 12 open quests per owner, so they always fit the prompts that carry them.

## Health plane
- **No readings in the goals table.** Wearable readings are never copied into a quest; they stay on the Supabase health plane and are read live.
- **What the model is told:** the quest prompts ask for zone words and never a reading or a score.
- **Traces:** `set_quest` sits in the health tool namespace, so its hop is withheld from diagnostics as a whole.

## Retention and forget
- **Completed quests:** they stay in the table and are listed to the app for 30 days.
- **Forget:** the owner's forget redacts the topic from `description`, `baseline`, `target`, `progress` and `plan`, as it already did for the first four.

## Not covered
- Personal experiments inside a quest (A2).
- An app control to change a quest. Quests change in chat.
- Check-ins outside the Close.
