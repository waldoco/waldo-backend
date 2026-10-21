# Codex handover: Waldo backend and app

Codex owns backend and app implementation end to end. Reviewer and sole merger on `beta-mvp` for Codex PRs: Instinct (merges after review, CI 6/6 and an adversarial pass, head SHA pinned). No secrets or personal data in this pack.

## 1. Queue state (immutable heads)

| Item | State | Head / ref |
|---|---|---|
| recovery.v1 derived health view | merged, not deployed | merge c2742e9a, head 28181852 (#993) |
| Health readings to model and owner reply | merged, not deployed | 7f9aa7e8 (#992) |
| Retained authenticated GET attachments | merged, not deployed | ed686308 (#985) |
| Browser upload (#987) | open, draft, CI 6/6, adversarial review unfinished, not merged | dcae83b1d3cb15b93384a64cfbca5749fdc2cca6 |
| Dalda compute lane (#973) | HELD until the owner says "final" | reviewed head 698bc7dd2c96953b71c5dcc589d181086c67d272 |
| #941, #906 | do not merge | - |
| Tasks read all lists | not started. Google connector reads only `@default` (connectors/google.ts ~459). No dependency. | - |
| calendar-list | not started. Needs Google scope beyond `calendar.events` (connectors/google.ts:9-19) plus reconnect: owner decision, unverified app so test users only | - |
| ingest/consent | not started. Design note first (`POST /app/v1/health/ingest`, consent and health tables, 90-day raw / 24-month aggregate retention). No migration until the owner approves the note. Staging only | - |
| Recovery producer | not started | - |
| Other queued | tree-interleave design note, ADR-0024 item-level withholding, failed-turn visible row, `POST /app/v1/auth/start` and session table design, overload-planning prompt fix, live Gmail readback of an approved send, Google `sendUpdates` PATCH-cancel staging trace | - |

Re-fetch `origin/beta-mvp` before branching; the tip moves. Kennel (bridge, device bridge, iMessage and WhatsApp connectors) is Ashish's lane: do not touch.

## 2. Quality bar

- Delete, do not layer. No new regex or keyword list to decide meaning; judgment belongs to the model, hard checks only at the execution boundary.
- Red tests first. Never skip or xfail. Keep pinned health-denial tests meaningful (move to a still-denying destination or external taint; never delete or loosen).
- No empty `catch`. No ticket, PR, date or person references in code comments.
- Stage explicit paths. Never `--no-verify`. Force-push only your own PR branch with an explicit lease.
- No new gate without a failing real trace. Telegram and staging traces are truth; CI is the typecheck (local `tsc` needs `NODE_OPTIONS=--max-old-space-size=6000`).
- PR body: spec item ids, red-first evidence, pinned tests changed and why, exact head SHA with PASS/FAIL/NOT RUN. Report merged, deployed and live-proven separately.
- Decide on engineering merit, log it in the PR, keep it reversible.

## 3. Capability matrix

Site promise claims against product, with open owner decisions: `capability-matrix-build-plan.md` (16-row plan, order, estimates, confidence) and `capability-matrix-consolidation.md` (gap table, mature-agent comparison). Decision: align the product to the site. Stage 1 is Recovery only; Form and Weight are Stage 2. Open owner decisions: Google scope add and reconnect, weather provider and cost, Android / Health Connect, coarse location, threads model, Weight early, ingest/consent note.

## 4. Parity checklist vs Instinct as a personal agent

Target to match, each proven by a staging trace:
- Reads mail, calendar (all calendars), tasks (all lists); drafts, then sends only after owner approval; verifies the send.
- Takes approvals through the ledger with exact recipient and body; no send without it.
- Browses and fills forms with held approval before any submit or upload.
- Holds durable memory and recalls it; says plainly when it has no data (no invented readings).
- Plans around real load (overload planning), with honest failure rows when a turn fails.
- Health context end to end for the owner (readings in model and reply; egress, memory and external taint still deny).
- Scheduled and proactive work with the owner's limits; every claim reported as merged, deployed or live-proven.

## 5. Staging, deploy and owner-only

- Staging only. Deploys and hosted migrations go through Dalda. Production, secrets and spend beyond testing 5-10 USD total (browse sandbox $5/month) are owner-only. Custody stays off. Secrets move only through vault requests, never chat or files.
- Migrations apply only after the owner approves the design note, staging first.
- Staging release at last read: eaa2469a; later merges are not deployed until Dalda rolls them.
