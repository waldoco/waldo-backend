# Dashboard slice 2: sidebar and supported controls

Base `c002d446327bfccb72cbe3e13492017f5c828b6d` (merged #425). Branch `lane/codex-l7-controls`; isolated worktree retained. Sole writer Codex; read-only planner/qa-breaker. Registration: https://github.com/waldoco/waldo-backend/issues/116#issuecomment-5905719107 . User scope: sidebar and Waiting, Memory, Connections, Your day; Account/sign-out copy correction. Runtime, full JSON, projections, auth, CSRF and contracts are unchanged.

## Preservation map — written before screens change

Source checked at base: `channels/console.ts:90,190–214,242–278,298–367,461–493`; `console-invites.ts`; actual owner handler and existing workspace helper. These are source eligibility observations, not live execution proof. New UI keeps effects in these protected destinations and does not duplicate their eligibility logic.

| Destination/action | Existing renderer eligibility and details | Modern entry / preserved destination |
| --- | --- | --- |
| `/console` browser entry | New authenticated React home for GET/HEAD; ticket GET/POST and JSON stay on existing handlers | Today shell; `/console/dashboard` remains an alias |
| `/console/legacy` overview | Existing overview and JSON, unchanged session/CSRF | Sidebar Existing controls; every deep route/action below remains reachable |
| `/console?m=...` action receipts | Existing notice text and eligible controls | Existing overview retained for notice-bearing root requests; no receipt discarded |
| React `#/overview` | Overview DTO | Alias to Today |
| `/console/waiting` full details | Matching typed review renders exact calendar/email/message details; unsupported/missing detail has no fabricated full review | Waiting → Open full proposals |
| `approval.approve` | Open `calendar_change`, authoritative `consoleMayApprove`, matching non-null calendar review | Protected Waiting only; no React approve |
| `approval.skip` calendar | Same eligible full-review branch | Protected Waiting only |
| `approval.skip` email/message dismissal | Open/review_only send, not console-approvable | Protected Waiting only; no send approval |
| `approval.undo` | Renderer shows only backend `undoable` in completed/non-open branch; handler remains authoritative | Protected Waiting only |
| Send exact approval | Chat full review card only; too-long or unconfirmed card cannot be approved | Chat unchanged; modern summary tells user where supported review happens |
| `/console/setup` checklist | Existing recorded setup evidence | Sidebar Setup checklist |
| `/console/spots` lists/details | Active claims with evidence notes, verification/source labels, shared/untrusted origin; held and retired disclosures | Memory → Spots → Open Spots |
| `spot.confirm` | Renderer offers for inferred active spot; handler trust/admission remains authoritative | Existing Spots control only |
| `spot.dismiss` | Active listed spots | Existing Spots control only |
| `spot.forget` | Active spots; purging/incomplete removal shows Retry forget, not silent disappearance | Existing Spots control only; modern removal explanation preserves partial state |
| `/console/constellation` lists/details | Tentative/stale nodes, supporting spots and links; strength is uncalibrated, not truth probability | Memory → Constellation → Open Constellation; no graph |
| `node.forget` | Listed node; removes pattern/links, not supporting spots | Existing Constellation control only |
| `/console/memory` Profile | Existing read-only profile sections and do-not-relearn notes | Memory → Profile → Open Profile; correction remains chat |
| `/console/connections` accounts | Existing per-account email, grants/error; saved permission is not successful live use | Connections → Manage Google & Telegram |
| `google.disconnect` | Every listed connected account, bound to its existing ID | Existing per-account control only |
| `google.connect` reconnect | Account error AND connectAvailable | Existing account control only; modern row shows needs_reconnect from DTO |
| `google.connect` add/connect | connectAvailable; unavailable OAuth config is explicit | Existing connection controls only |
| `telegram.link` | Existing link control | Existing Connections only; no Telegram status in React DTO |
| `telegram.unlink` | linked AND unlinkAvailable | Existing Connections only |
| `session.signout` | Existing current-browser control | Sidebar Sessions & sign out and Connections session link → `/console/connections` |
| `session.signout.all` | sessionCount > 1 | Existing Connections only; no React session count |
| `/console/day` day cards | Existing card reasons/times/sent/pins, timezone and proactivity | Your day → Open day controls |
| `card.today` | Unsent card (time input uses current/default time) | Existing day control only |
| `card.pin` | Unsent card, same time form | Existing day control only |
| `card.unpin` | Pin exists, including sent cards | Existing day control only |
| `timezone.set`, device-fill | Existing valid time-zone form, server validation; device-fill is local-only before save | Existing day control only; React displays DTO timezone |
| `proactivity.set` quiet/volume | Existing quiet-start/end and supported volume select; backend validation unchanged | Existing day control only; no fabricated values |
| `/console/files`, `file.remove` | Telegram reference list open/remove; remove-from-list not private byte purge | Sidebar Files · Telegram references, original route |
| `/console/workspace` list/upload/download/remove/pagination | Separate #424 source integration; authenticated lifecycle/session admission, revision-bound actions, CSRF for mutations; config availability checked there | Existing direct route retained; no duplicate storage UI or readiness claim |
| `/console/usage` | Existing estimated cost/model counts | Sidebar Usage & estimated cost |
| `/console/activity`, background run details/pagination | Existing protected activity/readback | Patrol existing activity link, original routes unchanged |
| `/console/invites`, `invite.member` | Authenticated member list/create; renderer only below existing issue limit, authoritative backend eligibility unchanged | Sidebar Invite someone; no data-sharing/trusted-person implication |
| Operator `invite.create`, `invite.revoke` | Restricted admin path and backend checks | Existing operator route retained; no owner navigation/admin inheritance |
| `/console/account`, `account.delete` | Existing destructive account confirmation and server handling | Sidebar Account; never labelled sign-out or claimed all stores purged |

No existing route is redirected/deleted. Map covers each `CONSOLE_ACTIONS` value plus workspace and chat controls. The source account page has deletion only; sign-out is in Connections. That mismatch is the slice1 review bug, tested before fixing. Client renders no effects, session list, approval eligibility or missing memory data.

## Current → ideal → gap

Current: top navigation and hidden More controls; undifferentiated unavailable Memory page; account label points sign-out at wrong destination; grants rendered as generic cards; no modern Your day route. Ideal: sidebar/mobile drawer with discoverable protected controls, one Memory destination/subviews, honest count/account/day records and explicit unavailable detail. Falsifiers: losing an action/eligibility, offering generic approve, inferring Telegram status/session counts, converting absent DTO data into empty memory/day state, or bypassing same-origin owner API/CSRF.

Waiting uses only count/first summary. Memory list/detail data is not in OverviewV1: subviews explain that limitation and open the existing list/detail controls. Connections uses only services account_id/email/grants/health. Your day uses timezone, next_card and Brief status/at; card timings/pins, quiet hours/volume, full Brief/Check-in/Close detail remain protected legacy controls. Static feature descriptions derive from source, not invented field values.

## Verification and handoff

Implemented: desktop sidebar and mobile modal drawer; supported Waiting review gateway; one Memory destination with Spots / Constellation / Profile subviews; Google account/grant rows; Your day control groups; accurate Account and separate Sessions & sign out links. Existing owner API, model parser, runtime routes, session and CSRF handlers are unchanged. No new action forms, dependencies or runtime fields.

### Evidence by layer

- Source: action-by-action preservation map above, reviewed against `CONSOLE_ACTIONS` and individual legacy renderer eligibility; all legacy routes remain unchanged. Applied Engineering Fundamentals sections for auth/session boundaries, retries, time, trust boundaries and truthful evidence. No new effects, provider calls, persistence, migrations or config.
- Component: `pnpm --filter @waldo/dashboard-app test` passed 19 tests across 2 files, including account/sign-out destinations, sidebar and subview links, recovery/sign-in, hostile text escaping, missing summaries and absence of modern effect forms/approval controls. Account label regression was red before the fix. Tests render components and exercise transport; they do not mount a real browser drawer.
- Runtime boundary: `pnpm --filter @waldo/runtime exec vitest run test/dashboard-overview.test.ts test/dashboard-static.test.ts` passed 11 tests across 2 files, including owner query rejection/owner isolation, unsigned sessions and static shell boundaries. Local boundary tests do not establish live owner acceptance.
- Build: dashboard build, asset allowlist verification and recursive workspace typechecks passed with Node v22.23.2 / pnpm 10.34.4. Frozen install leaves the lockfile unchanged. `git diff --check` passed.
- Rendered: synthetic local preview at port 4179 inspected at desktop 1440×1000, mobile 390×844 and narrow 320×640. Drawer Tab/Shift+Tab wraps inside; Escape returns focus to Menu; route selection closes; short-height drawer scroll reaches Account, sessions and Original console; desktop resize closes drawer. Memory back/forward/reload preserve selected subview; Skip to content focuses main without changing the hash. No horizontal overflow observed in those inspected states. This is manual browser evidence, not an automated accessibility certification or real owner data.
- Guard limitation: `pnpm verify:guards` exited 1 at pgTAP bootstrap: macOS lacks `/etc/os-release` and `dpkg`, and the expected PostgreSQL binary was missing. Prior printed guards passed; aggregate guard suite did not pass. pgTAP is UNRUN. No database/config remediation attempted in this UI lane.

Browser screenshots: `/tmp/waldo-dashboard-reference/controls-waiting-desktop.jpg` and `controls-memory-desktop.jpg`. Preview data is explicitly synthetic/not deployed. No pixel-parity, live tenancy, successful tool-use or execution claim.

### Reference direction and explicit dependencies

Reviewed supplied Figma nodes `797:9197` (Patrol), `797:9295` (Spots) and dashboard/sidebar `619:9181` / `619:9182` in file `Dl0WP9uIvx6QbSzZi7cZQY`. Useful direction: warm neutral sidebar, grouped navigation, soft card outlines, observation-led Spots, and compact timestamped Patrol entries. Their health/sample narratives, extra navigation and action claims are not implemented capabilities. Current Patrol remains one latest activity; no synthetic timeline. Modern Spots remains unavailable until an owner-scoped list/detail read contract exists.

For a later selected Constellation pattern, “Explore connections” is an optional secondary view, never the default Memory graph. Reference: https://andrewtrousdale.com. Dependency: authoritative owner-scoped selected-pattern identity/revision, saved node/link IDs, supporting Spots, provenance/origin, tentative/stale state and partial-removal state, with bounded/paginated retrieval. Only real saved relationships may be drawn; evidence notes/source IDs stay audit references, not original-message links or truth guarantees. Proposed rendering: bounded SVG and CSS transitions with a small spring loop that settles and stops; static reduced-motion mode; keyboard and touch selection plus equivalent list fallback. No Three.js. Consider D3 force only if real graph size later warrants it. Slice 2 adds no graph, fabricated relationship, or inert Explore control.

Other dependencies remain full Waiting queue/typed attention, modern memory read/action/detail links, full card content and Daily Close verified results, richer Patrol reason/outcome history (including recorded skips/suppression), Telegram/session details and settings value projections. Existing settings/actions remain reachable. Private workspace rollout/config stays owned by its separate lane; sharing remains unavailable.

### Acceptance remaining and recovery

Same-owner chat-to-console continuity, real two-owner access, live session/CSRF checks and stale/duplicate action receipts remain live acceptance work on the protected legacy surfaces. Approval-to-execution wiring is in flight; this UI cannot certify it. No merge or deployment performed. Rollback the bounded UI commit; existing console routes remain usable.

Checklist for this UI bug class: labels must name the actual destination and session controls; adversarial link tests must cover sibling routes. Mobile modal navigation must contain keyboard focus, restore it on close, and release the modal on desktop resize; manual rendered verification above catches the initial native focus-wrap gap. Canonical Engineering Fundamentals follow-up remains outside the lane packet's file ownership and must accompany any shipping acceptance. Draft review is not shipping acceptance.

## Console entry migration

Branch `codex/dashboard-console-entry`, base `ba4d4a1`. Normal browser GET/HEAD `/console` and `/console/` now serve the existing protected React shell. `/console/dashboard` remains compatible, and assets/API retain their original paths. Unauthenticated shell requests redirect only to `/console/signin`; successful existing email verification already returns to `/console`. No arbitrary return parameter or alternate auth authority is introduced. Configured email authentication renders its existing form; ticket-only deployments retain the existing Telegram `/console` link instructions.

The old overview remains available at `/console/legacy`. Root JSON, ticket previews/redemption, and `?m=` action receipts continue through the original handlers. Every individual action and eligibility in the preservation map stays unchanged. Existing controls sidebar points to the legacy alias, avoiding a home-to-home loop. The ticket fallback canonicalizes its owner routing header before invoking the selected owner DO. No Memory DTO or sign-in handler edits: #505/#506 retains those contracts.

Verification: red-first static root/redirect tests and spoofed-owner-header regression; 27 dashboard tests; focused runtime suites plus actual owner-DO session coverage for ticket reuse, shell, JSON/legacy CSRF parity, notices, invalid-action nonmutation and cross-owner denial. Workspace typechecks, dashboard build and asset checks pass. Source QA/security review pass after canonical-header correction. Rendered synthetic Chrome320×640: Enter and Space open Menu, Shift+Tab wraps to Existing controls, Tab wraps back, Escape closes/restores Menu; clientWidth/scrollWidth320/320. Desktop sidebar shows the correct legacy link. These are synthetic UI and local DO checks, not live deployment, delivery or chat-continuity proof. Full verification results and exact head belong in the draft PR receipt.
