# Capability gaps

Living ledger of known defects and missing wires between the completion tracker's final states and current source. One place to answer "what is actually wrong and what closes it", kept separate from the tracker (which grades journeys) and from planning docs (which describe intent).

## Files

- [LEDGER.md](LEDGER.md): one row per gap, current status. The only file that changes on every update.
- [PLAN.md](PLAN.md): phased resolution steps per gap, with red tests, falsifiers, owners and dependency order.
- [audits/](audits/): dated, SHA-pinned audit snapshots. Immutable once written; a new audit gets a new file.

## Rules

- **Pin everything.** Every claim names the SHA it was read at. Re-pin before relying on a row.
- **Evidence tags.** `[verified-source]` = read in source at the pinned SHA with file:line. `[inference]` = reasoned from source, not observed. `[staging]` = observed on a named deployed build with trace. Never upgrade source to staging without a trace.
- **Status vocabulary** (matches the tracker): `open` · `in-progress` (PR named) · `source-fixed` (merged SHA, not deployed) · `staging-verified` (deployed SHA + trace) · `accepted` (journey passed on a named build) · `wont-fix` / `owner-call` (decision needed, owner named).
- **Gap IDs are stable.** `G<n>` never gets reused. Split a gap as `G<n>a`, `G<n>b`.
- **Map to tracker IDs** (A1–A8, B1–B11, C1–C7, D1–D3, J0–J7) so status questions can be answered from either side.
- **Close with evidence, not prose.** A row moves only with a PR/SHA, a test name, or a trace reference. Keep failed attempts in the row's history column.
- **No secrets, emails, raw health values or personal data** in any file here.

## Updating

1. Re-read the affected source at the new SHA.
2. Update the row's status, evidence and next change in `LEDGER.md`; append to its history.
3. If a fresh audit pass was run, add `audits/<date>-<sha8>.md` and link it from the ledger header.
