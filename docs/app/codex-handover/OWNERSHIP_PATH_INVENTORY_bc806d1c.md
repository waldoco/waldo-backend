# Ownership path inventory at bc806d1c

Reviewable source-only proposal. Exact checkpoint: `bc806d1c66aa6da8a41f759c608391aae42a2b5e`; tree: `9d265f92b8441dacc1008900080da61e760e97bd`; base: `1206d7a8e7577fe23ed454c328007767507b9101`. [JSON inventory](OWNERSHIP_PATH_INVENTORY_bc806d1c.json) lists every path with status, committed blob, bytes, SHA256, proposed owner, reason and test limits.

**Count correction:275 committed delta paths**, rather than272. The accepted7410 checkpoint had272. The three additionally base-different paths are `packages/runtime/test/browser-public-read-owner-do.test.ts`, `packages/runtime/test/forget-store-table.test.ts`, and `packages/runtime/test/owner-skills-private.test.ts`; all were already inspected in the accepted six-pathbc806 privacy delta.

## Ownership proposals

[Immutable ownership boundary](https://raw.githubusercontent.com/waldoco/waldo-backend/aa3d0eae26ebe8be4f278020575adf13e84828f4/docs/app/codex-handover/OWNERSHIP_BOUNDARY.md) was independently read. Codex retains health end to end and app-enabling authority/transport. Core owns broader agent capabilities. Browser/compute belongs to Dalda and remains held. One writer per path applies; shared proposals await Core acknowledgment and allocation. Core/Instinct remains sole beta merger. Kennel remains Ashish's lane.

| Proposed owner | Committed paths |
|---|---:|
| Codex health | 35 |
| Codex app | 87 |
| Core broader | 38 |
| Dalda browser, held | 12 |
| Shared, allocation required | 103 |

The JSON provides all275 individual path decisions, rather than assigning the candidate as one lane. App memory/Work wire facades do not transfer ownership of Core backing state or execution.

Shared seams requiring explicit allocation include:

- `packages/runtime/src/channels/telegram-owner-do.ts` and `packages/runtime/src/channels/owner-turn.ts`: owner root, health/context and native transport.
- `packages/runtime/src/context-composer/materials.ts` and `packages/runtime/src/context-composer/owner-turn.ts`: Core composer plus health/app sources.
- `packages/contracts/src/index.ts`, `packages/contracts/src/runtime/conversation-entry.ts`, `packages/contracts/src/tools/handler.ts`, and `packages/contracts/src/tools/permissions.ts`: shared contract/barrel and authority interfaces.
- `packages/runtime/src/channels/approvals.ts`, `packages/runtime/src/channels/owner-effect-ledger.ts`, `packages/runtime/src/run-loop/do.ts`, and `packages/runtime/src/scheduler/alarm-slot.ts`: shared effect/control and scheduler seams.
- Workspace byte custody, tool dispatcher, connector proxy and associated denial tests also have individual shared proposals in JSON.

## Seven frozen fixtures outside the commit

All seven bytes were read twice and stable. Their exact sizes/SHA256, existing committed counterparts, lane proposals and scoped test states are in JSON. No patch payload or raw log is embedded. The two preserved patch hashes and browser tracked diff match parent-supplied hashes; the new helper hash also matches.

| Repository-relative fixture | Observed state |
|---|---|
| `packages/runtime/test/browser-ordinary-interactive-owner-do.test.ts` | Browser receipt across2 files:25 passed,1 failed; ordinary timeout reported. |
| `packages/runtime/test/browser-owner-host-do.test.ts` | Same bounded browser receipt; aggregate not green. |
| `packages/runtime/test/fixtures/signed-browser-owner-directory.ts` | New untracked helper; excluded from committed candidate. |
| `packages/runtime/test/calendar-prep-owner-do.test.ts` | Google/calendar edits untested at freeze. |
| `packages/runtime/test/connector-proxy-entry.test.ts` | Google/calendar edits untested at freeze. |
| `packages/runtime/test/owner-do-registered-workspace.test.ts` | Target1 passed,20 skipped; unexercised `health_plane` signature known wrong, must fix/remove. |
| `packages/runtime/test/trusted-run-loop.test.ts` | RPC inventory receipt79 passed across3 files; scoped evidence. |

The reviewer read receipt summaries and hashed evidence, but ran no tests. The seven-fixture scan found no private key/provider token/JWT/private host-path matches; synthetic IDs/credentials remain fixture data. These files are not approved or merged by inclusion in this inventory.

## Coordination and acceptance

Core beta is parent-supplied `aa3d0eae26ebe8be4f278020575adf13e84828f4`. [PR996](https://github.com/waldoco/waldo-backend/pull/996) boundary checkpoint is parent-supplied prefix `c976`; full object not independently resolved here. [PR997](https://github.com/waldoco/waldo-backend/pull/997) has a parent-reported memory collision; no rebase performed. Shared paths require Core acknowledgment before another writer resumes.

Exactbc806 source-only privacy review is accepted separately. Aggregate/runtime/release/live acceptance remains unclaimed. #973 activation/merge and #987 ready-for-review holds remain. Rejected autonomous/background health-to-model disclosure stays absent pending direct owner approval; clinical validation remains `not_established`.

No checkout edit, publication, commit/push, rebase, test execution or patch export was performed. Public-ready artifacts contain repository paths and hashes without private host paths, raw logs or credential values.
