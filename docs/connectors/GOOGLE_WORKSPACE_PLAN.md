# Google Workspace for the agent

The owner's ruling: a working agent and the app build come first. Publishing the Google app and verification come later. Waldo's typed Google tools are the production path. Google's Workspace MCP servers are a Developer Preview, so Waldo uses them for reads only, on staging first.

## Production path: Waldo's typed Google tools

Every Google change goes through Waldo's own tools (`tools/live/google.ts` behind the connector proxy). Each one carries:

- **The approval desk.** The owner sees a card and taps Do it or Not now. The model cannot create an approval.
- **An exact preview.** The card shows the payload that will be sent: recipient, subject and body, or the event fields. The approval is bound to that payload.
- **Readback.** After the provider call, Waldo reads the result back. "Done" appears only once the readback confirms it; an unconfirmed effect stays "Unconfirmed".
- **A receipt** in the reply and the trail.
- **Undo** for calendar changes, for a short window after the change: the event Waldo created is cancelled, or the moved event goes back.

These tools work with personal @gmail.com accounts. The proxy holds the refresh token at the edge, so the runtime never sees it.

**Scopes in code** (`GOOGLE_FEATURE_SCOPES` in `connectors/google.ts`), asked for in one consent:

| Feature | Scopes |
|---|---|
| calendar | `calendar.events` |
| availability | `calendar.events.freebusy` |
| calendar_list | `calendar.calendarlist.readonly` |
| mail | `gmail.readonly`, `gmail.send`, `gmail.compose` |
| tasks | `tasks` |
| drive, docs, sheets, slides | `drive.readonly`, plus `documents.readonly`, `spreadsheets.readonly` and `presentations.readonly` |

Mail reads (search, new mail, threads) run on `gmail.readonly`. Sending runs on `gmail.send` and drafts on `gmail.compose`. The edge checks those two scopes by name before a send or a draft.

## MCP reads on staging

The catalogue in `connectors/google-mcp.ts` names each Google MCP server and the only tools Waldo may call on it. The runtime and the connector-proxy edge both read the same list.

| Server | Reads allowed |
|---|---|
| Gmail (`gmailmcp.googleapis.com/mcp/v1`) | `search_threads`, `get_thread`, `get_message`, `list_drafts`, `list_labels` |
| Calendar (`calendarmcp.googleapis.com/mcp/v1`) | `list_events`, `get_event`, `list_calendars`, `search_events`, `suggest_time` |
| Drive (`drivemcp.googleapis.com/mcp/v1`) | `list_recent_files`, `search_files`, `get_file_metadata` (metadata only; file text goes through the typed Drive read) |

**What MCP adds over the typed tools:**
- `suggest_time` for finding free time;
- Calendar `search_events`;
- Gmail label listing.

The cross-corpus Workspace server, and the Docs, Sheets and Slides servers, would add search across products and document reading. Each needs its own catalogue entry, with tool names checked against Google's tool reference.

**Safety by construction:**
- Any MCP server on a Google host must be in the catalogue.
- A write tool (`create_draft`, `label_*`, `unlabel_*`, `create_event`, `update_event`, `delete_event`, `respond_to_event`) is refused with the fixed code `google_mcp_read_only`. So is any tool or server the catalogue does not list. The refusal happens before auth, before any network call and before the approval desk.
- Deploy config can narrow a server's tools but never add one.
- Reads run on the edge's non-storing rail: no ledger row and no stored result.

**Not available:** if Google answers 403 or 404 to a grant that already holds the scopes, the model reads `google_mcp_unavailable` and falls back to the typed tools. This is how a preview that isn't open to the account shows up. It never appears as a connect card or a transient error.

**Open unknowns:**
- Whether the preview serves personal @gmail.com accounts. Gmail's setup guide requires membership in the Workspace Developer Preview Program.
- Which scopes the Calendar MCP server checks for `list_calendars` and `suggest_time`.

**Production:** no Google MCP server is configured. A test pins that production config names no MCP server and keeps button-free reads off.

## When a connection breaks

The OAuth app is in Testing, so Google expires refresh tokens after 7 days. When that happens:

1. The next token refresh fails with `invalid_grant`.
2. The proxy marks the connection `google_refresh_failed`.
3. The tool tells the model "The Google grant expired.", and the owner gets a reconnect button in chat.

The model never retypes a link. Reconnecting stores a new grant on the same connection, and the agent carries on. Publishing the app ends the 7-day expiry.

## Publish later: the checklist

Run these when the owner says so:

1. **Branding:** add the home page, privacy policy and terms links, and make heywaldo.in an authorized domain. Adding a logo forces verification.
2. **Privacy policy:** describe how Waldo uses Google data, including Gmail, and add a Limited Use statement.
3. **Ownership and contact:** prove ownership of heywaldo.in in Search Console, use a company support contact, and consider a separate production project.
4. **Trim the scopes** to what the shipped tools use.
5. **Verification:** sensitive scopes need a written justification and a demo video. Restricted scopes (`gmail.readonly` is one) also need the yearly security assessment.

## Event-driven wakes

Gmail `users.watch` through Pub/Sub, and Calendar `events.watch`, would wake the owner object instead of waiting for the 10-minute poll. The poll stays as the fallback. The design is posted on the coordination issue before any code.
