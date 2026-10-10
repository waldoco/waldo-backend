# Calendar discovery (`query_calendar` operation `list_calendars`)

Why: the agent could read only the primary calendar. Weight (the day's demand), the Brief and conflict checks undercount when the owner also has work, shared or family calendars. `calendar.events` lets the connector read a calendar whose id it already knows (`calendar_id` on `query_calendar`), but nothing could name the owner's other calendars.

What changed (re-cut of the discovery half of #998):
- New feature `calendar_list` with scope `calendar.calendarlist.readonly`. Compatible broader scopes `calendar.calendarlist`, `calendar.readonly` and `calendar` also satisfy it. A legacy null-scope grant and an events-only grant do not.
- The one combined consent now asks for that scope. An owner who connected earlier is asked to connect again once; the tool answers with the typed connect intent (`feature: calendar_list`), not a link in text. Consent stays one combined dialog (owner ruling of 24 September), so there is no per-feature consent path.
- `query_calendar` takes `operation: list_calendars` (with optional `include_hidden`, `limit`, `page_token`). It returns id, name, time zone, access role, and whether the calendar is primary, selected or hidden, with coverage that is never `complete` on a continuation. Event queries are unchanged.
- The connector-proxy Edge Function refuses `calendarListsPage` without the scope. It treats the call as a read: no intent, no ledger claim.

Not changed: events are still read one calendar at a time. Reading across every calendar (Weight, the Brief) is a consumer that comes after this, and Calendar write verification is separate.

Deploy notes: the Edge Function must be redeployed for proxy installs to accept the new method; the runtime must be deployed for the tool. The Google Cloud OAuth consent screen may need the scope declared; that was not checked (the app is unverified, test users only).

Evidence is in the pull request. NOT RUN: a live Calendar list call, or a real re-consent. Prove one `list_calendars` with a real owner on staging, after the owner reconnects, before building on it.
