# Browser and computer lane (bounded in Phase 1)

**Owner:** the existing session "Finalize the Waldo browser lane (app-first)". Its audit, errand set and design are draft PR #1032.

## Phase 1 (now)

- **Close the superseded drafts after the owner's go:** #881, #894, #895, #906, #911, #941, #966. The evidence for each is in #1032.
- **Re-cut only the S0 files from #908** onto `beta-mvp`, dropping its guard loosening. Add the second check, which drives the real retained-session path.
- **Do not build the in-app browser UI yet.**
  - Browser admission still requires a Telegram link (`owner-browser-runtime.ts:49-69`). L2 slice 5 removes that.
  - Approvals in the app come from L3's piece A.

## Phase 2

- **Land #987** (approved upload) after piece A.
- **Re-cut #973** (bounded Linux compute) after its HIGH finding is fixed.
- **Own the "agent computer"** end to end (#776 spike).
- **Run the 23-errand set** with independent checks on every release. Any false claim blocks the release. This is the measured parity bar against mature personal agents (ledger §11).
- **No purchases** until the owner sets spend limits.
