# Onboarding, the consent ledger and the owner look-up

Status: implemented on the onboarding branch; not live until it merges and ships. Source of truth is `packages/contracts/src/app/onboarding.ts` and `packages/runtime/src/onboarding/`. App code is not in this repository.

## Routes (app.v1, all authenticated, additive)

| Route | What it does |
| --- | --- |
| `GET /app/v1/onboarding`, `POST /app/v1/onboarding/actions` | The first run: agreements, name, Google, health, first look, Brief time, priority, chat channel. State survives a restart; every write is exactly-once by `request_id`. |
| `GET /app/v1/onboarding/channels` | The three chat channels (iMessage, WhatsApp, Telegram) with the live link state of each, and the proactive-surface setting. |
| `POST /app/v1/onboarding/channel-link` | A one-time code for one chat channel. No `request_id`: it returns a secret that is never stored for a replay. |
| `GET /app/v1/consents`, `POST /app/v1/consents`, `POST /app/v1/consents/withdraw` | The consent ledger: non-health purposes only. |
| `GET /app/v1/findings`, `POST /app/v1/findings/actions` | Owner look-up findings: keep, correct or forget. |

## One consent representation per purpose

| Purpose | Where it lives | How the first run uses it |
| --- | --- | --- |
| `terms`, `privacy_notice`, `owner_lookup`, 18+ attestation | The consent ledger in the owner's Durable Object (`consent_ledger`, append-only; a withdrawal is a new row). | Written by `agreements.accept` and `/app/v1/consents`. |
| Health, per source and purpose (`storage_compute`, `model_processing`) | The health plane (Supabase), through its consent grant and withdraw routes. | Read only, through the signed `health_consent_list`. Never copied. |

The ledger table has a `CHECK` on `purpose`, so no health purpose or health source can be written to it by any code path. `test/app-onboarding.test.ts` ("one consent representation per purpose") proves it through a whole first run, through the consent route and by a direct write.

**WHOOP's express authorization** to store the owner's data and use it in AI processing adds no purpose. It is the health plane's (`whoop`, `storage_compute`) and (`whoop`, `model_processing`) grants, both live, shown on the same consent screen as the other sources with WHOOP-specific notice copy. The health step reads both: a device source (`apple`, `samsung`, `health_connect`) counts on its storage grant; any other source counts only with storage and model use both live, and a source the health plane learns later never makes the step unreadable.

## The chat-channel step

The owner picks and links iMessage, WhatsApp or Telegram (while it is the team test channel) through one flow, so no channel is built for one surface only. The app reads `GET /app/v1/onboarding/channels`, asks `channel-link` for a code, the owner sends the text from their own phone, and the app calls `channel.linked`, which marks the step done only when the owner directory shows the provider linked. `channel.set` (app, WhatsApp or both) chooses where proactive messages go and writes the console's own `proactive_surface_v1`; skipping leaves the app.

- Telegram is offered only while the server holds its bot token; removing it retires the channel with no contract change (`not_offered`).
- Proactive delivery to iMessage is not wired by this step. It records the link and the owner's choice and claims nothing more.
- Untrusted text stays untrusted: a link code is issued only on the owner's signed-in routes, never by a tool. `test/chat-channel-links.test.ts` fails if any other module (a tool, hook or turn module) calls an issuer, so adding one forces a review that it is an owner act or goes through an approval card.
- `channel-link` needs the agreements accepted first, and rechecks the app session before the answer leaves.

## The consent ledger and account deletion

Today the ledger lives in the owner's Durable Object and is erased with it when the owner deletes the account. Whether a minimal proof row should outlive the account is a legal call; it is written up as an owner ask on the pull request, with options and a recommendation. Nothing here decides it.
