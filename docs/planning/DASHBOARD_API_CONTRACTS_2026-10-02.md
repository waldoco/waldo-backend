# Dashboard narrow API contracts (running notes)

Pattern: a pure projection over owner-DO state in `runtime/src/channels/dashboard-*.ts`, a versioned path under `/console/dashboard/api/v1/`, no recycling of `ConsoleView` (it holds CSRF, memory and other private data). Writes stay on the existing CSRF console actions.

Slices: connections (#542), your-day (this PR). Not started: waiting queue/detail/receipts, activity trace/detail, memory/profile.

## Route-wiring notes for the dashboard lane (seam in console-signin.ts, not done here)
- Use `DASHBOARD_OVERVIEW_HEADERS` on every dashboard API response and the same owner gate as the overview route.
- The unauthorized branch must cover each new path, not only the overview path.
- `Grant` in the connections input carries calendar, mail and tasks only. It has no drive, docs, sheets or slides, so the UI must not claim those.
- `health: "access_granted"` means no recorded refresh error. It does not prove the full scope is granted or that a live read works.
- The your-day projection drops the planner's free-text reason on purpose (can carry model text). Add a closed reason code first if the UI needs it.
- Waiting list `summary` is the desk's own line: sends include recipients and subject or a 117-char content preview, browser actions their bindings. Full review bodies are only in the per-item detail. The route must sit behind the owner gate and send `cache-control: private, no-store` (DASHBOARD_OVERVIEW_HEADERS).
