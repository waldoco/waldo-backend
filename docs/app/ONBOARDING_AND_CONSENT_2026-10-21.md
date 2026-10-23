# Onboarding, the consent ledger and the owner look-up

Status: implemented on the onboarding branch; not live until it merges and ships. Source of truth is `packages/contracts/src/app/onboarding.ts` and `packages/runtime/src/onboarding/`. App code is not in this repository.

## Routes (app.v1, all authenticated, additive)

| Route | What it does |
| --- | --- |
| `GET /app/v1/onboarding`, `POST /app/v1/onboarding/actions` | The first run: agreements, name, Google, health, first look, Brief time, priority, chat channel. State survives a restart; every write is exactly-once by `request_id`. |
| `GET /app/v1/onboarding/channels` | The three chat channels (iMessage, WhatsApp, Telegram) with the live link state of each, and the proactive-surface setting. |
| `POST /app/v1/onboarding/channel-link` | A one-time code for one chat channel. No `request_id`: it returns a secret that is never stored for a replay. |
| `GET /app/v1/consents`, `POST /app/v1/consents`, `POST /app/v1/consents/withdraw` | The consent ledger: non-health purposes only. `owner_lookup_offered` says whether this server offers the look-up at all. |
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
> **2. Let Waldo's AI models use it.** To plan your day, Waldo sends a summary of your WHOOP data (zones such as "low" or "high", not your raw numbers) to the companies that provide its AI models, today OpenAI and Anthropic. They are third parties. This happens only if you give this second yes. Waldo never uses your WHOOP data to create, develop, test, train, fine-tune or improve any model, prompt or eval.
>
> **Who else sees it.** Your WHOOP data, and Waldo's replies drawn from it, are shown only to you, on the surfaces you choose, unless you ask Waldo to share a specific item. A reply on WhatsApp, Telegram or iMessage passes through that channel's provider (Meta, Telegram, Apple). Waldo's notes about your WHOOP data are not medical advice.
>
> To stop: taking back the first yes stops the sync, deletes the WHOOP data Waldo stored and ends AI use. Taking back the second stops the sync and AI use and deletes nothing. Disconnecting WHOOP in Settings ends Waldo's access at WHOOP. If you agree again later, Waldo asks you again.

While staging trace capture (Langfuse) stays on, a further line names it as a recipient of WHOOP-derived turns; the owner accepted that on 22 October 2026, and the line goes when capture goes. The providers named are whichever an owner turn can route to; the list changes with a new copy version.

What the wording is built to keep true:
- **Who gets the data.** It names every model provider a turn can route to (today OpenAI and Anthropic) as third parties that receive the data only under the second yes, because WHOOP's terms bar exposing WHOOP data to a third party without the owner's explicit opt-in. It names the channel providers (Meta, Telegram, Apple) because replies drawn from the data travel through them. It does not say the data is "shown or sent to no one else".
- **No promise the providers have not made.** It says nothing about the providers keeping nothing or never training on the data. Waldo's own promise (never to use the data to create, develop, test, train, fine-tune or improve any model, prompt or eval) is true today and stays. Once zero-retention and no-training terms exist with every one of those providers, add one sentence saying so, as a new copy version.
- **The withdrawal effects** match the health plane: withdrawing `storage_compute` withdraws both grants for the source and purges what was stored; withdrawing `model_processing` stops the sync and model use and deletes nothing.
- **Retention** is the health contract's own constants (90 days of readings, 24 months of daily summaries).

Set no WHOOP secret and enter no client for the edge until all of these hold, none of which the app can settle:
1. **The providers' terms.** WHOOP's §4 also binds anyone acting for Waldo, so zero-retention and no-training terms with every model provider an owner turn can route to are a precondition for WHOOP, not optional wording.
2. **Trace capture.** Staging trace capture (Langfuse) is a further recipient of WHOOP-derived turns; the owner accepted that on 22 October 2026, and the notice names it for as long as staging capture stays on.
3. **The legal reading.** Whether a consent screen counts as the "express authorization" WHOOP's terms ask for is a legal reading, not a code one.
4. **The notice shipped.** The app ships this notice (copy version 3) and the health plane's copy-version migration is applied. The runbook `WHOOP_AND_OURA_2026-10-21.md` holds the same conditions.

## The chat-channel step

The owner picks and links iMessage, WhatsApp or Telegram (while it is the team test channel) through one flow, so no channel is built for one surface only. The app reads `GET /app/v1/onboarding/channels`, asks `channel-link` for a code, the owner sends the text from their own phone, and the app calls `channel.linked`, which marks the step done only when the owner directory shows the provider linked. `channel.set` (app, WhatsApp, both, or the app with an iMessage copy) chooses where proactive messages go and writes the console's own `proactive_surface_v1`; skipping leaves the app.

- iMessage gives the owner the number they text, read the way the console reads it: with Photon configured, the owner's own assigned pool number; without Photon, the one configured address. An owner with Photon configured who has not enrolled yet has no number, so iMessage reads `not_offered` until they get their Waldo number in the console's iMessage view. A directory that cannot be read is not a refusal: the channels view reads `unknown`, `channel-link` and `channel.linked` answer `503 unavailable`, and the fixed code `imessage_number` is logged.
- Telegram is offered only while the server holds its bot token; removing it retires the channel with no contract change (`not_offered`).
- Proactive delivery to iMessage is not wired by this step. It records the link and the owner's choice and claims nothing more.
- Untrusted text stays untrusted: a link code is issued only on the owner's signed-in routes, never by a tool. `test/chat-channel-links.test.ts` fails if any other module (a tool, hook or turn module) calls an issuer, so adding one forces a review that it is an owner act or goes through an approval card.
- `channel-link` needs the agreements accepted first, and rechecks the app session before the answer leaves.

## The owner look-up

Looking the owner up is an agent skill (`skills/owner-lookup`), not an onboarding gate: the agreements step only records the owner's yes or no to it.

- **Consent order.** `owner_lookup` is disclosed in the privacy notice, so the ledger refuses it until `privacy_notice` is accepted at its current copy (`agreements_required` on the route), and a yes stops counting whenever the notice it depends on is no longer live. Every check (recording a finding, listing them, the app view) reads the same `active('owner_lookup')`.
- **The server's switch.** `OWNER_LOOKUP` (a Worker var, `"0"` in production and staging) keeps the look-up off until the privacy notice that discloses it is published. Off, `GET /app/v1/consents` answers `owner_lookup_offered: false` and the app does not ask; a grant, or `agreements.accept` with `owner_lookup: true`, is refused `not_offered` and records nothing; a yes recorded while it was on stops counting, and the rows stay as evidence. Set `"1"` only once the notice below is published.
- **Who decides whose page it is.** The model, then the owner. Code holds the grounding only: the page was returned by a search or read in the same run, and the quote is on that page. A finding is unconfirmed external content with its source, listed in What Waldo knows; read back by the model it is web content again. Only the owner's keep or correct makes it a claim. A namesake's page that the model records is a card the owner forgets.
- **Forget and withdrawal.** Forgetting one finding, or withdrawing the look-up (on the consent route or by unticking it in the agreements), first hides every retained copy of the finding's text and quote wherever the memory forget reaches them (chat history, stored tool output, episodes, thread titles, iMessage records, cards and job reports), then, in one commit, erases the findings, purges any claim one became, and bars their text and quote from being recorded again. A failed hide changes nothing and the same request can be retried. A claim the owner had stated before a finding pointed at it stays.

## Privacy notice, copy version 1 (draft: the owner approves the wording)

These are the passages the privacy notice must carry before any owner is offered the look-up or diagnostic recording. They are written to be merged into the privacy and terms draft, which is not published. Grants are recorded against notice version 1 because no notice has been shown to any owner yet; once one has, any change to these passages is a new version, which asks every owner again.

**Health details you tell Waldo**
> If you tell Waldo about your health, such as a reading, a symptom, a medicine or a health goal, Waldo may remember it so it can plan around it. It stays in your private memory and is never written to Waldo's logs. It goes to the companies that provide Waldo's AI models (today OpenAI and Anthropic) only when it is relevant to a reply. Replies that draw on it reach you in the app and on any chat channel you linked, and a chat channel carries them through its provider (Photon and Apple for iMessage, Meta for WhatsApp, Telegram). Beyond that, Waldo shares it only if you ask it to share a specific item, or if you agreed to diagnostic recording (below). To delete it, ask Waldo in chat to forget it, or remove it in What Waldo knows. Deleting your account deletes it from Waldo; anything diagnostic recording already captured stays until it expires or you ask us to delete it.

**iMessage**
> If you talk to Waldo on iMessage, your messages pass through Photon, the service that runs Waldo's iMessage numbers. Photon receives your phone number, the email you signed in with and a first name taken from it, and every message you and Waldo exchange there. Apple carries iMessage itself.

**Diagnostic recording (beta only)**
> During the beta, if you agreed to diagnostic recording, the full text of your conversations, including any health details and any replies drawn from your WHOOP data, also goes to Langfuse, a service the Waldo team uses to find and fix problems, and the Waldo team can read it. You can turn diagnostic recording off at any time. Turning it off stops new recording; what was already recorded stays until it expires or you ask us to delete it.

**Looking you up (only if you say yes)**
> If you say yes, Waldo may look you up on the public web to learn about your work and public life, so it can help you better. It searches using your name and the handles, sites and email addresses you have given it, through Brave Search, which receives those search terms, and it reads the public pages it finds; those pages go to Waldo's AI model providers as part of the conversation. Everything it finds is listed in What Waldo knows with the page it came from, and stays unconfirmed until you keep, correct or forget it. Waldo is built not to record your health, religion, caste, politics or sexuality from these pages, and does not look up other people. You can take this yes back at any time: Waldo then deletes every finding and the passages it quoted, and does not record those same items again; Waldo's own replies about them stay in that chat until you delete it.

What each passage rests on, as the code stands on this branch:
- **Health memory:** the owner ruling of 22 October 2026 (what the owner tells Waldo may be kept, numbers included, never logged). The owner turn's model routes are OpenAI and Anthropic (`llm/owner-routes.ts`). It does not say "shared with no one else": replies travel through the linked channel's provider, and recorded testers' text reaches Langfuse, as the WHOOP notice's own correction found. No health-notes switch is promised: `health_memory.set` is not on `beta-mvp`.
- **Photon:** `docs/channels/imessage/PHOTON_ONBOARDING.md` ("Data at Photon"). Deleting a Waldo account does not yet remove the owner's Photon user; until that is automated it is removed by hand, so the notice must not promise more.
- **Diagnostic recording:** waldoco/waldo-backend#1398 (draft): staging Langfuse text only for owners who agreed. The passage ships only with it. The retention period is still open.
- **"Never written to Waldo's logs":** true only once #1398 lands. On this branch staging sets `WHATSAPP_DEBUG_LOG` to `"true"`, and `whatsappDebugLog` then logs whole WhatsApp payloads, message text included, so a health detail sent over WhatsApp on staging reaches the Worker logs. #1398 commits it to `"false"` and leaves turning it on to an explicit owner choice, so the clause holds only while it stays off. The health passage ships only with #1398, or with that clause removed.
- **Look-up erasure:** a quoted passage is at least 12 characters and is always hidden; a finding's own text is hidden when it is 12 characters or longer, since a shorter one would hide unrelated lines. A barrier matches the exact text or quote, so the same fact found later in other words, with another quote, can be recorded again for the owner to decide; the passage says "those same items" for that reason. Waldo's own replies that put a finding in other words match neither, and a message already delivered to a chat channel stays with that channel's provider; the passage says the replies stay for that reason.
- **Look-up:** `web_search` sends the query to Brave Search (`BRAVE_SEARCH_API_KEY`); page reads run from Waldo's Worker on Cloudflare (on staging through Cloudflare's browser), so the sites see a request from Cloudflare, not from the owner's device. GDPR Art. 14 asks the notice to name the sources and the categories: the categories are the seven in `appFindingCategoryV1Schema`.
- **Not in the four items asked, for the owner to decide:** voice notes are transcribed by ElevenLabs, Smallest AI or OpenAI, whichever has a key (`llm/transcriber.ts`). The notice names none of them today.

## The consent ledger and account deletion

Today the ledger lives in the owner's Durable Object and is erased with it when the owner deletes the account. Whether a minimal proof row should outlive the account is a legal call; it is written up as an owner ask on the pull request, with options and a recommendation. Nothing here decides it.
