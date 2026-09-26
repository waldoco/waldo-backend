# P0 live probe steps (staging) - receipts only, no secrets

Run from the owner Telegram chat against `waldo-runtime-staging`. Read probes 1-3 touch the owner's REAL provider data - only the write probes (4-6) use synthetic content ("probe" subjects/bodies). Keep every report content-free: record counts, typed statuses, and receipt IDs, never provider bodies, tokens, or ticket URLs. Each probe's receipt is the turn's `tg-<update_id>` hop-log trace (wrangler tail) plus the Langfuse trace id; Langfuse traces must name the deployed commit SHA (WALDO_RELEASE). Record: probe, release SHA, tg trace id, Langfuse trace id, pass/fail, dashboard effect.

1. Calendar read: "what's on my calendar today" → query_calendar returns a populated or honestly-empty typed result. (Real provider data; report only the outcome class, not the events.)
2. Gmail read: "any new email?" → get_communication; a populated inbox must render items, never a false "nothing found". (Real provider data; content-free report.) Live context: at `tg-904957573` the tool completed and `llm_reply` then failed `forbidden:scribe_sanitise` before send; the exact Scribe reason was not exported, so batch overflow is a hypothesis this probe must confirm or refute.
3. Tasks read: "what are my open tasks" → get_tasks typed result. (Real provider data; content-free report.) First live run already happened on old release `2754a6c` (`tg-904957580`, failed `transient:invalid_handler_result` - the withGoogle error-stamp defect fixed at #202 @ `f027eb1`); this probe is the post-fix proof and must wait for the #202 deploy.
4. Calendar write via approval: "put a test event 'probe' tomorrow 1-2pm" → propose_calendar_change card. Required receipts: real `proposal_id`; console Waiting-on-you shows the pending proposal before approval; approval recorded as a separate action; provider readback confirms the event exists; Telegram delivery receipt for the result message. Then cancel it the same way with the same receipt set. A model sentence about buttons is not a receipt.
5. Gmail draft: "draft an email to myself, subject probe, body probe" → draft_email; provider readback: the draft exists in Gmail Drafts.
6. Gmail send via approval: "send an email to myself, subject probe, body probe" → send_email card. Required receipts: real `proposal_id`; console pending state; separate approval action; provider readback confirms the message in Sent (Message-ID reconciliation); Telegram delivery receipt.
7. Web search: "search the web for the Cloudflare Workers documentation" → web_search returns an official URL.
8. Connect link: "connect google" → the link button mints a ticket URL; after #202 merges the minted form must be `/c/?t=<ticket>` and `/c/<ticket>` must 404. Record only the URL FORM, never the ticket value.
9. Poisoned-history recovery (post-#164 acceptance, keeps #161 open until the live receipt passes). Two separate assertions:
   a. Privacy invariant - synthetic harness assertion: with a history entry known to trip a structural scribe deny, run the turn through the scribe test harness and assert the poisoned entry is absent from the request payload. Do NOT rely on Langfuse text capture for this - it may be off, and the invariant must hold regardless of telemetry settings.
   b. Live user recovery: send any ordinary message in the affected chat → the reply still arrives (degrade reduces to the current message). Receipt: successful llm_reply hop plus Telegram send receipt for the turn.
10. Invalid calendar arguments (#149 path 1): ask for a malformed calendar action (e.g. "move my 3pm to banana o'clock") → typed invalid-args result, not a crash or a hallucinated change.
11. Disconnected-owner recovery (#149 path 2): on an owner without Google connected, ask "check my email" → typed connect intent + connect button offered once, no half-proposed card.

#149 stays open until BOTH steps 10 and 11 pass live. #161 stays open until step 9b passes live.

Safety: write probes use only synthetic "probe" content; no real correspondence, contacts, or files are modified; no provider content or secret values appear in steps or receipts.
