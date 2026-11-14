# ADR-0081 scope addendum: the capacity note (`CAPACITY_PLAN`)

Status: proposed with #1910. The gate may accept it under the owner's standing ruling on bounded, product-first addenda.

## Scope
This is the first background pass that writes memory derived from the owner's shared health. ADR-0081's destination rules still hold: raw health values stay on the health plane. This addendum covers only the derived note described below.

## What is stored
**One capacity note per owner.** It is two to four plain sentences: how much focused work the owner sustains, the hours they think best in, and what drains them.
- **Inputs:**
  - the owner's memory, through the forget barrier;
  - the calendar as shape only (counts and local times, no titles, people or places);
  - the body as the zone words every owner turn already reads.
- **What the note may contain:** the pattern across days, never a day-by-day record of the body.
  - The numeric-health hold refuses any reading.
  - The evidence field is fixed text, never the model's reasoning.

## Where, and who sees it
- **Storage:** the owner's DO SQLite `claims` table, as kind `health`, area `mind`, source `inferred` with no owner origin. KV keys hold the claim id, whether it drew on shared health, and whether the owner set it aside.
- **Who sees it:**
  - the owner, in memory, where they can correct, dismiss or forget it like any claim;
  - the owner's own model turns, through memory recall;
  - the Brief and the Close, as the job's context.
- **Day cards built from outside text.** These now get this one health note. That is acceptable for three reasons:
  - it is inferred and number-free;
  - the card's calendar proposals still pass the health-word egress check before Google;
  - the note's paragraph opens with `Capacity note:`, which the trace health scrub withholds whole.

## Retention and forget
- **Superseded versions** stay in memory history, as every corrected claim does. The owner's forget purges them.
- **Owner control:** a dismissed or forgotten note is set aside, and Waldo writes no new one. The owner's correction is never overwritten, including one made while the nightly pass is running.
- **Revoked health:** the note is hidden from cards once sharing stops. The next night rewrites it without the body or retires it.
- **Failed health read:** treated as unknown, not revoked; the note stays as it is.
- **Health notes off:** no pass runs and no note is shown.

## Not covered
- Raw values, per-day zones, other stores (R2, logs, traces, fixtures), and any egress beyond the owner's own model calls.
- There is no owner control yet to reopen a set-aside note. Adding one is a follow-up.
