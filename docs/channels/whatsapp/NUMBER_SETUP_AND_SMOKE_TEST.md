# WhatsApp: number setup and smoke test

This page is the order of operations for putting a WhatsApp number in front of Waldo, and the checks that
prove each step: Meta's side, the Worker's configuration, then a smoke test. It authorizes nothing. Every
Meta write, secret change and deploy below needs the owner's yes at the time. Runtime claims cite source at
`f86af4fd`; Meta claims cite the guide page and its "Updated" date, read on 18 October 2026.

## What is true on 18 October 2026

| Piece | State |
| --- | --- |
| Runtime | Webhook, text-first linking, owner replies, the 24-hour window, held messages and the knock are on `beta-mvp`. A refused send or a failed delivery status logs the error's name and numeric codes, never the recipient, a message id or Meta's error text (`whatsapp-webhook.ts:212`, `:219`, `:221`). On staging only, while `WHATSAPP_DEBUG_LOG` is `"true"`, each signed webhook payload is also logged whole (`:23`, `:176`). A refused text-first, link-code or hidden-number reply then adds Graph's answer (its first 4,096 characters, with the token masked), and any other failure on those paths adds its text as `detail` (`:131-134`). Sends from the owner's Durable Object (replies, held messages, the knock) log the code only. |
| Meta app "Waldo" | Published. Its callback is staging's `/whatsapp/webhook`, subscribed to the `messages` field. |
| Meta's test number, +1 555 633 8976 | Inbound reaches staging, and Graph accepts sends. Meta then fails each delivery with 131031: seen at 16:39Z, 4 s after a reply was accepted. Meta's own `hello_world` never arrived either. Business Settings shows the number Connected, with quality High and a limit of 250 customers per 24 hours, and its Messaging account Approved (observed 16:50Z). The reason for the 131031 is not yet known. |
| Waldo's number, +91 92260 67544 | Verified, not registered. Registration was refused with `ACCOUNT_NOT_APPROVED`. Meta MCP reports its Messaging account as "Restricted" (16:41Z). WhatsApp Manager showed both of Waldo's Messaging accounts as "Account Restricted: Before you can begin messaging, you will need to verify your business" (observed 18 October). |
| Business verification | Not verified, per Meta MCP at 16:41Z. The owner started it on 18 October. [inference] It is the likeliest cause of the restriction on Waldo's number. Whether it also clears the test number's 131031 is unknown. |
| Knock template | Not created. See the [template plan](REENGAGEMENT_TEMPLATE.md). |

Meta's account model splits a number's assets in two
([WhatsApp accounts and Messaging accounts](https://developers.facebook.com/documentation/business-messaging/whatsapp/whatsapp-business-accounts/),
updated 5 August 2026):
- The **WhatsApp account** holds the phone number.
- The **Messaging account** holds templates, billing and the webhook subscription. Graph's permission errors
  call it the "Paid Message Account" (observed 18 October).

The Worker's `WHATSAPP_ACCESS_TOKEN` belongs to the system user `waldo-staging`.

## Setup chain

Each step ends with a check you can see. A step whose check fails is the answer: stop there.

1. **Verify the business** (owner, in Meta Business Suite's Security Center).
   *Check:* Meta MCP `whatsapp_biz_businesses` reports the business as verified. WhatsApp Manager no longer
   shows "Account Restricted" for the number's Messaging account.
   Do not probe this step by retrying step 3. After 10 registration requests in 72 hours, Meta returns 133016
   and blocks registration for the next 72 hours
   ([Register a business phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration),
   updated 26 June 2026).
2. **Add billing** (owner) on the number's Messaging account.
   *Check:* WhatsApp Manager no longer shows "Missing valid payment method". Without a payment method, Meta
   delivers service messages only within the monthly free tier
   ([Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing), updated
   30 September 2026), and [inference] the knock, a paid template, needs billing too.
3. **Register the number.** With the owner's yes, an agent may call Meta MCP `whatsapp_biz_register_phone_number`
   without a PIN. If Meta asks for a PIN, the owner registers the number themselves: registration is API-only
   (registration page above), so the owner calls Graph's `POST /<phone_number_id>/register` from their own
   terminal, with `messaging_product` set to `whatsapp` and a 6-digit `pin`, and keeps the PIN in their own
   password manager. A registration made with a PIN sets that PIN as the number's two-step verification PIN.
   That PIN is a credential: it never passes through an agent, chat, docs, tickets or logs.
   *Check:* MCP `whatsapp_biz_phone_numbers` lists the number as linked. List it through its Messaging
   account: on 18 October, looking the number up directly returned nothing, though it was on that account. An
   unregistered number fails sends with 133010 or 131045.
4. **Subscribe the number's Messaging account to the Waldo app** (MCP `whatsapp_biz_subscribe_webhook`). The
   app's callback alone delivers nothing. Meta sends webhooks only to apps subscribed to the Messaging account,
   which holds the subscription.
   *Check:* MCP `whatsapp_biz_onboarding_status`, given the number's `phone_number_id`, reports the account
   subscription done. Then message the number from a phone on nobody's file, never the smoke-test phone or an
   owner's: the tail filter below shows a webhook event (`"webhook":true`) with status 200. Until step 6, Waldo
   replies from the old number, so expect that reply to be refused or not to arrive.
5. **Give the system user `waldo-staging` full control of both of the number's accounts** (owner, in Business
   Settings): its WhatsApp account and its Messaging account.
   *Check:* Business Settings lists `waldo-staging` with full control on both. After step 6, a send refused
   with code 10, "(#10) Viewer cannot access the provided Paid Message Account", means this step is incomplete.
6. **Switch the Worker to the number** (owner sets the `WHATSAPP_PHONE_NUMBER_ID` secret). The switch is
   all-or-nothing: every send reads that one secret (`whatsapp-webhook.ts:203-243`, `owner-do.ts:2474`).
   Before switching:
   - **Unsubscribe the old number's Messaging account.** The owner does this on the app's WhatsApp
     configuration page in the App Dashboard, which is where the Meta MCP's own description sends subscription
     changes; the MCP cannot remove a subscription.
     - Why: the webhook never compares an entry's `metadata.phone_number_id` with the configured number. Its
       only mention is the type at `whatsapp-webhook.ts:69`. A message to any subscribed number is answered
       from the configured one, so a tester writing to the old number would get the answer from the new one.
     - Exception: if the old and new numbers share a Messaging account, don't unsubscribe it, because that
       cuts off both. The cross-answer risk then stays until the webhook compares numbers.
   - **Have each tester write to the new number first.** An owner's window record is kept per owner, not per
     business number (`whatsapp-window.ts:20`), and survives the switch. It is cleared only when the owner's
     own number changes or the owner unlinks (`whatsapp-window.ts:223-226`, `owner-do.ts:1731`). Meta has no
     window open for the new pair, so Waldo's first send to a tester who has not written is refused with
     131047 and held.

   *Check:* smoke test S2 to S4 pass from the new number.
   *Rollback:* set the secret back to the previous number and re-subscribe its Messaging account.
7. **Create the knock template after step 5, and configure it with step 6 or after it**, per the
   [template plan](REENGAGEMENT_TEMPLATE.md). Review can take up to 24 hours. Until the template is
   configured, messages outside the window are held without a knock.

Meta's test number delivers only to the recipients on its allow-list (error 131030, observed 18 October),
which is managed on the app's WhatsApp API testing page in the App Dashboard.

## Smoke test

**The test phone.** It must not be the business number. Its number must be on file for exactly one test
owner account, never the owner's own, and not linked yet. A phone that is on nobody's file gets the
waitlist text instead of a link (`whatsapp-webhook.ts:43-47`): S2 and S3 still pass; at S4 the waitlist
text arrives instead of the link, and S5 cannot run.

**Watching the Worker.** Use this tail filter. It prints no URL. It keeps every webhook request, and every
event that logs a `whatsapp_` line, including the owner's Durable Object: replies, held messages and the
knock log there, often inside an alarm, which has no request at all. From `packages/runtime`:

```bash
npx wrangler tail waldo-runtime-staging --format json | jq -c '{webhook: ((.event.request.url // "") | test("/whatsapp/webhook")), status: .event.response.status, hops: [.logs[]?.message[0]? | select(type == "string" and test("\"hop\":\"whatsapp_"))]} | select(.webhook or (.hops | length > 0))'
```

Never paste raw tail output anywhere shared. It carries request URLs and headers, and Meta's verification
request carries the verify token in its query string (`whatsapp-webhook.ts:163-165`). While staging's debug
log is on, don't share the filtered output either: its `whatsapp_debug_payload` lines carry testers' numbers
and message text.

**Reading a failed delivery.** On staging, the status view keeps only each status's `status`, `errors` and
`pricing` from the debug payloads. A failed status's `errors` carry Meta's `title`, `message` and
`error_data.details` for its code, and `pricing.category` shows how Meta billed the message:

```bash
npx wrangler tail waldo-runtime-staging --format json | jq -c '[.logs[]?.message[0]? | select(type == "string" and test("\"hop\":\"whatsapp_debug_payload\"")) | (try fromjson) | .payload.entry[]?.changes[]?.value.statuses[]? | {status, errors, pricing}] | select(length > 0)'
```

| Step | Do | Pass when | Evidence |
| --- | --- | --- | --- |
| S1 | Run MCP `whatsapp_biz_onboarding_status` with the number's id. Waldo's number only: the MCP leaves Meta's test numbers out | Every step is done | The tool result |
| S2 | From the test phone, send `hi` | A webhook event (`"webhook":true`) with status 200, whose hops include `{"hop":"whatsapp_text_first","ok":true,"replied":true}` | Tail |
| S3 | Nothing; same send | No `whatsapp_text_first` line with `"ok":false` follows | Tail. On failure, the line's `status` and `code`, and on staging its `body`: Graph's answer |
| S4 | Nothing; same send | The link message arrives, and no `whatsapp_status_failed` line appears within 10 minutes | The phone. On staging, the status view also shows `sent`, then `delivered` |
| S5 | Open the link, sign in, confirm, then send `hi` | Waldo answers as that owner's Waldo | The phone |
| S6 | The knock | As in the template plan's live test | The tail filter above, and the phone |

**Limits on repeat checks.**
- Texts from an unlinked phone, other than `waldo CODE`, are throttled at 3 per hour, before any reply logic
  (`whatsapp-webhook.ts:32-48`). [inference] Texts that get no reply count too.
- While a sent link is pending, further texts get no reply for its 10 minutes. That silence also follows a
  link whose send failed, which is a known gap.
- For a repeat check from a phone that is still unlinked, send `waldo 000000`. It is a code that cannot
  redeem: Waldo answers "That code did not work", and a refused send logs `whatsapp_link_code` with the
  Graph status and code (`:215-219`). On 18 October, one `waldo 000000` from the owner's unlinked phone took
  the text-first path instead. A text takes the code path only when, after trimming, its first word is
  `waldo` in any case and a second word follows (`:136-147`). [inference] The text that arrived differed,
  for example by a quote or a comma. On staging, the debug payload shows the literal text.
- A linked phone's texts go to its owner instead (`:188-201`).

**Stop rule.** Graph accepted a send (no `"ok":false` line), but within 10 minutes neither the message nor a
`whatsapp_status_failed` line arrived? Stop sending. Check WhatsApp Manager's overview for a restriction or
billing banner instead; more sends add nothing.

## Diagnosis by code

Codes come from [WhatsApp error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)
(updated 18 June 2026) unless marked as observed or cited otherwise. On staging, read Meta's own explanation
first: a failed status's `errors` in the status view, or the `body` of a refused text-first, link-code or
hidden-number reply. Sends from the owner's Durable Object log the code only.

| Code | Meaning | Where to look |
| --- | --- | --- |
| `ACCOUNT_NOT_APPROVED`, on registration | The Messaging account is restricted (observed) | Step 1 |
| 133016 | Too many registration requests: registration is blocked for 72 hours (registration page) | Step 3; wait |
| 10, 200 to 299 | Permission missing. Observed as "(#10) Viewer cannot access the provided Paid Message Account" | Step 5 |
| 190 | Access token expired | The owner replaces `WHATSAPP_ACCESS_TOKEN` |
| 131030 | Recipient not on the test number's allow-list (observed; not in Meta's table) | Test-number note |
| 131042 | Payment method problem | Step 2 |
| 131045, 133010 | Number not registered | Step 3 |
| 131031 | Either the account is restricted or disabled for a policy violation, or data in the request, such as a two-step PIN, does not match the account. Seen on 18 October as a failed status on the test number | On staging, the failed status's `error_data.details` first. At registration: the PIN in step 3. At send: step 1, WhatsApp Manager's account status, and the AI-provider terms below as a competing cause; then Meta Business Support |
| 368 | Account restricted or disabled for a policy violation | Meta Business Support |
| 131026 | Undeliverable: not a WhatsApp number, terms not accepted, or an old app version | The recipient's phone |
| 131047 | Window closed | Expected: Waldo holds the message and knocks |
| 131049, 131050 | Marketing-template limit or opt-out | The knock was categorized as marketing; see the template plan |
| 132001 | Template missing in that language, or not approved | Template plan, step 4 |
| 132015, 132016 | Template paused or disabled for low quality | Template plan, step 6 |
| 131056 | Too many messages to one recipient in a short time | Wait |
| 130429 | Throughput limit reached | Wait |

## Rules while testing

- The owner sets and holds these four. None of them goes in chat, docs, tickets or logs:
  - `WHATSAPP_ACCESS_TOKEN`;
  - `WHATSAPP_APP_SECRET`;
  - `WHATSAPP_VERIFY_TOKEN`;
  - the registration PIN.
- Outside staging, logs carry error names and codes, never phone numbers, message ids, business-scoped user
  ids or message text. Staging is the exception while testing, by the owner's ruling of 18 October 2026:
  with `WHATSAPP_DEBUG_LOG` set to `"true"`, it logs whole webhook payloads and Graph's answers to refused
  webhook replies, which carry all four, health details a tester types included. `CLAUDE.md` records the
  exception, which ends before production. The Worker never logs a credential.
- Tell each tester that staging logs what they send.
- Every Meta write (subscription, registration, access, template) and every secret change or deploy needs the
  owner's yes for that action.
- Message only people who have written to the number first.

## Risks the owner has accepted

- **AI assistants.** Meta's terms of 15 January 2026 allow general-purpose AI assistants on the WhatsApp
  Business Platform only in markets where Meta is legally required to. India is not among them
  ([AI Providers pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers),
  updated 15 October 2026). The owner accepted this risk on 16 and 18 October.
- **Service-message charges.** Since 1 October 2026, Meta charges for service messages beyond 1,000 per
  business number per month
  ([Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing), updated
  30 September 2026). Each Waldo reply inside the window is a service message. If Meta treats Waldo as an AI
  provider, the AI-provider page's own policy governs service messages instead.

## Proof limits

Seen on 18 October:
- inbound messages to the test number reached staging;
- Graph accepted sends;
- errors #10 and 131030 appeared and were cleared;
- after the logging deploy (`74dbb957`), a reply's failed delivery status carried 131031;
- Business Settings showed the test number Connected and its Messaging account Approved.

Not yet seen on any number:
- a delivered Waldo message;
- a registered Waldo number;
- a knock;
- a linked owner's conversation over WhatsApp.

Two things are not yet known: why the test number gets 131031, and whether verification clears it. The
debug log has been live on staging since 17:43Z (`f86af4fd`, Worker version `315fbc02`); no Meta webhook has
reached it yet, so its first `whatsapp_debug_payload` line is still to be seen. The next failed message should
show Meta's explanation.
