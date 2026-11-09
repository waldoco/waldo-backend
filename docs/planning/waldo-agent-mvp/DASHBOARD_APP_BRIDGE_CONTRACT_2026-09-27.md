# Dashboard and app bridge - contract before a second UI

Status: design contract, not a shipped React app. Source: the current `/console` read/action paths on `beta-mvp` (0c6f195) and the owner-approved dashboard spec. A live deployment must be checked independently before any claim of parity.

## What is real now

- The owner Durable Object builds `ConsoleView` from its own approvals, day-card records, memory, connection grants, trace log and background runs. `/console` renders HTML or JSON after a valid console session. The same account may have multiple Google grants; a grant and a refresh-health flag do not prove a tool read.
- The existing POST action path checks the console's session and CSRF token. Approval decisions use the desk handler. The action path is the source of mutation semantics; a new front end must not reimplement them.
- `/console` is a zero-dependency owner fallback. The Overview added in the companion patch is a read-only projection of persisted state, not a generated Brief, inbox, full task list or claim of provider delivery.

## Proposed read contract (not implemented)

`GET /dashboard/api/v1/overview` returns a versioned, owner-scoped projection after the existing owner routing and authenticated session have succeeded. Never accept an owner id from a query string. Return `401` without a valid session; `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and frame denial on every response. The projection should contain only data needed on Home:

```ts
type OverviewV1 = {
  version: 1;
  as_of: string;                 // ISO time, owner timezone separately named
  timezone: string;
  brief: { status: 'sent_recorded' | 'not_sent' | 'not_scheduled'; at: string | null };
  waiting: { count: number; first: { id: string; summary: string } | null };
  next_card: { id: string; label: string; scheduled_at: string } | null;
  latest_activity: { kind: string; status: string; at: string; summary: string | null } | null;
  services: { account_id: string; email: string; grants: ('calendar' | 'gmail' | 'tasks')[];
              health: 'access_granted' | 'needs_reconnect' }[];
};
```

`sent_recorded` says the agent stored a send event; it does not prove transport delivery or reveal the message body. `next_card` is future relative to `as_of` in the owner's timezone, not the earliest unsent card from the start of the day. `latest_activity` must come from the newest log entry, not an arbitrarily paged row. No health/Form score, protected window, weather, trust setting, task, or brief text appears without a real backing source. If the owner has no relevant data, null and explicit empty states win over sample cards. The server computes the projection; the React client merely renders it.

## Auth and actions

A Cloudflare Pages origin cannot assume the `/console` cookie is sent or share a `Path=/console` cookie. Decide the same-origin routing and session model before deploying Pages. The first safe version may serve static assets from the Worker under the console origin, or use a narrowly scoped API-origin credential with CSRF and explicit origin checks. Do not widen the existing cookie path as a shortcut or put session/CSRF tokens in URLs, local storage, build output or logs.

Mutations remain on existing guarded POST handlers until a versioned JSON action contract can preserve every invariant (owner, CSRF, approval state, idempotency, late-click result). Chat across channels is a separate contract: it must use the actual conversation store and pass a cross-surface continuation test. An app client uses its own account-bound session bridge; it does not reuse a console browser cookie.

## Sequence and exit tests

1. Owner-visible HTML Overview and fallback `/console`: desktop/mobile visual pass, empty/failed states, no fake claims. This is the companion patch.
2. Define API schema and source projections from current DO state. Test two owners cannot cross-read, no session yields 401, cursors cannot become latest-state hints, and the JSON excludes secrets, tokens and unnecessary memory. Keep the HTML and JSON views on one projection so status copy cannot drift.
3. Add a branded React shell on a verified deployment and wire read-only Overview, Waiting, Patrol, Memory and Connections. Loading, error and no-data states must be real. Do not attach a button until its mutation path exists and is tested.
4. Wire approval/memory actions with CSRF and late-click receipts; only then join channel conversation, then connect the existing Waldo app using its own authenticated account route. Test from Telegram/chat into dashboard and back to the same owner DO.

Figma pixels and the exact Home copy draft remain inputs for an editorial/visual pass. The current palette/serif posture is provisional, not a claim of exact Figma fidelity.
