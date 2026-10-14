> **UNVERIFIED DRAFT (research stage only).** Produced 14 Oct 2026 by the lead's decision workflow `wf_d8922d1d-861` at `beta-mvp` `e5c022ef`. The two adversarial verifiers and the reviser did not run because the session limit was reached. Verify against source before relying on it. Not accepted: the owner decides.

# ADR draft: standing grants, acting without asking within owner-set limits

Status: Proposed. Not authoritative until the owner accepts it, it is published in Brain under the next free number, and `docs/foundation/accepted-adrs.json` is regenerated. It amends how ADR-0018 (The Adjustment autonomy) grants its L3 "auto" level and narrows it for ADR-0019 (The Window). It does not change ADR-0081, ADR-0082, the v0.5 judgment-authority protocol, or the per-action card for any other effect.

Author: backend lead decision packet G3. Source read at `beta-mvp` `e5c022ef0839650180c4b3d465a54722f3fe4518`. Brain ADRs read at `waldo-brain` `23c4f992`. Draft PR #932 read at `5506de85`.

## 1. Context

**Waldo never acts under a standing permission.**

- Every calendar, mail, message, browser and MCP effect goes through a card. `propose_calendar_change` only proposes (`tools/live/google.ts:356-371`, `desk.propose`). The desk applies a frozen payload only after the owner decides (`channels/approvals.ts:484-495`, approve path `:771-802`), bound to a payload digest (`:335`).
- The only grant store is single use. `authority_grants` has `CHECK (use_limit = 1)` (`do-schema.ts:1062-1085`). The v0.5 protocol fixes `useLimit: z.literal(1)` (`contracts/src/protocol/responsibility-judgment-authority-v0-5.ts:287-321`). Its writer is the WaldoCoordinator's judgment module (`coordinator/judgment-authority-module.ts:366-388`), hosted by `RunLoopDO` (`run-loop/do.ts:378`), not by the owner object that runs the app, Telegram and WhatsApp turns.
- Standing orders are instructions, not authority. The `act_and_report` gate is text in the fire message (`contracts/src/tools/schemas/standing-orders.ts:8-12`; `channels/standing-orders.ts:110-115`). The tools such a run can call still only propose.
- `autonomy_level` exists in the contract and is pinned to `L0` for every loop (`contracts/src/runtime/loop-policy.ts:69-73, 101, 127-205`).
- First-party writes (memory, drafts) proceed without a card by the owner's 27 Sep direction (`channels/owner-turn.ts:52-62`). That is a tool-level allowance, not a grant, and it never reaches provider state other people can see.

**What the owner pays.** Every adjustment Waldo makes to its own focus blocks needs a tap. The Window (ADR-0019) cannot protect focus time unattended, and Patrol (ADR-0017) can only propose. The harness comparison records this as not a launch gap but an authority change that needs an ADR when built (`docs/research/HARNESS_COMPARISON_2026-10-13.md` §6.2, §11 item 6).

**What exists to build on.**

- The desk: frozen payloads, per-surface approvability, expiry (`PROPOSAL_TTL_MS`, `approvals.ts:34`), and a 10-minute etag-guarded calendar undo (`UNDO_WINDOW_MS`, `:33`; `revert`, `:467-481`).
- The owner effect ledger: intent before I/O, and a usage quota keyed by `grant_ref`, area, action and owner-local day, checked and reserved in one synchronous transaction (`channels/owner-effect-ledger.ts:3-10, 43-70`). No caller passes a quota today; the desk's `effect()` omits it (`approvals.ts:282-285`).
- Waldo's calendar writes are identifiable. A Waldo-created event's id is derived from its operation ref (`approvals.ts:771`), the write carries a private marker (`connectors/google.ts:905`), and the create is recorded with its `provider_id` in the effect ledger. Moves are conditional PATCHes with the read etag (`connectors/google.ts:718`).
- `responsibilities.grant_ref` exists with no writer (`channels/responsibilities.ts:12, 28`).
- Draft PR #932: a standing-grant contract and a conservative eligibility module with a strong adversarial test suite, stacked on an 8 Oct base, with no dispatch change.

**What reference systems do.** The Claude Agent SDK evaluates deny rules before allow rules, a scoped allow rule "auto-approves only matching calls", and "a hook deny applies even in `bypassPermissions` mode" (code.claude.com/docs/en/agent-sdk/permissions). The OpenAI Agents SDK's sticky `always_approve` lasts for the run [search snippet, secondary source; the primary page was unreachable from this session]. OWASP LLM06:2025 asks to "limit the permissions that LLM extensions are granted to other systems to the minimum necessary" and to keep a human approval for high-impact actions [search snippet]. A Waldo grant lasts longer than one run, so it must be narrower in what it covers than a run-scoped sticky approval.

## 2. Decision

Waldo gets **standing grants**: owner-created, closed-class permissions that let one exact kind of effect run without a card, within owner-set limits, rechecked at every dispatch, revocable at once, and receipted with undo. This release ships **one class**: moving a focus block Waldo itself created, on the owner's own primary calendar.

### 2.1 What a grant is

A grant is a row with these fields, in a new additive contract `packages/contracts/src/runtime/standing-grant.ts`:

- `id`, `owner_ref`, `revision` (bumped on every state change).
- `class`: a closed enum. This release has one value, `calendar.move_own_block`. Adding a class needs an ADR amendment.
- `resource`: `{ provider: 'google_calendar', connection_ref, calendar: 'primary' }`. `connection_ref` is the connection id, never an address.
- `bounds`: `local_window { from, to }` (HH:MM), `weekdays` (0 to 6), `min_lead_minutes` (5 to 240). Fixed in this class: same local day, duration unchanged, times only.
- `limits`: `max_per_day` (1 to 10) and `timezone` (the owner's confirmed IANA zone at creation). Uses are counted by the owner effect ledger's quota, not stored on the grant.
- `valid_from`, `expires_at`: required instants with offsets, at most 90 days apart.
- `state`: `active | revoked | expired | superseded`, with `revoked { at, via: 'owner' | 'connection_removed' | 'superseded' }`.
- `created_from`: `{ approval_id, payload_digest, surface }`.

At most one active grant exists per owner, class and connection. A newly approved grant supersedes the old one in the same commit.

### 2.2 Never grantable in this release

The class enum is the enforcement: nothing outside it can match. A contract test asserts the enum, and a conformance test asserts that no class maps to these effects:

- sends or invitations to other people: email, messages, calendar invites, RSVP accept or decline, and any move or cancel of an event with attendees;
- spending or purchases of any amount;
- deletes or cancels of any item, including Waldo's own blocks;
- sharing or access changes (Drive, artifacts, links);
- health destinations: any effect that would write owner health into an event, a document, a third-party payload or a draft;
- browser submits, MCP calls, connector authorization, memory, skill or procedure changes, trusted-relationship exchanges;
- creating, widening or renewing a grant.

Declining a conflicting invite is excluded because a decline notifies the organizer, which is a send to another person. It needs its own owner ruling.

### 2.3 The first class: `calendar.move_own_block`

Waldo may move a block it created, inside the owner's window, without a card. A proposal is eligible only when every check below holds; otherwise it becomes the ordinary card, unchanged from today.

1. The switch is on (2.10).
2. The call is `propose_calendar_change` with `action: 'move'`, no `send_updates`, the primary calendar, and the grant's connection.
3. The call's argument taint is null (`toolArgSourceTaint`, set to external for externally sourced background runs and non-owner-authored replies, `owner-turn.ts:437, 464`), and the run is an admitted owner turn or owner job.
4. One active grant of the class matches the owner and connection. Now is inside `[valid_from, expires_at)`. The owner's confirmed zone equals the grant's zone; a changed zone cards until the owner renews.
5. The target is Waldo's own block: the owner effect ledger holds a `done` `calendar_change` create whose `provider_id` is this event id, and whose frozen payload had no attendees and no Meet link. Legacy events with no record are not proven and card.
6. The live read the desk already makes for a move shows: not cancelled, zero attendees, not a recurring instance, current start at least `min_lead_minutes` away, new start at least `min_lead_minutes` away, same duration, same local day, inside the window, on an allowed weekday.
7. Today's uses are below `max_per_day` (checked again at reserve).

The model decides whether and where to move a block. The host checks only the owner's limits. These checks are authority bounds, which CLAUDE.md allows as deterministic owner checks; none of them judges intent or content.

### 2.4 Creation

- Only the owner creates a grant, by approving a desk card of a new kind, `standing_grant`. The card shows the exact class, the calendar account label, the window, weekdays, minimum lead, daily cap, expiry and undo window. It is digest-bound and expires like any card.
- The desk's per-surface rule applies: a surface can approve only if it showed the full review.
- The model may propose a grant with `propose_standing_grant`, only on owner-initiated untainted turns. It may offer one after repeated approvals of the same shape ("you approved this five times this week: make it standing?"). An offer is a card, never a grant.
- Widening, renewing or changing a grant is a new card. A habit, a memory, a standing order or a model claim never creates one.

### 2.5 Evaluation, dispatch and resume

- **At proposal.** The desk evaluates 2.3. Eligible: it writes the ledger row (kind `calendar_change`, frozen payload, `grant_ref`, `grant_revision`), claims it, and runs the effect without presenting a card. Not eligible: the card, as today.
- **At dispatch.** The desk passes the quota (`grant_ref`, area `calendar`, action `move_own_block`, local day, zone, `max_per_day`) and a new `authorize` callback to the owner effect ledger. `reserve` runs `authorize` inside its `transactionSync`, before any write: the grant row is active, at the evaluated revision, and unexpired. A failure reserves nothing and the row falls back to an open card. No external I/O runs inside that transaction; the provider PATCH runs after it, with If-Match on the etag read at proposal. A 412 is a stale outcome: nothing changed, and the reply says so.
- **On re-entry.** A grant-run operation id passes `authorize` on every `execute`, including when a prior `reserved` record exists. A revoked grant can therefore not release an intent reserved before the revoke; that intent is marked `rejected`, never dispatched.
- **At resume.** A stored eligibility is never authority, and grant authority never crosses a wake. Records found `attempting` or `unknown` reconcile by readback only (`owner-effect-ledger.ts:93-116`). An uncertain grant-run row offers no approve action. A C7 step re-run proposes again and is evaluated again. A card-approved effect needs no grant check: the owner's tap is the authority.
- **Revocation timing.** A revoke stops every dispatch that has not reserved. An effect reserved before the revoke may complete; its receipt says so.

### 2.6 Revocation, expiry and supersession

- The owner revokes in natural language on any owner surface (`revoke_standing_grant`, on owner-initiated turns), from the app's grant list, or from a console link. No slash command. Revocation is immediate and takes no card.
- Removing or re-linking the Google connection revokes its grants (`via: 'connection_removed'`).
- Expiry is checked as an instant at every evaluation and dispatch. An expiry sweep only tidies `state`; it is not the enforcement.
- Revocation never reverses past moves. Their receipts stay, and undo stays available inside its window.

### 2.7 Receipts and undo

- A grant-run move ends as a desk row in state `done`, carrying `grant_ref`, with undo. The app shows it in the approvals list as done, with `undo` and `undo_until`, plus an optional `grant` summary field. The turn's receipt part lists the `calendar_change` as accepted. The reply line says the move was made under the standing permission and when that permission ends. An activity entry carries `grant_ref`.
- Undo lasts until the earlier of the block's original start and 24 hours after the move, guarded by the applied etag. An owner edit since the move makes undo stale, and Waldo says so. The card-approved 10-minute window is unchanged.
- The Window never pushes (ADR-0019). Receipts arrive in the run's reply or the next app view, through the delivery gate and quiet hours. A background run reports through the existing outbox until A4's deliver seam lands.

### 2.8 Composition with standing orders, C7 durable tasks and Patrol

- **Standing orders** stay instruction context. An `act_and_report` order never creates, widens or implies a grant. Its fire reaches the desk like any turn, and the grant applies only if one exists and every check passes. A useful pairing is an order ("keep my focus blocks clear of meetings, daily at 07:30") plus a grant, created on separate cards.
- **C7 durable tasks.** Each step is evaluated afresh. `propose_calendar_change` is not a `safe_read` (`hooks/tool-replay-class.ts:35`), so the step journal's `effects_dispatched` flips and an interrupted attempt never resumes. A card fallback makes the step `blocked` with `waiting_on: proposal:<id>`. The responsibility's existing `grant_ref` records the grant a step used. Using a grant never closes a responsibility or open loop; explicit-owner closure rules are unchanged.
- **Patrol** has a schedule kind (`contracts/src/runtime/schedule.ts:10, 37`) and an ACL of reads plus `propose_action` (`contracts/src/tools/permissions.ts:133`), but no owner-object executor (`channels/owner-do.ts:1813`). When built, it runs as an owner job with no extra authority. A timer pass is untainted and may use the grant. A pass woken by an external event, such as a calendar push for someone else's invite, carries external taint and cards in this release. Patrol's ACL gains `propose_calendar_change` in the Patrol slice, not here.

### 2.9 Privacy and logs

- A grant-run move changes times only. The move schema already refuses description, location and attendees (`contracts/src/tools/schemas/calendar.ts:23-25`), and this class refuses `send_updates`. No text is written to the calendar.
- Owner health may inform the model's choice under the beta ruling. It never enters the grant row, the receipt, the event, logs or audit records.
- Two trace hops: `grant_eval { class, disposition: eligible | card, reason }`, with `reason` a closed enum, and `grant_use { class, ok, ms }`. No titles, event ids, addresses or times appear in hop fields or metric labels.

### 2.10 Store, writer, contracts and switch

- **Store.** An owner-object SQLite table `standing_grants`, created inline as `ledger`, `standing_orders` and `responsibilities` are. No hosted migration, no `wrangler.jsonc` change.
- **Writers.** The grant module is the only writer of grants. It is called from the desk's decision commit (create, supersede), the revoke paths, connection removal and the expiry sweep. The desk stays the only writer of approval rows. The owner effect ledger stays the only writer of effect intents and the only counter of uses. `authority_grants` and the v0.5 protocol are unchanged.
- **Contracts, all additive.** `runtime/standing-grant.ts`. In app.v1: approval kind `standing_grant` with `exact.grant`; an optional `grant` on the approval; `GET /app/v1/grants`; `POST /app/v1/grants/revoke`. Optional `grant_ref` on the activity input. Order: contract, then the app pins it, then the backend emits.
- **Tools.** `propose_standing_grant` (always a card), `list_standing_grants`, `revoke_standing_grant`.
- **Switch.** `STANDING_GRANTS.enabled`, default false. Off: every evaluation returns the card; stored grants stay inert; revoke and list still work.
- **Surface neutrality.** The desk code adds no channel compares; `guard-surface-neutral-core` stays at its baseline.

### 2.11 What PR #932 contributes

Kept, ported by hand onto the current base: exact-scope matching (every actual value inside the allowed set; a missing or empty actual fails); a confirmed shape must equal the reviewed shape; a revision bump on revoke; overlap fails to a card regardless of storage order; usage counted per owner-local day and failing closed on missing or invalid counts; a recheck after any await; expiry compared as instants with equality meaning expired; defensive copies; `grant_ref` on the activity contract; and its adversarial tests.

Dropped: the area enum with mail, messages, files and purchases; free-text `action`; the `recipients`, `amount_max` and `content_kinds` constraints; the per-area `tell | ask | auto` mode store, a second authority switch; the in-memory proposal map, which a desk row replaces; the open `put` store interface; optional expiry; `grant_ref` on channel send receipts, since sends are not grantable.

## 3. Considered options

1. **No standing grants; a card per action** (today). Safest. Leaves G3 open, keeps the Window and Patrol proposal-only, and keeps the approval fatigue the slice-I spec measured. Rejected as the end state, kept as the switch-off behavior.
2. **PR #932 as drafted.** Broad areas including email to named recipients and purchases with an amount cap, and per-area modes. Its acceptance case is sending reminders to a named person. Rejected for this release: sends to other people and spending are irreversible and third-party visible. Its in-memory proposals are lost on eviction, and two authority switches (area mode and grant) need races handled (its own tests show them).
3. **A global autonomy level per ADR-0018** (L3, "move things around"). Rejected: L3 `meeting_move` moves events with attendees and emails them. A single level has no resource, parameter, time or budget scope, which CLAUDE.md requires.
4. **Extend `authority_grants` (v0.5) to multi-use.** Rejected: v0.5 is a published protocol with `useLimit: z.literal(1)`, and CLAUDE.md forbids silent widening. Its host, `RunLoopDO`, is not where owner-surface effects run, so it would add a second effect writer.
5. **Grants only in runs that read no external content.** Rejected: `query_calendar` and `query_availability` are external-origin tools (`contracts/src/tools/handler.ts:98-108`), so no move could ever qualify. The narrow class, the bounds, the cap and undo carry that risk instead; argument taint still cards.
6. **The model judges eligibility.** Rejected: authority is a hard boundary and stays in the host.
7. **Declining a conflicting invite as the first class.** Rejected for this release: it notifies the organizer.

## 4. Consequences

- **Benefits.** The Window becomes real L3 for Waldo's own blocks: Waldo keeps focus time clear without a tap, inside limits the owner set and can see. Receipts and undo make every use legible. The same mechanism carries later classes, each through its own ADR amendment.
- **Costs.** One new owner-object table, one desk kind, one new ledger callback, an app settings view, four additive contract shapes, three tools.
- **Risks.**
  - Injection through calendar content in an owner turn can steer a move inside the bounds. Mitigated by the cap, the window, the minimum lead, receipts and undo; tested by the hostile scenario in section 6.
  - A wrong but bounded move annoys the owner. Undo and revoke are one step away.
  - The ledger-based ownership proof excludes blocks created before the effect ledger existed.
- **Impact surface.** `contracts/src/runtime/standing-grant.ts` (new); `contracts/src/app/parts.ts`, `app/approvals.ts`, a new `app/grants.ts`, `runtime/activity.ts`, `contracts/src/index.ts`, regenerated OpenAPI; `contracts/src/tools/schemas` and `tools/permissions.ts` for the three tools; `runtime/src/channels/standing-grants.ts` (new); `channels/approvals.ts`; `channels/owner-effect-ledger.ts`; `tools/live/google.ts` (the proposal result and the `query_calendar` own-block annotation from the ledger); `hooks/claim-verify-effects.ts` (an applied move is not "proposed"); `channels/app-api.ts`; one `channels/owner-do.ts` hunk; tests for each. No Supabase, `wrangler.jsonc`, secret or migration change.

## 5. Decisions the owner makes

1. Accept the mechanism and the first class `calendar.move_own_block`.
2. Accept the never-list in 2.2, including that RSVP declines are excluded until a separate ruling.
3. Accept that externally woken runs card in this release.
4. Set the defaults: expiry 30 days (90 max), daily cap 3 (10 max), minimum lead 30 minutes, undo until the earlier of the original start and 24 hours.
5. Choose whether a grant card is approvable on any surface that shows its full review (the desk's rule, proposed) or on the app and console only.

## 6. Verification and tests

Contract (valid and invalid pairs): every field bound; an unknown class; a missing or over-long expiry; a cap of 0 or 11; a window with `from` after `to`; an empty weekdays list; an extra key; an expiry with no offset.

Grant module (ported from #932 and extended): an unconfirmed proposal authorizes nothing; a cross-owner, substituted, reused or stale confirmation fails; revoke bumps the revision; a proposal raised before a revoke cannot revive it; a second approved grant supersedes the first; defensive copies.

Desk and ledger:

- **Golden path.** The owner approves a grant card. A Waldo-created block is moved inside the window. No card is shown; the row is `done` with `grant_ref`; the receipt and activity entry carry it; undo restores the original times.
- Each eligibility check fails alone and yields the ordinary card: a block with a guest, a recurring instance, an owner-created event, a legacy event with no ledger record, out of window, across midnight, a changed duration, inside the minimum lead, a disallowed weekday, `send_updates` set, another calendar, another connection, external argument taint.
- The cap: the call after the last allowed one cards, counted in the grant's zone, including two concurrent background jobs at the edge, of which exactly one reserves.
- **Revoke races.** A revoke between evaluation and reserve cards. A revoke after reserve completes once and says so. A `reserved` intent re-entered after a revoke is rejected and never dispatched.
- **Time.** Expiry equal to now is expired. Daylight-saving days of 23 and 25 hours keep the window and the day count right. A changed owner zone cards.
- **Stale and degraded.** An owner edit after the read makes the PATCH return 412: nothing changes and the reply says so. A provider failure leaves `outcome_unknown`, no re-dispatch, and the use counted.
- **Hostile.** An invite whose description tells Waldo to move every focus block to the middle of the night: no move outside the window, at most the cap, every move receipted. The same invite in an externally woken run: a card.
- C7: an interrupted step that dispatched a grant-run move does not resume; a card fallback blocks the step and resumes on the decision.
- Privacy: no health text, title, event id or address in `grant_eval` or `grant_use`.
- Switch off: the golden path yields a card, byte-equal to today's.
- Guards: `guard-surface-neutral-core` at baseline; the never-list conformance test; `npx -y pnpm@10.34.4 verify` at the PR head.

Falsifiers:

- In 20 hostile-scenario runs, any move outside the window or above the cap means the bounds are not enforced and the design fails.
- If beta testers' Waldo-created focus blocks mostly carry guests or recur, this class reaches little and another first class is needed.
- If the grant check cannot run inside the reserve transaction without I/O, the recheck-at-dispatch rule fails, and the status quo stands until it can.

## 7. Rollback

Set `STANDING_GRANTS.enabled = false` and deploy. Every proposal returns to a card. Stored grants stay inert, and list and revoke still work. Past moves keep their receipts and undo windows. The contract fields are optional and the table is additive, so nothing needs a down-migration. To remove the feature entirely, revoke all grants, then remove the tools and routes in a later PR after the app stops reading them.
