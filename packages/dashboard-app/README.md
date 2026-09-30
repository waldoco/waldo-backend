# Waldo React dashboard

The authenticated React dashboard reads only `/console/dashboard/api/v1/overview` on the same origin, with same-origin credentials and no-store requests. It does not read the full `/console` JSON (which includes memory and CSRF). The Worker gates the HTML shell through the same owner-session read; only content-hashed JS/CSS are served as public immutable assets. Unknown static paths do not fall back to the app.

Today replaces the visible Overview destination; old `#/overview` links still resolve to Today. Waiting and Patrol remain narrow summaries. Memory details are unavailable here. Connections show saved Google grants, not verified live tool use. The desktop sidebar and mobile modal drawer expose contextual links and protected controls. Memory has Spots / Constellation / Profile subviews; Your day groups timing, pins, timezone, quiet hours and volume through the existing controls. These links open the existing protected owner-console pages for real details/actions. Calendar review controls remain there; email/message sends still require the exact review card in chat. This slice adds no effect action and does not certify the approval-to-execution wiring.

The brand font and logo come from `waldo-landing/public/fonts/Mottle[wght].ttf` and `waldo-landing/public/logo.svg`. The Brief and Constellation illustrations also come from the landing repository. Copies live in `src/assets`; CSS imports force inline assets so the unchanged Worker JS/CSS allowlist remains valid. No third-party font requests are made. Body type uses locally available SF Pro Rounded or the platform fallback; the landing's large SF Pro files are not bundled. This is a brand-informed composition, not pixel parity with Figma.

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

Open `http://127.0.0.1:4178/console/dashboard`. There is no `dev` script. The preview is local-only, explicitly synthetic and excluded from production bundles; it does not simulate protected legacy pages or live authentication. After rebuilds reload the browser. Optional `--case=empty|missing-summary|signed-out|unavailable|malformed|loading|recorded` and `--port=4180` select a synthetic recovery scenario. The fixture intentionally shows an old `as_of` record; the UI displays its timestamp without inventing a freshness policy.

No deployed revision was inspected for this slice. Local component/transport tests and synthetic pixels cannot establish live two-owner isolation, chat continuity, CSRF, action receipts or provider delivery. Full work queues, Brief/Close detail, rich Patrol history, modern Memory read/actions, sharing, commitments and web chat need explicit contracts. Private workspace Files are a separate integration (#424, now source-merged), with namespace configuration and rollout still owned by that lane.

See `docs/planning/waldo-agent-mvp/CODEX_L7_CONTROLS.md` for the route/action map, evidence and acceptance handoff.
