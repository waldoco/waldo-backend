# Instinct-pattern audit - every core system against the owner's bar

Owner direction 2026-09-27 8pm: model every capability and core system on his stated
personal-agent patterns ("make it similar to yours and your philosophy"). The template is the
email flow + memory rule shipped in #287. The bar, per system:

1. **Read-only until decision** - reads and triage never mutate; effects wait for an explicit yes.
2. **Proposals carry exact content** - anything awaiting approval shows the precise recipients,
   words, times and cost, not a summary.
3. **Provenance on all state** - every durable record says where it came from (stated / inferred /
   confirmed, plus an evidence pointer).
4. **Corrections replace** - a correction supersedes; state never piles up contradictory versions.
5. **Live reads over stale recall** - current state of a connected source is read live at ask time;
   memory holds meaning and pointers, never content copies.

## Email

- Reads: get_communication / search_communication / read_thread, all read tools, external-tainted
  results. Meets the bar.
- Drafts: `draft_email` (src/tools/live/google.ts:156) is unprivileged, saves a Gmail draft,
  ledger-records it (`desk.record('email_draft', ...)`). Meets the bar.
- Sends: `send_email` (src/tools/live/google.ts:178) only proposes - canonical MIME + sha256 digest
  to the approval desk, Send it / Modify / Not now shows exact recipients, subject and body; replay
  sends the stored bytes, digest mismatch fails closed. Meets the bar; this is the reference shape.
- Model contract pinned in the reply prompt (#287, DOING section).
- OPEN: 19:35 draft_email hook halt is scribe-side (tool_arg_sanitise), not the approval gate;
  #286's span `metadata.code` pins the exact reason on the next recurrence.

## Calendar

- Reads: query_calendar, read-only. Meets the bar.
- Changes: `propose_schedule` routes to the desk as Do it / Modify / Not now with the exact change;
  10-minute undo window (UNDO_WINDOW_MS, src/channels/approvals.ts). Meets the bar.

## Approvals and ledger

- approvalDesk (src/channels/approvals.ts) is the single door: calendar proposals, browser submits
  (digest-bound page binding, replay aborts on a changed page), email sends (digest-bound MIME).
  Ledger with undo; /ledger owner command. Meets the bar.
- GAP (fixed #288): telegram turns had no `hasApproval`, so every privileged tool hard-halted
  "approval check unavailable". Now: first-party privileged tools proceed, external-reaching tools
  (send_message, execute_action, call_mcp_tool, delete/restore_message) halt with typed
  approval_denied until each gets a card flow.
- GAP (next): send_message and call_mcp_tool have no proposal cards yet - they halt instead of
  asking. Card flows for both, modeled on proposeSendEmail.

## Memory

- Claims carry provenance (stated/inferred/confirmed + evidence quote), corrections dismiss+add
  (replace), forget requires explicit owner intent with a barrier against relearning
  (src/memory/claims.ts CLAIM_RULES). Meets the bar.
- Sources-stay-sources rule pinned #287: claims record meaning + pointers, never source content
  copies; current source state is read live.
- Memory-writer model escalated to mini after nano hallucinated forget_claims (receipt 2026-09-27).
- GAP: update_memory as a tool is privileged but unwired on telegram; the record-first path is a
  separate model call. Decide one write path.

## Reminders and machine turns

- Reminders fire as machine turns with full tracing (#281 receipt: reminder:...:1 trace, hops
  reminder/llm_reply/send, 19:35 live). Delivery confirmed by trace; owner confirmation of arrival
  outstanding.
- Meets the bar on provenance; read-only by construction.

## Conversation behavior

- Reply prompt (src/prompt/messaging-behavior.ts): voice, honesty about abilities, defect-reports-
  as-bugs, anything reaching another person / money / shared calendar needs a clear yes.
- Greeting clock anchored at prompt build (ownerClockLine, 2026-09-27 receipt).
- GAP (cosmetic, demo-visible): REDACTED_INSTRUCTION can appear in owner-bound replies when the
  model narrates a guard action; phantom get_communication fetch on bare greetings. Prompt
  hardening, not a safety hole.

## Tools and taint

- ADR-0049 single law: external-tainted args + privileged tool = propose or block, never direct
  execution (taintGateBlocksDirectExecution). Taint restamps are typed; mismatches reject.
- Egress allowlist covers execute_code/browse_page/browse_act only.
- Meets the bar.

## Harness (run-loop, scribe, observability)

- Scribe sanitise pipeline: canary/secret deny, health deny, PII redact, instruction
  block/review, destination policy. Verify-only final pass (#283) fixed the composition crash loop.
- Tracing: every hop typed; failures carry code:reason on the span with capture off (#286).
- Deploy: Workers Builds upload versions; promotion is manual (owner steer 2026-09-27 8:05pm).
- Meets the bar; flakiness note: trusted-run-loop and execution-writer property tests flake in CI
  (~1 rerun in 2 runs today). Worth a flake-hunt pass before the demo.

## Dashboard

- Honest Google service state (access vs read-unverified), OAuth callback strips the code from
  history (#284, #285, dashboard lane). Meets the bar.

## Proposed PR order

1. send_message + call_mcp_tool proposal cards (modeled on proposeSendEmail).
2. Draft-halt fix once the typed reason lands (awaiting one recurrence post-#286).
3. REDACTED_INSTRUCTION reply hygiene + greeting phantom-fetch prompt hardening.
4. Single memory write path decision (tool vs model call).
5. CI flake hunt (trusted-run-loop, execution-writer property tests).
