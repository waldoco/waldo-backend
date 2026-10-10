# Basic native serving candidate

Base: `aa3d0eae26ebe8be4f278020575adf13e84828f4`. This additive serving slice retains the existing Supabase invited email OTP and HMAC console-session bearer rail. It does not use mint-agent-jwt. Native OTP signs in already-bound invited members; a first-time invite recipient redeems through the existing signup flow before native sign-in. This slice does not provision a fresh owner from a bare email. Core remains sole beta-mvp merger. Broad PR998 and its local archives are preserved separately and must not be deployed as this candidate.

## Consumer contract

Direct source modules: `packages/contracts/src/app/core.ts` and `controls.ts`. No broad contracts barrel is transplanted. Runtime uses the same modules.

| Method | Path | Contract |
| --- | --- | --- |
| POST | `/app/v1/auth/code` | `{email}` → `{ok:true}`; same response for invited/unknown address |
| POST | `/app/v1/auth/verify` | `{email,code}` → active session plus credential, or needs_invite |
| GET | `/app/v1/session` | active session with full sess_/acct_ hashes, surface app, integer absolute_expires_at |
| POST | `/app/v1/auth/signout` | push custody revoke first, console-session revoke, fresh validated absence |
| GET | `/app/v1/chat/main` | witnessed canonical-owner history; newest first, opaque before-row cursor |
| POST | `/app/v1/chat/main/messages` | `{client_message_id,text}`; text 1–4000 chars, wire ≤32768 bytes; 202 durable receipt |
| GET | `/app/v1/chat/main/messages/{client_message_id}` | admitted/running/completed/interrupted/revoked receipt |
| GET | `/app/v1/controls?view=...` | day, connections, activity; strict DTO with revision |
| POST | `/app/v1/actions` | day timezone.set/proactivity.set only; reviewed revision and stable request_id required |
| GET | `/app/v1/actions/{request_id}` | same session's durable action receipt; no re-execution |

Bearer is the exact returned credential. account_ref is display/custody metadata, never routing authority. Server identity comes from signed active owner/session UUID authority and the physical owner DO. Main conversation is `owner:prn_<canonical owner UUID without hyphens>`. Text-only requests omit media/thread/protected fields. GETs/POSTs outside these route groups remain unavailable. No advanced native feature availability follows from older broad schemas.

Same owner + same client ID + same payload returns the original receipt across sessions/restart. Different payload returns 409. Durable payload, sequence and wake publish together before ACK. Queued rows execute after reconstruction/alarm. Recovered running rows become interrupted with effects_unconfirmed and never auto-replay. Directory transport failure retains queued custody. Terminal receipts remain bounded (4096 per owner); exhaustion refuses new sends rather than evicting dedup identity. Existing legacy conv rows remain intact and are not promoted to canonical owner input.

## Configuration and staging gate

Native uses `EXPO_PUBLIC_WALDO_APP_API_ORIGIN`, an exact parent-reviewed HTTPS origin; the staging origin supplied by the owner is `https://waldo-runtime-staging.piyushfulper3210.workers.dev`. Existing deployment1206 is not candidate compatibility proof. The inherited staging config has broader Google/calendar flags and text capture enabled; parent must review those actual flags and egress settings against the basic journey before promotion. No candidate deployment or native/provider acceptance has happened during source implementation.

Reuse existing staging Worker entry `src/staging-browser.ts`, owner DO namespace/bindings, SUPABASE_PROJECT_URL, SUPABASE_PUBLISHABLE_KEY, WALDO_ROUTER_HMAC_SECRET, RESPONSIBILITY_RATE_LIMITER, OPENAI_API_KEY and release annotation. No new credentials or permission expansion is needed. Telegram bot/presence is not required for app chat. Native initialization does not launch background migration or planning model work. Command-shaped native text follows canonical chat; Telegram harness shortcuts are not app controls. Browser/new background planning/provider effects are not activated by this slice. Parent reviews exact flags, invited-owner configuration and model allowance before staging or real provider calls.

Only additive migrations100 (app_session_authority) and400 (push custody with both FORCE RLS corrections) are required. Existing owners/auth/console sessions/Vault/signature rail are reused. Migration600 is not needed by this session-bound slice. No shared Supabase reset/migration or production change is authorized here. Push sending is not enabled; signout still must revoke existing custody before its bearer session.

## Evidence and remaining acceptance

Local serving proof uses real handleApp, consoleAuth, signed directory calls, physical owner DO checks, Workers durable storage and the ordinary responder pipeline. OTP/directory and model responses are synthetic. Reconstruction is local object reconstruction, not platform eviction. Model/provider/native acceptance remains parent-owned.

The full verify script resets shared local Supabase; it was deliberately not run. Migration/pgTAP proof uses a separate network-none container and synthetic GoTrue bootstrap, not a shared database or live auth service. Final receipts, exact consumer object manifest, independent security/QA review, guard results and CI state are published alongside this document once observed.

Existing #973/#987 holds remain. No denied autonomous background health-to-model path is added or retried. Broader health/nonhealth launch scope remains on its prior backlog; this source slice does not claim it complete.
