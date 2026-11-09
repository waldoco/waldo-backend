# Meeting prep sources: Granola, Wispr Flow, Google

Read 30 Oct 2026 from primary sources only. Each claim names the page it came from. `[inference]` marks a conclusion of ours. "Not found" means the pages read do not say it.

## What this changes in the build

- **The brief follows Granola's shape.** It covers who is attending, the last thread with them, linked documents, open loops and what to have ready. Silence is a judgment: Granola itself shows nothing rather than padding a brief.
- **Waldo reads only what it can reach today.**
  - The calendar event: description, attendees, attachments.
  - The owner's Gmail, by attendee and subject.
  - Linked Drive files, by the attachment's `fileId`.
  - Google Tasks.
  - The owner's memory.
- **Granola over MCP is a follow-up.** The docs publish tool names but no input schemas. A harness-built call with fixed arguments cannot be written safely without them. Letting the model call MCP from a prep turn would cross the egress boundary that machine jobs keep (`MACHINE_READER`).
- **Wispr Flow adds nothing for prep.** Its MCP cannot read dictation history, and its API is speech-to-text only.
- **The Workspace Events API and Meet REST are not used.** Both are Workspace-only as far as the docs say, and they serve post-meeting notes, not prep.

## Granola

**How its notes are built**
- Enhanced notes combine three inputs: "the transcription captured during the meeting", the user's raw notes, and "information from the calendar event". https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes.md
- Typed notes "are seen as important details to include". https://docs.granola.ai/help-center/taking-notes/taking-notes-in-granola.md
- Templates set the structure. https://docs.granola.ai/help-center/taking-notes/customise-notes-with-templates.md

**Pre-meeting briefs**
- "Briefs are gathered for you overnight", "usually 2-3 bullet points". https://docs.granola.ai/help-center/taking-notes/pre-meeting-briefs.md
- Sources (same page):
  - previous Granola notes "with the same people or company";
  - shared workspace notes;
  - the wider web, including LinkedIn;
  - the calendar event;
  - Gmail, if connected.
- Limits (same page):
  - Business and Enterprise plans only, with Google Calendar connected.
  - Only "meetings with people outside your own organization".
  - Granola would "rather show nothing than pad the brief with filler".

**MCP server**
- Endpoint `https://mcp.granola.ai/mcp`, over "Streamable HTTP transport". Auth is browser OAuth: "there is no API key or service account access method for MCP". https://docs.granola.ai/help-center/sharing/integrations/mcp.md
- Tools (same page): `query_granola_meetings`, `list_meeting_folders` (paid), `list_meetings` (returns ID, title, date and attendees), `get_meetings` (adds private and summarized notes), `get_meeting_attachment`, `get_meeting_transcript` (paid), `get_account_info`, `switch_workspace`, `sign_out`.
- No input schemas are documented. Rate limits "average around 100 requests per minute".
- The free plan sees notes from the last 30 days only (same page).

**REST API**
- Base `https://public-api.granola.ai/v1`, with a `grn_` bearer key. Business or Enterprise plans only. https://docs.granola.ai/introduction.md and https://docs.granola.ai/help-center/sharing/integrations/granola-api.md
- `POST /v1/notes/search` filters by `participant` (name, email, company or domain from calendar data) and by date. https://docs.granola.ai/api-reference/search-notes.md
  - "Private notes and transcripts are not searched."
  - "Search coverage depends on indexing."
- Rate limits: a burst of 25 requests per 5 seconds, then 5 per second. https://docs.granola.ai/introduction.md
- Webhooks: `note.generated`, `note.edited` and `note.access_granted`, with no note content in the payload. https://docs.granola.ai/webhooks.md

`[inference]` The API key path would let Waldo search prior notes by attendee email deterministically. But it needs a per-owner secret stored in the vault, a Business plan, and its own egress and DPA review. The MCP path needs the live `tools/list` schemas, read when the owner connects, before arguments can be fixed in code.

## Wispr Flow

- **MCP server: read-only, Notetaker data only.** "Access is read-only". Clients cannot "read dictation history or Notetaker chat history". https://docs.wisprflow.ai/articles/9551372685-connect-an-mcp-client-to-wispr-flow-remote-mcp-server
  - Readable: "meeting summaries, notes, transcripts and attendees", plus calendar events.
  - Auth is browser sign-in, with no API key.
  - Tool names are not listed.
- **Public API: speech-to-text only**, over a WebSocket or REST at `platform-api.wisprflow.ai`. No user data. https://api-docs.wisprflow.ai/introduction.md
- **Webhooks:** not found.

## Google

**Calendar Events** (https://developers.google.com/workspace/calendar/api/v3/reference/events)
- `description` can contain HTML.
- `attendees[]` carries `email`, `displayName`, `responseStatus`, `organizer`, `self` and `optional`.
- `attachments[]` has at most 25 entries. `fileId` is "the ID of the corresponding Files resource entry in the Drive API".
- `eventType` includes `fromGmail` and `focusTime`.
- `recurringEventId` and `originalStartTime` identify an instance even after it moves.
- `supportsAttachments` is a write-side flag. It is not listed on `events.get` or `events.list`.

**Calendar push** (https://developers.google.com/workspace/calendar/api/guides/push)
- Notifications "do not include a message body". `X-Goog-Resource-State` is `sync`, `exists` or `not_exists`.
- Channels default to 7 days. "There's no automatic way to renew a notification channel."
- Changes are read with `syncToken`. A `410` means a full resync. https://developers.google.com/workspace/calendar/api/guides/sync

**Gmail search**
- `q` "supports most of the same advanced search syntax" as the Gmail UI. https://developers.google.com/workspace/gmail/api/guides/filtering
  - No thread-wide search.
  - Dates are read as PST unless given as epoch seconds.
- Operators: `from:`, `to:`, `cc:`, `subject:`, `{...}` for OR, `newer_than:`. https://support.google.com/mail/answer/7190
- Push via `users.watch` must be re-armed "at least once every 7 days", at most one event per second per user. https://developers.google.com/workspace/gmail/api/guides/push

**Drive**
- Docs are read with `files.export`, capped at 10 MB, to `text/plain` or `text/markdown`. https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export
- Search supports `'x' in writers` and `fullText contains`. https://developers.google.com/workspace/drive/api/guides/search-files
- `drive.file` covers only files the app opened or was given. `drive.readonly` is Restricted. https://developers.google.com/workspace/drive/api/guides/api-specific-auth

**Workspace Events and Meet**
- Subscriptions cover Chat, Drive and Meet. Each subscription "can only monitor one resource". https://developers.google.com/workspace/events
- Calendar invitees who are not the owner get only `conference.v2.started` and `transcript.v2.fileGenerated`. https://developers.google.com/workspace/events/guides/events-meet
- The Meet tutorial's prerequisite is "A Google Workspace account". https://developers.google.com/workspace/meet/api/guides/tutorial-events-python
- Transcript entries "are deleted 30 days after the conference ends". https://developers.google.com/workspace/meet/api/guides/artifacts
- Gemini meeting notes are "automatically attached to the Google Calendar event". https://support.google.com/meet/answer/14754931
  - `[inference]` An earlier meeting's Gemini notes can reach a later brief through the event's attachments and Drive.
