# C2: inner effect boundaries, uncertainty and purge maintenance

Plan only. Base 16d6523, issue #492. C1 is staged, not a universal fence.

## Coverage contract

Only supported durable Telegram owner responder runs inherit their captured RunEffectScope. Direct commands/callbacks, scheduler-originated turns, WhatsApp, probe and console remain excluded. A tool admitted before closure can currently continue its own inner requests; dispatcher admission cannot fix that gap. Never claim remote rollback or exactly-once.

C2 is three reviewable slices, not a blanket wrapper:

1. Provider request boundaries. Thread captured scope through live handlers and provider clients. Check immediately before each request after client/token/hash/discovery awaits, and before accepting results/relays/desk records. Caller-supplied content never creates authority. Browser start/navigate/observe/extract/act are distinct admissions. Google request clients must propagate the scope to token refresh and actual provider fetch, not merely wrap client acquisition.
2. Local publications. Pass scope into books/desk/scheduler stores. Check and synchronous local write share the same host transaction; recheck after preceding async reads. Multi-store operations have explicit partial state. Schedule/note insertion and cancel/note removal cannot silently split across closure. Approval proposals, OTP/artifact relay and their receipt publication need separate boundaries. Approval callback execution is a separately authorized owner workflow, not renewed turn authority.
3. Effect uncertainty and partial purge. Durable per-attempt operation identity must exist before issuing a mutating provider request. Persist only a safe identity/digest and typed state, never secret payload. If closure occurs after request start, retain started/uncertain evidence, no blind replay or success receipt. Reconciliation may only read/reconcile that exact operation under separate host authority; unknown outcome stays unknown. Do not infer success from a timeout. Purge similarly uses durable IDs/phase/version, with resumable typed maintenance authority restricted to already authorized deletion/redaction. It cannot launch model/tool/provider work or publish an expired run's final.

## Source leads at base

- tools/live/browser.ts handle ignores dispatcher context; call closure POSTs every operation. finally calls session end. End-only cleanup must remain separately permitted, even when the run closes, and must not become a general bypass.
- tools/live/google.ts withGoogle awaits client before work; draft hashes then client.draft, send proposal hashes/auth checks before desk.proposeSendEmail, thread reads await before artifact relay. Gate each actual request and local proposal/relay, not only handler.
- channels/reminders.ts book.set inserts note before awaited scheduler.schedule; cancel awaits scheduler.cancel before note DELETE. Scope must reach actual SQL and scheduler write, with policy for an interrupted pair.
- channels/owner-turn.ts memory applyClaimOps is synchronous after model admission; conversation redaction is asynchronous before settle. Scope currently blocks late settlement, but partial deletion remains pending. Maintenance must resume exact deletion phase without reopening expired owner authority.
- channels/run-effect-scope.ts provides admit/commit only, no receipt or maintenance authority. Never overload admit into an effect journal.

## Implementation decisions to review first

Use explicit parameters at leaf owners, not ambient mutable scope or captured global activeInbox. Provider reads still need admission. A request already issued may finish; its response does not renew the run. Cleanup authority is resource-bound and end-only. Maintain existing provider idempotency/reconciliation policy where present rather than add retry.

Journal and purge recovery need durable storage design inside existing schema capability or a separately reviewed schema change. This plan authorizes no migration/config/SQL rollout. First enumerate existing journals and storage policy, then decide minimal schema-free representation. Unknown support is a blocker, not a guessed receipt.

## Proof matrix

Deferred client acquisition/token refresh/response decoding; close before continuation; zero new provider fetches/relays/proposals. Pause browser start then close: no navigate/extract/act, end only for captured session. Close between local read and write: no publication. Child handler keeps same deadline. Stop/revoke/replacement: old handler cannot touch new state.

For started mutating request, close then resolve success/ambiguous: durable uncertain evidence remains; no replay, no expired final. Reconcile only verified outcome against exact identity. Real mock DB commit followed by response loss is separate from a fixture that merely seeds attempting state. Actual DO reconstruction/eviction proof is separate from same-instance journal reloading.

Purge cuts at every persisted phase, including redaction failure and scope closure: resumable exact deletion, no unrelated history rewrite, no misleading completed receipt. Maintenance runs may finish deletion but never publish owner success under a closed turn.

Red-first local fixtures, actual DO storage tests, exact-head actual CI jobs, independent review precede merge/stage. Live normal Telegram after stage is only smoke proof; fake clock/deferred adapters are not live physical cancellation or full 180-second provider proof. Coverage exclusions stay on issue #492 until each slice is implemented and tested.

## Review requirements: order and full inventory

Effect-started durable identity/storage is a prerequisite for MUTATING leaf admission, not a retrofit after the first slices. Reads may ship first with admission alone; mutation semantics remain unchanged until journal plus host settlement authority exists. Normal publication and post-close host reconciliation metadata are different capabilities. No generic allow-closed switch.

Before coding enumerate existing operation/purge journals, retention/access boundaries, schema/version compatibility, size/rate and reconciliation ownership. A digest alone may not permit reconciliation; never guess success. Secret-bearing payload retention/disclosure requires explicit design. Bring exact schema/config/migration effects as choices before requesting permission; this plan approves none.

Inventory to complete at leaf level (each needs request, local store, inherited capability, post-close cleanup/settlement, proof or explicit exclusion):

| Family | Requests and stores to inventory | Post-close authority |
| --- | --- | --- |
| Google, messaging/email | token acquisition/refresh, draft, proposal, relay, pagination; desk/cache/rotating token/consent | exact-operation reconciliation only; old run cannot poison newer refreshed tokens |
| MCP/dynamic adapters | discovery/auth/call and adapter-local stores | no generic late-call continuation |
| Browser custody/vault | start/navigate/observe/extract/act, cookies/session/custody/vault stores | end-only captured resource generation; never newer replacement session |
| Standing orders/scheduler | covered responder proposals, SQL notes/schedule, alarm registration | exact durable schedule phase recovery; scheduler-originated turns outside budget |
| Health/memory/background books | captured responder book writes vs independent background owners | typed target/version deletion maintenance only |
| Dispatcher | trustedEffect prepare/reconcile, pre/post hooks, sanitiser, offload stores | distinct host settlement metadata, no normal publication |
| Provider/children/fanout | fallback/repair/delegated branch requests and result stores | one deadline; branch-specific operation IDs and uncertainty |

Direct callback/console/scheduler-originated work is excluded from this budget, but covered responder reminder/approval/scheduler PROPOSALS are not excluded. Approval execution gets a separately grounded run and its own effect uncertainty policy.

Check-to-request issuance must be synchronous with host admission, no await in the gap, including body encoding/streaming and multi-page calls. Response acceptance is not remote mutation completion. Fanout admits each branch separately; closure stops new branches and already-issued branches retain distinct identities.

SQL, KV, R2 and providers cannot share a transaction. Specify durable phase/CAS and compensation or uncertainty per pair. Note plus schedule uses one local transaction where possible; alarm registration is another durability boundary. Purge checks phase/version plus exact authorized targets before every write, CAS against current rows; key reuse never permits deleting a later unrelated row.

Additional red-first proof: post-close token write, captured resource replacement, competing purge-version/history rewrite, failed fanout branch, marker storage failure yields ZERO remote calls, late remote success permits only host-owned exact-operation receipt and no normal final. No universal/no-late-provider claim until every inventory row is implemented or explicitly excluded.
