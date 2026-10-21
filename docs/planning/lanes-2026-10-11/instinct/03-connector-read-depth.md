# Brief 03: connector read depth (Calendar across calendars, Gmail full bodies)

**Branch:** `instinct/connector-read-depth`. A draft PR to `beta-mvp`.

## Why

**Calendar.** Waldo's Brief, Prep and Weight score undercount the owner's day when calendar reads miss secondary calendars, attendees or locations.

**Gmail.** Long threads and long bodies are truncated. Repository rule (CLAUDE.md): give the model full mail bodies and long threads within the owner's authorization; "paginate, chunk or retrieve" instead of refusing or cutting for size.

These are reads only. Writes (Gmail triage, Drive writes, Calendar writes beyond primary) go through the approvals ledger and wait for a separate slice.

## Step 1: audit and write the gap table first

Some depth landed after the ledger was written. On `beta-mvp`, `packages/runtime/src/connectors/google.ts` already has `calendarListsPage` (~420), per-calendar events (`calendars/{id}/events`, ~482 and ~603) and task list paging (`taskListsPage`, `allTasksPage`).

Before changing anything, put a table in the PR body:

| Capability | Status | Evidence |
|---|---|---|
| … | present / partial / missing | file:line |

Rows to cover:
- Calendar: which calendars `query_calendar` reads by default; attendees, location and conference link in the output; declined and cancelled handling; time-zone handling.
- Gmail: the body size cap in `read_thread` and `get_communication`; behaviour on long threads; attachments listed (name, size, type) vs fetched.
- Tasks: all lists in `get_tasks`.

Fix only rows marked partial or missing.

## Step 2: what to build (only the gaps)

**Calendar**
- `query_calendar` can read across the owner's selected (non-hidden) calendars, fanning out with a bounded concurrency and a per-call event cap.
- Each event carries:
  - `calendar_id` and the calendar name;
  - attendees (count, plus names and emails within the cap);
  - location;
  - the conference link presence.
- Results stay ordered by start time. The tool says when a cap truncated results, and how to page for more.

**Gmail**
- Replace hard truncation with paging or chunking, in two parts.
- The first call returns the body up to a bounded chunk plus a cursor. The model can ask for the next chunk.
- Threads return messages newest-first, with a cursor for older ones.
- Attachments are listed with metadata. Fetching attachment content is out of scope unless a reader already exists. If one does, note it in the PR.

**Tasks**
- Only if the audit shows a gap.

## Where things go

- `packages/runtime/src/connectors/google.ts`, `packages/runtime/src/tools/live/google.ts`, `packages/runtime/src/tools/live/tasks.ts`.
- Additive arg changes in `packages/contracts/src/tools/schemas/reads.ts`. Use optional fields only. Existing calls must parse unchanged.
- **Do not touch** the hot files listed in `00-README.md`, the approvals path, or `connector-proxy`.

## Behaviour that must hold

- All Google calls go through the existing proxy client (`google.client` → `googleProxy(...).client(do_name, connection_id)`). Do not add a new token path.
- Bounded work:
  - a cap on calendars fanned out;
  - a cap on events and on bytes per chunk;
  - timeouts consistent with the current code.
- Never log message bodies, subjects, addresses or event titles.
- Existing tests keep passing unchanged, unless one asserted the old truncation. Say which, and why, in the PR.

## Tests (red first)

- A Zod valid and an invalid test for every new or changed argument.
- **Calendar:**
  - two calendars merge in start order;
  - a hidden calendar is skipped;
  - the attendee cap holds;
  - a declined event is excluded by default;
  - a page token continues correctly.
- **Gmail:**
  - a 200 KB synthetic body returns chunk 1 plus a cursor, and chunk 2 continues without overlap or gap;
  - a 60-message synthetic thread pages;
  - attachment metadata is listed.
- **Failure paths:** a partial fan-out failure (one calendar 403s) returns the others plus a typed note; a timeout; a 429.

## Done means

- A draft PR with the gap table, the changes and the tests.
- The gate table at the head SHA.
- A list of the write capabilities you saw missing, left for the approvals slice.
