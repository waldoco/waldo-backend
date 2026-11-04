# L7 Today: bounded console surface

30 September 2026. Source starting anchor `b596405ccbeb9f89f5fc125e8c418eec9116d3e9`; isolated branch `lane/codex-l7-today`. Fresh beta at start `880db31acfadf0eee4f3da97692b536f67683712` had no changes to the dashboard or overview projection since the anchor. Session registration: https://github.com/waldoco/waldo-backend/issues/116#issuecomment-5905020279 . Human owner Shivansh; Codex sole writer, read-only planner and qa-breaker.

## Current, ideal and scope

The existing owner-scoped overview supplies waiting count/first summary, next card, Brief send state, latest activity and Google grants. It supplies neither a full queue nor Brief/Close text, full Patrol history or modern Memory detail. The initial React shell also obscured the legacy controls behind separate routes and used provisional Instrument Serif/Inter.

Today prioritizes waiting, then the next card, then recorded Brief/activity information. Record time and refresh remain visible. Contextual links plus More controls retain the existing owner-console capabilities. The new UI does not approve anything from a summary, invent a memory insight, fabricate a responsibility or show a graph.

H1: the small Today surface plus real control access helps returning users orient themselves. H2: orientation requires richer product projections. Choose H1 for this slice; user usefulness still needs observation. Falsifiers: any supported control becomes unreachable, a positive count becomes an empty claim, a recorded send becomes delivery, a saved grant becomes tool success, or the app requests owner IDs/full ConsoleView. No new projection/API was introduced. Before handoff the branch was rebased cleanly onto fresh beta `9990ae7d3861e3666e48a5d75c01ccfff91d453c` (workspace #424 merged); its dashboard/overview source still had no competing changes. Frozen install and all dashboard/recursive typechecks were repeated successfully on that rebased source, including the new workspace package.

## Premises and demonstrated failures

At the anchor, `packages/dashboard-app/src/App.tsx:20,26` used null-summary fallbacks claiming nothing was waiting even when count was positive. A red two-route regression reproduced that contradiction (1 failed / 9 passed), then the shared count-aware summary passed. Count remains authoritative for pending work; lack of summary is unavailable detail.

Adversarial review caught the added skip link changing the hash to `#main`, which selected Today from Memory. The fix prevents default navigation and focuses the existing main element. Browser regression: open Memory, wait for its heading, press Enter on Skip to content; observed hash `#/memory`, active element `main`. Both keyboard and pointer activation use that same handler.

Malformed JSON initially surfaced the platform parser message. Strengthening the transport test produced 1 failed / 13 passed; parsing now yields the same unsupported-shape error as malformed structured data, without displaying response fragments. No unavailable response becomes a fabricated empty record.

## Old-to-new route and action map

| Existing destination | New entry | Preserved behavior / boundary |
| --- | --- | --- |
| React `#/overview` | Today (`#/today`), old hash alias | Only existing overview fields; record timestamp, read-only refresh |
| `/console` | Existing original URL remains valid | Legacy overview unchanged; no redirect/removal |
| `/console/waiting` | Waiting → Open full proposals | Full proposal details; eligible calendar approve/skip and supported undo; send dismissal. Email/message approval stays on exact chat card. Wiring in flight remains separate. |
| `/console/setup` | More controls → Setup checklist | Existing setup evidence/checklist |
| `/console/day` | Next card, day note, More controls | Day card timing/pins, timezone, quiet hours and volume |
| `/console/connections` | Connections → Manage Google & Telegram | Per-account Google connect/disconnect/reconnect; Telegram link/unlink |
| `/console/spots` | Memory → Spots | Confirm/dismiss/forget and existing incomplete-removal retry |
| `/console/constellation` | Memory → Constellations | Tentative nodes/links remain in existing console; no new default graph |
| `/console/memory` | Memory → Profile | Existing profile sections; correction through chat |
| `/console/files` | More controls → Telegram references | Telegram-hosted open/remove-from-list; no private-byte purge claim |
| `/console/usage` | More controls → Usage & estimated cost | Existing estimates; not provider-billed |
| `/console/activity` | Patrol → Activity & background runs | Existing paginated activity/run records; new Patrol remains latest-only |
| `/console/invites` | More controls → Invite someone to Waldo | Existing member invitation controls. Joining is not sharing owner data or a trusted relationship; cohort-gate readiness is not certified. |
| `/console/account` | More controls → Account & sign out | Existing account deletion, session/sign-out controls; no new deletion claim |
| Restricted admin routes | Existing operator surface | No new owner-navigation entry, authority or inherited admin grant |

Plain links reuse protected server pages and their existing action/CSRF handling. The React app never requests their full JSON. All legacy controls are source-preserved, not certified by clicking synthetic links (the preview deliberately returns 404 there).

## Branding and pixels

Reference: Figma `Dl0WP9uIvx6QbSzZi7cZQY`, desktop `297:5981`, app `797:8676`; Brief/card/button/Patrol component references were inspected. Mottle variable font and vector logo are exact copies from the landing repository. Landing surfaces `#FAFAF8`, `#F4F3F0`, ink `#1A1A1A` and accent `#FB943F` guide the composition; actionable link blue is darkened for readability. Rounded 24px containers, warm waiting emphasis and quieter record rows establish hierarchy. Body SF Pro Rounded is local/platform fallback, not a bundled font; no pixel-parity claim.

Mottle and SVG use explicit inline Vite imports because the unchanged Worker accepts only JS/CSS hashes. Verified built assets: CSS 246.25kB (98.66kB gzip), JS approximately 203.5kB (63.8kB gzip), two valid content-hashed files; no new static-serving contract/config or external font fetch. This keeps scope small at the cost of font bytes living in CSS.

Actual local synthetic Chrome pixels inspected at 1440×1000, 390×844 and 320×740; no horizontal overflow at 390 or 320. Saved desktop/mobile artifacts: `/tmp/waldo-dashboard-reference/today-desktop.jpg` and `today-mobile.jpg`. Preview banner is in normal flow so it does not obscure controls. Keyboard Enter expands More controls, skip preserves Memory, and refresh preserves the selected page. Focus outlines and ≥44px primary controls are explicit; full screen-reader certification is not claimed.

## Verification and remaining acceptance

Local Node `v22.23.2`, pnpm `10.34.4`, frozen install. Latest source check:

- `pnpm --filter @waldo/dashboard-app test`: 2 files / 14 tests PASS; covers missing summaries, legacy destinations, recovery copy, escaped hostile strings, absent data, recorded-send/heartbeat/summary/grant truth and transport failures.
- Dashboard `typecheck`, `build`, `verify:assets`: PASS. Asset verifier sees only the existing bounded content-hashed JS/CSS files.
- `pnpm -r typecheck`: PASS at tested source; no contract/runtime mutation.
- `git diff --check`: PASS.
- `pnpm verify:guards`: FAILED at the local pgTAP bootstrap on macOS (`/etc/os-release` absent, `dpkg` unavailable, PostgreSQL executable missing). Preceding guards through owner-wire/package-manager passed. This is an environment limitation, not a passing full guard wall; remaining guards/pgTAP were not run, no remediation outside lane scope.
- Local synthetic browser: delayed loading then ready, empty, positive count/missing summary, 401 sign-in link, 503 retry still failed, unsupported version rejected; mobile/desktop and keyboard checks above. One delayed-load selector wait reached its tool deadline; next snapshot showed Today ready. No code/test bypass or retry-until-green classification.
- Read-only qa-breaker: PASS after the skip fix. New parser recovery fix received its own red/green test and final source check.
- Runtime projection/invite behavior suites: NOT RUN; no projection/invite source changed. Full runtime suite, hosted probes, provider actions, migrations, deploy and merge: NOT RUN. UI tests do not certify tenancy.

Session/CSRF server paths are unchanged. Async abort suppression is source-preserved; no race/eviction certification from the static component suite. Source route map and pixels prove accessibility improvements within scope; deployed action behavior requires the following separate test run after the smoke/release gate.

Two independently authenticated users A/B must open dashboard and legacy routes: prove A sees only A data, B only B, signed-out/stale sessions fail closed and full ConsoleView never enters dashboard fetches. Match each owner's console summary to the same chat proposal/card IDs. Review an eligible calendar proposal and duplicate/stale action receipts through authoritative legacy handlers; never approve a send from a summary. Verify supported undo/dismiss and CSRF rejection without introducing a new approval path. Check Google accounts, Telegram links, invites and memory correction/partial forget with owner-scoped receipts. Keep content-free evidence and record exact deployed SHA. Real sends/provider effects require separately authorized fixtures. This plan is not permission to execute those effects.

## Dependencies and next slice

Rich Waiting needs an explicit owner-scoped proposal detail/read projection and verified action receipts; unified clarifications/blockers are not a typed queue yet. Full Brief and Daily Close detail need content/results contracts, although scheduled chat cards already exist. Patrol needs reason/outcome history with recorded skips/suppression and attempt/result distinctions. Modern Memory needs list/detail/deep-link/read/action contracts; evidence notes/source IDs are not truth or original message links, and partial forget/untrusted origin remain visible. No backed Today memory insight exists in this DTO.

Private workspace #424 merged into beta during this session; coordinate its existing source integration rather than equating merge with deployment. Coordinate private workspace Files with #424; do not duplicate list/upload/revision download/remove/pagination. Namespace configuration and deployment are that lane's outstanding dependencies. Existing Files are Telegram references, and removal must not promise all bytes purged. Sharing is unavailable. Commitments, web chat, sharing and Kennel controls need product contracts; named commitments table and Health remain deferred. Ledgers/runs are not invented responsibilities or resume targets.

## Engineering checklist and rollout

Applied sections: truth of result/receipt, escaping, identity-preserving navigation, data failure/recovery, keyboard/mobile and supply-chain preservation. No backend auth, secrets, health, RLS, bytes, effect or schema changes. No package/dependency/config/lockfile edits.

Checklist/bug-log handoff to the shared engineering guide owner (that file is outside L7's explicit allowlist):

| Class | Regression / required checklist addition |
| --- | --- |
| Count without summary falsely empty | Both Today/Waiting public rendering regression; summary absence cannot override pending count |
| Skip link collides with SPA routing | Actual keyboard Memory→skip preserves route/focus; in-app skip anchors must not select another page |
| Malformed JSON shows parser diagnostics | Transport malformed JSON/version failures share safe error copy; response fragments must not be displayed |

One bounded PR into beta-mvp, with exact-head CI pending until observed. No merge/deployment authorization. Rollback revert the UI slice before rollout; old console routes remain available. Retain this worktree and local screenshots for review.
