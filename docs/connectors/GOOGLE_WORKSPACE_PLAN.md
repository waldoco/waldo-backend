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
| Gmail (`gmailmcp.googleapis.com/mcp/v1`) | `search_threads`, `get_thread`, `get_message`, `list_drafts`, `get_draft`, `list_labels` |
| Calendar (`calendarmcp.googleapis.com/mcp/v1`) | `list_events`, `get_event`, `list_calendars`, `search_events`, `suggest_time` |
| Drive (`drivemcp.googleapis.com/mcp/v1`) | `list_recent_files`, `search_files`, `get_file_metadata` (metadata only; file text goes through the typed Drive read) |
| Docs (`docsmcp.googleapis.com/mcp/v1`) | `read_doc` |
| Sheets (`sheetsmcp.googleapis.com/mcp/v1`) | `get_spreadsheet`, `get_values` |
| Slides (`slidesmcp.googleapis.com/mcp/v1`) | `read_presentation`, `read_slide_page` |

Tool names and read-only hints come from each server's own `tools/list`.

**What MCP adds over the typed tools:**
- `suggest_time` for finding free time;
- Calendar `search_events` (primary calendar only);
- Gmail label and draft reads;
- Sheets and Slides content, and Docs structure.

**Not in the catalogue:**
- **People** (`people.googleapis.com/mcp/v1`: `get_user_profile`, `search_contacts`, `search_directory_people`): Waldo does not ask for a contacts scope yet.
- **Cross-corpus Workspace** (`workspacemcp.googleapis.com/mcp/v1`: `search_corpus` across Drive, Gmail, Calendar and Chat): its scope needs are unverified.
- **Chat:** Google's Chat API serves Workspace accounts only.

**What the MCP servers cannot do at all:**
- Gmail: no send, no attachments, no filters.
- Calendar: no free/busy, no recurring instances, no move.
- Drive: no share, trash or move.
- Tasks, Keep, Meet and Forms: no server at all.

So the MCP servers can never be the complete path, even for reads.

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

## Gap list: what Waldo's own Google tools still need

MCP stays an optional read accelerator on staging. Every capability below belongs in Waldo's own typed tools, which work for personal accounts, carry the approval desk, readback and receipts, and don't depend on a preview.

The list is built from three sources:
- the current tools in source;
- Google's API discovery documents and the managed MCP servers' `tools/list`;
- the tool sets of other harnesses: `taylorwilsdon/google_workspace_mcp`, `googleworkspace/cli`, and Composio's Gmail and Google toolkits. Claude's Workspace connector was read from its public help page, so it counts as an advertised claim.

None of this is evidence of parity with any product. Parity needs the same consented scenario run on both.

**Approval rule for the new writes:**
- **Owner card first:** anything that sends, shares, deletes or can't be undone. That's mail send, reply and forward; event invites that email guests; RSVP; Drive share; Drive and Gmail permanent delete (never built).
- **Receipt and undo instead of a card:** reversible personal changes. That's archive, mark read, labels, and trash with untrash (Gmail keeps trash for 30 days). These follow the "full capability by default" rule: a guard needs a harm it prevents.

**Owners:** `tools/live/google.ts`, `connectors/google.ts` and `approvals.ts` belong to the Connectors lane. Each row is one end-to-end slice in that lane: contract, client method, edge method allowlist, desk card where it applies, tests.

### Fix first: existing tools that are poorly engineered

| Gap | Where | Fix |
|---|---|---|
| Reply-all is impossible: the thread reader returns no To or Cc, so the model guesses recipients | `ThreadMessage` (`connectors/google.ts:182`) | Return To, Cc and Reply-To per message. Derive reply-all recipients from the thread, minus the owner's addresses. |
| Non-ASCII subjects go out unencoded | `connectors/google.ts:216` | RFC 2047 encode the Subject. |
| Mail goes out as `text/plain` only, and the Markdown body is sent raw | `connectors/google.ts:223`, `tools/live/google.ts:338` | Send `multipart/alternative` (text plus rendered HTML). |
| Event writes always hit the primary calendar, though reads take any `calendar_id` | `connectors/google.ts:530`, `:597` | Take `calendar_id` on create, move and cancel. Etag and readback stay per calendar. |
| A new event carries only title and times | `connectors/google.ts:602` | Add attendees, description, location, reminders, a Meet link (`conferenceData` with `conferenceDataVersion=1`) and an IANA `timeZone`. |
| `sendUpdates` is never set, so guests are notified or not by Google's default | `connectors/google.ts:601` | Make it an explicit desk field the owner sees ("email the 3 guests"). |
| Recurring events: moves act on one instance only, with no choice of scope | `connectors/google.ts:797` | Offer "this event" (an instance) or "the series" (the recurring master), shown on the card. |
| Mail list fetches metadata one request per message | `connectors/google.ts:541` | Batch the metadata reads. |
| `read_thread` re-fetches the whole thread for every page | `connectors/google.ts:548`, `:560` | Fetch once and cursor locally, or use `messages.get` per page. |
| Drive search is name-only, own-drive only, 6 fields | `connectors/drive-rest.ts:84`, `:38` | `fullText contains`, shared drives (`corpora=allDrives`), and `webViewLink` and owners in the result. |
| Drive content reads Docs and plain text only; Sheets and Slides are rejected | `connectors/drive-rest.ts:106` | Export Sheets as CSV and Slides as text. PDFs and Office files get text extraction, with an explicit "could not extract" when it fails. |
| Truncation is silent | `connectors/google.ts:335`, `connectors/drive-rest.ts:114` | Add a fixed "content truncated" marker, as other harnesses do, so the model knows it saw part of the item. |
| `write_sheet_cell`, `propose_schedule` and `search_connector` are permitted but have no handler | `packages/contracts/src/tools/permissions.ts:49-51` | Build them, or remove them from the permission table (post-mvp-cleanup). |
| Mail and Tasks reads have no per-method scope check at the edge | `connector-proxy/index.ts:154-158` | Add the check, so a missing scope reads as `insufficient scopes` before any Google call. |

### Missing reads

| Product | Read | Google method | Scope (already held?) |
|---|---|---|---|
| Gmail | Attachment content as text (PDF, Office, images by name only), size-capped | `users.messages.attachments.get` | `gmail.readonly` (held) |
| Gmail | Drafts: list and get | `users.drafts.list`, `drafts.get` | `gmail.readonly` (held) |
| Gmail | Labels list | `users.labels.list` | held |
| Gmail | Incremental sync since the last seen point (feeds event-driven wakes) | `users.history.list` | held |
| Gmail | Send-as aliases and signature, so replies come from the right address | `users.settings.sendAs.list` | held (readonly covers settings reads) |
| Calendar | Events across all calendars in one call | `events.list` per `calendarList` entry | held |
| Calendar | Recurring series with RRULE, and instances | `events.get` on the master, `events.instances` | held |
| Calendar | Conflicts shown in the desk preview (data for the model, not a fixed rule) | `freebusy.query` | held |
| Contacts | Resolve a name to an email, including people the owner has mailed | `people.searchContacts`, `otherContacts.search` | **new:** `contacts.readonly`, `contacts.other.readonly` |
| Sheets | Range read, sheet names | `spreadsheets.values.get`, `spreadsheets.get` | `spreadsheets.readonly` (held) |
| Slides | Slide text | `presentations.get` | `presentations.readonly` (held) |
| Docs | Structure and comments | `documents.get`, Drive `comments.list` | held |
| Tasks | All lists in one view | `tasks.list` per list | held |

### Missing writes

| Product | Write | Google method | Approval | Scope (already held?) |
|---|---|---|---|---|
| Gmail | Reply and reply-all in thread (In-Reply-To and References derived from the thread, no subject override) | `messages.send` with `threadId` | card | `gmail.send` (held) |
| Gmail | Forward, with attachments | `messages.send` | card | held |
| Gmail | Send an existing draft; update and delete a draft | `drafts.send`, `drafts.update`, `drafts.delete` | card for send | `gmail.compose` (held) |
| Gmail | Archive, mark read or unread, star, label and unlabel, singly or in batches | `messages.modify`, `batchModify`, `threads.modify` | receipt and undo | **new:** `gmail.modify` (restricted, same class as `gmail.readonly`, which it can replace) |
| Gmail | Trash and untrash | `messages.trash`, `untrash` | receipt and undo | `gmail.modify` |
| Gmail | Create a label | `labels.create` | receipt | `gmail.modify` or `gmail.labels` |
| Gmail | Filters and vacation reply | `settings.filters.create`, `settings.updateVacation` | card | **new:** `gmail.settings.basic` |
| Calendar | RSVP with a comment | `events.patch` on the owner's attendee `responseStatus` | card | `calendar.events` (held) |
| Calendar | Add or remove guests, edit details | `events.patch` | card when guests are emailed | held |
| Calendar | Move to another calendar; quick add from text | `events.move`, `events.quickAdd` | card | held |
| Calendar | Out-of-office and focus time | `events.insert` with `eventType` | card | held |
| Tasks | Delete, move, subtasks, new list | `tasks.delete`, `tasks.move` (parent), `tasklists.insert` | receipt and undo for delete | `tasks` (held) |
| Drive | Create a Doc, Sheet or file from text, or upload one | `files.create` | receipt | **new:** `drive.file` (non-sensitive: covers only files Waldo creates or the owner picks) |
| Docs | Insert, replace or append text in a Doc Waldo created or the owner picked, located by a heading or text anchor rather than raw indices | `documents.batchUpdate` | card for files Waldo did not create | `drive.file` |
| Sheets | Append rows, update a range (`USER_ENTERED`) | `values.append`, `values.update` | card for files Waldo did not create | `drive.file` |
| Drive | Share, move, rename, trash existing files | `permissions.create`, `files.update` | card | **new:** `drive` (restricted). Defer until verification. |

**Not for personal accounts:** Chat, Keep and the org directory need Workspace accounts. Meet transcripts and recordings likely need a paid edition [inference].

**Scope plan:**
- Replace `gmail.readonly` with `gmail.modify`.
- Add `contacts.readonly`, `contacts.other.readonly` and `drive.file`.
- Keep `drive.readonly` for reading the owner's existing files.
- Leave `drive` and `gmail.settings.basic` until the publish checklist is done.

Every new scope means existing testers reconnect once.

**Engineering patterns to copy** (observed in the other harnesses' code):
- retry reads only, never writes;
- return web links and thread IDs with every result;
- explicit truncation markers;
- an IANA time zone, so Google handles daylight saving;
- `USER_ENTERED` for Sheets writes;
- Docs edits located by anchors resolved at execution time.

**Pitfalls to avoid:**
- defaulting `sendUpdates` to "all";
- creating events without showing conflicts;
- Gmail label tools that take display names instead of label IDs;
- full-draft replace on update losing fields.

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
