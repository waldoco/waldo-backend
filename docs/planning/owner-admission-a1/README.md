# A1 local admission preparation

Owner approved canonical owner UUID, one personal owner per tenant, lifecycle rechecks and an explicitly fresh staging conversation. This is the non-overlapping preparation portion of #519/#520. No production caller imports the new helper; actual ingress, ACL/composer and fresh-history wiring are not implemented here.

## Scope and ownership

Base: `5958a8f73be68d083c78508b9b0aacb67854ce60`, explicitly fetched from GitHub October 2. Branch `codex/owner-admission-a1`; isolated worktree `/Users/shivanshfulper/Documents/Codex/2026-10-02/task-2/waldo-admission-a1`.

No reserved-file transfer was established. Local task evidence retains the dashboard lane and exclusive deployment session, and #520's exact docs-only head `76e49d2b6e989b61beb23fc549d73c7f57ba8394` is authored by Instinct. Existing `telegram-owner-do.ts`, `console-signin.ts`, `owner-turn.ts`, composer/contracts, canonical migrations and native36 fixtures are untouched. One small Engineering Fundamentals checklist/bug-log addition records the required NULL-auth regression discipline.

The helper accepts a **private authenticated host lookup**, not user/model authority. It validates and freezes owner UUID/presence UUID/provider/subject/state-version against the staging locator and exact allowlist; maps UUID to existing `prn_`/`ten_` references; accepts actual input through the existing authenticated-ingress invocation contract; and guards input disclosure/currentness around awaited lookups using RunEffectScope. Input and envelope are immutable. Retry identity includes environment, namespace, DO name, owner UUID, provider, subject and persisted occurrence key; actual DO ID is validated separately; callers must preserve the occurrence timestamp/content on replay. Changed content produces a different canonical idempotency serialization.

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

1. **Core/#520 allocation:** adopt the approved UUID/tenant policy and this proposed helper/lookup, rather than build a second implementation. Allocate `owner-turn.ts` and necessary composer admission/material/actual-ACL work. No transfer found; user policy approval does not cancel file reservations.
2. **Existing Codex single writer:** integrate a host-bound lookup and actual DO locator/run/inbox identity through `telegram-owner-do.ts` and the private responder path. Do not pass a message/env-selected repository. No real binding exists yet.
3. **Canonical SQL owner:** allocate the additive function migration, register canonical lists, and review the minimal signed-RPC execute privilege. This proposal grants none. Hosted installation needs separate release authorization; a reader/adapter must not call the absent live RPC beforehand.
4. **Context/ACL integration:** intersect trigger policy with installed handler/probe/current grants, supply live owner-bound sources/revision attestations, and recheck before private disclosure/provider dispatch and local publication. The current composer reports trigger-wide ACL; local sources remain fixture-backed.
5. **Fresh conversation:** reserved writer must use an explicit fresh canonical tree for admitted staging mode, preserve legacy bytes, reject mismatched fixture ancestry, and label the fresh start. No relabel/migration or deletion here.
6. **Cross-surface follow-on:** Telegram-only helper deliberately rejects other providers. Console/session expiry adapter, WhatsApp/app mapping, shared task continuation, health consent/device proof and Kennel integration retain their existing owners.
7. **Skills follow-on:** B provider counter/serialization proof, C reviewed manifest activation and J metadata-first loader remain separate. No skill row is activated by A1.

## Separate high-priority baseline authentication finding

The baseline `waldo.router_signed` can return SQL NULL for missing signature/timestamp. Existing `route_presence` uses `IF NOT router_signed`, so rejection is skipped. A read-only call in a fresh disposable synthetic database returned one routing row with a NULL signature (`/tmp/waldo-a1-baseline-null.log`). No hosted query or private data was used.

The latest `delete_owner` definition in `20260928140000_waldo_delete_owner_session_tables.sql:13` and other signed RPCs use the same pattern. Destructive calls were **not invoked**. This is a source-backed authentication bug class with potentially destructive impact; deployed exposure/version/permissions are unverified. Canonical SQL owner should reject NULL at the verifier boundary and test every signed caller before release. No baseline SQL function was modified by this slice. This is distinct from the fixed, unexposed proposal.

Rollback for preparation: discard the local commit/branch. There is no deployed binding, applied schema or owner data to reverse. Preserve Calendar branch/commit `1cf28a8bf679b76145bf392ef6557e266ff18862` and all dirty/reserved checkouts. No communications, credentials, new permissions or publication were performed.
