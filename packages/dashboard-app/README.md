# Waldo React dashboard

Normal browser visits to `/console` serve the authenticated React dashboard; `/console/dashboard` remains a compatible alias. Existing control pages and the old overview at `/console/legacy` remain protected and reachable. Root JSON, ticket redemption and action receipts retain their existing handlers. Signed-out shell visits redirect to the fixed `/console/signin` route.

The authenticated React dashboard reads only `/console/dashboard/api/v1/overview` on the same origin, with same-origin credentials and no-store requests. It does not read the full `/console` JSON (which includes memory and CSRF). The Worker gates the HTML shell through the same owner-session read; only content-hashed JS/CSS are served as public immutable assets. Unknown static paths do not fall back to the app.

Today replaces the visible Overview destination; old `#/overview` links still resolve to Today. The top bar holds four destinations (Today, Waiting, Memory, Patrol) and a Settings link; on phones the same four become a bottom tab bar. Settings groups Your day, Connections, Files, Usage, Account and Invites, plus Invite management for admins; Setup and Sessions stay reachable by URL. Waiting and Patrol remain narrow views of the existing control reads. Connections show saved Google grants, not verified live tool use. Calendar review controls remain where they were; email/message sends still require the exact review card in chat. This slice adds no effect action and does not certify the approval-to-execution wiring.

Memory opens on a graph of the returned Spots and patterns, ported from the waldo-landing Spots and constellations map (`components/site/memory-map.tsx`, after andrewtrousdale.com), with List and Calendar views a toggle away. The graph view makes one extra read for the other side of the map (the first patterns page beside Spots, or the first Spots page beside patterns) and separates saved support membership from decorative root spokes and derived shared-support context. Read failures and partial reads stay visible, with caps and an inspectable record list; zoom and keyboard pan do not change the saved data. While the graph is open the page crossfades to a dark scene over 1.6s (View Transitions, with a fading veil as the fallback); it never switches brightness in a single frame. Profile shows saved sections as card stacks.

Type is the platform SF Pro. Mottle (`waldo-landing/public/fonts/Mottle[wght].ttf`) is used only for the greeting's time-of-day word and the Spots calendar month. The logo is the landing nav's mark, drawn inline. Product icons are SF Symbols from Waldo's icon set (`Waldo-App/assets/sf`, `waldo-landing/public/assets/home/icons` and the landing's illustration glyphs); connector marks are the landing's Gmail, Google Calendar and Telegram logos. The decorative pointer figures are `@lucasmarkes/hairline` (MIT), used as published; they never carry data. Copies live in `src/assets`, and CSS/JS imports inline them so the unchanged Worker JS/CSS allowlist remains valid. No third-party font or network requests are made.

Run with Node 22 and pnpm 10.34.4:

```sh
pnpm install --frozen-lockfile
pnpm --filter @waldo/dashboard-app test
pnpm --filter @waldo/dashboard-app typecheck
pnpm --filter @waldo/dashboard-app build
pnpm --filter @waldo/dashboard-app verify:assets
pnpm -r typecheck
node packages/dashboard-app/scripts/preview.mjs
```

Open `http://127.0.0.1:4178/console/dashboard`. There is no `dev` script. The synthetic overview follows the real clock in its fixture zone so the day rail has something to draw. The preview is local-only, explicitly synthetic and excluded from production bundles; it does not simulate protected legacy pages or live authentication. After rebuilds reload the browser. Optional `--case=empty|missing-summary|signed-out|unavailable|malformed|loading|recorded` and `--port=4180` select a synthetic recovery scenario. The fixture intentionally shows an old `as_of` record; the UI displays its timestamp without inventing a freshness policy.

No deployed revision was inspected for this slice. Local component/transport tests and synthetic pixels cannot establish live two-owner isolation, chat continuity, CSRF, action receipts or provider delivery. Full work queues, Brief/Close detail, rich Patrol history, modern Memory read/actions, sharing, commitments and web chat need explicit contracts. Private workspace Files are a separate integration (#424, now source-merged), with namespace configuration and rollout still owned by that lane.

See `docs/planning/waldo-agent-mvp/CODEX_L7_CONTROLS.md` for the route/action map, evidence and acceptance handoff.

Slice3 adds a restricted `#/admin` panel only after `/console/admin` returns the signed admin read successfully. It reuses `/console/action` with the existing session/CSRF and invite RPCs. The additive admin projection migration is required for issuer/quota fields; an older projection produces an unavailable view with the existing HTML path. Owner invites remain separate. Pagination is over all returned records, not a new server paging contract. No raw code is saved or recoverable.

Synthetic admin layout/recovery checks: `node scripts/preview.mjs --case=admin --port=4180` or `--case=admin-refresh-failure --port=4181`. These are local fixtures only; legacy paths and permission enforcement are not simulated. Real keyboard proof uses Menu Enter/Space, Close menu Shift-Tab, last navigation link Tab, then Escape and opener focus return.
