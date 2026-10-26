# ADR draft: one owner backlog on `loops` (26 October 2026)

This is a draft for `Pin4sf/waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`. The design it records is
[`OWNER_BACKLOG_2026-10-26.md`](OWNER_BACKLOG_2026-10-26.md).

- It lands in waldo-brain through brain's own review, after the owner answers the design's §11 decisions.
- The number is the next free slot at publication. 0085 and 0086 are claimed by open drafts.
- Nothing here changes an accepted ADR by itself. The ADR-0064 amendment and the ADR-0079 supersession take effect only
  when brain publishes them.

---

```markdown
---
status: proposed
date: 2026-10-26
canonical_location: waldo-brain/01-Waldo/Architecture Decision Records (ADR)/00NN-owner-backlog-on-loops.md
supersedes: [0079-prospective-commitments]
amends: [0064-persistent-goals-and-skill-curator-lifecycle-contract]
related: [0002-cf-durable-objects-agent-supabase-health, 0049-source-taint, 0055-gdpr-deletion-runbook-all-stores, 0081-health-computation-destinations, 0085-forget-barrier (proposed), 0086-mail-radar-ledger (proposed)]
---

# One owner backlog: the `loops` table holds Waldo's promises and the owner's open items

## Context

Waldo tracks what it promised the owner in `loops`. It has no home for what the **owner** owes, plans or wants across
work, personal life and health.

Three other places half-hold the same concept:
- an unwired `responsibilities` module;
- an unused `goals` table (ADR-0064);
- `followup` memory claims.

ADR-0079 (proposed) asked for a `commitments` table once a real flow needed one. The owner wants the simplest design and
asks before new machinery.

The product theory (waldo-brain `02-Knowledge/open-loop.md`) requires:
- inferred items stay candidates until the owner confirms them;
- closure is the owner's resolution, not agent activity;
- Waldo follows up only where the owner asked it to care.

## Decision

1. **One aggregate, one writer.**
   - `loops` in the owner's Durable Object SQLite is the only store for open items, Waldo's and the owner's. The owner DO
     is its only writer.
   - `responsibilities` is deleted. It has no runtime caller and is a forget gap.
   - Multi-step work belongs to task jobs (the worker layer), not to loop steps.
   - This ADR supersedes ADR-0079. Its prospective-commitment semantics live on `loops`.

2. **Fields, all additive:**
   - `holder` (`owner|waldo`);
   - `area` (`work|personal|health`, nullable; set by the model's judgment, never by keyword rules);
   - `check_at`, separate from `due`;
   - `goal_ref` (a goal claim id, resolved through the supersede chain at read time);
   - `origin` (`chat|mail|calendar|meeting`) and `origin_ref` (ids only), both harness-set;
   - `closed_by` and `updated_at`.

   Statuses are `candidate`, `open`, `waiting`, `done`, `dropped`, `rejected`.

3. **Who confirms.**
   - In an untainted owner turn, a loop stated in the owner's words opens `open`. That turn is the confirmation.
   - Every other owner-held loop opens `candidate`: after outside text (ADR-0049 taint), in machine turns, or when
     inferred. The harness sets this from taint and trigger; it is a security boundary.
   - Only an untainted owner turn, or the owner's console action, moves `candidate` to `open`.
   - Unanswered candidates close `rejected` after 14 days and are not re-proposed for the same source.
   - Waldo's own source-bound mail follow-ups are not owner commitments. They keep today's path under the owner's
     follow-ups setting.

4. **Proactivity follows care.**
   - Waldo's loops nudge on `check_at`, or on `due` when no check time is set, as today.
   - Owner loops nudge only when `check_at` is set, which means the owner asked Waldo to check.
   - The Close card carries owner items, Waldo's items, up to three candidates and up to three stale items.

5. **Goals are claims of kind `goal`** (ADR-0064 amendment).
   - The `goals` table and its migration stay inert, with no writer, until a separate cleanup.
   - `GoalRecord` remains a contract, usable as a projection of goal claims.
   - Forgetting a goal claim nulls `goal_ref` on loops. It never closes them.

6. **Memory stops writing `followup` claims.** A follow-up is a commitment, not a fact about the owner, so it goes to the
   loop path as a candidate. This is coordinated with the Memory v2 ADR; existing `followup` claims remain readable
   history.

7. **Health boundary.** A loop title is refused when it carries a health reading. The check reuses the claims sanitiser
   check (`numericHealthIn` / `readingBeyondOwner`), so no raw health value enters DO storage (ADR-0081).

8. **Surfaces.**
   - The app's existing optional `carrying` (Waldo-held) and `open_loops` (owner-held) fields are filled from `loops`.
     No contract change; candidates are omitted until an app confirm action exists.
   - New `open_loops.source` values (`calendar`, `meeting`) are an additive app.v1 revision, announced to the app lane
     before any Worker emits them.
   - The console gets a Backlog view.
   - iMessage answers briefly and links to the app.

9. **Google Tasks** is the owner's external list. It is read for planning, and changed only through its existing
   approval card. It is never mirrored into or out of `loops`.

## Considered options

- **Adopt `responsibilities` as the aggregate.** Rejected.
  - Everything live reads or writes `loops`: heartbeat, check-back, mail follow-through, taint exemptions, ledger, Close
    card, health trigger and forget. Moving them is a rewrite.
  - Its steps duplicate task jobs.
  - Its useful fields port as three columns.
- **A separate `commitments` table (ADR-0079 as written).** Rejected. It would be a second home for the same concept
  beside `loops`, needing two writers or a sync.
- **Candidates as one approval card each.** Rejected as the default.
  - A sweep can find several at once.
  - Rejections must be remembered.
  - A candidate asks for attention; it is not an effect.

  Cards stay for effects. This is an owner decision recorded in the design.
- **Build out the ADR-0064 `goals` table.** Rejected for now. It would be a second representation of goals beside
  claims, with its own writers, prompt block, surfaces and forget path, and no owner benefit over claims.
- **Mirror loops to Google Tasks.** Rejected for now. It creates two writers for one item and a reconciliation problem.

## Consequences

- Four unwired tool names leave the ACL ceiling. One tool is added (`update_loop`); `open_loop` and `close_loop` widen
  additively.
- Removing the responsibility tool schemas from `packages/contracts` is a contract change. Downstream repositories are
  checked before merge.
- The launch contract needs a four-line amendment:
  - the owner's own items are commitments;
  - inferred items are candidates, and confirmation is not a grant;
  - goals live in claims;
  - the backlog is not a general life ledger.
- #1138 (app open work) and #1282 (console Tasks) are reworked onto `loops` only.
- #1431's radars feed the candidate list rather than a separate queue, if the owner agrees.

## Failure and degraded paths

- **Null:** no loops means empty sections. Nothing is fabricated.
- **Revoked:** removing mail access stops new mail candidates. Existing loops stay, because they are the owner's record.
- **Hostile:**
  - mail text can at most create a candidate, which the owner must confirm in a clean turn;
  - a title carrying a health reading is refused;
  - titles reach prompts fenced as data, as today.
- **Concurrent:** the DO single writer serializes writes. Confirm and close are conditional updates on the current
  status.
- **Degraded:** with no model, nothing is captured or confirmed, and the console Backlog still reads and closes.

## Verification

- Schema `valid + invalid` pairs for every changed tool argument.
- Taint tests: a tainted or machine `open_loop` produces `candidate`, and a tainted confirm is refused.
- A heartbeat test proves owner loops without `check_at` stay silent.
- Forget tests: titles redacted, `goal_ref` nulled, inventory complete.
- An app projection test against the pinned schema.
- An eval for the rewritten `open_loop` description: what it should capture, and what it should leave alone.

## Reversibility

- Every column is additive with exact defaults for existing rows. Old code reads only `status = 'open'`, so reverting the
  Worker hides new-status rows and corrupts nothing.
- `responsibilities` held no data, so its deletion reverts by restoring files.
- The ADR-0064 amendment leaves the `goals` table in place, so it is reversible.

## Security and privacy

- Rows hold a bounded title, enums, times and ids. No mail bodies, event text, meeting notes or health values are stored.
  Provenance is an id that points at the owning store.
- Loops stay per-owner in the Durable Object and inside forget, export and deletion (ADR-0055).
- Confirmation is attention, not authority. Acting on a loop still goes through the ordinary grant and approval path.
```
