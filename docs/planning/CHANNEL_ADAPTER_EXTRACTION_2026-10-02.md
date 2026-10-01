# Channel adapter extraction (design only, no code)

Status: draft proposal for review. Evidence layers kept apart: SOURCE = code at beta-mvp df7726c; REFERENCE = docs fetched 2026-10-02. Nothing here is LIVE-verified, and no code is changed by this document.
Decision attribution: this is an analysis answering the owner's 2026-10-02 question ("isn't a Telegram-specific DO wrong vs mature harnesses?"). It is not an owner decision. Codex owns `telegram-owner-do.ts` and `console-signin.ts`; this document edits neither.

## 1. What exists today (SOURCE)

- `src/channels/telegram-owner-do.ts` is 1,658 lines. `telegram` appears about 115 times and `whatsapp` about 28.
- `type ChannelKind = 'telegram' | 'whatsapp'` (line 152). `setup(channel)` (line 889) is the composition root: memory, tools, scheduler, outbox, responder. `turn(update, channel)` (line 783) runs a turn. WhatsApp turns already run through this same DO (line 421). The console surface also uses the DO (`index.ts:160`, `console-signin.ts:132`).
- The turn loop is channel-neutral: `owner-turn.ts` `createOwnerResponder` consumes an `OwnerTurnEnvelope` (`owner-turn-envelope.ts`: "Auth and provider parsing happen in adapters. This is the admitted content boundary").
- Per-platform transport already lives in separate files: `telegram-api`, `telegram-polling`, `telegram-webhook`, `telegram-final-outbox`, `telegram-link-*`, `telegram-media`, `whatsapp-api`, `whatsapp-webhook`, and `imessage/{ingress,admission,media}`. The iMessage files already emit `OwnerTurnEnvelope` but are not reachable from the Worker entry today.
- Keying: one DO per owner by name. The Telegram webhook resolves the sender through the owner directory (`byPresence('telegram', subject)`), then calls `idFromName(route.doName)` with `/enqueue`.

## 2. Where the DO is channel-specific (the inline branch sites)

All line numbers are at df7726c.

| Line | Branch | What differs |
| --- | --- | --- |
| 415-421 | WhatsApp ingest route | stores `whatsapp_subject`, drives `turn(update, 'whatsapp')` |
| 790 | `offsetKey` | `wa_offset` vs `offset` |
| 897-901 | owner id and config check | `whatsapp_subject` vs Telegram owner; unconfigured-runtime errors |
| 954-955 | `baseCall` | `whatsappTelegramShim(...)` vs Telegram caller |
| 958 | `egressSubject` | `whatsapp_subject` vs `telegram_subject` |
| 962 | unlinked flag | `whatsapp_unlinked` vs `telegram_unlinked` |
| 1122 | `surface` label | dashboard / telegram / undefined |
| 1168 | proposal channel check | rejects proposals for another channel |
| 1202 | media `download` | WhatsApp vs Telegram download |
| 1276 | `queueFinal` | Telegram-only final outbox (`telegram-final-outbox.ts`) |
| 1295 | `saveOffset` | `wa_offset` vs `offset` again |
| 1323 | Telegram-only block | inside the turn setup, `channel === 'telegram'` |
Also `intercept(update)` (line 715) handles Telegram link and pairing commands.

## 3. How the references we already cite split it (REFERENCE)

- Hermes Agent gateway: a `GatewayRunner` composes platform adapters (Telegram, Discord, Slack and others). Each adapter normalizes a raw event into a `MessageEvent`. Core owns the session store, authorization, slash commands and the agent loop; `delivery.py` and `pairing.py` are separate modules. Source: https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals (fetched 2026-10-02). The repo already cites Hermes in `docs/planning/ADOPTION_DIRECTION.md` and `TOOL_LOOP_BUDGET.md`.
- OpenClaw: one long-lived Gateway owns all messaging surfaces (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, WebChat) behind a typed WebSocket protocol, with channel routing as its own concept. Sources: https://docs.openclaw.ai/concepts/architecture and https://docs.openclaw.ai/channels/channel-routing (fetched 2026-10-02).
Both are a channel-neutral core, per-platform adapters, and a shared session store. Neither names its core after one platform. This is evidence about their shape, not a requirement that Waldo copy their process model (Waldo runs on Workers and Durable Objects).

## 4. Smallest extraction that unblocks other channels

1. Define one `ChannelAdapter` interface: `parse(raw) -> OwnerTurnEnvelope`, `send(reply or artifact)`, `download(media)`, identity key names (subject key, unlinked flag, offset key), and an optional `finalQueue`.
2. Replace the branch sites in section 2 with three adapter objects (telegram, whatsapp, console). Behavior-preserving and mechanical.
3. Put `intercept` (link and pairing) behind the Telegram adapter. Keep DO storage key names unchanged.
4. Wire the existing iMessage ingress and admission as a fourth adapter.
5. Do not rename the DO class in this step. A class rename needs a `renamed_classes` migration and a coordinated deploy, with no functional gain. Alias it in docs if wanted and rename later.

## 5. Risks

- The final outbox (`queueFinal`) is a Telegram delivery guarantee. Other channels need an explicit choice (at-least-once vs best-effort) before they share it.
- Renaming stored keys (`offset`, `wa_offset`, `telegram_subject`, `whatsapp_subject`, `*_unlinked`) would orphan state. Keep them.
- Conflict with Codex's dashboard work in `telegram-owner-do.ts` and `console-signin.ts`. Codex should own the edit or sequence it.
- Test coverage of the branch sites is unmeasured. Existing owner-turn tests are the guard; a pass over them is needed before the change.
- I have not estimated effort in hours; a diff-size estimate needs a pass over the sites with Codex.

## 6. Open question: two cores

`RunLoopDO` and `TracerDO` are bound in `wrangler.jsonc` but the Telegram path does not call them (`RunLoopDO` serves the owner-root route at `index.ts:220`; `TracerDO` has no caller outside its binding). Telegram turns share the tracer table schemas, not the tracer loop. A channel-neutral core decision should also say which core wins: fold the Telegram turn path onto the run loop, or keep the owner turn path as the core and retire or park the run-loop stack.

## 7. Not decided here

DO class rename, final-outbox semantics for non-Telegram channels, iMessage pairing contract (waiting on the owner), which core wins.
