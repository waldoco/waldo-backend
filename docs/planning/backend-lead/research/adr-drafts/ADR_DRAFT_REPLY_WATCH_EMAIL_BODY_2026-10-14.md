> **UNVERIFIED DRAFT (research stage only).** Produced 14 Oct 2026 by the lead's decision workflow `wf_d8922d1d-861` at `beta-mvp` `e5c022ef`. The two adversarial verifiers and the reviser did not run because the session limit was reached. Verify against source before relying on it. Not accepted: the owner decides.

# ADR draft: the reply watch reads new messages on threads the owner sent through Waldo

Status: Proposed, 14 Oct 2026. Not approved. On the owner's approval it becomes an ADR in Brain under the next free number. The first build PR carries that publication and regenerates `docs/foundation/accepted-adrs.json`.

Author: backend decision packet G1. Source read at `beta-mvp` `e5c022ef`.

## 1. Context

**The gap.** An approved email ends at `done` once Gmail's readback proves the send (`channels/approvals.ts:595-735`, `done` at `:694-695`). Nothing follows. No loop or watch is created, and nothing reads the thread again. A reply never closes the follow-up. A bounce or an auto-reply never reaches the owner.

**Why the existing mail paths do not cover it.**
- The update lane reads `in:inbox category:primary` since the last sweep, as From, Subject and snippet (`connectors/google.ts:800-801`, `channels/update-cards.ts:79-92`). It is inbox-wide. It misses replies filed outside Primary or outside the inbox. It has no link to the approval. It stores mail detail in `update_cards` and traces it in staging (`update-cards.ts:46-49`, `owner-do.ts:3293`).
- A mail-sourced loop needs an `observed_mail` row from that lane. `open_loop` refuses an unobserved source (`channels/loops.ts:22-27`), and a sent thread is never observed.
- Full bodies reach the model only through `read_thread`, on request in a turn, with the E1 artifact quarantine, capped at 32,000 characters (`tools/live/google.ts:118-151, 306-318`; `connectors/google.ts:436-458`).
- Gmail push (#1154, #1215) only pulls the sweep forward. The watch covers the INBOX label only (`connectors/google-push.ts:177`, `channels/gmail-push.ts:4-5`, `channels/owner-do.ts:1282-1290`).

**Why an ADR.** CLAUDE.md requires explicit bounded contract/ADR review for email-body processing. The reply watch reads a third party's message without a turn asking for it. Owner ruling 7 (10 Oct) names the reply watch as a place where push latency is allowed.

**Reference.** RFC 3834 defines `Auto-Submitted: auto-replied` for automatic responses. RFC 3464 defines delivery status notifications inside `multipart/report; report-type=delivery-status`. Both are evidence the model can read. Neither is reliable alone, because many auto-replies omit the header [inference]. Google's Limited Use policy allows restricted-scope data only for prominent user-facing features, so the watch must be visible to the owner.

## 2. Decision

**A reply watch.** Waldo watches one thread until a deadline when two things are true: the owner approves an email whose card says Waldo will watch for a reply, and Gmail confirms the send. New messages on that thread are read once, judged by the model, and dropped. Only the verdict is kept. Waldo tells the owner and proposes the next step. It never sends on its own.

### 2.1 What is read

- Only new messages on a thread that meets all three conditions: the owner sent it through Waldo; the `email_send` approval ended `done` with verified readback; and the approved payload carried `await_reply`. An `uncertain` or `failed` send gets no watch.
- "New" means a message in that thread, after the sent copy's internal date, whose Gmail id the watch has not seen.
- The owner's own later messages (Gmail label `SENT`) are recorded as origin `owner`. Their bodies are not read and no model call is made. The label is a provider fact, not a judgment.
- Other new messages are read with a fixed header list and a body capped at 8,000 characters, after the E1 artifact quarantine, with a `truncated` marker. Attachments are not read and their names are not passed.
- Only the account that sent the mail is read. One active watch per thread: a later approved send with `await_reply` on the same thread supersedes the earlier watch.

### 2.2 When

- Every update sweep (10 minutes) checks due watches. A verified Gmail push pulls that sweep forward, as today. Push is the latency path. The sweep is the floor, and it also catches replies that skip the inbox.
- Each wake does a metadata-only thread read (`threads.get`, `format=metadata`) per watch. A body is fetched (`messages.get`) only for a new message that is not the owner's own.
- Caps:
  - at most 25 active watches per owner;
  - at most 10 watches checked per wake, least recently checked first;
  - at most 3 new messages judged per watch per wake.
- A send that would need a 26th watch is proposed without one, and the model is told why.

### 2.3 What is stored

Two tables live in the owner object. The new reply-watch book (`channels/reply-watch.ts`) is their one writer.

- `reply_watches`:
  - links: `id`, `approval_id` (unique), `loop_id`, `connection_id`, `thread_id`, `sent_message_id`;
  - times: `sent_at`, `await_until`, `ends_at`, `last_checked_at`;
  - state: `status` (`watching`, `ended`), `ended_reason` (`answered`, `expired`, `superseded`, `loop_closed`, `forgotten`, `disconnected`, `grant_lost`), `check_failures`, `deadline_noticed`;
  - `waiting_ref`: the C7 item, null until C7 exists.
- `reply_watch_messages`: `watch_id`, `message_id` (Gmail id), `fingerprint`, `internal_at`, `origin` (`owner`, `other`), `verdict`, `attempts`, `judged_at`, `noticed`.
- `fingerprint` is SHA-256 over `reply-watch.v1`, the watch id, the Gmail message id and its internal date. It is the idempotency key for the judgment and the notice. It is content-free by construction.
- Never stored: the body, the snippet, the subject, the sender, any header value, or the model's reasoning. The `waiting_for` line and the deadline live in the approved ledger payload. The owner's approval wrote them, not the watch.
- Retention: message rows are deleted 7 days after the watch ends. The watch row is deleted 30 days after it ends.

### 2.4 How the body is treated

- The body is external, tainted content (taint `external`). It may inform the model's judgment. It is never an instruction. The judgment call has no tools.
- It goes in delimiters in the user message, never in the system prompt, through the Scribe, like any external mail read.
- The judgment call carries only:
  - the approved `waiting_for` line;
  - the subject and recipients from the ledger row;
  - the verdicts already recorded on this watch;
  - the new messages' headers and capped bodies.
- It carries no memory, no other mail and no health context. The owner's health never enters this tainted path.
- Nothing is stored (2.3) and nothing goes to logs. The model-call purpose `reply_watch` is metadata-only in every environment (`channels/owner-turn.ts:255`), so neither input nor output reaches a trace, in staging either. The staging capture ruling covers testers' own text, and a correspondent never opted in. Production never captures text anyway (`observability/trace-privacy.ts:65-66`).
- The body never reaches memory, the nightly pass, episodes, R2, browser jobs, drafts or any third-party send.

### 2.5 Who decides

- **The model.** One call per watch per wake, with structured output validated by a contract schema:
  - `verdict`, one of:
    - `answered`: a person replied, and it answers what the owner was waiting for;
    - `replied_open`: a person replied, and the ask is still open;
    - `auto_reply`;
    - `bounce`: some or all recipients did not get the mail;
    - `other`;
    - `unclear`;
  - `notice`: Waldo's own note to the owner, one or two sentences, no quoting, or null;
  - `proposal`: the next step Waldo offers, or null.
- **Schema rule** (validation, not judgment): `answered` and `bounce` require a `notice`, so a closure or a failed delivery is never silent.
- Headers such as `Auto-Submitted`, a `multipart/report` content type and `X-Failed-Recipients` are passed as evidence. No regex decides the verdict.
- An invalid or failed output counts as an attempt. After 3 attempts the message is `unclear`, and the owner is told once that a new message arrived on the thread.

### 2.6 Expiry and deadline

- The model sets `await_reply.until` at proposal time, 1 to 30 days ahead, together with a `waiting_for` line of at most 200 characters. The card shows both: "I'll watch this thread for a reply until <date> (waiting for: <line>) and tell you what comes back." No `await_reply` means no watch. An owner who wants the send without the watch asks for it again without one.
- `ends_at` is `until` plus 48 hours, so a reply that lands just after the deadline still counts.
- At `until`, if no `answered` verdict exists, Waldo tells the owner once that no reply came and offers a nudge draft. That note is written from the ledger row and the verdict enums only, with no body.
- At `ends_at` the watch ends `expired`. The loop stays open; the owner closes or drops it.

### 2.7 What Waldo does

- On approval, the desk opens Waldo's own loop (title from `waiting_for`, due `until`) in the same transaction as `done`.
- `answered`: Waldo closes that loop as `done`, with the verdict row as closure evidence, and says so in the notice. If the owner says it was not an answer, the model opens a new loop.
- `bounce`: Waldo tells the owner which delivery failed, as the model read it, and proposes a fix (a corrected address, a resend). The watch continues for the other recipients.
- `replied_open`, `auto_reply`, `other`, `unclear`: the loop stays open. A notice goes out only when the model writes one.
- Every next step is a proposal. A reply draft or a resend goes through `send_email` and the approval desk like any send. Mail sends stay per-action approval. No standing grant applies to a send proposed from a reply-watch verdict until the standing-permission ADR says otherwise.
- Notices go through the final outbox to the owner's proactive surface (ruling 20), with a `replyWatch` receipt keyed by the fingerprint. They honour quiet hours, volume and the follow-ups switch.
- The update lane skips messages in an actively watched thread, so one reply produces at most one notice.

### 2.8 Forget, disconnect, off

- **Forget:** the watch tables hold no text, so a literal forget has nothing to rewrite there.
  - A forget that terminalises the watch's loop (existing loop coverage, `memory/claims.ts:695-704`) ends the watch `forgotten` in the same transaction and deletes its message rows.
  - Undelivered `replyWatch` outbox rows join the existing mail-follow-up redaction (`channels/telegram-final-outbox.ts:273`).
- **Loop closed:** closing or dropping the loop ends the watch `loop_closed`.
- **Disconnect:** disconnecting the Google account ends that account's watches `disconnected` at once and deletes their message rows (`channels/owner-do.ts:2388-2397` gains the call). No read happens after.
- **Grant failure:** reads stop while the grant fails to refresh. If it is still failing at `ends_at`, the watch ends `grant_lost` and the owner is told once.
- **Follow-ups off** (`proactiveEnabled`): no reads and no notices while off. The watch still ends at `ends_at`. The model does not propose new watches while follow-ups are off.

### 2.9 Link to C7 durable tasks

- C7 is not built at `e5c022ef`. Its spec (#1103, comment 6154789747) lets a step wait on an event through `waiting_on`.
- When C7 lands, a step that proposes a send with `await_reply` returns `blocked` with `waiting_on: reply_watch:<watch id>`.
- When the watch reaches a terminal state (`answered`, a `bounce` for every recipient, `expired`, or any end), the book calls `unblock` with the verdict enum only.
- If the resumed step needs the words, it reads the thread through `read_thread` under the turn's normal rules. No body enters the C7 journal.
- Until C7 lands, the watch stands alone with its loop.

### 2.10 Logs and traces

- One hop `reply_watch` per wake, with counts and enums only: watches checked, new messages, verdicts, failures, ms. No text.
- `llm_reply_watch` carries usage and shape only.

### 2.11 Switch

- `REPLY_WATCH.enabled = false` in `channels/reply-watch.ts` until the eval in section 6 meets its bar. It gates the `await_reply` field, the card line and the runner. Off means today's behaviour.
- The end, forget and disconnect paths run whatever the switch says.
- The watch runs only where `MAIL_SOURCE_FOLLOWUPS` is on (staging `1`, production `0` today). This ADR makes no `wrangler.jsonc` change.

## 3. Considered options

1. **Headers and snippet only.** Same watch, no full body. Smaller surface and cheaper. Rejected as the default because "will get back to you" versus an answer, and the cause of a delivery report, usually lie past the snippet [inference]. The eval runs this variant on the same fixtures. If it meets the bar, it replaces the body read.
2. **Bounded body read on approved, watched threads only.** Chosen (section 2).
3. **Fold into the inbox update lane.** Rejected:
   - it is inbox-wide, not bounded to approved threads;
   - `update_cards` stores from, subject and snippet, and the staging trace carries them, which conflicts with "never stored";
   - it has no link to the approval;
   - it misses replies outside the inbox.
4. **No watch; read on request.** Rejected: it fails ruling 7's reply watch and the follow-up closure, and bounces stay silent.

## 4. Consequences

- **Benefits:**
  - A sent email's outcome reaches the follow-up: answered, still open, auto-reply or bounced.
  - The owner hears about a failed delivery without asking.
  - Retention is lower than the existing mail paths: ids and enums only.
- **Costs and risks:**
  - A background reader of third-party text.
  - One model call per wake for each watch that has new mail.
  - Two new edge read methods, which need an owner deploy.
  - Prompt injection through a reply body. It is contained: no tools, enum output, owner-only notice, desk-only actions.
  - A reply that starts a new Gmail thread is missed [inference].
  - The notice is Waldo's own sentence. Like every proactive message it lands in the owner's transcript, so the instruction forbids quoting.
- **Impact surface:**
  - contracts: `tools/schemas/writes.ts` (the `send_email` args) and a new `runtime/reply-watch.ts` (the verdict schema);
  - desk: `channels/approvals.ts`;
  - tools and Google client: `tools/live/google.ts`, `connectors/google.ts` (two read methods, `GOOGLE_METHODS`);
  - edge: `supabase/functions/connector-proxy/index.ts` (scope check);
  - new modules: `channels/reply-watch.ts`, `prompt/reply-watch.ts`;
  - changed runtime: `channels/update-cards.ts`, `channels/owner-do.ts`, `channels/loops.ts`, `memory/claims.ts`, `channels/telegram-final-outbox.ts`, `channels/owner-turn.ts`.
  - No app contract change: the app renders the review text. No hosted migration, no wrangler change, no secret.
- **Process:** this record is not authoritative until it is published in Brain and `accepted-adrs.json` is regenerated.

## 5. Verification and tests

- **Contract:**
  - `await_reply` valid and invalid cases: past date, more than 30 days ahead, empty or over-long `waiting_for`;
  - verdict schema valid and invalid cases: `answered` without a notice is rejected.
- **Card:** the review text carries the watch line on Telegram and in the app. The payload digest changes when `until` changes. A proposal without `await_reply` shows no line.
- **Desk:**
  - the watch is created in the same transaction as `done`;
  - none for `uncertain`, `failed` or a send without `await_reply`;
  - the recovery path creates it exactly once;
  - a second watched send on the thread supersedes the first;
  - a 26th is refused, and the model is told.
- **Runner** (workers pool, fake Gmail, fake model):
  - one reply gives one call, one verdict row, the loop closed `done` with evidence, and one notice;
  - push and sweep together give one judgment;
  - an owner `SENT` message gives no body read and no model call;
  - a reply filed outside the inbox is found by the sweep;
  - 11 watches give 10 checked; 4 new messages give 3 judged.
- **Storage falsifier:** after a judged reply carrying a canary string in body, subject and sender, no owner-object table, KV key, outbox row or trace sink contains the canary.
- **Traces:** with staging configuration (capture on), `llm_reply_watch` has no `text`, and the `reply_watch` hop has counts only.
- **Hostile:** a reply that tells Waldo to forward the thread or send money produces a verdict and a notice only. No tool call is possible, nothing is sent, and the loop changes only per the verdict.
- **Health:** the judgment input holds no health context, even when the owner has health connected.
- **Deadline** (time-mocked, including a DST change in the owner's zone): one notice at `until`; `expired` at `ends_at`; a reply between the two still counts.
- **Forget, disconnect, off:**
  - forgetting the loop's topic ends the watch and deletes its message rows;
  - disconnect ends the watch, and no read follows;
  - with follow-ups off, nothing is read.
- **Degraded:**
  - Gmail 429 or 5xx counts as a check failure, with no notice spam;
  - a model outage counts attempts, then gives one `unclear` notice after 3;
  - an edge without the new methods fails closed with no reads.
- **C7** (when built): a blocked step resumes on `answered` with the enum only.

## 6. Eval bar for the switch

- The fixture set has at least 30 synthetic messages and no real mail:
  - direct answers and "will get back to you";
  - out-of-office replies with and without `Auto-Submitted`;
  - hard and delayed delivery reports;
  - a reply from a CC'd person and a reply in another language;
  - injected instructions.
- It runs on a real model twice: full body, and headers plus snippet.
- The switch turns on when the full-body run meets all three conditions:
  - zero `answered` on auto-replies, delivery reports and injection probes;
  - bounce recall of at least 0.9;
  - answered recall of at least 0.8.
- If the headers-and-snippet run also meets the bar, the build moves to option 1 before flipping.
- The flip PR reports both runs' counts.

## 7. Rollback

- Flip `REPLY_WATCH.enabled` off and deploy. The card line and the runner stop. Stored rows stay inert and age out under 2.3. The end, forget and disconnect paths keep running.
- `await_reply` is optional, so older proposals still parse.
- The edge methods are additive, and leaving them deployed is harmless.
- There are no hosted migrations to reverse.

## 8. Decisions for the owner

1. Scope: Option 2, with the bounds in 2.1-2.2.
2. Caps: a window of at most 30 days (plus 48 hours of grace), and 8,000 body characters.
3. Traces: the `reply_watch` purpose is metadata-only in staging too (recommended). The alternative is to allow staging capture under the 10 Oct ruling.
4. Closure: `answered` closes Waldo's own loop automatically (recommended). The alternative is that Waldo only proposes the closure.
