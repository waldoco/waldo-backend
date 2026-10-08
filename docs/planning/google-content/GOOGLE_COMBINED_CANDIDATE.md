# Combined Google candidate for final review

Local preparation only. Owner: Google lane (Dalda). Prospective base is PR903 head 48c46ce50dca21711912c38d4feec26d2a13c6a0, not a claim that PR903 merged. That source includes console PR904. Mail source is frozen PR905 a4165cdae1812d2ffefad6c4d2c85edeb7226595; Calendar source is frozen PR907 117b34567e8d31bf7f7d23364c9f360553d26dfd. Neither published head was changed.

## Reconciled behavior

- The shared Google adapter keeps PR905's selected-account/reply headers/latest-message slice and exact sent metadata/thread verification together with PR907's stable Calendar ID, private operation marker, etag and all-day endpoint support. The unchanged connector-proxy entrypoint imports this combined adapter; no new command registration is needed.
- Owner account selection keeps mail's exact selection and multi-account rejection, and Calendar's selected-account scope/disconnection errors plus mandatory selection for ambiguous proposals. Both pass the pinned account through the existing proxy intent route. Calendar's current-source assertion reaches proposal preparation. No fallback or new action permission was added.
- The existing approval desk exposes both read-only recovery methods. The owner /ledger path calls both. Callback receipts mark their own lane. Both uncertain queues stay visible outside the bounded Recent history; recovery retains each lane's bounded fair rotation and never resubmits an effect.
- Common admission retains PR903 reminders and both reviewed Google tool sets. Mail writers retain the mail family; Calendar proposal retains the Calendar family and cannot use unresolved read defaults. Pasted-only guards retain mail reply-header and Calendar existing-event read checks; content-only creates remain usable. PR905's connector-metadata source policy is preserved, not broadened.
- Test configuration includes both Node journey suites and preserves console isolation. Type signatures retain both additions instead of choosing one branch's GoogleClient/desk contract.

Conflicts in common policy/host assertions, test configuration, package verification command, task-source mapping, owner client/desk/ledger wiring, Google failure mapping, source guards, and approval receipts/uncertainty were individually inspected and reconciled. No ours/theirs conflict strategy was used. Nonshared PR903/#904 changes were checked byte-for-byte against the pinned base, including reminders, console routing, owner activation/host, webhook, index, run-loop and CI routing.

## Local verification

- Mail journey: 26 tests pass, including a new combined same-adapter/same-ledger test. It loses mail and Calendar responses, crowds Recent with unrelated completed rows, recreates the desk, recovers both receipts, and confirms exactly one write per provider action after duplicate callbacks.
- Calendar journey: all 20 tests pass, preserving delayed receipt/Undo custody, later owner edit, If-Match race, unknown/restart and fair bounded recovery cases.
- Affected Workers: 168 tests across 11 files pass, including actual registered Calendar owner callbacks, approvals, Google, common policy/host, source guards, proxy intent routes and preserved reminder regressions.
- Hermetic owner ingress: 258 pass, two skipped. Link routing: 14 pass. Console tenant/ticket routing: 13 pass.
- Contracts: 1755 tests across 93 files pass. Workspace typechecks and final runtime Worker/integration typechecks pass. Connector-proxy transitive dependency graph check passes with no bare workspace imports. Canonical migration list validation passes (43 source migrations); full local Supabase/pgTAP bootstrap was not completed on this host. No Supabase source change is introduced.

This candidate has no published CI run or new independent final feature review yet. Parent/Core owns final exact-head review and any later shared integration. No push, merge, deployment, provider effect, new grant/session, credential extraction or model call was performed.

## Later integration and activation

Compute PR906 was inspected at 66d9aad0968d845728368141153f6c93d788fc0f but is not included. Its prospective common-tool options/admission and workspace source mapping must be combined additively with the Google and reminder entries; its owner capability wiring must remain intact. These are concrete future conflicts, not a reservation over those files. The local worktree is isolated and no other lane's source was edited.

Serving staging proxy v15 remains baseline 18f65898: it lacks mail reply-header/exact-sent-readback changes and Calendar stable-ID/private-marker/all-day support. After separate authorization, activation requires the connector-proxy bundle containing this combined adapter and a matching reviewed runtime. Parent-coordinated authenticated provider readback and approved effects remain outstanding. Existing source/CI proofs do not substitute for live acceptance.
