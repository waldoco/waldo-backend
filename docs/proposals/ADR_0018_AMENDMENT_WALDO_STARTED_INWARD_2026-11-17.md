# ADR-0018 amendment: inward, undoable changes in runs Waldo started (17 November 2026)

> **Status: Accepted by owner ruling, 16 Nov 2026** (waldoco/waldo-app#257, comment 6926736096, ruling 2: "Inward, undoable changes in Waldo-started runs need no card, even after reading mail. What outside content asks for still gets a card." Consistent with the rulings of 8 and 13 Nov, D1). It amends [`ADR_0018_AMENDMENT_JUST_DO_IT_2026-11-14.md`](ADR_0018_AMENDMENT_JUST_DO_IT_2026-11-14.md) §2 and §5, which kept a card for every effect of "a proactive run, a Brief, a webhook, or a task job". Behind `AUTONOMY_WALDO_INWARD` (`1` in staging, `0` in production). It does nothing where `AUTONOMOUS_BY_DEFAULT` is not `1` or where the owner's "Just do it" choice is off.

## Decision

1. **A run Waldo started may make an inward change it can undo, with no card.** That includes such a run that has read mail, a calendar invite or another tool's answer. The run is recorded and keyed through the same path as an owner-asked run (`runAsked` → `decideOnce`: `<operation>:apply` effect keys, recorded before dispatch and never dispatched inside the SQLite transaction).
   - **The desk itself always tells the owner** ("Done without asking: …", with an Undo button where the surface has buttons), whatever the run's own reply says or whether it stays silent. Being told is part of the safety bound.
   - A change made this way counts against the owner's interruption limit as a card does.
   - A run that came back without an Undo logs `approval_waldo_run:no_undo`.
2. **"A run Waldo started" is provenance, set by the host.** The caller that starts the run marks it Waldo-first: a day card, a loop check-back, the update sweep, an intervention, and later the wake run of the model-set wakes design. The host then sets `waldoStarted` on the run's tool context, and the approvals desk reads it there (`askedBy`), never from a tool's arguments. The following are never Waldo-started, so their effects keep the 14 Nov rules:
   - a run that answers the owner (their own turn, a retry of it, a Mac result, a task's report);
   - a run that someone else's words started: inbound mail to the Waldo address, a forward, and an `/events/` webhook (ruling 3). An update-sweep batch that carries a webhook's change, and a day card whose updates carry one, are not Waldo-started either.

   The update sweep that a push from the owner's own Gmail or Calendar pulls forward stays Waldo-started. Its input is the owner's own mail and calendar, which is the D1 case ("even when the idea came from mail or an invite").
3. **"Inward and undoable" is bounded in code** (`inwardUndoable` in `channels/approvals.ts`):
   - **a day plan's blocks.** They carry no guests, and Undo removes them;
   - **a calendar change on the owner's own primary calendar that invites, emails or links no one and carries no text beyond its title.** That means:
     - no attendees, no `send_updates: all` and no Meet link;
     - no description, location or rename, because a shared calendar shows these to others;
     - no event in a series (an instance or its master), because a change there reaches every instance;
     - and for a move or a cancel, an event read before the change that has no guests;
   - **no proposal that replaces another card.** Replacing happens where the owner sees the new card;
   - **a cancel**, only where Waldo can put it back (`CALENDAR_UNDO_CANCEL`, an event read before the change). One it cannot put back is a permanent deletion and keeps its card.

   Whether the change serves the owner is the model's judgment. Code bounds only what may run unasked. Waldo's own follow-ups (`open_loop` with no mail source, `MODEL_SET_WAKES`) were already card-free under the same provenance and stay governed by their own bounds.
4. **Cards remain**, with the switch on, for every effect of a Waldo-started run that is not inward and undoable:
   - every send (mail, a message, mail as Waldo), even one addressed to the owner;
   - a calendar change on another calendar, with guests, or that notifies anyone;
   - a Google task change (it has no undo);
   - an MCP call, a browser submit and a standing grant;
   - a `tainted_action`, which is how a run puts on the owner's card what outside content itself asked for.
5. **What outside content asks for still gets a card.** Code cannot read whether an idea came from a mail or from Waldo, and this repo allows no fixed rule to judge that. The ruling is therefore held two ways:
   - **provenance:** a run that outside content started is never Waldo-started (2);
   - **the inward bound:** the worst an injected instruction can reach in a Waldo-started run is a guest-free change to the owner's own calendar that is reported with an Undo (3, 4).

   This is the risk D1 accepted on 13 Nov.

## Considered

- **Keep a standing grant as the only path** (`calendar.move_own_block`, the 14 Nov state). Rejected by the ruling. It already lets Waldo-started runs (origin `waldo`) move Waldo-made blocks inside an owner-set window, but not after an outside read (origin `external`), and not to add a block or plan a day without a grant the owner must first create. The grant path stays as it is, for owners who want a window.
- **Judge "outside content asked for it" by reading the run's text.** Rejected. It is a judgment call; it belongs to the model, which routes such an action to `propose_action` (a `tainted_action` card).

## Unchanged

- The 8 and 14 Nov amendments for owner-started turns, the recipient guard, closure rules, digest-bound payloads and owner checks.
- With `AUTONOMY_WALDO_INWARD` at `0`, a Waldo-started run cards every effect, exactly as on 14 Nov, apart from the standing grant path.

## Rollback

`AUTONOMY_WALDO_INWARD` to `0`. Changes already made stay made and keep their Undo.
