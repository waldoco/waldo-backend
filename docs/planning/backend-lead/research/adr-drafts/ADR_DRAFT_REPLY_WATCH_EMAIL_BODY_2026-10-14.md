> **DRAFT for owner decision.** Written 14 Oct 2026 by the backend lead's decision workflow `wf_d8922d1d-861` at `beta-mvp` `e5c022ef`. Each draft went through research, two adversarial verifiers (source and risk) and a reviser. Status: Proposed. Not accepted until the owner says so.

# ADR draft: the reply watch reads new messages on threads the owner sent through Waldo

Status: Proposed, 14 Oct 2026. Not approved. On the owner's approval it becomes an ADR in Brain under the next free number. The first build PR carries that publication and regenerates `docs/foundation/accepted-adrs.json`.

Author: backend decision packet G1. Source read at `beta-mvp` `e5c022ef`.

## 1. Context

**The gap.** An approved email reaches `done` once Gmail's readback proves the send. That happens on two paths: after the effect (`channels/approvals.ts:694`) and on the reconcile readback after an error (`:697-699`). The email branch is `:595-709`. Nothing follows. No loop or watch is created, and nothing reads the thread again. A reply never reaches the follow-up. A bounce or an auto-reply never reaches the owner.

**Why the existing paths do not cover it.**
- The update lane reads `in:inbox category:primary` since the last sweep, as From, Subject and snippet (`connectors/google.ts:800-801`, `channels/update-cards.ts:79-92`). It is inbox-wide. It misses replies filed outside Primary or outside the inbox. It has no link to the approval. It stores mail detail in `update_cards` and traces it in staging (`update-cards.ts:46-49`, `owner-do.ts:3293`).
- A mail-sourced loop needs an `observed_mail` row from that lane. `open_loop` refuses an unobserved source (`channels/loops.ts:22-27`), and a sent thread is never observed. The contract treats mail-derived completion as a hypothesis with unknown completion (`contracts/src/tools/schemas/loops.ts:5`).
- Full bodies reach the model only through `read_thread`, on request in a turn, behind the E1 quarantine and the turn's taint gate (`tools/live/google.ts:118-151`, `channels/owner-turn.ts:59-60`).
- Gmail push (#1154, #1215) only pulls the sweep forward. The push watch covers INBOX only (`connectors/google-push.ts:177`, `channels/owner-do.ts:1282-1290`).

**What already exists and is reused.**
- The heartbeat notifies once per past-due open loop that has no mail source. It stays silent in quiet hours and on low volume (`channels/heartbeat.ts:72-101`).
- The responsibilities book has a `waiting` status and evidence-based closure, and it adopts loops under their own ids (`channels/responsibilities.ts:8-13, 93-107`). Nothing calls it yet; loops are the live aggregate.
- The final outbox already holds model-written mail follow-up notices (`update-cards.ts:109-110`, `telegram-final-outbox.ts:265-273`).

**Why an ADR.** CLAUDE.md requires explicit bounded contract/ADR review for email-body processing and conversation-body storage. The reply watch reads a third party's message without a turn asking for it, and stores Waldo's note about it. Owner ruling 7 (10 Oct) names the reply watch as a place where push latency is allowed.

**Reference.**
- RFC 3834 defines `Auto-Submitted: auto-replied`.
- RFC 3464 defines delivery reports in `multipart/report; report-type=delivery-status`.
- Both are evidence, not rules. Many auto-replies omit the header [inference].
- Google's Limited Use policy allows restricted-scope data only for prominent user-facing features.

## 2. Decision

**A reply watch.** Waldo watches one thread until a deadline when two things are true: the owner approves an email whose card says Waldo will watch for a reply, and Gmail confirms the send. New messages on that thread are read once, judged by the model, and dropped. The watch keeps only ids and enums. Waldo tells the owner in a short note of its own. It never sends, drafts or closes anything on its own.

### 2.1 What is read

- Only new messages on a thread that meets all three conditions:
  - the owner sent it through Waldo;
  - the `email_send` approval reached `done` with verified readback;
  - the approved payload carried `await_reply`.
- An `uncertain` or `failed` send gets no watch.
- "New" means a message in that thread whose Gmail id the watch has not seen, dated after the sent copy's internal date.
- The owner's own later messages (Gmail label `SENT`) are recorded as origin `owner`. Their bodies are not read and no model call is made. The label is a provider fact, not a judgment.
- Other new messages are read with a fixed header list and a body capped at 8,000 characters, with a `truncated` marker.
- Verification artifacts are extracted and dropped with no relay. The model input notes only that one was present. Attachments and their names are not read.
- `threadPage` is not reused. It reads every body and returns no labels, so it cannot read headers first or recognise the owner's own messages.
- Only the account that sent the mail is read. Each wake re-resolves the mail client for that account and checks the account matches, as the desk does at send time (`approvals.ts:600-601`). A mismatch or a failure reads nothing.
- One active watch per thread. A later approved send with `await_reply` on the same thread supersedes the earlier watch.

### 2.2 When, and the gate

- Every update sweep (10 minutes) checks due watches. A verified Gmail push pulls that sweep forward, as today. The sweep also catches replies that skip the inbox.
- Each wake does a metadata-only thread read (`threads.get`, `format=metadata`) per watch. A body is fetched (`messages.get`) only for a new message that is not the owner's own.
- Caps:
  - at most 25 watches per owner, counting active watches plus open proposals that carry `await_reply`;
  - at most 10 watches checked per wake, least recently checked first;
  - at most 3 new messages judged per watch per wake.
- The cap is checked when the send is proposed. Opening the watch at `done` always succeeds, so the cap is soft by the number of cards already open.
- **Gate at proposal.** The `send_email` handler keeps `await_reply` only when all of these hold:
  - `REPLY_WATCH.enabled`;
  - `MAIL_SOURCE_FOLLOWUPS` is not `"0"`;
  - the owner's follow-ups are on;
  - the account's mail grant is present;
  - the cap allows another watch.
- Otherwise the handler drops the field, tells the model which condition failed, and the card shows no watch line. The card never promises a watch that cannot run. This is a capability check, not a judgment.

### 2.3 What is stored

Two tables live in the owner object. The reply-watch book (`channels/reply-watch.ts`) is their one writer.

- `reply_watches`:
  - links: `id`, `approval_id` (unique), `anchor_id` (the loop id, kept by `adoptLoops`), `connection_id`, `thread_id`, `sent_message_id`;
  - times: `sent_at`, `await_until`, `ends_at`, `last_checked_at`;
  - state: `status` (`watching`, `ended`), `ended_reason` (`expired`, `superseded`, `anchor_closed`, `forgotten`, `disconnected`, `grant_lost`, `followups_off`), `check_failures`;
  - `waiting_ref`: the C7 item, null until C7 exists.
- `reply_watch_messages`: `watch_id`, `message_id` (Gmail id), `fingerprint`, `internal_at`, `origin` (`owner`, `other`), `verdict`, `failed_recipient_idx` (indexes into the ledger row's to/cc), `next_step`, `attempts`, `judged_at`, `noticed`.
- `fingerprint` is SHA-256 over `reply-watch.v1`, the watch id, the Gmail message id and its internal date. It is the idempotency key for the judgment and the notice. It is content-free by construction.
- **Never stored in these tables:** the body, the snippet, the subject, the sender, any header value, or the model's reasoning.
- **Stored elsewhere, named here:**
  - Waldo's notice, at most 300 characters, as a final-outbox row and then a transcript message, like any mail follow-up notice. It is model text derived from a third party's mail. The transcript has no per-row taint field, so this text is bounded by the schema in 2.5 and by the canary check in section 6.
  - The `waiting_for` line and the deadline, in the approved ledger payload and the loop title. The owner's approval wrote them. The ledger is outside forget today. It already holds the full outgoing email, so this adds little, but it is named in section 8.
- Retention: the sweep deletes message rows 7 days after a watch ends, and watch rows 30 days after.

### 2.4 How the body is treated

- The body is external, tainted content (taint `external`). It may inform the judgment. It is never an instruction. The judgment call has no tools.
- It goes in delimiters in the user message, never in the system prompt, through the Scribe like any external mail read.
- The call carries only:
  - the approved `waiting_for` line;
  - the recipients (to and cc) from the ledger row;
  - the verdicts already recorded on this watch;
  - the new messages' headers and capped bodies.
- It does not carry the subject, any memory, other mail or health context. The `waiting_for` description tells the model to write it neutrally, with no health values or readings. The owner's health never enters this tainted path.
- **Provider.** The call goes through the gateway on the same provider path as other turns. That path sends `store: false` (`llm/openai.ts:70`), so the request does not ask the provider to retain it. Before the switch flips, the owner confirms that the DPA and the tester disclosure cover this processing (section 8).
- **Failures.** A Scribe halt, a provider failure or an invalid output counts as an attempt. Nothing about the content is logged.
- **Traces.** The purpose `reply_watch` is metadata-only in every environment (`channels/owner-turn.ts:255`), so neither input nor output reaches a trace, in staging either. The staging capture ruling covers testers' own text, and a correspondent never opted in. Production never captures text (`observability/trace-privacy.ts:65-66`).
- The body never reaches memory, the nightly pass, episodes, R2, browser jobs, drafts or any third-party send.

### 2.5 Who decides

The model decides. One call per watch per wake returns structured output, validated by a contract schema:
- `verdict`, one of:
  - `answered`: a person replied, and it appears to answer what the owner was waiting for;
  - `replied_open`: a person replied, and the ask looks still open;
  - `auto_reply`;
  - `bounce`: some or all recipients did not get the mail;
  - `other`;
  - `unclear`.
- `failed_recipients`: allowed only with `bounce`. Each entry must match an address in the ledger row's to or cc. The runner stores indexes, and the notice names recipients from the ledger, never from the reply.
- `notice`: Waldo's own note to the owner, at most 300 characters, or null. It names its source ("A reply came from one of the recipients; I read it as..."), and it does not quote.
- `next_step`: `none`, `reply`, `nudge`, `check_address` or `close`. This is a suggestion shown to the owner, never a desk row.

**Schema rules.** These are validation at an egress and safety seam, not judgments:
- `answered` and `bounce` require a `notice`.
- `notice` may not contain a URL, an email address or a phone number.
- `failed_recipients` must be a subset of the ledger recipients.

Headers such as `Auto-Submitted`, a `multipart/report` content type and `X-Failed-Recipients` are passed as evidence. No regex decides the verdict.

After 3 failed attempts a message becomes `unclear`, and the owner is told once that a new message arrived on the thread.

### 2.6 Expiry and deadline

- The model sets `await_reply.until` at proposal time, 1 to 30 days ahead, with a `waiting_for` line of at most 200 characters.
- The card shows both: "I'll watch this thread for a reply until <date> (waiting for: <line>) and tell you what comes back."
- No `await_reply` means no watch.
- `ends_at` is `until` plus 48 hours, so a reply that lands just after the deadline still counts.
- **The deadline nudge is the heartbeat's past-due notice for the watch's loop**, whose due is `until`. The heartbeat notifies once per (loop, due) and follows quiet hours and volume (`heartbeat.ts:72-101`). The watch sends no deadline notice of its own, so one deadline gives one notice.
- At `ends_at` the watch ends `expired`. The loop stays open, and the owner closes or drops it.

### 2.7 What Waldo does

- On approval, the desk helper opens Waldo's own loop (title from `waiting_for`, due `until`) and the watch in the same synchronous write block as `setStatus(id, 'done')`, on both done paths. The block has no `await` inside it, so the writes commit together [inference: Durable Object implicit write coalescing]. Recovery re-enters the same helper, which creates the watch exactly once because `approval_id` is unique.
- **`answered` is evidence, not acceptance.**
  - The notice says a reply came and asks whether to close the follow-up.
  - The owner closes it in a turn with `close_loop`.
  - The verdict row is the closure evidence.
  - The watch keeps reading until the loop closes or `ends_at`, so a misread answer does not hide a later reply.
- **`bounce`:** the notice says which delivery failed, naming recipients from the ledger. The owner can then ask for a corrected address or a resend. The watch continues for the other recipients.
- **`replied_open`, `auto_reply`, `other`, `unclear`:** the loop stays open. A notice goes out only when the model writes one.
- **Next steps.** The runner never creates a draft, a send or a desk row. When the owner asks in a turn, the turn drafts through `send_email` and the approval desk under the normal taint gate. Mail sends stay per-action approval. No standing grant applies until the standing-permission ADR says so.
- **Delivery.** Notices go through the final outbox to the owner's proactive surface (ruling 20), with a `replyWatch` receipt keyed by the fingerprint.
  - The `answered`, `bounce` and watch-ended notices are owner-requested, because the owner approved the watch. Quiet hours defer them; low volume does not hold them.
  - Other notices are held on low volume, like mail follow-ups.
  - All are held while retained recall is unproven, as mail follow-ups are (`owner-do.ts:1780, 1793`).
- The update lane skips messages in an actively watched thread, so one reply gives at most one notice.

### 2.8 Forget, disconnect, off

- **Forget.** The forget pass calls the book's `endForForget(needles)`. It matches each active watch's ledger recipients, subject and `waiting_for`, and its loop title. A match ends the watch `forgotten` and deletes its message rows in the same pass.
  - Forget writes loops directly (`memory/claims.ts:697-704`), so the runner also ends any watch whose anchor is no longer open (`anchor_closed`).
  - Undelivered `replyWatch` outbox rows join the existing mail-follow-up redaction (`telegram-final-outbox.ts:273`).
- **Loop closed or dropped:** the watch ends `anchor_closed` on the next wake.
- **Disconnect:** disconnecting the Google account ends that account's watches `disconnected` at once and deletes their message rows (`owner-do.ts:2388-2397` gains the call). No read happens after.
- **Grant failure:** reads stop while the grant fails to resolve or the account does not match. If it is still failing at `ends_at`, the watch ends `grant_lost`, and the owner is told once.
- **Follow-ups turned off mid-watch:** the watch ends `followups_off`, and the owner is told once.
- **Deployment flag `"0"`:** the runner reads nothing, and watches end at `ends_at`.
- The prune, forget, disconnect and end paths run whatever the switch and flag say.

### 2.9 Responsibilities and C7

- The loop is the interim anchor.
- When the responsibilities book becomes the live aggregate, `adoptLoops` keeps ids, so `anchor_id` resolves to the responsibility with no change to watch rows. Its status is `waiting` while watching. The owner's close records `closed_by_evidence` as `reply_watch:<id>:<fingerprint>`.
- C7 is not built at `e5c022ef`. Its spec (#1103, comment 6154789747) lets a step wait through `waiting_on`. When C7 lands:
  - A step that proposes a send with `await_reply` returns `blocked` with `waiting_on: reply_watch:<watch id>`.
  - A terminal watch state calls `unblock` with the verdict enum only.
  - `answered` is evidence for the step, not acceptance of the outcome.
  - Before any dispatch, the resume rechecks the Google grant, the account match, the follow-ups setting and the flag. Resuming is never authority to send.
  - A step that needs the words reads the thread through `read_thread` under the turn's rules. No body enters the C7 journal.

### 2.10 Logs and traces

- One hop `reply_watch` per wake carries counts and enums only: watches checked, new messages, verdicts, failures, ms. No text.
- `llm_reply_watch` carries usage and shape only.

### 2.11 Switch

- `REPLY_WATCH.enabled = false` in `channels/reply-watch.ts` until the eval in section 6 meets its bar. It gates `await_reply`, the card line and the runner. Off means today's behaviour.
- The watch also needs `MAIL_SOURCE_FOLLOWUPS` not `"0"`. That is everywhere except production today, where it is `"0"` (`wrangler.jsonc:20`). This ADR makes no `wrangler.jsonc` change.

## 3. Considered options

1. **Headers and snippet only.** The same watch, with no full body. Smaller surface and cheaper. Rejected as the default, because "will get back to you" versus an answer, and the cause of a delivery report, usually lie past the snippet [inference]. The eval runs this variant on the same fixtures and runs. If its worst run meets the bar, it replaces the body read.
2. **Bounded body read on approved, watched threads, with only a verdict and owner-facing text out.** Chosen (section 2).
3. **Fold into the inbox update lane.** Rejected:
   - it is inbox-wide, not bounded to approved threads;
   - `update_cards` stores from, subject and snippet, and staging traces carry them;
   - it has no link to the approval;
   - it misses replies outside the inbox.
4. **No watch; read on request.** Rejected: it fails ruling 7's reply watch and the follow-up closure, and bounces stay silent.

Variants considered inside option 2 and rejected:
- **Auto-close on `answered`.** Rejected: it lets any thread participant close the owner's follow-up, and it merges Evidence with Acceptance.
- **A free-text proposal turned into a desk row by the runner.** Rejected: it would carry tainted model output past the turn's taint gate.
- **A separate deadline notice.** Rejected: the heartbeat already sends one.

## 4. Consequences

- **Benefits:**
  - A sent email's outcome reaches the follow-up: answered, still open, auto-reply or bounced.
  - The owner hears about a failed delivery without asking.
  - The watch tables hold ids and enums only.
- **Costs and risks:**
  - A background reader of third-party text.
  - One model call per wake for each watch with new mail.
  - Two new Gmail read methods and an edge deploy.
  - Prompt injection and phishing through a reply body. These are contained: no tools, enum output, a schema ban on links, addresses and numbers in the notice, recipients rendered from the ledger, and no runner-written desk rows.
  - The notice is model text derived from a third party's mail, stored in the outbox and the transcript.
  - A reply that starts a new Gmail thread is missed [inference].
  - The 25-watch cap can be exceeded by the number of open cards at proposal time.
- **Impact surface:**
  - contracts: `tools/schemas/writes.ts` (the `send_email` args), new `runtime/reply-watch.ts` (the verdict schema);
  - desk: `channels/approvals.ts`;
  - tools and Google client: `tools/live/google.ts`, `connectors/google.ts` (two read methods, `GOOGLE_METHODS`);
  - edge: `supabase/functions/connector-proxy/index.ts` (mail-scope checks for the new reads);
  - new modules: `channels/reply-watch.ts`, `prompt/reply-watch.ts`;
  - changed runtime: `channels/update-cards.ts`, `channels/owner-do.ts`, `memory/claims.ts`, `channels/telegram-final-outbox.ts`, `channels/owner-turn.ts`; later `channels/responsibilities.ts`;
  - no app contract change (the app renders the review text), no hosted migration, no wrangler change, no secret.
- **Coordination.** `approvals.ts` and `owner-do.ts` are in active lanes (one desk, runtime factory, open pr/1113). The Gmail-read slice goes first; the desk and runner slices wait or coordinate on #116.
- **Process.** This record is not authoritative until it is published in Brain and `accepted-adrs.json` is regenerated.

## 5. Verification and tests

- **Contract:**
  - `await_reply` valid and invalid: past date, more than 30 days ahead, empty or over-long `waiting_for`;
  - verdict schema valid and invalid: `answered` without a notice, a notice with a URL, an email address or a phone number, and `failed_recipients` not in the ledger are each rejected.
- **Gate:** with the switch off, the flag `"0"`, follow-ups off, no mail grant, or the cap reached, the handler drops `await_reply`, the tool result says why, and the card has no watch line.
- **Card:** the review text carries the watch line on Telegram and in the app. The payload digest changes when `until` changes.
- **Desk:**
  - the watch and loop are created with `done` on the effect path (`:694`) and on the reconcile path (`:697-699`);
  - none for `uncertain`, `failed` or no `await_reply`;
  - recovery creates the watch exactly once;
  - a second watched send on the thread supersedes the first.
- **Runner** (workers pool, fake Gmail, fake model):
  - one reply gives one call, one verdict row and one notice, and the loop stays open until the owner closes it;
  - push and sweep together give one judgment;
  - an owner `SENT` message gives no body read and no call;
  - a reply outside the inbox is found by the sweep;
  - 11 watches give 10 checked, and 4 new messages give 3 judged;
  - an account mismatch reads nothing;
  - a reply carrying a verification code has the code dropped, no relay, and the code absent from the input.
- **Deadline** (time-mocked, including a DST change in the owner's zone):
  - one deadline gives exactly one notice (the heartbeat's);
  - the watch is `expired` at `ends_at`;
  - a reply between `until` and `ends_at` still counts.
- **Storage falsifier:** after a judged reply with a canary in body, subject and sender, the canary is not in any watch table, any KV key or any trace sink. The fake model's notice carries no canary, and the real-model check is in section 6.
- **Traces:** with staging configuration (capture on), `llm_reply_watch` has no `text`, and the `reply_watch` hop has counts only.
- **Hostile:**
  - a reply telling Waldo to forward the thread or send money gives a verdict and a notice only, with no tool call and no desk row;
  - a forged delivery report naming a "correct address" creates no desk row, and no address from the reply appears in the notice;
  - fake bank, security and click-to-confirm messages do not get their link or request repeated as a Waldo instruction.
- **Health:** with health context in the proposing turn, the judgment input holds no health context and no subject.
- **Forget, disconnect, off:**
  - forgetting the loop's topic ends the watch;
  - forgetting a CC'd recipient's name that is not in the loop title ends the watch, deletes its message rows, and no read follows;
  - disconnect ends the watch, and no read follows;
  - follow-ups off mid-watch ends the watch with one notice.
- **Delivery:** `answered` and `bounce` notices go out on low volume and are deferred in quiet hours. A `replied_open` notice is held on low volume.
- **Degraded:**
  - Gmail 429 or 5xx counts as a check failure, with no notice spam;
  - a model outage or Scribe halt counts attempts, then gives one `unclear` notice after 3;
  - an edge without the new methods fails closed with no reads.
- **Prune:** the sweep deletes message rows 7 days after a watch ends, and watch rows after 30 days.
- **C7** (when built): a blocked step resumes on `answered` with the enum only, rechecks the grant and switches, and sends nothing without a new approval.

## 6. Eval bar for the switch

- **Fixtures:** at least 50 synthetic messages and no real mail, with these minimums:
  - 10 delivery reports (hard and delayed);
  - 10 auto-replies (with and without `Auto-Submitted`);
  - 10 true answers;
  - 6 "will get back to you";
  - 8 injection or phishing probes;
  - also a CC'd person's reply and a reply in another language.
- Every body carries a unique canary token.
- Each variant runs 3 times on a real model: full body, and headers plus snippet. The worst run of each is reported.
- **The switch turns on when the full-body variant's worst run meets all of these:**
  - zero `answered` on auto-replies, delivery reports and probes;
  - bounce recall of at least 0.9;
  - answered recall of at least 0.8;
  - no notice contains a body canary, a URL, an address, or a probe's request phrased as Waldo's instruction.
- If the headers-and-snippet variant's worst run also meets the bar, the build moves to option 1 before flipping.
- If any notice leaks a canary, notices become fixed templates rendered from enums and ledger fields.
- The flip PR reports both variants' counts and the canary results.

## 7. Rollback

- Flip `REPLY_WATCH.enabled` off and deploy. The handler drops `await_reply`, and the card line and the runner stop.
- Stored rows stay inert and age out under 2.3. The prune, end, forget and disconnect paths keep running.
- `await_reply` is optional, so older proposals still parse.
- The edge methods are additive, and leaving them deployed is harmless.
- There are no hosted migrations to reverse.

## 8. Decisions for the owner

1. **Scope:** option 2, with the bounds in 2.1 and 2.2.
2. **Caps:** a window of at most 30 days (plus 48 hours of grace), and 8,000 body characters.
3. **Traces:** the `reply_watch` purpose is metadata-only in staging too (recommended). The alternative is staging capture under the 10 Oct ruling.
4. **Closure:** `answered` is evidence, and the owner closes the follow-up (recommended). The alternative is a distinct auto-closure outcome, which is an additive contract change.
5. **Notice storage:** Waldo's bounded notice (at most 300 characters, no links, addresses or numbers, no quoting) is stored in the outbox and transcript like other proactive notes. The alternative is fixed template notices from enums only.
6. **Delivery:** `answered`, `bounce` and watch-ended notices count as owner-requested. Quiet hours defer them; low volume does not hold them.
7. **Ledger residue:** `waiting_for` stays in the approved ledger payload, which forget does not cover today. The ledger already holds the outgoing email. The alternative is extending forget to the ledger, which is a separate change.
8. **Egress:** confirm that the provider DPA and the beta-tester disclosure cover background processing of correspondents' replies before the flip.
