# WhatsApp knock template: plan

Outside WhatsApp's 24-hour customer service window, only an approved template reaches the user. Waldo then
holds the real message, sends one template (the knock) per closed window, and delivers what it held once the
owner replies (`whatsapp-window.ts:5-10`, `:74-92`, `:241`). This page plans that template. Creating it is a
Meta write, and configuring and deploying it are changes; each needs the owner's yes. Runtime claims cite
source at `f86af4fd`; Meta claims cite the guide page and its "Updated" date, read on 18 October 2026.

## What the runtime sends

- **A name and a language, nothing else** (`whatsapp-api.ts:95-97`). The body has to be static text: a
  template with a variable fails with 132000 because no parameter values are sent. Keep it to a body and an
  optional footer, without media or buttons, since a reply in the chat is all the owner needs to do. A
  static body also means no message content, and so no health detail, ever travels in a knock.
- **A strict format.** `WHATSAPP_REENGAGE_TEMPLATE` must match `^[a-z0-9_]{1,512}$` and
  `WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE` must match `^[a-z]{2,3}(_[A-Z]{2})?$`; anything else counts as unset
  (`whatsapp-window.ts:41-45`). Unset, Waldo holds messages without knocking and logs
  `{"hop":"whatsapp_window","ok":false,"held":true,"code":"template_unconfigured"}` (`:81`).
- **At most one knock per closed window**, re-armed by the owner's next message (`:74-92`).

## The template

- **Name:** `waldo_update_ready`
- **Category:** UTILITY
- **Language:** `en`. Meta also lists `en_IN`
  ([Supported languages](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages),
  updated 21 May 2026). The configured code must equal the template's exactly.
- **Body**, one of these, for the owner to pick:
  1. `Waldo has a reply waiting for you on something you asked about. Reply here to see it.`
  2. `Waldo has an update on a request you made. Send any message here to see it.`
  3. `Your Waldo has news on something you asked it to do. Reply to this chat to read it.`
- **Footer**, optional and static: `Unlink WhatsApp any time from your Waldo console.`

**Why utility, and the risk.** Meta treats a template as utility only if it is non-promotional and either
specific to or requested by the user (their account, order or service) or essential to them. A template whose
content is unclear is marketing
([Template categorization](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization),
updated 15 September 2026). Since 9 April 2025, a template submitted as utility that Meta judges to be
marketing is approved as marketing instead of being rejected. A static body has no order number or account
detail to make it specific, so this risk is real.

Accept the template only if it reads back APPROVED with category UTILITY. As marketing, a knock counts against
WhatsApp's per-user marketing limits (131049), stops for anyone who has turned off marketing messages from
Waldo (131050), and is charged at the marketing rate. If that happens, you have two options. Both are
described on the same categorization page:
- edit the template in WhatsApp Manager and resubmit it;
- within 60 days, request a category review. Start it in WhatsApp Manager, which sends you to Business
  Support's Template Category Updates.

## Steps

1. **Prerequisites.**
   - Steps 1 to 5 of the setup chain in [the setup page](NUMBER_SETUP_AND_SMOKE_TEST.md) are done: the
     business is verified, and Waldo's number is registered and set up on its Messaging account.
     Templates belong to a Messaging account, so a template on the test account does not exist for Waldo's
     number.
   - The template is created at that point and configured with the switch (setup step 6) or after it, as
     setup step 7 says.
   - The opt-in wording is fixed (below).
2. **Create** it in WhatsApp Manager under Message templates, or with Meta MCP `whatsapp_biz_create_template`.
   *Check:* MCP `whatsapp_biz_list_templates` on that account lists `waldo_update_ready`.
3. **Wait for review**, which can take up to 24 hours.
   *Check:* status APPROVED, category UTILITY.
   *Falsifier:* category MARKETING. Do not configure it.
4. **Configure.** In `packages/runtime/wrangler.jsonc`, staging `vars` (line 90, where both are empty
   today), set:
   - `WHATSAPP_REENGAGE_TEMPLATE` to `waldo_update_ready`;
   - `WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE` to `en`.

   Deploy it with the switch to Waldo's number or after it. If it is deployed while staging still sends from
   the test number, every knock fails with 132001.
5. **Live test** on a linked test account, never the owner's:
   1. Let 24 hours pass with no message from the test phone.
   2. Have Waldo send something after that, such as a reminder set to fire once the window has closed.

   *Pass:*
   - the setup page's tail filter shows `{"hop":"whatsapp_window","ok":true,"held":true,"knocked":true}`. The
     owner's Durable Object logs it, often inside an alarm, so a filter on the webhook's URL misses it;
   - the template arrives, and on staging the setup page's status view shows its `pricing.category` as
     `utility`;
   - after a reply, the held message arrives on the phone. A reminder held in the outbox is released without a
     `whatsapp_held` line (`whatsapp-window.ts:205`), so the phone is the evidence.
   *Falsifiers:*
   - `template_unconfigured`: the configuration is not deployed.
   - 132001: the name, language or account does not match.
   - 131049 or 131050, or `pricing.category` `marketing`: the template is marketing.
6. **Keep watching.** Meta can change an approved template after approval:
   - it pauses a low-quality template (132015), and disables one paused too often (132016);
   - it archives a template unused for 12 months
     ([Template fundamentals](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview),
     updated 21 May 2026);
   - it can recategorize a utility template as marketing. Email and a webhook confirm the change; for a
     business Meta has already warned, it takes effect at once, without advance notice (categorization page
     above).

   The Worker reads only messages and statuses from a webhook (`whatsapp-webhook.ts:78-111`), so these
   changes reach the Messaging account's admins by email and in WhatsApp Manager, never Waldo.

## Opt-in comes first

Meta requires opt-in that clearly tells people they will receive messages, and from which business
([Get opt-in](https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in),
updated 16 June 2026). The link confirmation page says that Waldo "will answer there"
(`whatsapp-link-console.ts:26`). That covers replies, not messages Waldo starts. Before the knock is
configured, the page should also say that Waldo may write first, with the reminders and updates the owner
asked for, and how to stop: unlink in the console. That wording is a separate code change.

## Cost

A utility template delivered outside a window is charged at Meta's published rate for the recipient's
country, with volume tiers
([Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing), updated
30 September 2026). Waldo sends at most one knock per owner per closed window.

## Proof limits

None of this has run against Meta. No template exists yet, and the knock has been exercised only by the
runtime's tests.
