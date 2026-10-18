# WhatsApp: number setup and smoke test

This page is the order of operations for putting a WhatsApp number in front of Waldo, and the checks that
prove each step: Meta's side, the Worker's configuration, then a smoke test. It authorizes nothing. Every
Meta write, secret change and deploy below needs the owner's yes at the time. Runtime claims cite source at
`74dbb957`; Meta claims cite the guide page and its "Updated" date, read on 18 October 2026.

## What is true on 18 October 2026

| Piece | State |
| --- | --- |
| Runtime | Webhook, text-first linking, owner replies, the 24-hour window, held messages and the knock are on `beta-mvp`. A refused send or a failed delivery status logs numeric codes only (`whatsapp-webhook.ts:198`, `:205`, `:207`). |
| Meta app "Waldo" | Published. Its callback is staging's `/whatsapp/webhook`, subscribed to the `messages` field. |
| Meta's test number, +1 555 633 8976 | Inbound reaches staging, and Graph accepts sends. Meta then fails every delivery with 131031, an account restriction: seen at 16:39Z, 4 s after a reply was accepted. Meta's own `hello_world` never arrived either. |
| Waldo's number, +91 92260 67544 | Verified, not registered. Registration was refused with `ACCOUNT_NOT_APPROVED`. Meta MCP reports its Messaging account as "Restricted", with outstanding issues in WhatsApp Manager. |
| Business verification | Not verified, per Meta MCP at 16:41Z. The owner started it on 18 October. Until it passes, nothing can be delivered from this business. |
| Knock template | Not created. See the [template plan](REENGAGEMENT_TEMPLATE.md). |

Meta's current account model splits a number's assets in two. The **WhatsApp account** owns the phone number.
The **Messaging account** owns templates and billing; Graph calls it the "Paid Message Account" in permission
errors. The Worker's `WHATSAPP_ACCESS_TOKEN` belongs to the system user `waldo-staging`.

## Setup chain

The same chain applies to any number. Each step ends with a check you can see. A step whose check fails is
the answer: stop there.

1. **Verify the business** (owner, Meta Business Suite, Security Center). Until then Meta keeps every
   Messaging account of the business restricted ("Before you can begin messaging, you will need to verify
   your business").
   *Check:* WhatsApp Manager's overview no longer shows "Account Restricted" for the number's Messaging account.
   *Falsifier:* step 3 still returns `ACCOUNT_NOT_APPROVED`.
2. **Add billing** (owner) on the number's Messaging account.
   *Check:* WhatsApp Manager no longer shows "Missing valid payment method". Without it, sends fail with 131042.
3. **Register the number** (Meta MCP `whatsapp_biz_register_phone_number`). Registering sets the number's
   two-step verification PIN. The PIN is a credential: the owner chooses and keeps it, and it never goes in
   chat, docs, tickets or logs.
   *Check:* MCP `whatsapp_biz_phone_numbers` lists the number as linked. Unregistered, sends fail with 133010 or 131045.
   List it through its Messaging account. On 18 October, looking the number up directly returned nothing, though it was on that account.
4. **Subscribe the number's WhatsApp account to the Waldo app** (MCP `whatsapp_biz_subscribe_webhook`). The
   app's callback alone delivers nothing: Meta sends an account's webhooks only to apps that account is
   subscribed to.
   *Check:* MCP `whatsapp_biz_onboarding_status`, given the number's `phone_number_id`, reports the account
   subscription done, and a message to the number shows `POST /whatsapp/webhook 200` in the Worker's tail.
5. **Give the system user `waldo-staging` full access to both of the number's accounts** (owner, Business
   Settings), the WhatsApp account and the Messaging account. The existing token picks the access up.
   *Check:* sends stop failing with `(#10) Viewer cannot access the provided Paid Message Account`.
6. **Switch the Worker to the number** (owner sets the `WHATSAPP_PHONE_NUMBER_ID` secret). The switch is
   all-or-nothing: every send reads that one secret (`whatsapp-webhook.ts:189-229`, `owner-do.ts:2474`).
   Before switching:
   - **Unsubscribe the old number's account.** The webhook never compares an entry's
     `metadata.phone_number_id` with the configured number (its only mention is the type at
     `whatsapp-webhook.ts:61`). A message to any subscribed number is answered from the configured one, so
     a tester writing to the old number would get the answer from the new one.
   - **Have each tester write to the new number first.** An owner's window record is kept per owner, not per
     business number (`whatsapp-window.ts:20`), and survives the switch: `bindWhatsAppNumber` (`:223`)
     clears it only when the owner's own number changes. Meta has no window open for the new pair, so
     Waldo's first send to a tester who has not written is refused with 131047 and held.

   *Rollback:* set the secret back to the previous number and re-subscribe its account.
7. **Create and configure the knock template** on the number's Messaging account, per the
   [template plan](REENGAGEMENT_TEMPLATE.md). Until it is configured, messages outside the window are held
   without a knock.

Meta's test number delivers only to the recipients on its allow-list (error 131030, observed 18 October),
which is managed on the app's WhatsApp API testing page in the App Dashboard.

## Smoke test

Run it after the chain, from a phone that is not the business number and is not the owner's. Watch the
Worker with `npx wrangler tail waldo-runtime-staging --format json` (from `packages/runtime`), piped through a
filter that prints only each request's path and status and the log fields named below. Never paste raw tail
output anywhere shared: it carries request URLs and headers, and Meta's verification request carries the
verify token in its query string.

| Step | Do | Pass when | Evidence |
| --- | --- | --- | --- |
| S1 | Run MCP `whatsapp_biz_onboarding_status` with the number's id | Every step is done | The tool result |
| S2 | From an unlinked phone, send `hi` | `POST /whatsapp/webhook 200`, then `{"hop":"whatsapp_text_first","ok":true,"replied":true}` | Tail |
| S3 | Nothing; same send | No `whatsapp_text_first` line with `"ok":false` follows | Tail. On failure, the line's `status` and `code` |
| S4 | Nothing; same send | The link message arrives, and no `whatsapp_status_failed` line appears within 10 minutes | The phone. Delivered statuses are not logged |
| S5 | Open the link, sign in, confirm, then send `hi` | Waldo answers as that owner's Waldo | The phone |
| S6 | The knock | As in the template plan's live test | Tail and phone |

The text-first reply is limited to 3 per sender per hour, and while a sent link is still pending, further
texts get no reply for its 10 minutes (`whatsapp-webhook.ts:24-40`). That silence also follows a link whose
send failed, a known gap. For repeat checks from one phone, send `waldo 000000`: a code that cannot redeem,
answered with "That code did not work", whose refused send logs `whatsapp_link_code` with the Graph status and
code (`:201-205`).

**Stop rule.** Graph accepted a send (no `"ok":false` line) but within 10 minutes neither the message nor a
`whatsapp_status_failed` line arrived? Then stop sending. Check WhatsApp Manager's overview for a restriction
or billing banner instead; more sends add nothing.

## Diagnosis by code

Codes come from [WhatsApp error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)
(updated 18 June 2026) unless marked as observed.

| Code | Meaning | Where to look |
| --- | --- | --- |
| `ACCOUNT_NOT_APPROVED`, on registration | Messaging account restricted (observed) | Step 1 |
| 10, 200 to 299 | Permission missing; observed as "(#10) Viewer cannot access the provided Paid Message Account" | Step 5 |
| 190 | Access token expired | The owner replaces `WHATSAPP_ACCESS_TOKEN` |
| 131030 | Recipient not on the test number's allow-list (observed; not in Meta's table) | Test-number note |
| 131042 | Payment method problem | Step 2 |
| 131045, 133010 | Number not registered | Step 3 |
| 131031, 368 | Account restricted or disabled for a policy violation. Seen on 18 October as a failed status on the test number while the business was unverified | Step 1, then WhatsApp Manager's account status. If it outlasts verification, Meta Business Support |
| 131026 | Undeliverable: not a WhatsApp number, terms not accepted, or an old app version | The recipient's phone |
| 131047 | Window closed | Expected: Waldo holds the message and knocks |
| 131049, 131050 | Marketing-template limit or opt-out | The knock was categorized as marketing; see the template plan |
| 132001 | Template missing in that language, or not approved | Template plan, step 4 |
| 132015, 132016 | Template paused or disabled for low quality | Template plan, step 6 |
| 131056 | Too many messages to one recipient in a short time | Wait |
| 130429 | Throughput limit reached | Wait |

## Rules while testing

- The owner sets and holds `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` and the
  registration PIN. None of them goes in chat, docs, tickets or logs.
- Logs carry codes only: never phone numbers, message ids, business-scoped user ids or message text.
- Every Meta write (subscription, registration, access, template) and every secret change or deploy needs the
  owner's yes for that action.
- Message only people who have written to the number first.

## Risks the owner has accepted

- Meta's terms of 15 January 2026 allow general-purpose AI assistants on the WhatsApp Business Platform only
  in markets where Meta is legally required to; India is not among them
  ([AI Providers pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers),
  updated 15 October 2026). The owner accepted this risk on 16 and 18 October.
- Since 1 October 2026 Meta charges for service messages beyond 1,000 per business number per month
  ([Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing), updated
  30 September 2026). Each Waldo reply inside the window is a service message. If Meta treats Waldo as an AI
  provider, that page's own policy governs service messages instead.

## Proof limits

Seen on 18 October:
- inbound messages to the test number reached staging;
- Graph accepted sends;
- errors #10 and 131030 appeared and were cleared;
- after the logging deploy (`74dbb957`), a reply's failed delivery status carried 131031.

Not yet seen on any number:
- a delivered Waldo message;
- a registered Waldo number;
- a knock;
- a linked owner's conversation over WhatsApp.

Not yet known whether 131031 clears once the business is verified. The next smoke test answers it.
