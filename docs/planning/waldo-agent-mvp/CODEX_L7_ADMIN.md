# Dashboard slice 3: restricted invite management

Base: 5103b50 (slice2 merged); branch codex/dashboard-slice-3. Draft review, no merge/deploy or hosted database mutation.

## Current → ideal → criteria
Existing signed admin_overview and admin create/revoke remain the authority. The modern dashboard lacked a restricted entry and issuer/quota projection. Done means an admin-only shell panel, canonical issuer attribution and lifetime quota, existing action policies and one-time-code honesty, filters/pagination, session/CSRF continuity and real keyboard drawer operation. Anti: no member-flow change, permission flag, resend, email delivery, recovered code, bulk action or quota/expiry alteration.

## Route/action preservation
| Existing route/action | Modern destination / eligibility | Preserved working path |
| --- | --- | --- |
| GET /console/admin | #/admin; sidebar only after successful signed admin projection | Existing HTML remains at /console/admin |
| invite.create | Admin create-by-email; current issuer count shown before action, disabled at five; signed RPC remains final authority | Original CSRF form unchanged |
| invite.revoke | Admin row on recorded open invite; issuer lifetime quota visible; stale refusal is failed, transport loss outcome unavailable | Original CSRF form unchanged |
| invite.member, GET /console/invites | Owner-facing flow unchanged, separate from restricted admin | /console/invites |
| Slice2 destinations/actions | No route removed/replaced | CODEX_L7_CONTROLS.md map still applies |

The new JSON Accept representation uses the same /console/admin and /console/action paths after owner session validation. No new permission model or endpoint. A new additive migration extends only admin_overview with canonical IDs, issuer email and all-status counts, including unattributed legacy rows. It must be integrated through the existing migration workflow before the modern projection is available. No migration was applied remotely.

## Data and recovery
All rows come from the existing signed query. Local email/status filters and ten-row pages operate on all returned records, with counts and recorded as-of. This does not introduce server-side pagination or change existing all-record query semantics. Raw codes appear only in creation receipts, never the read projection or persistent browser storage. Malformed/lost receipts explain unknown outcome and unrecoverability; no blind automatic retry. A refresh failure retains a just-created receipt. A new action is disabled while a raw-code receipt awaits dismissal. Missing projection is unavailable with retry and the original path; non-admin receives a generic404 and no nav entry.

Existing dashboard link sweep: supported paths /console/waiting, activity, spots, constellation, memory, connections, day, files, usage, setup, invites, account and root remain in the source dispatcher. Unavailable Memory/day/Telegram summaries explain their read-contract limits and working paths. Preview404s intentionally do not simulate legacy handlers and are not runtime-link proof.

## Verification layers
- Component/model: admin-only navigation, absent route, quota math, expired/used/revoked precedence, page clamping, escaped issuer/email, unsupported projections, stripped extra fields, malformed200 and lost transport recovery; no snapshots.
- Real handler: actual owner DO fetch validates foreign-session rejection, signed current-owner read with query owner ignored, CSRF rejection before RPC, create/revoke dispatch. External RPC transport is synthetic; signed hashing/signatures checked independently. Existing legacy admin/auth/signin/overview tests remain.
- Database: new pgTAP14 assertions for admin/suspended/unsigned gates, canonical issuer attribution, all-status counts, missing attribution, no code read field. Local UNRUN: no Docker daemon/Postgres. CI fresh database is the execution gate.
- Rendered: synthetic local preview, real browser keyboard events at390x844: Enter/Space open; initialClose focus; ShiftTab first→last and Tab last→first; Escape close/Menu focus return. Not a live admin or deployment claim.
- Source: required planner, QA-breaker and security reviewer; security source review found no authorization regression. QA malformed receipt finding fixed with regressions/checklist. Full external review follows draft.

Rollback: revert bounded PR. Legacy HTML and owner invitation controls remain. No pixel-parity, delivery, hosted DB or live acceptance claim.
