# WhatsApp channel design - 2026-09-24

Design for adding WhatsApp as a Waldo channel, per the owner's 9:17 directive. Assumes route A (official Cloud API direct) from WHATSAPP_ROUTES_2026-09-24.md; a BSP slot-in changes only hosting of the webhook target and token custody, not this design. Code references are from the beta-mvp tree as of 76adaef; verify names against the code when implementing.

## 1. Shape

A new channel beside Telegram, not a fork of it:

- packages/runtime/src/channels/whatsapp-webhook.ts - Worker routes: GET verification, POST events.
- packages/runtime/src/channels/whatsapp-owner-do.ts - the DO-side turn plumbing, mirroring telegram-owner-do.ts.
- The responder core (today createTelegramResponder in telegram-turn.ts) is channel-shaped in everything but name. Rename the shared core (responder.ts) and keep thin telegram/whatsapp adapters. One refactor commit, no behavior change, gates cover it.

Waldo concepts map cleanly: presence, turns, update cards, reminders, loops, stop/steer and feedback already exist for Telegram. WhatsApp reuses all of them.

## 2. Webhook into the channel layer

Verification (one-time, Meta app dashboard): GET with hub.mode=subscribe, hub.verify_token, hub.challenge. Answer with the challenge when the token matches. The verify token is a random secret in the Worker's env, not in the repo.

Events: POST with X-Hub-Signature-256. Verify HMAC-SHA256 of the raw body with the Meta app secret before parsing; reject unsigned or badly signed calls (same rule as the Telegram webhook secret and the connector-proxy signing; Trust boundaries checklist).

Payload: object="whatsapp_business_account", entry[].changes[].value holds:
- metadata.phone_number_id - which Waldo number was addressed.
- contacts[].wa_id - the sender's phone, the presence key (the Telegram chat id analogue).
- messages[] - inbound: {from, id (wamid), timestamp, type, text.body}. Types to handle at launch: text, audio (voice notes), interactive (button replies). Others: log and answer with a short honest "can't read that yet".
- statuses[] - delivery receipts for our own sends; feeds the trace, never the model.

Processing rules:
- Ack 200 immediately, process async (ctx.waitUntil or a Queue). Meta retries non-200s.
- Dedupe on wamid: Meta retries and at-least-once delivery are normal; a wamid is processed once (Idempotency checklist). Store seen wamids per presence with a short horizon.
- Ordering: messages from one wa_id process in arrival order through that owner's DO, same as Telegram (Concurrency checklist: writes settle before the next turn).

## 3. Presence and stranger gating

- Presence row keyed on wa_id, linked to the owner exactly as Telegram presences are (W2.1).
- A stranger who messages the number gets the same one-time link-code flow ("/start CODE" equivalent): their first message opens a service window, so the reply is free-form and free. No template needed for gating.
- Unlink (W2.5) must drop WhatsApp presences identically: mark unlinked, drop all outbound including queued reminders and cards.

## 4. The 24-hour window

Track last inbound message time per presence. Every proactive send (update cards, reminders, loop results, fetch nudges) checks the window:

- Window open (owner messaged within 24h): free-form text. Until 2026-10-01 this is free; after, billable per delivery with 1,000 free/number/month.
- Window closed: an approved utility template is the only door. See section 5.

The window is per owner, not per card. The update-cards ledger already decides what is worth sending; window state only changes how it is sent.

## 5. Template strategy for cards outside the window

Submit a small set of utility templates on day one (approval is minutes to 48h; start early, before business verification completes, since templates can be submitted once the WABA exists):

- waldo_update: header "Update", body = one to three short lines (the card text). Parameters: body only.
- waldo_reminder: header "Reminder", body = the reminder text.
- waldo_prompt: body = a question or nudge needing a reply, with two quick-reply buttons (e.g. "Done" / "Later") wired to Fetch feedback. Button taps come back as interactive messages, inside which the window is open, so the follow-up is free-form.

Card text already exists; templates carry it verbatim as parameters. No per-card approval needed, only per-template. Keep the template count low and the bodies generic; Meta rejects templates that look like marketing, and a rejection is a retry loop, not a blocker.

Volume honesty: from 2026-10-01 every delivered template is billable (India utility about Rs 0.115 today). At one owner plus a handful of invitees this is pocket change; at invite scale it becomes a real line item, and the feedback loop (send more like the useful ones) is also the cost loop.

## 6. Coexistence vs dedicated number

- Dedicated number (recommended): clean separation, no coupling to a phone app, quality rating and bans (policy, not ToS) stay isolated. Costs a SIM or a virtual number; the number cannot be on consumer WhatsApp.
- Coexistence: register a number already on the WhatsApp Business app; app and API work side by side. Useful if he wants Waldo on an existing business-app number. Adds moving parts (message sync, app/API ownership of threads) that a personal assistant does not need.

Either way: start on the Meta test number today (5 allow-listed recipients), submit business verification immediately, cut over when it clears.

## 7. Voice notes

The owner talks to Waldo; on WhatsApp that is voice notes. Inbound audio arrives as type=audio with a media id: download via the media endpoint, transcribe (Whisper or the OpenAI audio API, nano-class cost), then enter the same turn path as text. Outbound voice replies wait on the ElevenLabs key (owner-pending). Transcription errors follow the failure-paths checklist: send something true or nothing.

## 8. Failure paths and observability (fundamentals applied)

- Every hop logs trace id, duration, ok/failed, detail: signature verify, dedupe, presence resolve, turn, send, status receipt.
- Webhook down or backing up: Meta holds and retries; on recovery, dedupe absorbs the replay.
- Send failures: window-closed without an approved template -> hold the card, fold it into the next window-open send, and note it in the ledger. Never silently drop.
- Template rejected: fall back to holding cards for open windows only; tell the owner in the next card.
- Per-message billing surprise: a daily send counter per presence, surfaced in the close card if it ever spikes.

## 9. Build order (after access returns and the route is confirmed)

1. Refactor: channel-neutral responder core (no behavior change).
2. Webhook + signature verify + dedupe + presence mapping + link codes, text turns only. Adversarial tests: forged signature, replayed wamid, stranger without code, unlinked presence.
3. Window tracking + the three templates + template send path. Eval cases: card held when window closed, card sent free-form when open, feedback button closes the loop.
4. Voice notes in, text out.
5. Live proof joins the combined E2E (owner's stated preference) on the test number, then production after verification.

## 10. Keyed to owner decisions

- Route pick (A/B/C/D) - research in WHATSAPP_ROUTES_2026-09-24.md.
- Dedicated number vs coexistence.
- Meta app + WABA creation needs his Meta account; business verification needs his business details.
- ElevenLabs key for outbound voice.
