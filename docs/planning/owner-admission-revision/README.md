# Local owner admission revision preparation

Task `/root/owner_revision`; branch `codex/owner-admission-revision`, based on A1 `d8a082fac548cfdeeee08e4a86975c958ac129b4` (Core ancestor `e9a45fc51670c6683cc67cc2b023eb48c07aca4b`). This is authorized local source/test preparation. No hosted migration, signed-guard remediation, lookup/helper integration, grants, push, PR, merge or activation occurred.

## Counter contract

`owners.admission_revision` is a non-secret positive bigint epoch, allocated on owner creation and changed on actual owner `id`, `state`, `do_name`, or `auth_user_id` changes. Presence INSERT/DELETE and changes to `id`, `owner_id`, `provider`, `subject`, or `state` change affected owner epochs. Transfers change both old/new owners once, in sorted UUID order. No-op edits and other metadata preserve the epoch. Deleting the Auth user nulls its binding through the existing FK and changes the epoch. Owner deletion removes the row; a recreated UUID receives a fresh epoch.

A private, noncycling sequence supplies values across owner incarnations. A per-row `old + 1` counter would reset after deletion/reuse and allow ABA if a UUID is recreated. Values increase monotonically but are not consecutive: other owners and rolled-back transactions consume allocations. Exhaustion fails the mutation instead of wrapping. Reads must retain bigint precision; any future JSON receipt must serialize the epoch as an exact decimal string rather than a JavaScript number.

The invoker guard rejects direct supplied epoch mutations, including privileged postgres callers at depth one. The later definer allocator preserves existing service-role INSERT/custody writes without sequence grants. The presence writer is a private definer trigger; its nested owner write requires depth two **and** its effective function-owner identity. An unrelated service-role nested trigger fails this check. Trigger order is explicit (`a_...guard`, existing lifecycle trigger, `z_...allocate`) and the existing state_version behavior is preserved.

This protects against caller-level edits, not an administrator who can alter/disable triggers, reset the private sequence or define another same-owner privileged trigger/function. Same-owner privileged trigger code remains trusted. No caller-set GUC authorizes increments. The new sequence/functions grant no privileges to clients or service_role; authenticated owner table reads retain their existing policy/permissions.

`email`, `phone`, `phone_verified_at`, `bootstrap_claimable` and timestamps do not change this epoch. They affect existing signup/console/WhatsApp eligibility, not this bounded canonical owner + Telegram presence tuple. The epoch does **not** attest those eligibility/consent surfaces: their existing checks remain required. A bootstrap operation changing `auth_user_id` invalidates this tuple, regardless of accompanying profile changes. Do not describe this epoch as covering every identity or eligibility change.

## Observed verification

```sh
node scripts/verify-supabase-migrations.mjs
node docs/planning/owner-admission-revision/prove-local.mjs
```

The runner accepts no URL/arguments or inherited Docker endpoint overrides. It freezes a local Unix socket, uses cached pinned images, a unique labelled internal network and no ports. It applies 38 migrations, seeding an owner before the new migration. A separate explicit check requires exactly one seeded owner with a positive backfilled epoch; missing seed rows fail. The runner then deletes its seed and runs all 41 canonical pgTAP assertions without that fixture. The canonical suite checks the non-null column contract directly, so migrate-from-zero CI does not depend on a private seed. It then then runs three committed sessions: 40 opposite presence transfers and 20 lifecycle changes produce 100 unique strictly increasing owner revisions with no deadlock. A rolled-back presence edit preserves the original owner epoch. Cleanup confirms zero owned labelled containers/networks.

The initial transfer fixture exposed a real deadlock: destination foreign-key KEY SHARE conflicts with FOR UPDATE owner locks. The final source uses FOR NO KEY UPDATE, sufficient for epoch writes and compatible with FK key-share. Deterministic ordering prevents the opposing-transfer cycle exercised here. Arbitrary preexisting caller lock orders, owner deletion/key changes, and broad multi-row transactions are not proven deadlock-free; PostgreSQL may abort and the caller must retry the complete transaction. The trigger does not perform partial durable mutations when a transaction aborts.

Receipts are retained outside Git at `../evidence/owner-revision/`: `proof.log`, `proof-transfer-deadlock-red.log`, `proof-first-test-fixture-failure.log`, `guards-tests.log`, `guards.log`. The first fixture failure refreshed both saved owner epochs before its second assertion; the corrected helper refreshes only the checked owner. The concurrent red receipt was an implementation failure, fixed by compatible lock strength.

The migration-list and JavaScript syntax checks passed, as did 66 workflow/staging source tests. The full guard runner passed through OpenAPI freshness, OTP-template and owner-wire HMAC checks using cached yaml/typescript/contracts dependencies. It then failed at pgtap-gate: its bundled bootstrap requires Linux `/etc/os-release` and `dpkg`, absent on this macOS host; the attempted home-directory PGDG source write was sandbox-denied. The disposable pinned PostgreSQL proof above passes independently. Temporary dependency symlinks were removed. No network install or shared database reset was performed.

No full `pnpm verify` ran: it resets shared Supabase, outside authorization. No hosted/live/CI behavior is claimed. Source remains reviewable for the canonical SQL owner and parent release lane.

## Integration and rollback

The existing A1 lookup proposal/helper remain untouched and still lack this epoch. Adopting the exact epoch into signed lookup output and strict currentness receipts, defining any approved RPC privileges and applying the migration require coordinated follow-on work; this commit alone does not invalidate runtime receipts. The separate blocked signature issue remains unchanged. Do not route traffic to uninstalled interfaces.

Private preparation rollback is dropping this unactivated local commit. A hosted schema rollback was neither authored nor executed; once used for live authority, removing/resetting epochs could make old receipts current and needs separate release planning.

CI fixture correction: the initial canonical assertion queried the private runner seed, which is absent in normal migrate-from-zero CI and yielded NULL (1/41 failed in run 37003283847). Upgrade/backfill verification now belongs to the private runner; the canonical assertion verifies the required schema column. No fallback or conditional success was added. The corrected proof has not been rerun: automatic approval review rejected SQL execution based on an earlier user prohibition. JavaScript syntax and whitespace checks passed.
