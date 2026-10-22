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

**WHOOP's express authorization** to store the owner's data and use it in AI processing adds no purpose. It is the health plane's (`whoop`, `storage_compute`) and (`whoop`, `model_processing`) grants, both live, shown on the same consent screen as the other sources with WHOOP's own notice, copy version 3 (below). A WHOOP grant carries `version: 3` and a device grant `version: 2`; WHOOP rows may read back as 2 or 3, which the first run's health step ignores because it decides on source, purpose and status only. The health step reads both: a device source (`apple`, `samsung`, `health_connect`) counts on its storage grant; any other source counts only with storage and model use both live, and a source the health plane learns later never makes the step unreadable.

## WHOOP notice, copy version 3

This is the wording the app shows on the WHOOP consent screen. The app reads it from here. Both grants (storage, then AI use) are asked on this one notice, and any change to the wording is a new version number, which asks the owner again.

**Screen title:** Connect WHOOP

> Waldo can read your WHOOP data (sleep, recovery and workouts, with WHOOP's own scores) so it can plan your days around how you are doing. That needs two separate yeses from you, and you can take either back at any time.
>
> **1. Store it.** Waldo stores your WHOOP data in its health store and works out your Form, Recovery and Load from it, so you can see them. Readings are kept for 90 days and daily summaries for 24 months.
>
> **2. Let Waldo's AI model use it.** To plan your day, Waldo sends a summary of your WHOOP data (zones such as "low" or "high", not your raw numbers) to the company that provides its AI model. That company is a third party. This happens only if you give this second yes.
>
> Waldo's replies that draw on your WHOOP data appear wherever you talk to Waldo: in the app and in any chat channel you have linked, such as iMessage, WhatsApp or Telegram. Waldo's notes about your WHOOP data are not medical advice.
>
> To stop: taking back the first yes stops the sync, deletes the WHOOP data Waldo stored and ends AI use. Taking back the second stops the sync and AI use and deletes nothing. Disconnecting WHOOP in Settings ends Waldo's access at WHOOP. If you agree again later, Waldo asks you again.

What the wording is built to keep true:
- **Who gets the data.** It says the model provider is a third party and that it receives the data only under the second yes, because WHOOP's terms bar exposing WHOOP data to a third party without the owner's explicit opt-in. It does not say the data is "shown or sent to no one else": replies that draw on it travel through the owner's linked chat channels, and the notice says so.
- **No promise the provider has not made.** It says nothing about the provider keeping nothing or never training on the data. Add exactly one sentence to that effect, as a new copy version, only once zero-retention and no-training terms with that provider exist. Until then the notice must not promise it.
- **The withdrawal effects** match the health plane: withdrawing `storage_compute` withdraws both grants for the source and purges what was stored; withdrawing `model_processing` stops the sync and model use and deletes nothing.
- **Retention** is the health contract's own constants (90 days of readings, 24 months of daily summaries).

Gates before this notice ships (the owner's, not the app's):
1. Staging trace capture (Langfuse) would be a further recipient of WHOOP-derived turns. The owner's decision on excluding them is open; the notice must name any recipient that remains, so it does not ship until that is settled.
2. Whether a consent screen counts as the "express authorization" WHOOP's terms ask for is a legal reading, not a code one.
3. The provider's no-retention and no-training terms, as above, gate only the extra sentence, not the notice.

## The chat-channel step

The owner picks and links iMessage, WhatsApp or Telegram (while it is the team test channel) through one flow, so no channel is built for one surface only. The app reads `GET /app/v1/onboarding/channels`, asks `channel-link` for a code, the owner sends the text from their own phone, and the app calls `channel.linked`, which marks the step done only when the owner directory shows the provider linked. `channel.set` (app, WhatsApp or both) chooses where proactive messages go and writes the console's own `proactive_surface_v1`; skipping leaves the app.

- Telegram is offered only while the server holds its bot token; removing it retires the channel with no contract change (`not_offered`).
- Proactive delivery to iMessage is not wired by this step. It records the link and the owner's choice and claims nothing more.
- Untrusted text stays untrusted: a link code is issued only on the owner's signed-in routes, never by a tool. `test/chat-channel-links.test.ts` fails if any other module (a tool, hook or turn module) calls an issuer, so adding one forces a review that it is an owner act or goes through an approval card.
- `channel-link` needs the agreements accepted first, and rechecks the app session before the answer leaves.

## The consent ledger and account deletion

Today the ledger lives in the owner's Durable Object and is erased with it when the owner deletes the account. Whether a minimal proof row should outlive the account is a legal call; it is written up as an owner ask on the pull request, with options and a recommendation. Nothing here decides it.
