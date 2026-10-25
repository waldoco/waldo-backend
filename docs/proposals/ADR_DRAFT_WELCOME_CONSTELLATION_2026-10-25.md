# ADR draft: the welcome constellation (25 October 2026)

This is a draft for `Pin4sf/waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`. The design it records is
[`WELCOME_CONSTELLATION_2026-10-25.md`](WELCOME_CONSTELLATION_2026-10-25.md). It lands in `waldo-brain` through that repository's
own review, after the gate approves the design. Nothing here changes an accepted ADR by itself. The number is the next free slot
at publication: 0085 is proposed for the forget barrier, and #1517 and #1534 may claim the slots after it.

---

```markdown
---
status: proposed
date: 2026-10-25
canonical_location: waldo-brain/01-Waldo/Architecture Decision Records (ADR)/00NN-welcome-constellation.md
related: [0049-source-taint, 0055-gdpr-deletion-runbook-all-stores, 0081-health-computation-destinations, 0082-device-lifecycle]
---

# The welcome constellation: one bounded build, Waldo's read until the owner confirms it

When setup ends, Waldo builds a small constellation from the owner's connected sources and shows it as a welcome gift. The build
writes memory from outside text (mail, calendar) and from health data, at a moment when the owner has not yet said anything
about themselves. **Decision: one idempotent welcome job per owner, in the owner's OwnerDO. It reads each source within a bound.
Each source gets one structured model call. Code admits what the model returns only as inferred, non-owner support claims and
the nodes they back. Web text stays in look-up findings and is never copied.**

## Rules

1. **One writer, once.** `welcome.start` writes a single `welcome_builds` row and arms one job, inside the caller's
   transaction. Reads and model calls run in the job, outside any SQLite transaction. A second start returns the first row.
   A rerun needs the owner's act.
2. **Bounded reads, as pointers.**
   - Health: 90 days through the signed series read, under live `storage_compute` and `model_processing` consent.
   - Calendar and Tasks: every connected Google account, named explicitly.
   - Mail: senders, subjects, dates and thread ids over 90 days, never bodies or snippets.
   - Web: only through the existing look-up and its `owner_lookup` consent.
   - Each source has a time and page budget and a recorded state.
3. **Judgment is the model's; hard checks are code's.** The model decides what is worth showing and how to say it. Code holds
   only these checks:
   - schema and lengths;
   - no digit and no numeric health value in any stored string;
   - forget-barrier hits;
   - budgets and the total cap.
4. **Waldo's read until confirmed.**
   - Support claims are `kind: observation` and `source: inferred`. Their origin is `untrusted` for mail and calendar, and
     `agent` for health.
   - `source_ref` holds `welcome:<source>:<pointer>`.
   - They are never recalled as owner facts, never pinnable, and never touch an existing row.
   - Confirming owner-grounds them; correcting replaces them with the owner's words.
5. **Narrow outside-text exception (`welcome_read`).** The job's health, calendar and mail stages make no tool calls and carry
   no effects. Their only writes are rule 4's rows. The web stage's only writing tool is `record_owner_finding` (`honest_origin`).
6. **Chat sees what the gift shows.** Each turn gets a bounded `<owner_constellation>` block. Untrusted-origin nodes are
   labelled as Waldo's read, and look-up findings are counted, not quoted. The block passes the held-topic filter.
7. **Health stays numberless outside the health plane** (ADR-0081).
   - Values reach the model only inside the health stage's own untainted call (`source_taint: null`), under live
     `model_processing` consent.
   - Every welcome call's purpose is metadata-only, so trace capture records no text.
   - No DO table, log, trace or event payload holds a value.
   - When the `HealthPattern` contract (#1472) ships, the stage reads admitted patterns instead of daily values.
8. **Forget is final.** A node forget barriers the label and each support's text, purges the supports and deletes the node. A
   rebuild cannot relearn it. Withdrawing `owner_lookup` erases findings (existing behaviour). Account deletion removes all of
   it with the DO (ADR-0055).

## Persistence

- One new DO table, `welcome_builds`, holding stage states and counts only, never text.
- Rows in the existing `claims`, `constellation_nodes` and `constellation_edges` tables. No new column.

## Considered options

- **Source-backed nodes with new node columns** (`sources`, `confirmation`). Rejected: the app projection drops unsupported
  nodes, so every reader and forget path would need a second support model.
- **Web nodes copied from findings.** Rejected: two copies of external text, and a break with the rule that findings stay out of
  prompts until kept.
- **One agentic machine turn over all sources with tools.** Rejected: unbounded reads, a tool-taint fight with the write gate,
  and no per-source progress.
- **Store welcome health nodes as `HealthPattern` rows** (#1472 §5). Rejected for now: that contract is computed evidence in
  Supabase, with false-discovery control, and it is not built. A welcome node is Waldo's digit-free phrasing, not evidence.
  Once patterns exist, the welcome node points at them, and the two do not compete.
- **Wait for the nightly pass.** Rejected: its two-day evidence rule cannot produce a first-day gift, and the owner ruled for a gift.

## Consequences

- The app gains three additive keys (`welcome`, `sources`, `confirmation`) and three node actions on the controls route.
- The privacy notice gains a welcome-build paragraph before it is published.
- A cohort deploy without the published notice ships the web stage as `skipped`.
```
