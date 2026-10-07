# Google mail reply action journey

Local candidate based on canonical `waldoco/waldo-backend` beta-mvp `18f658987a6977e8233811b68761e66715659c23`. No live Google effects, grants, credential changes, model calls, deployment, publication or hosted database changes are part of this verification.

## Serving path and account custody

The shared common owner tool admission now includes Gmail reads, draft creation and the existing send proposal handler. The owner-local dispatcher and approval desk remain the executors; this is not a separate workflow runner. Mail-only task scope admits these handlers. A reply's additional provider header read respects the owner's explicit pasted-only source restriction.

Read connected account metadata with `connect_service`; pass `connection_id` on mail reads when multiple accounts are connected. Each read result reports the adapter account. Replies require that connection ID explicitly. Selection is constrained to the current owner's account set and grant scopes. Missing selected accounts, missing scopes and ambiguous multi-account selection never fall through to another account. Approval freezes the sender connection and address with the recipient list, subject, body, thread ID and exact MIME bytes. Legacy unbound proposals require a fresh review and cannot send.

`read_thread` returns RFC Message-ID and References alongside its messages. Reply draft/send preparation rereads the selected thread, chooses the supplied provider/RFC parent ID or the latest message in the returned latest-message window, validates header shape and subject compatibility, then builds In-Reply-To and References. Draft creation returns a Gmail draft receipt and remains unsent. `send_email` prepares the separate exact review card and never sends at tool invocation time. The existing Modify action invalidates its prior card; the revised content receives its own review.

## Effects, verification and recovery

An authenticated approval synchronously claims its ledger row before any await. Only that first claim can invoke `sendRaw`. Concurrent callbacks, interrupted attempts and reconstructed desks perform read-only reconciliation of the frozen Message-ID. Provider acknowledgement IDs are persisted separately from confirmation and channel delivery.

Sent-mail verification queries the Message-ID and reads the returned message metadata, checking the exact Message-ID and SENT label. A provider acknowledgement alone is insufficient. Empty lookup, transport failure and pending proxy intent remain uncertain; they never claim no delivery and never grant a resend.

The existing `/ledger` serving path runs a bounded reconciliation pass (at most eight outstanding send/delivery rows in fair durable check order). It delivers a confirmed receipt that was lost to a channel failure, without resending the email. Unknown operations remain visible in the existing ledger. Gmail Sent confirmation establishes that Gmail recorded the send; recipient delivery is not proven.

## Local evidence and commands

- `pnpm --filter @waldo/runtime exec vitest run --config vitest.google-journey.config.ts`: end-to-end synthetic thread → draft → exact review → authenticated callback → single send → provider metadata readback → channel receipt; adversarial account, grant, payload, callback, restart and delivery cases.
- `pnpm --filter @waldo/runtime exec vitest run test/approvals.test.ts test/google.test.ts test/google-token-refresh.test.ts test/common-owner-host.test.ts test/google-read-auth-status.test.ts test/run-effect-fence.test.ts test/mcp-google-auth.test.ts test/google-consent.test.ts test/task-source-scope.test.ts test/source-scope.test.ts`: existing Workers regressions with fictional bindings.
- `pnpm --filter @waldo/contracts test`, `pnpm -r typecheck`, `pnpm verify:guards`, `git diff --check`.

The node journey suite is included in `verify:node` and excluded from the Workers pool because it uses Node SQLite. Local node evidence is not live owner-turn acceptance.

## Shared integration hunks

- `telegram-owner-do.ts`: exact selector on `google.client`; forward approved selector in desk dependency; read-only reconciliation in the existing ledger projection.
- `common-owner-tool-policy.ts`: add the existing Gmail handlers to common admission.
- `task-source-scope.ts`: classify existing mail writes/account metadata under the mail family.

No changes to ticket routing, browser execution, workspace execution or the common loop state machine.

## Remaining acceptance

Parent must coordinate an authorized real owner journey on staging, including current Vault/proxy deployment compatibility (the shared connector now returns reply headers and performs message metadata readback), owner account selection and actual channel receipt. No live send was attempted. `/ledger` reconciles only up to eight outstanding rows per invocation and advances unfinished backlogs without completed-history starvation; this is bounded recovery, not unattended bulk reconciliation. This candidate does not send an existing mutable Gmail draft by ID: it sends exactly the separately reviewed MIME. General calendar/Tasks/Drive mutations remain outside this mail outcome.

## Official sources

- [Gmail sending guide](https://developers.google.com/workspace/gmail/api/guides/sending): base64url MIME and messages.send.
- [Gmail threads guide](https://developers.google.com/workspace/gmail/api/guides/threads): threadId, RFC reply headers and matching subject.
- [Gmail messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get): metadata readback.
- [OAuth web-server guide](https://developers.google.com/identity/protocols/oauth2/web-server): token refresh and grant lifecycle. Existing refresh classification is preserved.
