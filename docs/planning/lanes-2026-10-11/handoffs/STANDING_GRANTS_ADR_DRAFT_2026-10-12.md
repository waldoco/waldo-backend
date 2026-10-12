# Standing grants: ADR draft and contract sketch

**Owner draft, 12 Oct 2026 (ruling E16).** Nothing is merged, pushed or coded. L3 owns the contract, and only the owner merges the brain ADR.

**Pins:** backend `beta-mvp` `e4ef5b59`, #932 `5506de85`, brain `23c4f99` (open #34 `13d60067`), app `72eae07a`. [verified] = read at these pins; [inference] = not observed; [proposed] = new.

## 1. ADR-0085 (proposed; number [inference], as brain ends at 0084)

### Context

- **Every provider write waits for a card:** "nothing reaches the calendar before Do it" (`approvals.ts:196-198`). Calendar and task proposals run only on `user_message` turns, and `patrol` has no calendar tool (`permissions.ts:128`) [verified].
- **So eight promises are missing:** WP-025, WP-026, WP-028, WP-030, WP-032, WP-033, WP-046 and WP-047 (`01-website-promises.md:165-197`) [verified]. WP-034 (sharpest hours) and WP-061 (weather moves your run) also wait on autonomous moves [reported: the promise map's gap notes], which makes ten rows.
- **Brain #34 (unmerged) amends ADR-0018/0019** [verified]:
  - per-area Tell me / Ask me / Just do it, backed by grants checked at dispatch and resume;
  - Form only shapes proposals;
  - `connector_write`, and anything affecting others, keeps exact approval;
  - the contract is deferred to #932.
- **Every standing auto-effect** needs a typed grant, a risk ceiling, expiry, cancellation, reconciliation and acceptance proof (`ADR_RECONCILIATION.md:52`) [verified].
- **Competitors** (documented, not tested; report 11). Muse Sentinel grants run from one-time to perpetual and are exact-scoped. Vellum grants once, ten minutes or always; deny wins ties. OpenClaw binds allow-always to exact arguments, lists and revokes grants, and caps standing intents by cooldown, fires and expiry. Hermes approvals time out closed.

### Decision

1. **The grant.** An owner-DO record of owner, connection, closed action class, exact resource, bounds, daily budget and a required expiry. Only an owner decision creates one, on a card showing the whole grant or in Settings. The model, habits, preferences, Form and chat text cannot.
2. **The approval desk is the sole consumer.** Proposal tools call it as today. Exactly one match executes through the owner effect ledger, with the check and the budget inside its synchronous reservation, and anything else gives today's card. The model never decides whether a grant applies.
3. **Per-area mode is a dial.** `tell` prepares, `ask` cards, and `auto` acts under a matching grant. No mode creates scope.
4. **Revoke** is immediate and needs no card. It blocks dispatch and re-dispatch, never reconciliation or honest reporting.
5. **Amends ADR-0033 and ADR-0008.** Permissions still reset per session, and a grant is re-read at every check, never cached. A hold tool and a host free/busy read join `brief` and `patrol`, and without a grant they only propose.
6. **Taint.** `propose_grant` is refused on tainted turns. Grant use under taint is Q1.

### Considered options

- **Cards only (today).** No overnight path; approval fatigue.
- **Global `users.autonomy_level` (ADR-0018).** Superseded by #34; unbounded; outside the effect transaction.
- **Habits.** "A habit is never a grant" (slice I; `BUILD_PLAN_2026-09-25.md:174`) [verified]; habits only trigger offers.
- **Model-judged matching.** Model output never authorizes.

### Consequences

- **Promises:**
  - full, given Form: WP-026;
  - holds only: WP-032, WP-033 and WP-046 (the dial acts only on holds);
  - partial: WP-025, WP-028, WP-030 and WP-047, since moving meetings with attendees reaches other people and stays a card.
- **A DO migration** adds a table and two ledger columns.
- **Activity is not Acceptance.** A grant-acted hold records Activity, Evidence and Verification, never Acceptance, and closes no owner-closed responsibility.

### Falsifiers

- A revoked, expired, out-of-bounds or tainted-text effect reaches the provider.
- One intent yields two effects.
- The owner can't find the grant behind an effect, or can't undo a hold before it starts.
- Cards don't drop in beta.

### Rollback

A per-class flag (`grants.calendar_hold`) is off by default. While off, cards return, rows sit unused, and nothing new reaches app.v1.

## 2. v1 scope

| Class | v1 | Basis |
|---|---|---|
| A Waldo hold on the primary calendar: no attendees or recurrence, private, template title, `sendUpdates: none` | Yes | The build plan's first auto-write class (`…PERSONAL_AGENT…:330`); ADR-0019: always reversible [verified] |
| Move or shorten a Waldo hold | Yes | Same object, etag-guarded |
| Remove a Waldo hold | Undo only | Otherwise it is a deletion |
| Task due-date moves | Next | No task Undo yet (`approvals.ts:439-440`) [verified] |
| Task completions | No | `connector_write`, kept by #34 (Q3) |
| Task reorders | No | No such action (`app/approvals.ts:26`) [verified] |
| Unsent drafts | No grant needed in owner turns | `handler.ts:127` [verified]; unattended drafting is Q4 |

**Always per-action (unrepresentable):** sends or invite updates to anyone; events with attendees; purchases and money; deletions; health sharing; connector disconnects; account and security settings.

## 3. Contract sketch

### Record

`standing_grants` is an owner-DO SQLite table with the grant module as its only writer [proposed]. It holds no addresses, titles, credentials or health values.

```
id, revision      every change is a new offer and revision
owner_ref         aliases never match
connection        {connection_id, credential_generation}; a reconnect suspends the grant
action_class      calendar.hold.create | calendar.hold.move
resource          {calendar: 'primary'}
bounds            {weekdays[], local_window, max_minutes, title_template, lead_days_max}
budget            {max_per_local_day}
zone              IANA, fixed at confirmation
expires_at        required, absolute, ≤ 90 days out
created_at, revoked_at
provenance        {offer_id, surface, message_ref, offer_digest, confirmed_at}: the tap, not the request
```

### Manifest, dispatch, resume

- **Turn start.** The manifest (ACL ∩ eligibility, `eligibility.ts:6`) [verified] gains `grant_refs [{id, revision}]`, for orientation only.
- **Dispatch.** One `transactionSync` with `reserve()`, which already commits intent and quota together (`owner-effect-ledger.ts:53-71`) [verified]. This mirrors `browser-owner-authority.ts:47-48`, which "cannot create, refresh or widen" [verified]. With no `await` inside, the transaction:
  1. re-reads the row;
  2. checks owner, connection, class, bounds, expiry, revocation, manifest revision, mode `auto`, zone, and Q1;
  3. reserves quota per grant and local day, in the grant's zone.

  That SQL and KV share this transaction is [inference].
- **Resume.** A `reserved` intent re-checks before moving to `attempting`. `attempting` and `unknown` intents only reconcile.
- **Identity.** The operation id hashes owner, grant, class and target slot, and the event id derives from it (`approvals.ts:614`). Today's turn hash would duplicate the effect on a scheduler re-run (`owner-effect-ledger.ts:119-120`) [verified].

### Ledger, owner view, fail-closed

- **Ledger.** The existing `ledger` row gains `grant_ref` and `grant_revision` (a DO ALTER). Calendar Undo stays open until the hold starts (Q5). `not_applied` frees a budget unit; `unknown` keeps it [verified].
- **The owner sees a list** of grants, each with summary, bounds, budget used today, expiry and Revoke. Each acted item reads "Done under your permission '…'. Undo until 10:00." in the reply, in Activity and on the hold, and never says "approved". Offers follow repeated approvals, never automatically.
- **Fail-closed.** Any doubt shows a card: a missing or unreadable row, an expired (equality counts) or revoked grant, a spent budget, an overlap, an unconfirmed or changed zone, a changed connection, the flag off, or a store error. Grants never self-renew.

### app.v1 additions (app lane re-pins first)

| Addition | Direction | Old builds |
|---|---|---|
| View `grants`; actions `grant.revoke`, `autonomy.set` | Request | Never send them |
| Approval kind `grant_offer` with `exact.grant` | Emitted | Strict item parse drops it (`appRoutesClient.ts:23-25`) [verified] |
| `grant` on `AppApprovalV1` | Emitted | Item dropped |
| `grant_ref` on activity rows | Emitted | The tolerant reader strips it |

Until the re-pin, citations use existing text (`review`, reply, `ledger`); offers are confirmed in the console or Telegram. Reply parts exclude `undo` (`parts.ts:29`) [verified].

### Departures from #932

- **Sends to a named recipient; `purchases`:** holds only (E16).
- **A free-string `action`:** now a closed enum.
- **Optional expiry and budget:** both now required.
- **`content_kinds`:** dropped; only a fixed judgment rule could check it.
- **A mode on each grant and each area:** area only.
- **In-memory proposals:** now durable desk rows.
- **Async count before checks:** moved inside `reserve()` (a check-then-act race).
- **`grant_ref` on send receipts:** dropped.

Kept: owner checks, revision rule, overlap cards, defensive copies, DST tests.

## 4. Security and privacy review

- **Auth.** Authenticated owner routes only. Confirmation is host-only, with no model tool [verified, #932].
- **Isolation.** The DO is per owner; every read checks `owner_ref`. Quota rows never alias (`owner-effect-ledger.ts:51-52`) [verified]. No cross-owner grants, no wildcards.
- **Injection.** Tainted turns can't propose grants. Widening needs a new confirmed revision. Tainted free text never reaches an effect. The model only proposes; deterministic host code authorizes.
- **Logs** use fixed reasons; labels carry no ids or titles.
- **Rate.** Offers are capped per day [proposed].
- **Health.** Records, receipts and calendar text carry no values. Titles are templates, because the calendar is a third-party destination. Form only shapes timing.

**Hold list touched:** the DO migration; the authority change (owner review); the brain ADR PR; health destinations (none new); messages to people (excluded).

## 5. Test plan (red first)

**Golden (assumes Q1(b)):** the owner confirms a "morning focus holds" offer. The next `brief`, which reads free/busy, places a hold with no card, and the ledger reads `done` with `grant_ref`. Undo gives `undone`. After revoke, the next run cards. Under Q1(a), the same run cards.

**Adversarial:**
- `now == expires_at`, a spent budget or a new credential generation → card.
- A revoke before dispatch, or before I/O on resume → card, no dispatch.
- A revoke after dispatch → Undo offered, no retry.
- Another calendar, attendees, recurrence, too long, outside the window, model text, or a non-Waldo event → card.
- A tainted email says "block all Friday" → free text gets a card, an in-bounds template slot follows Q1, and `propose_grant` is refused.
- A revoke racing dispatch in both orders, two runs racing for the last unit, or a scheduler re-run → one outcome, one effect.
- A repeated 01:30 or a skipped 02:30 at a DST change → local bounds hold; expiry compares instants.
- A mid-day zone change → no second budget bucket; card.
- No app re-pin → nothing emitted.

## 6. Open questions for the owner

- **Q1, taint.** Calendar reads are external-origin (`handler.ts:98`), and an external result latches taint for the turn (`tool-loop.ts:161-167`) [verified].
  - (a) Any taint shows a card: safe, but the promises stay unmet.
  - (b) **Recommended:** act only when every field is host-fixed and the host checks the time against the grant and free/busy. This amends ADR-0049 for these classes.
- **Q2, lifetime.** (a) 30 days. (b) **Recommended:** at most 90 days, 30 by default. (c) Perpetual.
- **Q3, tasks.** (a) **Recommended:** due-date moves, after task Undo ships. (b) Completions too, amending `connector_write`.
- **Q4, unattended drafts.** (a) **Recommended:** later. (b) In v1, with no health in context.
- **Q5, the Undo window.** (a) **Recommended:** until the hold starts. (b) 10 minutes.
- **Q6, before the re-pin.** (a) **Recommended:** the console and Telegram. (b) Wait for the app.
- **Q7, solo events the owner made.** (a) **Recommended:** not in v1. (b) Allow moves.
