# A1 local admission preparation

## Superseding local integration state (October 2)

The isolated `codex/owner-turn-integration` branch, based on owner revision head `2ad3cc5fda4272de106338de5c803f23adec1d3c`, now consumes the exact positive decimal bigint `admission_revision` in the private lookup proposal and strict receipt. The helper retains canonical UUID identity, exact presence and physical locator checks; revisions survive JavaScript bigint precision. SQL proposal assertions are now22, based on38 baseline migrations. This updated SQL proposal has been source-reviewed, **not executed**, because signed/unsigned RPC proof execution remains behind the separate blocked platform security remediation.

The existing authenticated Telegram DO `/enqueue` text path now constructs a per-turn admission/context binding through an optional private constructor dependency and the existing responder. The local deterministic proof uses trusted private receipt/context/grant suppliers and a fake gateway; no hosted RPC, live supplier, credentials, grants or activation exist. Without the supplier the scoped text path fails closed instead of falling back to fixture admission. Unscoped machine/scheduler, direct-command and other-presence semantics retain their previous scope; this slice does not claim canonical admission for them.

Actual admitted text drives invocation digest, canonical conversation messages, principal cache key and safety identity. The admitted ACL filters provider schemas and actual dispatcher handlers; provider, handler, history and final-outbox boundaries recheck owner revision/access and the durable run fence. Fresh history lives under `canonical-owner-v1:<principal>:<tenant>:` with per-row lineage witnesses in the same fenced write. Legacy `conv:*` bytes are not imported or relabelled. Bound legacy memory writes/read prompts, standing orders, health fixture material, tool ledger/offload and reaction model calls remain off until reviewed canonical suppliers/redaction exist. Grant-set comparisons cannot detect revoke/regrant ABA without an authoritative grant epoch.

**The complete admitted material-to-provider proof is blocked.** Core's private composer hardcodes `TOOL_PERMISSIONS[trigger]` into rendering/evidence before the adapter intersects grants. The existing responder also discards `JoinedConversationModel.complete.request.system`. Consuming that prompt now would advertise grant-denied tools. The non-vacuous actual-DO assertion `replies[0].system` contains `ADMITTED_MATERIAL_OWNER_BOUND_CANVAS` failed locally; receipt and exact test snippet are outside Git at `../evidence/owner-turn/material-delivery-red.*`. This is failing requirement evidence, not a passing full-context proof. Core must allocate a narrow private admitted-ACL seam in `context-composer/types.ts`, `composer.ts`, `prompt.ts` (and canonical tests), feeding rendering, evidence and checkpoint digest together; then the responder can consume the admitted composed system and rerun that assertion. No private renderer import or string surgery was introduced here. The existing messaging prompt also describes automatic memory behavior while bound memory is disabled; the canonical prompt integration must remove those unsupported claims before activation.

Observed bounded verification:121 tests across7 runtime files passed, including9 actual-DO cases,21 strict admission cases and12 adapter cases. Worker and integration typechecks and whitespace checks pass after final narrowing correction. Evidence is outside Git in `../evidence/owner-turn/`. One actual-provider material assertion remains observed failing and release-blocking, as stated above. No SQL proposal execution, full runtime wall, shared database reset, paid/live provider test or CI was run.

Historical preparation descriptions below refer to the earlier A1 head and are superseded only by this section. No deployability/full acceptance is claimed.

Owner approved canonical owner UUID, one personal owner per tenant, lifecycle rechecks and an explicitly fresh staging conversation. This is the non-overlapping preparation portion of #519/#520. No production caller imports the new helper; actual ingress, ACL/composer and fresh-history wiring are not implemented here.

## Scope and ownership

Original base: `5958a8f73be68d083c78508b9b0aacb67854ce60`. Rebased locally onto verified Core #556 merge `e9a45fc51670c6683cc67cc2b023eb48c07aca4b`, explicitly fetched from GitHub October 2. Branch `codex/owner-admission-a1`; isolated worktree `/Users/shivanshfulper/Documents/Codex/2026-10-02/task-2/waldo-admission-a1`.

Initially no reserved-file transfer was established. Subsequent authorized supported local task coordination released A1's DO admission/turn/responder and owner-turn adapter/history hunks; dashboard retains routing/rendering/session-action hunks. Core explicitly allocated a new isolated host-bound adapter and tests, retaining composer/provenance/contracts/loader integration. Existing `telegram-owner-do.ts`, `console-signin.ts`, `owner-turn.ts`, composer, canonical migrations and native36 fixtures are untouched by this branch. Core's merged contracts are reused rather than duplicated.

The helper accepts a **private authenticated host lookup**, not user/model authority. It validates and freezes owner UUID/presence UUID/provider/subject/state-version against the staging locator and exact allowlist; maps UUID to existing `prn_`/`ten_` references; accepts actual input through the existing authenticated-ingress invocation contract; and guards input disclosure/currentness around awaited lookups using RunEffectScope. UUID-derived principal and tenant references are explicitly **non-secret identifiers**, never authorization tokens or cryptographically opaque labels. No new key infrastructure. Input and envelope are immutable. Retry identity includes environment, namespace, DO name, owner UUID, provider, subject and persisted occurrence key; actual DO ID is validated separately; callers must preserve the occurrence timestamp/content on replay. Changed content produces a different canonical idempotency serialization.

`assertCurrent` observes supported owner-state/presence lifecycle; it does not make remote revocation transactional with local writes. `scope.commit` remains the local publication fence. Supported relink inserts a new presence UUID; manual reactivation of the same row between checks has no presence generation and is not claimed detectable. Reuse-after-delete returns a different owner UUID and invalidates the old receipt.

The helper does not authenticate the external webhook, implement tool/grant ACL, construct live material adapters, restore conversation, save memory, run tools, or supply a skill repository. Existing callers are unchanged. Wrong-owner tests demonstrate rejection of a changed verified tuple, not a demonstrated existing cross-owner leak.

## Inert SQL and reproducible proof

`lookup-proposal.sql` is outside canonical migrations and rolls back. It proposes a read-only signed Telegram staging lookup over existing owner/presence records, checks the entire JSON locator tuple, requires signature verification to be explicitly true, and grants **no execute permission**. The caller still proves physical DO identity via idFromName; SQL cannot attest a Cloudflare object. No provisioning or workspace mapping occurs.

`lookup-tests.sql` also wraps synthetic fixtures in a transaction. Run the complete local proof with:

```sh
node docs/planning/owner-admission-a1/prove-local.mjs
```

The runner accepts no URL/arguments or inherited Docker endpoint overrides. It freezes the existing local Unix Docker socket, uses cached pinned Supabase images (`--pull=never`), a unique labelled internal network, no published ports, and a disposable database. It applies the 37 canonical migrations, observes the exact proposed function only inside its transaction, tests 18 assertions, proves proposal rollback, and disposes only its own labelled resources. It never addresses the shared Supabase stack.

## Verification

- TDD evidence: missing-module initial red; relink disclosure red/green; future source-time red/green; mutable-envelope red/green. Independent review found NULL-verifier bypass, reproduced as 2 failing pgTAP assertions, then fixed. Earlier typecheck failures were test annotations and the incorrect input-source enum; final worker/integration typechecks pass.
- Focused 5-file run: 104 tests PASS (new helper 17 plus existing skill/composer 87). The final canonical retry assertion was then rerun in the helper suite: 17 PASS.
- Existing hermetic ingress/run-fence: 22 tests PASS; local Workers alarm warnings observed.
- Disposable PostgreSQL: 37 canonical migrations applied, 18 proposal assertions PASS, rollback and zero-owned-resource disposal PASS. No new anon/authenticated function execution privilege.
- Runtime worker/integration typechecks, JavaScript syntax check, canonical migration-list check and diff whitespace check PASS.
- Independent Standards/Spec/security review: CLEAR for preparation after fixes; source review plus supplied test receipts, not independently executed reviewer tests.
- Full `pnpm verify` NOT RUN: it invokes shared `supabase db reset`; no reset is authorized. No CI, full runtime wall, live provider/model, deploy, push or hosted migration claim.

Local evidence logs are retained under `/tmp/waldo-a1-*.log` and copied to the task's `evidence/` directory. Dependency symlinks borrowed the unchanged contracts/workspace/dependency tree from release `8ef75e8…`; those packages are identical at the base. Setup symlinks are removed before handoff.

## Exact remaining blockers and next owners

1. **Core/#520 reconciliation:** conditional policy acceptance and new adapter allocation are now recorded; Core's #556 contracts merged. Complete directory revision, actual source/metadata and provenance integration before the released call-site hunks can safely activate. #555 is a docs-only amendment targeting #520, not beta-mvp.
2. **Existing Codex single writer:** integrate a host-bound lookup and actual DO locator/run/inbox identity through `telegram-owner-do.ts` and the private responder path. Do not pass a message/env-selected repository. No real binding exists yet.
3. **Canonical SQL owner:** allocate the additive function migration, register canonical lists, and review the minimal signed-RPC execute privilege. This proposal grants none. Hosted installation needs separate release authorization; a reader/adapter must not call the absent live RPC beforehand.
4. **Context/ACL integration:** intersect trigger policy with installed handler/probe/current grants, supply live owner-bound sources/revision attestations, and recheck before private disclosure/provider dispatch and local publication. The current composer reports trigger-wide ACL; local sources remain fixture-backed.
5. **Fresh conversation:** reserved writer must use an explicit fresh canonical tree for admitted staging mode, preserve legacy bytes, reject mismatched fixture ancestry, and label the fresh start. No relabel/migration or deletion here.
6. **Cross-surface follow-on:** Telegram-only helper deliberately rejects other providers. Console/session expiry adapter, WhatsApp/app mapping, shared task continuation, health consent/device proof and Kennel integration retain their existing owners.
7. **Skills follow-on:** B provider counter/serialization proof, C reviewed manifest activation and J metadata-first loader remain separate. No skill row is activated by A1.

## Separate high-priority baseline authentication finding

The baseline `waldo.router_signed` can return SQL NULL for missing signature/timestamp. Existing `route_presence` uses `IF NOT router_signed`, so rejection is skipped. A read-only call in a fresh disposable synthetic database returned one routing row with a NULL signature (`/tmp/waldo-a1-baseline-null.log`). No hosted query or private data was used.

The latest `delete_owner` definition in `20260928140000_waldo_delete_owner_session_tables.sql:13` and other signed RPCs use the same pattern. Destructive calls were **not invoked**. This is a source-backed authentication bug class with potentially destructive impact; deployed exposure/version/permissions are unverified. Canonical SQL owner should reject NULL at the verifier boundary and test every signed caller before release. No baseline SQL function was modified by this slice. This is distinct from the fixed, unexposed proposal.

Rollback for preparation: discard the local commits/branch. There is no deployed binding, applied schema or owner data to reverse. Preserve Calendar branch/commit `1cf28a8bf679b76145bf392ef6557e266ff18862` (now owner-reported draft PR #554) and all dirty/reserved checkouts. Authorized internal Codex and Instinct Messages coordination occurred; no credentials, new permissions, push or deployment.

## Allocated host-bound adapter slice

`channels/owner-message-context-adapter.ts` wraps the existing `createContextComposer` and its existing dependencies, with no production caller. It supplies actual admitted input, binds every request and returned owner payload to the admission owner/tenant/snapshot, copies plain data without evaluating accessors, and checks owner/run/access currentness before and after awaited host reads. One immutable per-adapter access receipt serves direct reads and concurrent calls. Access set changes reject; revoke/regrant ABA is not detectable without a grant epoch.

ACL reuses Core's `intersectToolAcl` and `ToolAclSource` from merge e9a45fc. No new ACL table or permission grant. A registered/trigger-permitted/granted local tool remains available when connector state is unavailable; connector-backed tools are denied. Private caller must derive registered handlers and connector classification from authoritative metadata. The actual metadata/grants suppliers and unknown-name diagnostics remain Core/host integration, not silently invented here. Existing model schema/dispatcher integration is not wired.

Canonical history has a private per-row principal/tenant/lineage witness, checks every row and reuses `ConversationTree.append` for parent/chat/thread-anchor boundaries. Legacy and mismatched rows are denied without mutation. This does not stamp old storage as canonical. Existing composer still emits V2 checkpoints; Core owns V3 lineage/provenance emission and replay integration. Verification receipts remain private and absent from adapter prompts/checkpoints.

Adapter regression proof: real composer output contains actual admitted Bengaluru input, zero skills, unavailable grants empty ACL; available local tools are reachable; wrong identity/snapshot/reissued invocation denied before source read; revoked identity/access during await denied; mutation/getter/concurrent-call regressions; per-row wrong owner/tenant/legacy and invalid ancestry denied, admitted rows frozen. Independent review cleared the isolated inactive preparation after fixes; live sources, ABA generations, V3 provenance and activation are excluded from that clearance.

Final adapter verification: 116 focused tests/6 files PASS (12 adapter +17 admission +87 existing composer/skills), Core ACL/lineage contract tests10/2 files PASS, runtime worker/integration typechecks PASS, diff whitespace PASS. Initial loopback sandbox failures were setup errors; focused Workers tests used approved local loopback. Review regressions failed3/10 before fixes, then passed. Earlier test annotation errors corrected. No full verify/shared DB reset, live trials, CI rerun or runtime activation.

Mutation audit at5958: owner state_version changes only on owner.state; supported redeem_link_code unlinks and inserts a new presence UUID; unlink_presence marks state; auth provisioning changes auth_user_id; service-role updates can change custody fields. Disposable lifecycle-only fixture reproduced identical receipts after same-row unlink/reactivate and do_name away/back (2 expected failing requirements), then rolled back/disposed. Evidence is in task `evidence/a1/currentness-counterexamples.*`; no authentication RPC or live probe in this proof.

Minimal additive revision proposal, **not implemented**: owners.admission_revision managed by owner/presence triggers. Bump on owner state/do_name/auth_user_id and presence INSERT/DELETE/relevant owner_id/provider/subject/state UPDATE; transfer bumps affected old and new owners. Reject manual counter changes and return the revision in the separately allocated lookup. Existing tuple alone is insufficient for all mutations, so live currentness remains gated on an agreed installed revision source. Canonical SQL/migration ownership and security gate remain separate.
