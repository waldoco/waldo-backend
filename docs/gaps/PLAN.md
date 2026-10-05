# Gap resolution plan

Resolution steps for the gaps in [LEDGER.md](LEDGER.md), from the [2026-10-05 audit](audits/2026-10-05-f38971d5.md). This plan slots into the tracker's existing five-step build order; it is not a competing roadmap. Planning text does not authorize deploys, merges, spend or production changes.

Every slice follows the repo merge wall: red test first, `npx -y pnpm@10.34.4 verify` + `git diff --check` at exact head, fresh reviewer, 6/6 CI, merge only on CLEAR, green push CI. Staging requires a separately approved pin; acceptance requires a trace on the named deployed build.

Ownership follows the tracker: **Core** is sole writer of the shared serving/background seam (`telegram-owner-do.ts`, `owner-turn.ts`, Google, files, commitments, and the current forget correction). **Dalda** owns memory/forget/recovery boundaries and release evidence. **Instinct** freezes and grades acceptance cases. **Owner** decides open calls.

---

## Phase 0 — Decisions and cheap checks (no code)

| Step | What | Who | Exit |
|---|---|---|---|
| 0.1 | **Brain decision (G1).** Choose: (a) ratify `TelegramOwnerDO` as the per-owner authority root and port the required effect/closure invariants into it, park RunLoopDO's Coordinator path; or (b) fold Telegram turns onto RunLoop/Coordinator. Either way needs an ADR and a CLAUDE.md amendment, because CLAUDE.md says "Keep WaldoCoordinator". **Recommendation: (a)** for the MVP — J0 needs claim-before-I/O, reconciliation and evidence closure, and porting the existing browser-submit/outbox patterns is small; (b) is a rewrite of the live path. What flips it: if the app must launch on RunLoop's responsibility API in the same release, (b) avoids two implementations. | Owner, Core drafts ADR | ADR merged; `CHANNEL_ADAPTER_EXTRACTION` §7 closed |
| 0.2 | **#787 falsifier.** Read `halted_by`/`scribe` on the failing day-card trace. | Core | Hypothesis R2 confirmed or rejected in LEDGER G2 |
| 0.3 | **Google route on staging.** Vault/proxy or local refresh-token? | Core | G4b severity set |
| 0.4 | **Gmail attachments.** Does `read_thread` return attachment bytes? Can send carry one? | Core | J0 fixture confirmed feasible, or J0 amended / attachment slice added |
| 0.5 | **Forget unsupported-shape outcome.** "Don't hold" (Core) vs "remain unresolved" (Dalda). | Owner + Dalda | Decision recorded; #794 scope fixed |
| 0.6 | **Memory judgment rules (G7).** Approve moving `looksTransient`, `correctionTopicMatches` to model judgment; decide whether `FORGET_INTENT` stays as a destructive-action guard. | Owner | Disposition recorded |
| 0.7 | **App-first vs Telegram-first.** Reconcile CLAUDE.md / build plan with the tracker's Telegram-only surface. | Owner | One sentence in CLAUDE.md + plan amendment |

---

## Phase 1 — Forget correction (tracker step 1) · G3

One PR, Core writes, Dalda reviews currentness/preservation/recovery. Replaces Core's planned single-PR correction with these additions.

**Files:** `src/memory/claims.ts`, `src/memory/held-rows.ts`, `src/channels/update-cards.ts`, `src/channels/telegram-owner-do.ts` (day-card call site only).

**Changes**
1. One matcher module used by hold, purge exit and readback. Input: normalized string built from ordered keys **and** string leaves, NULs stripped, case-folded. Checks the full topic. Delete `LIKE_PREFILTER_MAX`; SQL `LIKE` may remain only as a prefilter whose candidates are then judged by the shared matcher.
2. Leaf-level purge: blank only leaves (and keys) that carry the topic; keep every unrelated leaf and the original key names. When the topic is only detectable across leaves (split), hold — do not blank the whole card — and report per 0.5.
3. Add `update_cards` to the span-selector `collect` list (`claims.ts:706-717`) so a topic-only forget has an exit. Keep `HELD_ROW_TABLES` derived from that list, not a hand copy.
4. Readback checks keys as well as values and skips (reports) unrelated unparseable rows instead of throwing.
5. Never write a bare `"[forgotten]"` string into `changes`; keep it a valid `Change[]`.
6. Day-card render: move `updates.unfolded()` inside the `try`; tolerate purged rows.

**Red tests (must fail on f38971d5)**
- Prefix decoy: unrelated card sharing the first 40 chars stays byte-identical.
- Mixed card: topic leaf blanked; unrelated leaves and key names preserved.
- `pendingMail`/`reviewDue`: joins and non-target detail survive.
- Split/NUL before char 40: forget stays incomplete across eviction and retry; no false-clean.
- Quote/backslash and key/value forms.
- Topic in a JSON key.
- Topic-only forget whose only carrier is an `update_cards` row reaches complete.
- Unrelated unparseable row does not block purge.
- Day card renders after a purge.

**Falsifier:** any pre-existing unrelated card changes bytes after purge → reject.
**Rollback:** revert PR; staging stays on `e3adf20a`.
**Exit:** merged SHA, staging pin approved, `/heldrows update_cards` clean, real forget → readback → no resurfacing on a trace. Closes G3a–G3e; G3f (#794) stays open per 0.5.

---

## Phase 2 — Context interface (tracker step 2) · G2

**Contract** (one type, `packages/contracts` if cross-repo, else runtime): owner/task, source coverage, commitments, artifact revision, corrections, authority/cancellation, last verified progress, **and a byte budget** derived from the sanitiser cap.

**Changes (Core)**
1. One wire budget shared by the history window and the sanitiser (`window.ts`, `provider.ts`, `../contracts/src/memory/sanitise.ts`). No path may produce a single message over the cap.
2. Every `converse` wake (day, update, brief card, standing order, mail follow-up, reminder) builds its input through a budgeted composer like `composeDayPlanInput`, counting omissions.
3. Bound `updates.unfolded()` (LIMIT + newest-first), `loopsSection`, `feedback`.
4. Fold update cards when consumed into a card prompt, not only on successful send — or fold on failure after N attempts — so failures can't ratchet.
5. Don't persist full card prompts into conversation history; persist a short reference.
6. Classify provider context-length 400 as `oversize`, not `invalid_args` (`llm/openai.ts:157-165`).
7. Background wakes pass explicit `toolNames` (G6e).

**Red tests:** card with 200 unfolded updates stays under cap and reports omissions; failing card does not grow the next one; context-length 400 classified `oversize`.
**Falsifier:** if 0.2 shows a non-scribe provider failure, items 1–4 still ship as hardening but #787 stays open.
**Exit:** #787 day card delivered on staging with trace.

---

## Phase 3 — Parallel slices behind the interface (tracker step 3)

Independent PRs; Core is writer for shared files, so sequence edits to `telegram-owner-do.ts`/`owner-turn.ts`/`approvals.ts` or batch them.

### 3A. Effects: claim before I/O, readback, claim check · G4
1. Apply the browser-submit CAS (`open`→`uncertain` before await) to Gmail `sendRaw`, calendar apply, `message_send` in `channels/approvals.ts`. Settle to `done` only on provider readback; `failed` only on definitive provider rejection.
2. Readback after success: `findSentByMessageId` for mail; `event()` get for calendar.
3. Bind the sending connection id into `EmailSendProposal` and its digest; show sender on the card; reject if the account changed.
4. Route machine-turn sends (standing orders, briefs, update/day cards) through `finalOutbox.enqueue`; extend `hasCommittedFinal` to those kinds so scheduler retries don't resend.
5. Wire `evaluateTurnClaims` next to `receiptLine` (`owner-turn.ts:746`) in log-only mode; promote to enforce after a week of traces.
6. Local refresh-token route: either remove it for effects (proxy only) or add a DO-local intent ledger.
7. `replayDecision`: add a per-tool-call intent row in the dispatcher before `handle()`; call `replayDecision` on recovery.

**Red tests:** crash between claim and send → row `uncertain`, not re-approvable; changed account → new review; standing-order throw after send → no second send; claim "sent" without receipt → logged finding.

### 3B. Commitments and follow-through · G5
1. Add `close_reason` + evidence ref to `loops`; update lane closes a mail loop when `collectChanges` sees a reply on the same thread.
2. Make non-mail nudges once-only per `(loop_id, due)` (drop the 4h cooldown at `heartbeat.ts:103,135`).
3. Decide (per 0.1) whether `loops` becomes the store for `OpenLoop` v0.4 or v0.4 is marked not-serving.
4. Resumable task state: persist the J0 task (thread ref, artifact revision, awaiting dependency, last verified step) so a wake can resume; `background_runs` stays audit.
5. Delete `proactiveGate` or route the inline checks through it.

**Red tests:** reply detected → loop closed with evidence; past-due loop nudged once across three heartbeats; DO eviction mid-wait → task resumes at last verified step.

### 3C. Scope and gating · G6
1. Attachment/voice turns: build `sourceScope` even with an attachment (`telegram-owner-do.ts:1720`), or set `requireTaskScope` only when a scope exists.
2. `requires_connector`: require the tool's own family, not all 10 (`task-source-scope.ts:180`).
3. Export: allow `export_artifact`/`workspace_render` under the `workspace` default; gate the tool on the limiter too; record export URLs as receipt URLs.
4. Export link from Telegram: short-lived signed download token instead of console cookie (needs security review: auth, expiry, owner binding, rate limit).
5. `updateCheck` uses `google.client('mail')`.
6. Don't register `read_drive` when `DRIVE_READS !== '1'`; split content flag.
7. Fix stale comments (`drive.ts:9`, `curated-catalog.ts:6`) and decide whether all catalog skills should default active.

**Red tests:** screenshot turn can call `get_context`; mail-narrowed task can `draft_email`; unready turn can export; Telegram link downloads without console session and is denied for a foreign owner; multi-account owner's mail poll uses the mail account.

### 3D. Memory judgment to model · G7 (after 0.6)
Replace `looksTransient` and `correctionTopicMatches` with model judgment inside the existing memory proposal step, with scenario tests (durable preference phrased as imperative is kept; one-off errand is not; correction replaces the right fact; paraphrased and non-English forget requests). Keep `FORGET_INTENT` only if 0.6 rules it a safety guard; otherwise move to model with a deterministic confirmation step.

### 3E. Docs · G8 (any time; docs-only gate)
1. Rewrite `docs/CURRENT_SYSTEM.md` at a new pin; describe `TelegramOwnerDO` as the serving path.
2. Collapse to one entrypoint: CLAUDE.md, `AGENTS.md:15`, `docs/README.md`, `NEXT-SESSION-PLAN.md` all point to the same file.
3. Add a superseded banner to the September planning docs listed in the audit (or move them to an `archive/` index).
4. Link `docs/gaps/` from `docs/README.md` "Start here".

### 3F. Baseline and evals · G9
1. Stamp build SHA/version into every turn trace (CF version metadata or `WALDO_RELEASE` set at deploy).
2. Trace export readable without a Mac.
3. Two native36 starter cases after the owner sets model route and cost ceiling.

---

## Phase 4 — First acceptance journey (tracker step 5) · J0

Precondition: Phases 1, 2, 3A, 3B, 3C merged and pinned on staging; 0.4 confirmed attachment support or J0 amended.

Instinct freezes the controlled thread, attachment, expected artifact revision and grading case. Run on real Telegram against the deployed SHA, then variants: already done/cancelled, changed source, uncertain send, self-reported capacity, selective forget, two-owner collision (needs second Telegram account — owner call). Record per attempt: candidate and deployed SHA, fixture, artifact hash, approval, provider readback, interruption outcome, reviewer, defects, cost.

---

## Dependency order

```
0.1 brain ADR ──┬─> 3A effects ──┐
0.2 #787 read ──┼─> 2 context ───┤
0.5 forget ─────┼─> 1 forget ────┼─> J0 run ─> widen (skills, channels, health, parity)
0.4 attachments ┘   3B loops ────┤
0.3 route ─────────> 3A sev      │
0.6 rules ─────────> 3D memory   │
                    3C scope ────┘
3E docs, 3F baseline: independent, start now
```
