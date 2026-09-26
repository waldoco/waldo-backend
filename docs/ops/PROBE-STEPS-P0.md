# P0 live probe steps (staging) - synthetic, non-private, no secrets

Run from the owner Telegram chat against `waldo-runtime-staging`. Each probe's receipt is the turn's `tg-<update_id>` hop-log trace (wrangler tail) plus the Langfuse trace id; Langfuse traces must name the deployed commit SHA (WALDO_RELEASE). Record: probe, release SHA, tg trace id, Langfuse trace id, pass/fail, dashboard effect.

1. Calendar read: "what's on my calendar today" → query_calendar returns populated or honestly-empty typed result.
2. Gmail read (regression for the batch-overflow break): "any new email?" → get_communication; populated inbox must render items, never a false "nothing found".
3. Tasks read: "what are my open tasks" → get_tasks typed result.
4. Calendar write via approval: "put a test event 'probe' tomorrow 1-2pm" → propose_calendar_change card; approve from the console Waiting-on-you list; verify the event exists; cancel it the same way.
5. Gmail draft: "draft an email to myself, subject probe, body probe" → draft_email; verify the draft in Gmail Drafts.
6. Gmail send via approval: "send an email to myself, subject probe, body probe" → send_email card shows exact recipients/subject/body; approve; verify in Sent.
7. Web search: "search the web for the Cloudflare Workers documentation" → web_search returns an official URL.
8. Connect link: "connect google" → the link button mints a ticket URL; after #202 merges the minted form must be `/c/?t=<ticket>` and `/c/<ticket>` must 404.
9. Poisoned-history recovery (post-#164 acceptance, keeps #161 open until receipt): with a history entry known to trip a structural scribe deny, send any ordinary message → the reply still arrives (degrade reduces to the current message); receipt = successful llm_reply hop with the poisoned entry absent from the request payload.
10. Invalid calendar arguments (keeps #149 open until receipt): ask for a malformed calendar action (e.g. "move my 3pm to banana o'clock") → typed invalid-args result, not a crash or a hallucinated change.
11. Disconnected-owner recovery (#149): on an owner without Google connected, ask "check my email" → typed connect intent + connect button offered once, no half-proposed card.

Safety: all content is synthetic ("probe" subjects/bodies); no real correspondence, contacts, or files are touched; no provider content or secret values appear in steps or receipts.
