# ADR-0018 amendment: "Just do it", a per-owner choice, with provenance as the line (14 November 2026)

> **Status: Proposed by Ashish, needs owner ack.** This amends [`ADR_0018_AMENDMENT_AUTONOMOUS_BY_DEFAULT_2026-11-08.md`](ADR_0018_AMENDMENT_AUTONOMOUS_BY_DEFAULT_2026-11-08.md). It changes what the owner ruled on 8 and 9 November (waldoco/waldo-backend#2003): the wide "carries from before" taint rule no longer decides a turn that the owner started. Production stays off. `AUTONOMOUS_BY_DEFAULT` is still the master switch (`1` in staging, `0` in production). The widened rule is behind its own switch, `AUTONOMY_OWNER_TURNS` (`1` in staging, `0` in production).

## Decision

1. **The owner chooses: "Just do it — Waldo won't ask before acting."** It is on by default, for new and existing owners alike. It is kept in the owner object (`act_without_asking_v1`; no migration). The app changes it through the day view (contract pair `act_without_asking=1`), and the website changes it on Settings > Your day. Both are covered by the same fixed receipts (`APP_ACT_WITHOUT_ASKING_RECEIPTS_V1`).
   - **Off:** every consequential effect is a card, exactly as before autonomy by default. The desk's `autonomous()` is the master switch and the choice together, so off takes the same path as a switch at `0`. That includes the app hand-off and the owner's word being unable to undo.
   - **Where the master switch is `0`:** the choice is saved, reads `available: false`, and changes nothing. The settings say "not active on this Waldo yet" instead of showing it as on.
2. **The line is provenance.** A turn that the owner started with their own message may act even after it read outside text: an email, a page, a tool's answer, or a summary or note that carries someone else's words. A turn that something else started still raises a card for its effects: inbound mail, a forward or quote, a proactive run, a Brief, a webhook, or a task job. The host already sets this once, at the start of the turn (`runOrigin === 'owner'` with `ownerMessage`). What the turn reads afterwards never changes it. No keyword, intent reading or threshold decides it. The model still judges what to do.
3. **The recipient guard: one narrow, code-checked rule against injection inside an owner-started turn.** When a turn passes only under the owner rule (it read or carries outside text), an effect that reaches another party runs with no card only if every party meets one of two conditions:
   - **in the owner's own words:** the address appears in the owner's own typed or spoken words in this message. A quote, a file transcript or a media note does not count.
   - **already reached:** Waldo has already reached the party: a recipient of a send that went out, or a guest of an event Waldo made. Each such party went out on the owner's tap or passed this same guard, so outside text cannot seed the list.

   The parties are an email's to/cc/bcc, an email sent as Waldo, and a new event's guests. If code cannot list who an effect reaches, it goes to a card. That covers an MCP write that speaks as the owner, such as a Slack post. The guard compares addresses. It never reads what the owner meant. It catches the main exfiltration path: "handle my inbox" reads a mail asking for the figures to go to an address the owner never named.

   The people map is deliberately not a source of known contacts. A model write from a tainted turn can merge an address into a person the owner knows, so an address there carries no provenance.
4. **With the choice on, these run with no card in an owner-started turn,** recorded, keyed and reported exactly as autonomy by default runs them (`decideOnce`, `<operation>:apply` effect keys, an undo where one exists, the "what Waldo did" line):
   - sends (Gmail, a message, mail as Waldo), calendar changes and day plans, and Google task changes, including work in a turn that has read email;
   - **MCP tool calls on a catalogue app** (the console's tiles: Notion, Todoist, Linear, Slack, Fireflies, Wispr, Granola);
   - **a calendar cancel that Waldo can put back** (`CALENDAR_UNDO_CANCEL` is on and the event was read before the change). Guests included: the owner asked to cancel, and the undo restores the event.
5. **Cards remain, even with the choice on, for:**
   - **payments and purchases, and entered passwords or credentials.** A browser submit is always a card (see 6). An MCP call on a server the owner added by its address is a card, because code cannot tell a purchase there.
   - **permanent deletion:** a calendar cancel that Waldo cannot put back, and an MCP tool whose server marks it `destructiveHint: true`;
   - **what outside content itself asked for:** every effect of a turn that outside content started (2), a `tainted_action`, and a party that only outside text named (3);
   - **lasting access:** a standing grant. Only a tap on its card approves it. *This is Ashish's call to reverse*, since it is the closest thing to credentials;
   - a send identical to an earlier one whose outcome is unknown.
6. **Browser submits stay cards.** Code cannot reliably tell a payment, purchase or credential submit from an ordinary form submit:
   - a saved card pays with no card fields on the page;
   - checkout fields often sit in a cross-origin iframe the page cannot read;
   - `secretKeys` marks only fields the page itself labels as secret.

   An ordinary Google Form therefore still asks first. A rule built on field names or URLs would be a guess, and this repo does not allow a fixed rule to make that kind of judgment call.

## Unchanged

- Everything in the autonomous-by-default amendment §3, §4 and §6: the decision path, receipts, undo, decided-where-shown cards, and `approve_shown`.
- With `AUTONOMY_OWNER_TURNS` at `0` and the choice on, the narrow 2078 rule decides alone, exactly as on 13 November.
- Owner checks, digest-bound payloads, credential masking and closure rules.

## Not built here

- Known contacts from the owner's Gmail sent history or Google Contacts. Each would widen the guard's known set, but needs a read the desk does not make before deciding.
- A steering message that arrives mid-turn is not part of "the owner's own words" for the guard. A recipient named only there goes to a card.
