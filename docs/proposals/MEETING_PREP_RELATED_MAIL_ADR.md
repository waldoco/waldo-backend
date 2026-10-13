# Proposed ADR: meeting prep reads the owner's mail tied to the meeting

Status: proposed for the orchestrator's review, with the change that implements it. The owner ruled it on 12 Oct 2026, about 21:06Z, in the orchestrator session (`docs/planning/lanes-2026-10-13/README.md`, ruling 3). It should be published in waldo-brain and given a number there; until then, no code cites it by number.

## Problem and decision

Scheduled meeting prep (`channels/event-briefs.ts`, the grounded sweep) sees only calendar fields. So it can't say what the related emails said, which is the brief the owner wants: "an Instinct-style brief that names what the related emails said, the Meet link and the attached docs".

**Decision.** When the grounded sweep prepares an event, it reads a bounded amount of the owner's own mail tied to that event, at that moment. It hands the text to the prep decision as external data.
- The prep decision stays tool-less.
- The sweep does the reads; the model only judges what in them bears on the meeting.

## Limits (each is enforced in code and pinned by a test unless marked otherwise)

1. **Only the owner's mail.** The read uses the same Google client and account the sweep already holds for that owner's calendar. No other account is reached.
2. **Only meetings the owner organized or accepted.**
   - An invite the owner hasn't answered, or answered tentatively, reads no mail. Its title and attendee list were written by someone else, and they choose which of the owner's mail is searched. An attendee could be a bank or an account-security sender.
   - The connector sets `owner_status` (`organizer` or `accepted`) from Google's `organizer.self` and the owner's own attendee response. It's a deterministic authority check, not a judgment.
   - The connector-proxy maps it only for a Worker that asks (`calendar_owner_status` in the signed body), so either deploy order is safe. Prep fails closed: with a proxy that predates the field, it reads no related mail.
   - The field stays out of the prep digest and the card projection, so its arrival never re-preps an event or moves a card prompt.
3. **Only mail tied to that meeting.**
   - The Gmail query is built from the event alone: its title as a quoted subject phrase, and its non-declined attendees' addresses as `from:` and `to:`. At most 10 attendees are used.
   - The owner's own address is left out twice: the calendar mapper drops the attendee Google marks `self`, and the query also drops the connection's recorded address. The recorded address alone isn't enough; it can be `'google'` or an alias.
   - Mail is searched only within the last 30 days.
   - At most 3 threads (the most recent matches), and the newest 2 messages of each. Each body is cut to 1,500 characters after redaction.
   - Gmail returns a thread oldest first, 20 messages a page, so prep reads up to 5 pages (100 messages) to reach the newest two. In a longer thread, the two it reads are messages 99 and 100.
   - [inference, not pinned by a test] The `{…}` OR group combined with a quoted `subject:` phrase, and Gmail's newest-first order, follow Gmail's documented search syntax. Only a live run proves them; the orchestrator's Simulator prep run is that proof.
   - An event with no usable title and no attendees reads no mail.
   - Deciding which retrieved mail is relevant is left to the model, per CLAUDE.md. The query only bounds retrieval.
4. **Read at prep time, within a deadline.**
   - The read happens inside the sweep, between the digest check and the decision, under the same currentness fence (`current()`) as the calendar reads. A test pins the fence that runs right after the read.
   - The read has an 8-second deadline, and never runs past the meeting's start. The Google calls take no signal, so a read past its deadline is abandoned, not cancelled; it's a read, with no effects. The prep then runs on calendar facts.
5. **The mail itself is not stored or logged.**
   - The mail text exists only in the decision's prompt. `event_briefs` stores the event key, start and calendar digest, as before.
   - No log line carries mail content.
   - The prep note may restate what the mail said. The note is the one output, and it's stored like any message Waldo sends the owner: the final outbox, the app transcript and episodes. Under E15 it also goes out as the plain Telegram copy.
   - The existing forget path covers retained prep copies (`test/calendar-prep-review-cancelled-history-proof.test.ts`).
   - Staging traces follow the existing alpha/beta exception: the staging Langfuse project captures model text for opted-in testers. Production never captures text. Prep is no different from a `read_thread` result here.
6. **Verification codes and links stay quarantined; other links don't.**
   - The owner's ruling said codes and links. This narrows "links" to verification links (magic links, reset links), as chat's quarantine already does. Ordinary URLs, a join link included, reach the prompt. **This narrowing needs the owner's sign-off.**
   - Verification artifacts (OTPs, magic links, reset links) are replaced by the source-app marker before anything else touches the text. That includes codes an HTML mail lays out in table cells, glued to their label or one digit per cell.
   - Extraction runs on the full body before the 1,500-character cut, so no artifact can straddle the cut. Prep never relays artifacts.
7. **The health scan applies.**
   - The provider scribes a background decision with its own null taint, which skips the free-text health scan. So the sweep scribes the mail itself first: `sanitise` with `source_taint: 'external'` at `internal_context`, as a `read_thread` result gets.
   - A scribe refusal drops the mail and keeps the calendar-only prep.
   - The scribe's canary check is inert on this path. It trips on a session's own tokens coming back, and the read runs outside any turn: the turn that decides the prep keeps its tokens to itself. The scribe still requires three tokens, so the sweep passes fresh ones. The checks this call is for are health, secrets and PII.

**Failure is honest.**
- **A connection without mail access** (Gmail's `ACCESS_TOKEN_SCOPE_INSUFFICIENT`) gets exactly the calendar-only prompt, with no mail line.
- **Any other failure,** a network drop or a read past its deadline included, still runs the prep on calendar facts, and the prompt says related mail could not be read.
- Related mail only enriches a note that must reach the owner before the meeting. So its failure never costs the owner the note.
- The sweep's currentness check runs right after the read, so a cancelled or stale run still stops.
- The prompt never says "no related mail" unless the search ran and found none.

**Injection.** Third-party mail can now shape an unprompted message to the owner.
- Ordinary URLs in mail are not quarantined; only verification artifacts are.
- This is the same class as invite descriptions, which prep already reads.
- The decision has no tools and no effects. Its prompt marks the mail as external data, never instructions. Its output is only a note to the owner.
- Only a meeting the owner organized or accepted chooses which mail is read (limit 2).
- **Open, in another lane:** prep notes go to Telegram with link previews on, so a URL in the note could be fetched by Telegram's previewer without a click. Turning previews off for prep sends is in the owner DO; it's asked on #1103.

**Observability.** Every read failure maps to "unavailable", and nothing is logged. A broken query would therefore not show up in hop logs. A content-free `prep_related_mail` code hop (status and counts only) belongs in the owner DO, which is another lane's file; it's requested on #1103.

**Switch.** It runs only where grounded prep runs: `CALENDAR_GROUNDED_PREP`, which is `"1"` on staging and `"0"` in production. There's no new flag and no new env var.

## Alternatives

- **Give the prep decision read-only mail tools.**
  - Rejected for now. It needs the owner DO's job tools changed (another lane's file).
  - It turns a bounded read into an open-ended one: the model chooses queries and the number of reads.
  - It's slower: prep already took about 2 minutes on staging.
- **Store a per-meeting mail summary ahead of time.** Rejected: it stores mail-derived text, which the ruling forbids.
- **Search by title only.** Rejected: invites and threads often don't share the event title; attendees are the stronger tie.

## Rollback

Revert the change. Prep goes back to calendar fields only. Nothing was stored.
