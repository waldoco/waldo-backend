# S3 independent preparation; verification and activation blocked

Base: beta-mvp `b822989aef2d5c5614e109f757a74b098d380a25`. S0 #508, S1 #510 and S2 #515 merged in that order at the original reference heads. No iMessage source differences were introduced by their merge commits. Source packet: [Waldo on iMessage](https://files.instinct.com/file-01M3V4WW7G7BGCDBNAMSG9WXK4), revision `filerevision-01m3v546v91v938mk1y0aca7sa`, inspected 1 October 2026.

## Verification decision gate

The packet's S3 section explicitly leaves verification and new-identity linking unavailable until later setup. S1 parses an injected `verified:true` binding; that flag is not verification. Existing `OwnerDirectory.byPresence` returns a DO name, subject and timezone, without owner/presence/bridge/Apple-account/chat identity or a revocation revision. Existing console authority authenticates Waldo sessions; `assert_channel_presence` checks owner/provider/subject membership. Neither proves control of an Apple sender or binds the full relay scope. Telegram/WhatsApp redemption remains unchanged.

Required decisions, requested from the owner before implementation:

- Pairing proof: how an authenticated existing owner proves the exact Apple sender and direct chat; permitted send-from/alias policy. Signed relay traffic, Apple account, display name and collected phone alone cannot link or provision.
- Canonical writer and activation authority: persistence of owner/presence/bridge/account/exact subject/chat, verification evidence and concurrent-link uniqueness. No new generic approval or auto-invite redemption.
- Revoke/unlink/account replacement: what authoritative revision changes, how keys and issued tickets become invalid, and how old work is fenced. No bearer challenge lifetime or cached authorization policy has been invented.
- Any live media byte/resource budget and commitment-expiry policy require separately named sources/decisions. Existing signature freshness does not imply an execution deadline.

Setup, linking, activation SQL and their positive activation/concurrent-link PostgreSQL tests are **BLOCKED**, not implemented or passed. Current states stay active/unlinked, with iMessage inactive-only. This preparation is not completed signup, independent activation readiness or live iMessage operation.

## Independent admission/media contract

`admitIMessageOwnerTurn` is an inert function with injected authority, directory and media adapters. No production composition, listener or enabled route calls it. It assumes the upstream relay boundary already authenticated/durably admitted raw bytes; it does not authenticate an arbitrary caller itself.

Authority has no default. A future reviewed authority must synchronously resolve a verified scope and answer whether the immutable grant's complete binding, revision and owner DO name are still current. The revision is an adapter fence, not a new identity policy or pairing token. Fixture authority proves only pipeline behavior. Revoke, replacement or unlink must make old grants fail; adapters returning an always-true/cached check are not production conformant.

Message/service/audience/echo and exact binding checks precede directory lookup. Oversized and duplicate-reference arrays reject before lookup. Directory output must match the authorized owner DO and exact subject; the validated route is copied/frozen across awaits. Authority is checked before lookup and after lookup, ticket issuance, ticket read, SHA-256, content handling and immediately before the admission callback. The callback is the existing owner-runtime seam; there is no second brain or Telegram numeric shim. Unknown senders invoke neither directory nor private-context callback.

Media scopes retain owner/presence/bridge/account/chat, revision, event/database generation, source message/part, reference, caption, filename, MIME, bytes, hash, kind and native-voice flag. Fixture storage keys are owner-prefixed JSON tuples, never filesystem paths or URLs. Tickets are nonserializable object-identity capabilities, single-use and exact-scope bound; the fixture store has no authority by default and checks current authority itself. There is no bearer lifetime, cloud fetch or live R2 adapter. A production ticket/storage implementation remains subject to the reviewed setup/revoke contract.

Loaded bytes must match declared length, SHA-256, observed MIME and kind. Adapters receive a copy so mutation cannot change the verified bytes. Image/document/file results must also match the actual bytes, filename, MIME and existing `LLMAttachment` schema. Audio/native voice/video/stickers are explicit unsupported results unless a later reviewed per-kind adapter exists; they are never disguised as loaded images/files or transcripts. Native voice stays distinct from ordinary audio in retained metadata.

The admission callback receives ordered per-source media statuses alongside the admitted envelope. Loaded attachments and source references preserve relative order, captions and identity; quote context retains external taint. Unsupported media is not claimed to be rendered by the existing core. The existing four-loaded-attachment ceiling is named `LLM_ATTACHMENTS_MAX` in its owning model contract without changing schema behavior. Singleton callers remain unchanged. Only the existing pure base64 utility is reused from Telegram media; no Telegram classification, IDs or download limits apply.

## Signature freshness

S2 `SignedRelay.authenticate` checks raw-byte HMAC and signature age at admission. After an awaited probe, it checks a current heartbeat, key and exact binding and transactionally rechecks command identity/digest. It does **not** recheck signature age as a commitment-expiry fence. The delayed-probe test advances the fixture clock beyond signature age, refreshes the heartbeat and leaves binding unchanged; one local_recorded fixture execution is permitted. Existing revocation-during-probe tests reject changed authority. No new late-execution policy or limit is introduced.

## Disposable PostgreSQL proof

Run `node docs/channels/imessage/migration-proposal/prove-inactive.mjs`. It accepts no URL/arguments and never reads an environment database URL. It refuses inherited Docker endpoint/context overrides and non-local contexts, then freezes the inspected local Unix socket for every Docker call. Each run creates fresh labeled containers and an internal Docker network, publishes no ports, and runs PostgreSQL as its postgres OS user. Pinned official Supabase image digests correspond to locally inspected Postgres 17.6.1.143 and GoTrue v2.192.0; only GoTrue's migrate command runs, with synthetic credentials, not a login or Auth listener. The authored startup budget is a disposable test budget, not provider capacity.

The runner validates the canonical list, applies all 37 canonical SQL files in order with printed SHA-256 hashes, then snapshots actual constraints, RLS/table ACLs, functions/function ACLs, policies and live-subject index. Synthetic owners carry the baseline-required verified-phone marker solely to test existing WhatsApp behavior; its phone-proof trigger is unchanged.

It executes the exact S1 candidate script, including its own rollback, and asserts catalog restoration. An outer transaction cannot contain a script that issues its own rollback. Therefore a second execution inserts pgTAP observations immediately before that same candidate rollback, without rewriting/duplicating DDL. Tests cover existing providers, inactive-only iMessage, rejection of privileged/authenticated activation, no pending state, owner FK, live-subject/cross-owner conflict, unchanged redemption providers, owner RLS, anon denial and unchanged grants/functions/policies/index. After rollback, the complete catalog must match again. Label-scoped cleanup inventories must report zero remaining owned containers/networks; Docker errors fail rather than claiming disposal.

This executes candidate inactive SQL in real PostgreSQL. It is not string-shape proof or an inference from baseline CI. It does not prove a verification/activation model, positive verified activation, concurrent iMessage linking or live revocation authority. Candidate SQL stays outside canonical migration discovery. No activation/down migration is written while the model is missing; the current proposal rolls itself back. Any later activation migration must carry reviewed down guidance that cannot leave active unverified rows.

## Proof limits and rollback

Source/fixture proof only: synthetic authority, fixture storage/content adapters, temporary relay SQLite and disposable PostgreSQL. No actual Apple device/account/database, native mutation, provider call/spend, hosted SQL/config, secret collection, public endpoint, manual/production deployment or production enablement. Existing automatic previews are owner-authorized. Existing local Linux-PG15 guard may be unavailable on macOS; actual CI jobs and local candidate SQL are separate evidence.

Rollback removes this unmerged preparation and disposes only its owned local fixture resources. No production authority/state depends on it. A later approved pairing/revoke contract is required to finish S3.
