# Telegram deadline and effect fencing (slice C)

Status: plan in review, not implemented. Base 5d4e012. Issue #492.

## Guarantee and limit

A closed host run cannot admit a new model/tool/provider request or a fenced local commit. Previously issued remote requests may finish despite abort; their effects remain uncertain until reconciled. This is neither remote rollback nor exactly-once execution. An entire handler is not a single effect boundary.

Immutable authority comes from the host: channel, subject, DO name, inbox ID, attempt, run ID, deadline. No content or model output can supply it. Recheck exact binding and durable state. Failure transport has its own bounded host authority, not the expired run's permission.

## Source audit at base

- `telegram-listener.ts`: `Promise.race` rejects at 150s but does not stop the responder. Progress/typing/reaction requests need separate bounded treatment. Expiry copy currently claims work stopped.
- `telegram-owner-do.ts`: `activeInbox` is mutable across awaits in final admission. Reminder final mistakenly includes an active inbox when one exists. Run closure/replacement must invalidate captured capabilities, not depend on the current slot alone.
- `owner-turn.ts`: trace, pending attachments, tool ledger buffer, receipts, quote, notice, control and last reply are shared. Late callbacks and finally can affect a later turn. Memory `ask` returns before synchronous `applyClaimOps`; redaction awaits before settle/receipt; conversation save/ledger follow model completion.
- `joined-path.ts`: composition and model completion precede assistant append and publication map. The assistant commit needs a post-await fence. User admission append and failure cleanup need a defined policy, not deletion of unrelated tree state.
- `tool-loop.ts`, `dispatcher.ts`, `subagent.ts`: check before rounds and after model await, before dispatch, after pre-tool hooks/argument validation and after effect preparation. Child loops inherit the same capability, not a renewed deadline. On-connect, offload and onTool callbacks are also commits/effects.
- `artifacts.ts`: immutable body PUT before metadata INSERT/UPDATE. Check before body request and after it before SQL. A late body can be orphaned; never publish its metadata/receipt. Artifact delivery reads origin/body across awaits; reject stale receipts.
- `reminders.ts`, `standing-orders.ts`, scheduler: synchronous note mutation plus async scheduler operations. Gate actual schedule/cancel SQL and post-await note cleanup, not only handler admission. Work issued before close may partially persist; disclose uncertainty.
- `approvals.ts`: proposal creation and review message may straddle multiple awaits (Google client/event reads, hashes, review URL). Gate local proposal commit and each request. Approval callbacks are separate owner actions, not inherited turn authority.
- `google.ts`: client acquisition and hashes precede draft/proposal effects. Thread reads can relay OTPs directly. Gate each provider request, relay, desk record and proposal. Read results are external data and never renew permission.
- `browser.ts`: session start/navigate/observe/extract/act and proposal are separate boundaries. Session cleanup is a separate permitted cleanup scope; fencing must not leak sessions.
- `mcp.ts`, messaging proposals: dynamic auth/client discovery can finish late before proposal commit. Gate each step with captured run identity.
- conversation store, indexed episodes, tool ledger redaction: storage reads precede writes. Pass fences into actual writes so a wrapper does not hide await-to-commit gaps.
- memory/health/background run books: synchronous writes still need captured capability or a separately bounded host settlement authority. Do not leave unresolved rows falsely marked completed.

## Planned proof

Red-first deferred model/handler fixtures, actual DO storage tests, fake clock at 150s and response at 180s. Verify new effect admission, local writes, history/ledger, receipts and final are refused; old-run completion/finally cannot touch replacement state. Stop, revoke, child loop, interrupted recovery, artifact orphan and pending remote effect uncertainty are separate assertions. Green focused fixtures are not live physical cancellation proof.

Implementation only after independent design review. Any incomplete handler coverage remains OPEN and is listed explicitly. Exact-head green CI and independent code review precede merge/staging. No config, production, SQL migration, account or spend changes.

## Review-driven split

C1 covers supported durable Telegram inbox owner runs and core fences, artifact commits and fixed bounded failure notices. It does NOT cover inner boundaries of an already-admitted nonartifact handler: that handler can issue new remote requests after closure. C2 stays open for the remaining boundary audit and implementation. Scheduler/reminders, WhatsApp, probe, console, direct commands/callbacks and connector effects outside the responder are excluded from C1 unless specifically changed and tested.

Use commitIfLive with authority check and commit in the same synchronization boundary. Closure is monotonic and durable under that same synchronization. Deadline begins at claim, covers the entire run, and closure commits before abort or serial release. Failed closure retains the queue. Artifact bodies use per-attempt immutable keys and metadata revision CAS; no cleanup may remove a shared key. Frozen success final vs stop is decided by the same transaction. Failure notice has fixed host copy, captured binding, expiry and an idempotent outbox identity, with no model content. A late local callback never publishes history, receipts or artifacts.

Additional proofs: final-vs-stop race, delayed same-revision R2 write, closure transaction failure retains queue, atomic history leaf acceptance, paused nested hook/effect preparation, and pre-close remote result marked uncertain without replay. Memory partial purge is not rollback; C2 requires typed resumable maintenance authority rather than bypass booleans.

## Wiring checkpoint (draft, not merge-ready)

Implemented core host scope on supported durable Telegram normal owner turns, absolute 150s claim deadline, synchronous durable closure before abort/queue release, atomic success final plus closed inbox, fixed failure outbox with five-minute expiry and bot/binding, artifact immutable bodies/fenced metadata, run-local responder tree/control/buffers, history and ledger commit gates, model fallback/admission and signal, dispatch/child loop admission gates. Direct commands/callbacks are explicitly unfenced. Reminder metadata no longer borrows an owner inbox.

Proof so far: delayed artifact conflict/orphan, storage closure/deadline/revoke, responder replacement isolation and post-model dispatch refusal, actual DO success/stop/deadline/final-wins. DO stop proof directly invokes host closure/abort; authenticated webhook stop replacement fixture separately exercises the route. Deadline test advances Date.now at the paused model, not a real 180s provider call. Closure rollback proof is storage-only; host queue retained-on-close-failure proof still needed. Remote effect-started persistence/reconciliation and inner nonartifact effects remain C2, so universal no-new-provider-work is NOT claimed.
