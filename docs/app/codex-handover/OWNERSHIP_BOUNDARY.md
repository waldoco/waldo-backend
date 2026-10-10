# Ownership boundary: agent-capability backend vs app and app-enabling backend

Rule: one writer per path. A PR that must touch the other side's path stops and asks the other owner; it does not edit across the line. Instinct remains sole merger on `beta-mvp`. Staging only. Held until the owner says: #973, #987. Kennel is Ashish's lane.

## Agent-capability backend (Instinct)

Memory, tools, Google connectors, health, proactivity, prompt and loop quality.
- `packages/runtime/src/memory`, `recall`, `context-composer`, `prompt`, `scribe`, `skills`, `goals`, `responsibility`, `scheduler`, `triage`, `loop-governor`, `run-loop`, `run-journal`, `delivery-gate`, `hooks`, `llm`
- `packages/runtime/src/tools/**` and `connectors/google.ts` (Tasks all lists, calendar-list, Gmail readback, `sendUpdates` trace)
- Health: `channels/health-context.ts`, `contracts/src/health` and the `recovery.v1` / Form view contracts, Recovery producer, wearable read tool, retention rules
- Ingest/consent: the design note, health and consent tables (migration PR, pgTAP), `POST /app/v1/health/ingest` handler body. The route registration stays app-enabling (below).
- Tests under `packages/runtime/test` for the above.

## App and app-enabling backend (Codex)

App shell, sign-in, sessions and transport; anything that couples a non-Telegram client to the owner.
- `packages/runtime/src/channels/app-api.ts`, the `/app/v1/*` route table and request/response envelopes
- `identity/**`: owner-message-admission, common-message-ingress, owner-directory, console-auth and signup (Telegram identity coupling, admission, who may call)
- `POST /app/v1/auth/start`, session and device tables, bearer issuance (`packages/mint-agent-jwt`), push and thread transport
- `packages/contracts/src/{auth,channels,ui,public,protocol}` for wire shapes the app consumes; `packages/dashboard-app`
- The app repo (Pin4sf/waldo-app) entirely.

## Shared contracts (change only by a PR both sides can read)

- `contracts/src/health` and `core`: Instinct edits; Codex may add consumers but not alter fields without asking.
- Any change to the owner-turn input shape, the approval ledger, or the egress/taint rules: Instinct reviews, and the change must keep the existing denial tests meaningful.
- Reading the other side's files is always fine.

## Browser and compute (Dalda, held)

`channels/browser-*`, `common-browser-*`, `cloudflare-*`, `general-browser-*`, compute lane (#973), upload (#987). Not in either list.

## Conflicts

If two PRs touch the same file, the first green PR merges and the second rebases. Flag any write to `beta` or `main`, force-push, production, secrets or destructive SQL to the parent instead of merging.
