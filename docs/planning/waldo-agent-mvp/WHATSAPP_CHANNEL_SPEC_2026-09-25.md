# WhatsApp channel spec - 2026-09-25

Written from code reality (what Telegram does today, file by file) plus Meta platform constraints.
Owner's queue: WhatsApp is item 3; Meta business verification is the critical path and is his-side
(lane offered to drive the browser for the verification flow itself).

## 1. How the Telegram channel works today (the shape WhatsApp slots into)

- `telegram-webhook.ts`: POST `/telegram/webhook`, authenticated by a shared-secret header
  (`x-telegram-bot-api-secret-token`, constant-time compare). Resolves sender id, asks the owner
  directory who this subject is, forwards the raw update to that owner's DO (`/turn`). Unlinked
  senders can only redeem a one-time link code (`/start CODE`); anything else is ignored.
- `owner-directory.ts`: `byPresence(provider, subject)` -> signed `route_presence` RPC (do_name,
  subject, timezone); `redeem` -> signed `redeem_link`. Provider literal is typed `'telegram'` only.
- `telegram-owner-do.ts`: per-owner runtime. Identity binds from webhook headers
  (`x-waldo-telegram-subject`); unlinked directory-backed DOs resolve owner 0 and every Telegram
  send drops at the gate (d3a050c). Settings/timezone persist in DO kv, editable via console
  (Supabase is source of truth).
- `telegram-api.ts`: `createTelegramCaller` + `gatedCaller` (unlinked drop) inside
  `egressGuardedCaller`. All sends go through it.
- `telegram-media.ts`: `MediaReaders { download, transcribe }` seam - the Transcriber interface is
  channel-agnostic; smallest.ai is wired as STT (`WALDO_STT_PROVIDER`). Voice-note reading exists
  for Telegram and carries over.
- Console: link codes (`issue_link_code`, 10 min TTL) bind a chat to an owner.

## 2. What WhatsApp needs, concretely

Schema (one migration):
- `waldo.presences.provider` check `('telegram','console','ios')` -> add `'whatsapp'`.
- `waldo.link_codes.provider` check `('telegram','ios')` -> add `'whatsapp'`.
- Canonical lists + fixture + pgTAP in the same commit (guard-migration-fixture-sync enforces).

Runtime:
- `owner-directory.ts`: widen provider literal to `'telegram' | 'whatsapp'` (subject = E.164 phone).
- `whatsapp-webhook.ts` mirroring telegram-webhook: GET verify (`hub.mode`, `hub.verify_token`,
  echo `hub.challenge`), POST with `X-Hub-Signature-256` HMAC-SHA256 over the raw body (app
  secret), extract `entry[].changes[].value.messages[]`, resolve `from` via the same directory,
  forward to the owner DO. Status callbacks (sent/delivered/read) ignored but acknowledged.
- `whatsapp-api.ts`: caller for `POST /{phone-number-id}/messages` (bearer token), same
  gatedCaller + egressGuardedCaller wrapping. Sends are text + reply buttons (interactive) only
  for MVP; no media sends.
- Owner DO: a second ingress path (`/whatsapp-turn`) reusing the same turn pipeline; identity
  header `x-waldo-whatsapp-subject`. The owner-0 send gate must cover the WhatsApp caller too.
- Media: inbound voice notes = Graph API media download (two-step: media id -> URL -> bytes,
  bearer on both) feeding the existing Transcriber. This closes the alpha voice gap flagged in
  CAPABILITY_INVENTORY.

## 3. Meta platform constraints (verify each at build time - recalled, not live-checked)

- 24-hour customer service window: free-form replies only within 24h of the user's last message.
  Outside it, only pre-approved message templates send. THIS SHAPES PROACTIVE WALDO: morning wag,
  nudges, evening close all fire outside the window, so each proactive class needs an approved
  template (utility category) or the user must have messaged within 24h. Telegram has no such
  constraint - this is the biggest design delta, not the API mechanics.
- Business verification: required for scale/display name; a test number works unverified but is
  limited (small recipient count, must add recipient numbers manually). Verify current limits.
- Pricing: per-conversation/per-template category; service conversations reportedly free, utility
  templates paid in some regions. Confirm current pricing before enabling proactive templates.
- Number choice: a fresh number for the WABA (a number on consumer WhatsApp can't be reused
  without migration).

## 4. Meta setup checklist (his-side, critical path; lane can drive the browser)

1. Meta developer app -> add WhatsApp product -> test number live (works same day, limited).
2. Business verification (documents; days of review - start NOW, it gates nothing about coding).
3. WABA + permanent number + display name review.
4. System user + permanent access token (never in repo/chat; worker secret via wrangler).
5. Webhook subscription pointing at the worker with verify token + app secret.

## 5. Build order (each = gates green, push, report)

W1. Schema migration (provider literals) + pgTAP + lists.
W2. whatsapp-webhook + directory widening + routing tests (mirror telegram-webhook tests:
    bad signature 403, unknown sender ignored, link-code redeem, routed turn hits the right DO).
W3. whatsapp-api caller + send gate coverage + owner DO ingress (`/whatsapp-turn`).
W4. Media download -> transcriber (voice notes).
W5. Template-gated proactive sends (depends on owner's template approvals; design after W2 lands
    so template classes match the loop taxonomy: morning wag / nudge / evening close).

Open decisions for him: (a) fresh number vs migrate an existing one; (b) which template classes to
submit first; (c) does WhatsApp replace Telegram for alpha testers or run alongside (spec assumes
alongside - presences are multi-provider already).
