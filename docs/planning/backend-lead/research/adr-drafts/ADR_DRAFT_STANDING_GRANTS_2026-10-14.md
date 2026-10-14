> **DRAFT for owner decision.** Written 14 Oct 2026 by the backend lead's decision workflow `wf_d8922d1d-861` at `beta-mvp` `e5c022ef`. Each draft went through research, two adversarial verifiers (source and risk) and a reviser. Status: Proposed. Not accepted until the owner says so.

# ADR draft: standing grants, acting without asking within owner-set limits

Status: Proposed. Not authoritative until the owner accepts it, it is published in Brain under the next free number, and `docs/foundation/accepted-adrs.json` is regenerated.

What it changes:
- It amends how ADR-0018 (The Adjustment autonomy) grants its L3 "auto" level, and narrows it for ADR-0019 (The Window).
- It is the explicit policy and contract update that ADR-0074 (loop governor) requires before an L3 activation. It covers one effect, not a loop, and section 6 is its graduation evidence.
- It states how this class relates to ADR-0049's turn taint.

What it does not change: ADR-0081, ADR-0082, the v0.5 judgment-authority protocol, loop `autonomy_level` (every loop stays L0), or the per-action card for any other effect.

Author: backend lead decision packet G3. Source read at `beta-mvp` `e5c022ef0839650180c4b3d465a54722f3fe4518`. Brain ADRs read at `waldo-brain` `23c4f992`. Draft PR #932 read at `5506de85`.

## 1. Context

**Waldo never acts under a standing permission.**

- Every calendar, mail, message, browser and MCP effect goes through a card. `propose_calendar_change` only proposes (`tools/live/google.ts:356-371`, `desk.propose`). Its description tells the model a review card was sent (`:357`, `:367`).
- The desk applies a frozen payload only after the owner decides (`channels/approvals.ts:484-495`; approve path `:771-802`). The payload is bound to a digest (`:335`).
- The only grant store is single use. `authority_grants` has `CHECK (use_limit = 1)` (`do-schema.ts:1062-1085`), and the v0.5 protocol fixes `useLimit: z.literal(1)` (`contracts/src/protocol/responsibility-judgment-authority-v0-5.ts:287-321`).
- That store's writer is the WaldoCoordinator's judgment module (`coordinator/judgment-authority-module.ts:366-388`). `RunLoopDO` builds the coordinator only in local run-loop environments (`run-loop/do.ts:376-378`). It does not run on the owner object that serves the app, Telegram and WhatsApp.
- Standing orders are instructions, not authority. The `act_and_report` gate is text in the fire message (`contracts/src/tools/schemas/standing-orders.ts:8-12`; `channels/standing-orders.ts:110-115`).
- `autonomy_level` is pinned to `L0` for every loop. ADR-0074's note says L3 means "unattended low-stakes behind a graduation gate" and needs a policy or contract update plus conformance proof (`contracts/src/runtime/loop-policy.ts:69-72`).
- First-party writes (memory, drafts) proceed without a card by the owner's 27 Sep direction (`channels/owner-turn.ts:52-62`). That is a tool-level allowance, not a grant.

**Taint builds up across a turn.** A tool result stamped external taints the rest of the turn (`conversation/tool-loop.ts:208-215`, ADR-0049). `query_calendar` and `query_availability` are external-origin (`contracts/src/tools/handler.ts:98-108`), so any turn that reads the calendar before proposing a move is tainted. Today that does not matter for calendar moves: `propose_calendar_change` is not a privileged action under the autonomy gate (`hooks/registry.ts:418-470`), and the card is its protection. A grant removes the card, so this ADR must name a different control.

**What the owner pays.** Every adjustment needs a tap. The Window (ADR-0019) cannot protect focus time unattended, and Patrol (ADR-0017) can only propose. No code creates Window blocks yet; "The Window" exists only as prompt vocabulary (`prompt/messaging-behavior.ts:27`). The harness comparison records standing grants as an authority change that needs an ADR (`docs/research/HARNESS_COMPARISON_2026-10-13.md` §6.2, §11 item 6).

**What exists to build on.**
- The desk: frozen payloads, per-surface approvability, expiry (`PROPOSAL_TTL_MS`, `approvals.ts:34`), and a 10-minute etag-guarded calendar undo (`UNDO_WINDOW_MS`, `:33`; `revert`, `:467-481`; checked at `:396`, `:803`, `:1066`).
- The owner effect ledger: intent before I/O, and a usage quota checked and reserved in one synchronous transaction (`channels/owner-effect-ledger.ts:3-10, 43-70`). A prior record is returned before any quota check. Records not in `reserved` are only read back, never re-dispatched (`:52-56`, `:96-104`). No caller passes a quota today (`approvals.ts:282-285`).
- Calendar creates use an id derived from the operation (`sha256(operationRef + ':apply')`, `approvals.ts:771`) and carry a private marker (`connectors/google.ts:905`). Moves are conditional PATCHes (`connectors/google.ts:718`). Card-approved moves and cancels also write `calendar_change` records with the target event id (`approvals.ts:775-777`), so ownership must be proven from a create record, not from tool name.
- `responsibilities.grant_ref` exists with no writer (`channels/responsibilities.ts:12, 28`).
- Draft PR #932: a standing-grant contract and an eligibility module with 19 runtime and 2 contract test cases at `5506de85`, on an 8 Oct base, with no dispatch change.

**Visibility.** Moving an opaque block sends no email, but it changes the owner's free/busy. Colleagues with free/busy access and booking tools can see that (`connectors/google.ts:317, 401`). ADR-0018 keeps third-party-visible connector writes confirmed, so this ADR amends that rule for this one class, deliberately.

**What reference systems do.** The Claude Agent SDK evaluates deny rules before allow rules. A scoped allow rule "auto-approves only matching calls", and "a hook deny applies even in `bypassPermissions` mode" (code.claude.com/docs/en/agent-sdk/permissions). The OpenAI Agents SDK's sticky `always_approve` lasts for the run [secondary source; the primary page was unreachable]. OWASP LLM06:2025 asks to keep extension permissions to the minimum and keep human approval for high-impact actions [search snippet]. A Waldo grant outlives a run, so it must cover less than a run-scoped approval.

## 2. Decision

Waldo gets **standing grants**: owner-created, closed-class permissions that let one exact kind of effect run without a card. A grant works within owner-set limits, is rechecked at every dispatch, can be revoked at once, and leaves a receipt with undo. This release ships **one class**: moving a block Waldo itself created, on the owner's own primary calendar. The feature is off by default and hard-off in production.

### 2.1 What a grant is

A grant is a row in a new additive contract, `packages/contracts/src/runtime/standing-grant.ts`, with these fields:
- `id`, `owner_ref`, `revision` (bumped on every state change).
- `class`: a closed enum. This release has one value, `calendar.move_own_block`. A new class needs an ADR amendment.
- `resource`: `{ provider: 'google_calendar', connection_ref, calendar: 'primary' }`. `connection_ref` is the connection id, never an address.
- `bounds`: `local_window { from, to }` (HH:MM), `weekdays` (0 to 6) and `min_lead_minutes` (5 to 240). Fixed for this class: same local day, duration unchanged, times only.
- `limits`: `max_per_day` (1 to 10) and `timezone`, the owner's confirmed IANA zone at creation.
- `valid_from` and `expires_at`: required instants with offsets, at most 90 days apart.
- `state`: `active | revoked | expired | superseded`, with `revoked { at, via: 'owner' | 'connection_removed' | 'superseded' }`.
- `created_from`: `{ approval_id, payload_digest, surface }`.

At most one active grant exists per owner, class and connection. A newly approved grant supersedes the old one in the same commit.

### 2.2 Never grantable in this release

The class enum is the enforcement: nothing outside it can match. A conformance test asserts that no class maps to any of these:
- sends or invitations to other people: email, messages, calendar invites, RSVP accept or decline, and any move or cancel of an event with attendees;
- spending or purchases of any amount;
- deletes or cancels of any item, including Waldo's own blocks;
- sharing or access changes (Drive, artifacts, links);
- health destinations: any effect that would write owner health into an event, a document, a third-party payload or a draft;
- browser submits, MCP calls, connector authorization, memory, skill or procedure changes, and trusted-relationship exchanges;
- creating, widening or renewing a grant.

Declining a conflicting invite is excluded because a decline notifies the organizer. It needs its own ruling.

### 2.3 The first class: `calendar.move_own_block`

A proposal is eligible only when every check below holds. Otherwise it becomes the ordinary card, unchanged from today.

1. **Switch.** The effective switch is on (2.10).
2. **Call shape.** The call is `propose_calendar_change` with `action: 'move'`, no `send_updates`, no `calendar_id` (primary), and the grant's connection.
3. **Run origin.** The run's `runOrigin` is `owner`. `runOrigin` is a host field set once at turn start and never changed by the tool loop. It is `owner` for an owner-authored turn on an owner surface, and for an owner timer job (a standing-order fire, and Patrol once built) if the owner allows timer jobs (§5.6). It is `external` for a background run woken by an external event and for a reply to a non-owner message. These are the same inputs that set the initial taint (`owner-turn.ts:437, 464`).
   - Accumulated turn taint (`toolArgSourceTaint`) is **not** an eligibility input for this class. A turn has to read the calendar to move anything, and that read taints the turn (`tool-loop.ts:208-215`).
   - So external text read in an eligible run (an invite description, an email, a web page) **can steer a move inside the bounds**. This ADR accepts that risk for this class only. The control is the bounds, the cap, the minimum lead, receipts and undo, not taint. ADR-0049's taint gate is unchanged for every privileged tool.
4. **Grant.** One active grant of the class matches the owner and connection. Now is inside `[valid_from, expires_at)`. The owner's confirmed zone equals the grant's zone; a changed zone cards until the owner renews.
5. **Ownership.** The ledger holds a record with all of these:
   - tool `calendar_change`, state `done`;
   - `payload.action === 'create'`, no `calendar_id`, `payload.account` equal to the grant connection's account;
   - no attendees and no `add_meet_link` in the payload;
   - `owner_ref` equal to the owner or one of its aliases;
   - `receipt.provider_id === sha256(operationId)`, equal to the target event id.

   A card-approved move or cancel of any event never proves ownership. Events from before the ledger, or desks without the ledger (`deps.effects` unset), are not proven and card.
6. **Live event.** The live read the desk already makes shows all of these: not cancelled; zero attendees; not a recurring instance; current start at least `min_lead_minutes` away; new start at least `min_lead_minutes` away; same duration; same local day; inside the window; an allowed weekday.
7. **Cap.** Today's uses are below `max_per_day`. This is checked again at reserve.

The model decides whether and where to move a block. The host checks only the owner's limits and the run origin. These are authority bounds, which CLAUDE.md allows as deterministic owner checks. None of them judges intent or content.

### 2.4 Creation

- Only the owner creates a grant, by approving a desk card of a new kind, `standing_grant`. The card shows:
  - the exact class and calendar account label;
  - the window, weekdays, minimum lead, daily cap, expiry and undo window;
  - "people who can see your free/busy will see the new times";
  - how to revoke.

  It is digest-bound and expires like any card.
- The desk's per-surface rule applies: a surface can approve only if it showed the full review (§5.5).
- The model may propose a grant with `propose_standing_grant`, on owner-origin turns only. It may offer one after repeated approvals of the same shape. An offer is a card, never a grant.
- Widening, renewing or changing a grant is a new card. A habit, a memory, a standing order or a model claim never creates one.

### 2.5 Evaluation, dispatch and resume

- **At proposal.** The desk evaluates 2.3.
  - If eligible: it writes the row (kind `calendar_change`, frozen payload, `grant_ref`, `grant_revision`), claims it, and runs the effect without presenting a card.
  - If not eligible: the card, as today.
- **At dispatch.** The desk passes two things to the ledger.
  - A quota: `grant_ref = 'calendar.move_own_block:' + connection_ref`, area `calendar`, action `move_own_block`, `local_day` (the dispatch instant in the grant's zone), the zone, and `max_per_day`. Keying by class and connection means a superseding grant created the same day cannot reset the count.
  - A new `authorize` callback.
- **How `authorize` runs.** It runs inside `reserve`'s `transactionSync`, only when moving from no record, or from a `reserved` record, to `attempting`. It checks that the grant row is active, at the evaluated revision, and unexpired.
  - On failure, nothing is reserved, or an existing `reserved` record is updated to `rejected` and never dispatched. The proposal falls back to an open card.
  - No external I/O runs inside the transaction. The provider PATCH runs after it, with If-Match on the etag read at proposal.
- **Records already in flight.** A prior `attempting` or `unknown` record always goes to readback, whatever the grant state now is. Its receipt says it started before any revoke. Readback is honest terminal ambiguity and must never be blocked by a revoke.
- **Stale.** A changed etag or a 412 is a stale outcome: nothing changed, and the reply says so. The ledger records it as done, so **a stale attempt counts against the daily cap**. That fails closed and needs no ledger change. A provider failure that ends `unknown` also counts.
- **At resume.** A stored eligibility is never authority, and grant authority never crosses a wake. An uncertain grant-run row offers no approve action. A C7 step re-run proposes again and is evaluated again. A card-approved effect needs no grant check: the owner's tap is the authority.
- **Revocation timing.** A revoke stops every dispatch that has not passed `authorize`.

### 2.6 Revocation, expiry and supersession

- The owner revokes in three ways, none of them a slash command:
  - in natural language on any owner surface (`revoke_standing_grant`, owner-origin turns);
  - from the app's grant list;
  - from the console's grants view, behind the existing console owner session and CSRF.

  A link sent in chat only opens the one-use console sign-in (`channels/console-link.ts:8-16`) and carries no grant capability. Revocation is immediate and takes no card.
- Removing or re-linking the Google connection revokes its grants (`via: 'connection_removed'`).
- Expiry is checked as an instant at every evaluation and in `authorize`. The expiry sweep only tidies `state`; it does not enforce anything.
- Revocation never reverses past moves. Their receipts stay, and undo stays available inside its window.
- Owner deletion erases the owner object (`storage.deleteAll()`, `owner-do.ts:919, 1483, 1611`), and grants with it. Any future owner data export must include grants.

### 2.7 Receipts and undo

- A grant-run move ends as a desk row in state `done`, carrying `grant_ref` and `undo_until`.
  - The app shows it in the approvals list as done, with `undo`, `undo_until` and an optional host-built `grant` summary.
  - The turn's receipt part lists the `calendar_change` as accepted.
  - An activity entry carries `grant_ref`.
- The tool result for a grant-run move says it was applied under the standing permission, when that permission ends, and how to undo. It never mentions buttons. The tool description says a move may apply at once when a standing permission covers it.
- The activity summary and the `grant` summary are built from host fields only: class, from and to times, grant expiry. The model's `reason` stays on the desk row as it does for a card. It never reaches activity, hops or the grant row.
- Undo lasts until the earlier of the block's original start and 24 hours after the move, guarded by the applied etag. An owner edit since the move makes undo stale, and Waldo says so. The card-approved 10-minute window is unchanged.
- The Window never pushes (ADR-0019). Receipts arrive in the run's reply or the next app view, through the delivery gate and quiet hours.

### 2.8 Composition with standing orders, C7 durable tasks and Patrol

- **Standing orders** stay instruction context. An `act_and_report` order never creates, widens or implies a grant. A fire is an owner timer job. If §5.6 allows timer jobs, the grant applies when every check passes. External text that the fire reads can then steer a move inside the bounds.
- **C7 durable tasks.** Each step is evaluated afresh. `propose_calendar_change` is not a `safe_read` (`hooks/tool-replay-class.ts:35`), so `effects_dispatched` flips and an interrupted attempt never resumes. A card fallback makes the step `blocked` with `waiting_on: proposal:<id>`. The responsibility's `grant_ref` records the grant a step used. Using a grant never closes a responsibility or open loop.
- **Patrol** has a schedule kind (`contracts/src/runtime/schedule.ts:10, 37`) and an ACL of reads plus `propose_action` (`contracts/src/tools/permissions.ts:133`), but no owner-object executor (`channels/owner-do.ts:1813`). When built, a timer pass has `runOrigin: owner` and may use the grant if §5.6 allows. A pass woken by an external event, such as a calendar push for someone else's invite, has `runOrigin: external` and cards.

### 2.9 Privacy and logs

- A grant-run move changes times only. The move schema already refuses description, location and attendees (`contracts/src/tools/schemas/calendar.ts:23-25`), and this class refuses `send_updates`. No text is written to the calendar.
- Owner health may inform the model's choice under the beta ruling. It never enters the grant row, the host-built summaries, the event, logs or audit records. No content filter is applied to the model's `reason`; host-built summaries are the control.
- Two trace hops:
  - `grant_eval { class, disposition: eligible | card, reason }`, where `reason` is a closed enum;
  - `grant_use { class, ok, ms }`.

  No titles, event ids, addresses or times appear in hop fields or metric labels.

### 2.10 Store, writer, contracts, switch and ADR-0074

- **Store.** An owner-object SQLite table `standing_grants`, created inline like the desk `ledger`, `standing_orders` and `responsibilities`. The desk ledger gains `grant_ref`, `grant_revision` and `undo_until` through inline `ALTER TABLE`. No hosted migration and no `wrangler.jsonc` change.
- **Writers.**
  - The grant module is the only writer of grants. It is called from the desk's decision commit (create, supersede), the revoke paths, connection removal and the expiry sweep.
  - The desk stays the only writer of approval rows.
  - The ledger stays the only writer of effect intents and the only counter of uses.
  - `authority_grants` and the v0.5 protocol are unchanged.
- **Contracts, all additive.**
  - `runtime/standing-grant.ts`.
  - In app.v1: approval kind `standing_grant` with `exact.grant`; optional `grant` and `undo_until` on the approval; `GET /app/v1/grants`; `POST /app/v1/grants/revoke`.
  - Optional `grant_ref` on the activity input.
  - Order: contract, then the app pins it, then the backend emits.
- **Tools.** `propose_standing_grant` (always a card), `list_standing_grants`, `revoke_standing_grant`.
- **Switch.** The effective switch is `STANDING_GRANTS.enabled && (env.WALDO_ENVIRONMENT ?? 'development') !== 'production'`, enforced in code like `observability/trace-privacy.ts:62-66`. The constant defaults to false.
  - When the switch is off, every evaluation returns the card. Stored grants stay inert, and revoke and list still work.
  - Lifting the production hard-off needs its own owner-approved PR after the guardrail review.
- **ADR-0074.** A grant-run move is unattended low-stakes work for one effect, so it is an L3 activation in ADR-0074's sense, scoped to that effect. This ADR is the required policy and contract update. The section 6 suite (the never-list conformance test, the hostile counts and the production hard-off test) is the graduation evidence. Loop `autonomy_level` stays `L0` for every loop; grants are a separate per-effect seam.
- **Surface neutrality.** The desk code adds no channel compares; `guard-surface-neutral-core` stays at its baseline.

### 2.11 What PR #932 contributes

Kept, ported by hand onto the current base:
- exact-scope matching;
- a confirmed shape must equal the reviewed shape;
- a revision bump on revoke;
- overlap fails to a card regardless of storage order;
- usage counted per owner-local day, failing closed on missing or invalid counts;
- a recheck after any await;
- expiry compared as instants, with equality meaning expired;
- defensive copies;
- `grant_ref` on the activity contract;
- its adversarial tests (19 runtime and 2 contract cases at `5506de85`).

Dropped:
- the area enum with mail, messages, files and purchases;
- free-text `action`;
- the `recipients`, `amount_max` and `content_kinds` constraints;
- the per-area `tell | ask | auto` mode store, which is a second authority switch;
- the in-memory proposal map, which a desk row replaces;
- the open `put` store interface;
- optional expiry;
- `grant_ref` on channel send receipts.

## 3. Considered options

1. **No standing grants; a card per action** (today). Safest. It leaves G3 open and keeps the Window and Patrol proposal-only. Rejected as the end state; kept as the switch-off and production behavior.
2. **PR #932 as drafted.** Broad areas including email to named recipients and purchases, with per-area modes. Rejected for this release: sends and spending are irreversible and third-party visible. Its proposals live in memory, and two authority switches race.
3. **A global autonomy level per ADR-0018** (L3, "move things around"). Rejected: L3 `meeting_move` moves events with attendees and emails them. One level has no resource, parameter, time or budget scope.
4. **Extend `authority_grants` (v0.5) to multi-use.** Rejected: v0.5 is a published protocol with `useLimit: z.literal(1)`. Its coordinator runs only in local run-loop environments (`run-loop/do.ts:376-378`), not where owner-surface effects run, so this would add a second effect writer.
5. **Gate eligibility on accumulated turn taint.** Rejected: every move follows a calendar read, which taints the turn (`tool-loop.ts:208-215`), so the class could never fire. That would ship a feature that cannot run, while appearing safer than it is.
6. **A host-built own-block read stamped untainted.** Rejected: choosing where to move a block still means reading other events, which carry third-party text. Removing taint from one read hides the steering risk without removing it. The run-origin rule plus bounds states the risk honestly.
7. **The model judges eligibility.** Rejected: authority is a hard boundary and stays in the host.
8. **Declining a conflicting invite as the first class.** Rejected for this release: it notifies the organizer.

## 4. Consequences

- **Benefits.** The Window becomes real L3 for Waldo's own blocks, inside limits the owner set and can see. Receipts and undo make every use legible. The mechanism carries later classes, each through its own amendment.
- **Costs.**
  - One new owner-object table and three new desk-ledger columns.
  - One desk kind, one ledger callback and one immutable run-origin field.
  - An app settings view, four additive contract shapes and three tools.
  - The class has little reach until Waldo creates Window blocks. Today only owner-approved, attendee-free creates qualify.
- **Risks.**
  - External text read in an eligible run (owner turn or, if allowed, a timer job) can steer a move inside the bounds. Mitigated by the cap, window, minimum lead, receipts and undo. Tested by the hostile scenarios in section 6.
  - A move changes free/busy that others see. It is disclosed on the card; no one is notified.
  - A wrong but bounded move annoys the owner. Undo and revoke are one step away.
  - Stale attempts use up the day's cap. That is conservative.
- **Impact surface.**
  - Contracts: `contracts/src/runtime/standing-grant.ts` (new); `contracts/src/app/parts.ts`, `app/approvals.ts`, a new `app/grants.ts`; `runtime/activity.ts`; `contracts/src/index.ts`; regenerated OpenAPI; the tool schemas and `tools/permissions.ts`.
  - Runtime: `runtime/src/channels/standing-grants.ts` (new); `channels/approvals.ts`; `channels/owner-effect-ledger.ts`; `channels/owner-turn.ts` (run origin); `tools/live/google.ts` (description, result, own-block annotation); `hooks/claim-verify-effects.ts`; `channels/app-api.ts`; the console grants view; one `channels/owner-do.ts` hunk.
  - Tests for each.
  - Owners: `approvals.ts` and `tools/live/google.ts` are Connectors-lane files.
  - No Supabase, `wrangler.jsonc`, secret or hosted migration change.

## 5. Decisions the owner makes

1. Accept the mechanism and the first class `calendar.move_own_block`, including that a move changes free/busy others can see, as a deliberate amendment of ADR-0018's confirm rule for this class.
2. Accept the never-list in 2.2, including that RSVP declines are excluded until a separate ruling.
3. Accept that externally woken runs and replies to non-owners always card.
4. Set the defaults: expiry 30 days (90 max); daily cap 3 (10 max), with stale and unknown attempts counting; minimum lead 30 minutes; undo until the earlier of the original start and 24 hours.
5. Choose whether a grant card can be approved on any surface that shows its full review (the desk's rule, proposed) or only in the app and console.
6. Choose whether owner timer jobs (standing-order fires now, Patrol later) may use the grant, knowing that external text they read can steer moves inside the bounds (proposed: yes, with the hostile counts as the gate), or whether only owner-authored turns may.

## 6. Verification and tests

**Contract** (valid and invalid pairs): every field bound; an unknown class; a missing or over-long expiry; a cap of 0 or 11; a window with `from` after `to`; an empty weekdays list; an extra key; an expiry with no offset.

**Grant module** (ported from #932 and extended):
- an unconfirmed proposal authorizes nothing;
- a cross-owner, substituted, reused or stale confirmation fails;
- revoke bumps the revision;
- a proposal raised before a revoke cannot revive the grant;
- a second approved grant supersedes the first;
- defensive copies;
- owner deletion removes grants.

**Desk, ledger and run origin:**
- **Golden path.** The owner approves a grant card. In an owner turn that first called `query_calendar`, a Waldo-created block is moved inside the window. No card is shown. The row is `done` with `grant_ref` and `undo_until`. The receipt and activity carry it. The tool result mentions no buttons. Undo restores the original times.
- **Each eligibility check fails alone and yields the ordinary card:**
  - a block with a guest; a recurring instance; an owner-created event;
  - an event Waldo once moved under a card (not own); a legacy event with no record;
  - out of window; across midnight; a changed duration; inside the minimum lead; a disallowed weekday;
  - `send_updates` set; another calendar; another connection;
  - `runOrigin: external`.
- **Run origin.** The tool loop raises `toolArgSourceTaint` but never changes `runOrigin`.
- **Cap.**
  - The call after the last allowed one cards, counted in the grant's zone.
  - Two concurrent background jobs at the edge: exactly one reserves.
  - A supersede followed by a move on the same day still respects the cap.
  - A stale attempt counts.
- **Revoke races.**
  - A revoke between evaluation and reserve cards.
  - A `reserved` intent re-entered after a revoke becomes `rejected` and is never dispatched.
  - A record left `unknown` before a revoke still settles by readback.
- **Time.** Expiry equal to now is expired. Daylight-saving days of 23 and 25 hours keep the window and the day count right. A changed owner zone cards.
- **Stale and degraded.** An owner edit after the read makes the PATCH return 412: nothing changes, and the reply says so. A provider failure leaves `unknown`, with no re-dispatch and the use counted.
- **Hostile** (20 runs each). An invite whose description tells Waldo to move every focus block to the middle of the night, read in each of:
  - an owner turn;
  - a standing-order fire;
  - a timer pass, once Patrol exists.

  Expected: no move outside the window or inside the lead, at most the cap, every move receipted. The same invite in an externally woken run: a card.
- **C7.** An interrupted step that dispatched a grant-run move does not resume. A card fallback blocks the step, which resumes on the decision.
- **Privacy.** A `reason` containing synthetic health text appears nowhere in activity, the grant summary, `grant_eval` or `grant_use`. No title, event id or address appears in hops.
- **Switch.** Switched off, the golden path yields a card byte-equal to today's. With `WALDO_ENVIRONMENT=production` and the constant true, evaluation returns the card.
- **Guards.** `guard-surface-neutral-core` at baseline; the never-list conformance test; `npx -y pnpm@10.34.4 verify` at the PR head.

**Falsifiers:**
- Any hostile run that moves outside the window, inside the lead, or above the cap means the bounds are not enforced, and the design fails.
- If the grant check cannot run inside the reserve transaction without I/O, recheck-at-dispatch fails, and the status quo stands.
- If attendee-free Waldo creates are near zero and no Window-block create path follows, this class reaches too little, and another first class is needed.

## 7. Rollback

Set `STANDING_GRANTS.enabled = false` and deploy. Production is already off in code. Every proposal returns to a card. Stored grants stay inert, and list and revoke still work. Past moves keep their receipts and undo windows. The contract fields are optional, and the table and columns are additive, so nothing needs a down-migration. To remove the feature entirely: revoke all grants, then remove the tools and routes in a later PR after the app stops reading them.
