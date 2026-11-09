# ADR-0018 amendment: autonomous by default (8 November 2026)

> **Status: Accepted by owner ruling, 8 Nov 2026** (waldoco/waldo-backend#2003, ruling comment 09:26Z; beta list #2076 P0-1). The owner pre-accepted this amendment. It amends the approval rule of ADR-0018 as extended by ADR-0086 (`AUTONOMY_OPT_IN_2026-10-27.md`) and the chat-to-app hand-off that followed it. Behind `AUTONOMOUS_BY_DEFAULT` (`WALDO_SWITCHES`): `1` in staging, `0` in production.

## Decision

1. **Work the owner asked for runs with no card.** A send (Gmail, a message, mail as Waldo), a change to the owner's calendar (including a day plan) and a Google task change run at once when the turn was started by the owner's own message, every part of that message is the owner's own words (a transcript of a file they sent, or a note on a photo, is not), the turn has read no outside text, and nothing it carries from before may be someone else's words (`ownerAsked` in `channels/approvals.ts`). Whether the owner asked is the turn's provenance, never a reading of their words: no keyword or threshold decides it, and the model still judges what to do.
2. **"Carries from before" is the whole conversation the model can see** (owner ruling, 9 Nov):
   - the chain since the live summary: a reply that read outside content, a Brief or other machine input, a forward or quote, and a summary marked as covering any of those. The mark carries into every later summary, so a chat that read outside text stays marked; this fails closed;
   - what recall shows: a note whose origin is not the owner's (saved from outside content, or with no recorded origin), and a past message that is not the owner's own words (a whole message with quotes or a file transcript, or a reply that read outside content), including through the links it shows;
   - what `search_episodes` and `search_history` return during the turn, judged the same way: a hit that may carry someone else's words taints the turn like the mail it quotes, and a `search_history` entry always does, since a summary records nothing of where its words came from.

   An email read last turn, or in another chat, therefore can't steer an "ok, handle it" into a send with no card.
3. **It runs through the same decision as a tapped card.** The desk records an `asked` presentation and opens the row in one commit, then decides it with `decideOnce`: the effect is keyed (`<operation>:apply`), recorded before it is dispatched, and never dispatched inside the SQLite transaction. A replay in the turn answers with the first run; a retry after a restart is fenced by the effect key, the email dedupe key and Message-ID, and the message idempotency key. A revised request closes the card it replaces in the same commit, so the earlier version can no longer go out too. A run that ends before it acts (an account not connected) is settled not done, never left as an open card nobody saw.
4. **Waldo reports what it did and offers an undo where one exists.** Calendar changes and day plans have one; a Google task change, a message and an email do not, and the report says so. The tool result carries the outcome and, while the undo window is open, tells the model the owner can undo it. `raise_approval` gains `undo`, taken only with the switch on and only on the owner's own words in a turn that read no outside text.
5. **Cards remain** for:
   - what outside content asked for (a turn that read or carries outside text, a `tainted_action`);
   - a browser submit (a payment, a purchase, entered credentials) and an MCP call (an effect the desk cannot see);
   - a standing grant (lasting access);
   - a calendar cancel, unless cancels can be undone, the event was read before the change, and it has no guests (a cancel emails its guests at once, and no undo reaches them);
   - a send identical to an earlier one whose outcome is unknown.
6. **Every remaining card is decided on the surface showing it.** No chat surface hands a card to the app. A tap there approves it in place. So does the owner telling Waldo to go ahead (`approve_shown`), when every part of their message is their own words, for every kind except a standing grant: lasting access is approved only by a tap on its card. A review too long for one message goes out across up to eight messages ahead of the card that decides it; past that the card still says it cannot be approved.

## Unchanged

Lasting-access grants, owner checks, the taint boundary for outward effects, credential masking, digest-bound payloads (an edited payload is never approved by an earlier yes), one writer per ledger row, and the closure rules. With the switch at `0` every decision is as before, with one tightening that applies either way: `approve_shown` takes a go-ahead only when every part of the owner's message is their own words. `raise_approval undo` is in its schema there too, and refuses.

## Not built here

- **An undo-send hold** (holding a send for a short window before it goes). It needs a durable timer in the owner's Durable Object; sends go out at once and are reported as final.
- **Browser and MCP autonomy.** Every browser step reads a page, so code cannot tell an owner-asked submit from one a page suggested, and a submit can pay or enter a password. They stay cards, decided where shown.

## Width

The owner ruled the wide option on 9 Nov: the whole conversation the model can see, plus recall and what the turn searches. Because Briefs and mail or calendar reads mark most chats, owner-asked work will often go to a card; how often is measured on staging after deploy.
