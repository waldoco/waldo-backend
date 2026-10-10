# Basic native serving checkpoint

The source consumer pin is `bc806d1c66aa6da8a41f759c608391aae42a2b5e`, tree `9d265f92b8441dacc1008900080da61e760e97bd`. The source was pushed and remote SHA verified. [Draft PR998](https://github.com/waldoco/waldo-backend/pull/998) targets Core's beta-mvp; Core remains sole merger. This is a bounded local serving checkpoint, not a deployed app acceptance receipt.

[Exact contract manifest](NATIVE_CONTRACT_PIN_bc806d1c.json) contains251 committed contract/OpenAPI/dependency objects. SHA256: `1c6a6647586ce86e795e2f0b282fa7b3ecc1cdc16d24f36b45fef46ca3d6c4a5`. Every blob, byte count and SHA256 was independently verified. Consume Git objects at that pin; never import dirty files or mix330 andbc806 contracts. [Serving and full27 procedure matrix](../NATIVE_SERVING_MATRIX_2026_10_10.md) preserves the complete scope and records unavailable features.

## Minimum connected app interface

| Step | Canonical route and behavior |
| --- | --- |
| Request code | `POST /app/v1/auth/code`, `{email}`. Existing invited account and real Supabase OTP delivery; generic response does not disclose invitation membership. |
| Verify | `POST /app/v1/auth/verify`, `{email,code}`. Successful reply carries the exact issued credential and active account/session references; store that received credential in native secure custody. |
| Session | `GET /app/v1/session`, issued bearer. Server derives canonical account/owner; channel identity is optional. |
| Send | `POST /app/v1/chat/main/messages`, stable `client_message_id` plus text. Durable admission returns202 and actual message ID/state. Use the same ID/body after uncertain admission; conflicting content is rejected. |
| Receipt | `GET /app/v1/chat/main/messages/{client_message_id}`. Owner-scoped receipt readback after restart; absence or uncertainty does not authorize blind model/effect replay. |
| Reply/history | `GET /app/v1/chat/main`, bounded immutable cursor; optional `/events` replay. Canonical witnessed history and app inbox delivery are distinct from provider push. Completed model request/reply is required for real acceptance. |
| Signout | `POST /app/v1/auth/signout`, issued bearer. Revoke session-bound device custody first, then the exact auth session and verify fresh absence. Missing custody RPC returns503 rather than a false success. |

Current local evidence includes API auth/forwarding/revocation tests and actual production-shaped owner DO tests with Telegram absent. Main serving consumes original media and reviewed voice input, reads same-ID receipt after reconstruction and prevents duplicate model invocation. Native, health-privacy and touched-source publication reviews match the committed source. These use fictional directory/model/provider responses; no real OTP/model/native journey is claimed. The legacy synthetic app-chat aggregate test fails its user-history assertion; an actual signed canonical basic journey is being rechecked before release. Four diagnostic runtime shards remain red:4798 passing/78 failing tests, and seven later frozen fixture paths remain outside this source pin.

## Required staging receipt

ONE immediate dependency: parent-reviewed HTTPS candidate origin serving this compatible app/auth/owner code, current signed directory RPCs and real model dispatch, with an authorized invited owner. No verified candidate origin is available here. Last reported staging source `1206d7a8e7577fe23ed454c328007767507b9101` is a different checkpoint and cannot establish candidate readiness.

The release receipt must identify the deployed commit and safe origin, successful route/auth preflight, current owner DO binding, rate limiter, existing Supabase OTP configuration and owner/session authority, and confirmed signout custody. New canonical migrations are `20261010010000_app_session_authority.sql`, `20261010040000_app_push_custody.sql` and `20261010060000_owner_runtime_authority.sql`; assess which already exist before applying anything. Existing auth/session migration lineage also remains required. No shared database reset is permitted. Existing server secrets are configuration inputs, never app build values or receipt content. The app only receives its API origin and nonsecret availability configuration.

For the basic journey, general model chat must use a real configured provider; `COMMON_OWNER_TASKS` may remain disabled and does not authorize #973 activation. Advanced health scores, browser expansion, personal projections and native push activation do not block basic chat. Parent owns staging configuration and real-owner coordination; the app peer owns its configured Simulator build. #973 and #987 holds remain. The rejected new autonomous health-model disclosure is unwritten and unapproved; existing explicit foreground consent is distinct.

Known auth limitation: a lost verify issuance acknowledgment has no canonical issuance lookup/replay identity or expiry receipt. The native app conservatively retains bounded unresolved revoke-only custody; it cannot guess credentials or infer authority. Received-session custody/revocation is tested separately. No completion claim covers this remaining protocol gap.

Broader nonhealth code is frozen for Core's accepted handoff; Codex retains app/enabling and health end to end under [PR996](https://github.com/waldoco/waldo-backend/pull/996). [Exact275-path inventory](OWNERSHIP_PATH_INVENTORY_bc806d1c.md) includes hashes, frozen fixture test limits and proposed shared writers awaiting acknowledgment.
