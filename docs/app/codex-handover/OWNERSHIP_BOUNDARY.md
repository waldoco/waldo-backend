# Ownership boundary: agent-capability backend vs app and app-enabling backend

Rule: one writer per path. A PR that must touch the other side's path stops and asks the other owner; it does not edit across the line. Instinct remains sole merger on `beta-mvp`. Staging only. Held until the owner says: #973, #987. Kennel is Ashish's lane.

## Agent-capability backend (Instinct)

Memory, tools, Google connectors, proactivity, prompt and loop quality.
- `packages/runtime/src/memory`, `recall`, `context-composer`, `prompt`, `scribe`, `skills`, `goals`, `responsibility`, `scheduler`, `triage`, `loop-governor`, `run-loop`, `run-journal`, `delivery-gate`, `hooks`, `llm`
- `packages/runtime/src/tools/**` and `connectors/google.ts` (Tasks all lists, calendar-list, Gmail readback, `sendUpdates` trace)
- Tests under `packages/runtime/test` for the above.

## App and app-enabling backend (Codex)

App shell, sign-in, sessions and transport; anything that couples a non-Telegram client to the owner.
- `packages/runtime/src/channels/app-api.ts`, the `/app/v1/*` route table and request/response envelopes
- `identity/**`: owner-message-admission, common-message-ingress, owner-directory, console-auth and signup (Telegram identity coupling, admission, who may call)
- `POST /app/v1/auth/start`, session and device tables, bearer issuance (`packages/mint-agent-jwt`), push and thread transport
- `packages/contracts/src/{auth,channels,ui,public,protocol}` for wire shapes the app consumes; `packages/dashboard-app`
- The app repo (Pin4sf/waldo-app) entirely.

## Health (Codex, end to end)

Health contracts (`contracts/src/health`, `recovery.v1` and Form views), Recovery producer, ingest route and handler, health and consent tables, wearable read tool, retention, and app integration. Already-merged health work stays and Codex builds on it. Standing owner rules bind: the agent sees readings end to end, but the egress, memory and external-taint denies stay (keep the pinned denial tests meaningful), and the hard gate before any outside user stays. Instinct reviews and merges these PRs; the ingest/consent design note and any migration follow the owner approval rule (staging only).

## Shared contracts (change only by a PR both sides can read)

- Any change to the owner-turn input shape, the approval ledger, or the egress/taint rules: Instinct reviews, and the change must keep the existing denial tests meaningful.
- Reading the other side's files is always fine.

## Browser and compute (Dalda, held)

`channels/browser-*`, `common-browser-*`, `cloudflare-*`, `general-browser-*`, compute lane (#973), upload (#987). Not in either list.

## Conflicts

If two PRs touch the same file, the first green PR merges and the second rebases. Flag any write to `beta` or `main`, force-push, production, secrets or destructive SQL to the parent instead of merging.
