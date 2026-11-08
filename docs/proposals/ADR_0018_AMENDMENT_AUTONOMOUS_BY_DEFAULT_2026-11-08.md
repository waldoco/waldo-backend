# ADR-0018 amendment: autonomous by default (8 November 2026)

> **Status: Accepted by owner ruling, 8 Nov 2026** (waldoco/waldo-backend#2003, ruling comment 09:26Z; beta list #2076 P0-1). The owner pre-accepted this amendment. It amends the approval rule of ADR-0018 as extended by ADR-0086 (`AUTONOMY_OPT_IN_2026-10-27.md`) and the chat-to-app hand-off that followed it. Behind `AUTONOMOUS_BY_DEFAULT` (`WALDO_SWITCHES`): `1` in staging, `0` in production.

## Decision

1. **Work the owner asked for runs with no card.** A send (Gmail, a message, mail as Waldo), a change to the owner's calendar (including a day plan) and a Google task change run at once when the turn was started by the owner's own message, carries no one else's words, and has read no outside text (`ownerAsked` in `channels/approvals.ts`). Whether the owner asked is the turn's provenance, never a reading of their words: no keyword or threshold decides it, and the model still judges what to do.
2. **It runs through the same decision as a tapped card.** The desk records an `asked` presentation and opens the row in one commit, then decides it with `decideOnce`: the effect is keyed (`<operation>:apply`), recorded before it is dispatched, and never dispatched inside the SQLite transaction. A replay in the turn answers with the first run; a retry after a restart is fenced by the effect key, the email dedupe key and Message-ID, and the message idempotency key.
3. **Waldo reports what it did and offers an undo where one exists.** The tool result carries the outcome and, while the undo window is open, tells the model the owner can undo it. `raise_approval` gains `undo`, taken only on the owner's own message in a turn that read no outside text. A sent message or email has no undo, and the report says so.
4. **Cards remain** for what outside content asked for (a turn that read outside text, a `tainted_action`), for a browser submit (a payment, a purchase, entered credentials) and an MCP call (an effect the desk cannot see), for a standing grant (lasting access), for a remove when cancels cannot be undone, and for an email whose earlier identical send has an unknown outcome.
5. **Every remaining card is decided on the surface showing it.** No chat surface hands a card to the app. A tap there, or the owner telling Waldo to go ahead (`approve_shown`), approves it in place for every kind. A review too long for one message goes out across up to eight messages ahead of the card that decides it; past that the card still says it cannot be approved.

## Unchanged

Lasting-access grants, owner checks, the taint boundary for outward effects, credential masking, digest-bound payloads (an edited payload is never approved by an earlier yes), one writer per ledger row, and the closure rules. With the switch at `0` every path is exactly as before.

## Not built here

- **An undo-send hold** (holding a send for a short window before it goes). It needs a durable timer in the owner's Durable Object; sends go out at once and are reported as final.
- **Browser and MCP autonomy.** Every browser step reads a page, so code cannot tell an owner-asked submit from one a page suggested, and a submit can pay or enter a password. They stay cards, decided where shown.
