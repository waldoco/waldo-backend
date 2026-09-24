# WhatsApp routes for Waldo - 2026-09-24

Decision research. Owner ask: "think on the WhatsApp integration right now and see how fast we can have it. We can use any alternative way to get on WhatsApp."

## The four routes

### A. Official: Meta WhatsApp Business Platform (Cloud API), direct

- Speed: development starts today. Meta's get-started flow gives a test business number that can message up to 5 allow-listed recipient numbers, no business verification needed. Production needs business verification plus display-name review: the long pole, typically days, sometimes weeks. Start it now in parallel.
- Cost: owner-initiated chats are "service" messages. Today they are free. From 2026-10-01 (in one week) Meta bills service messages per delivery, with 1,000 free per number per month. Utility templates inside the 24-hour window are free today and become billable on 2026-10-01. India pass-through rates today: marketing about Rs 0.86, utility/auth about Rs 0.115 per message. At beta volumes (one owner, a few invitees), cost stays near zero under the 1,000 free service messages.
- ToS / ban risk: none. This is the protected platform.
- Unlocks: the real product surface, including invited users. Proactive pushes outside a 24-hour window must be approved template messages (see product note below).
- Needs: a Meta app, a WhatsApp Business Account, and a dedicated phone number. A number on the consumer WhatsApp app cannot register; a number on the WhatsApp Business app can, via "coexistence" onboarding, keeping the app usable alongside the API. Embedded signup v2 is deprecated on 2026-10-15; build on v4.
- Note: India Sold-To WABAs must move to INR billing by 2026-12-31.

### B. Official via a BSP (Twilio, Gupshup, 360dialog, or India BSPs: AiSensy, Wati, Interakt, Gallabox)

- Speed: the fastest official production path. BSPs pre-verify and hand-hold embedded signup; same-day onboarding is realistic.
- Cost: markup on Meta fees. Twilio: $0.005 per message handling fee. Gupshup: about $0.001 per message. India BSPs: flat monthly plans, entry tiers from Rs 0-1,000/month. INR invoicing available locally.
- ToS / ban risk: none; same platform as A with a vendor in the middle.
- Unlocks: same as A, plus support and faster verification. Costs a per-message markup forever.

### C. Unofficial libraries (Baileys, whatsapp-web.js) or self-hosted wrappers (WAHA, Evolution API)

- Speed: hours. Pair a number by QR code and go.
- Cost: free, plus hosting.
- ToS / ban risk: high, and this needs saying plainly. These violate WhatsApp's Terms of Service. Bans are routine, non-deterministic, driven by ML heuristics, and can permanently kill the attached number. Never attach the owner's personal number or any number the product depends on. If this route is ever touched, it is a disposable number for a throwaway demo, with the number treated as burnable.
- Unlocks: the only route that operates a consumer WhatsApp account (read and reply as that account). That is exactly why it is risky.

### D. Interim: no new surface

- Waldo already talks to the owner end-to-end on Telegram today. A beta can run on Telegram while the official WhatsApp path clears verification. Zero cost, zero risk, zero new build.

## Product note that shapes the choice

Waldo's core behavior is proactive: update cards, Fetch nudges, reminders. On WhatsApp, a message sent outside the 24-hour customer service window must be an approved template, and from 2026-10-01 every delivered message is billable. Telegram has neither constraint. WhatsApp as Waldo's primary channel means template approval for card shapes and a per-push cost line. Both are manageable; neither is free.

## Recommended shape (owner's call)

1. Today: claim a Cloud API test number, wire inbound webhook to the runtime's channel layer, demo owner chat on WhatsApp within days.
2. In parallel: submit business verification (the long pole). Direct Cloud API keeps per-message cost at Meta rates; pick Gupshup or Twilio only if hand-holding or INR invoicing is wanted.
3. Do not use unofficial libraries on any number that matters.

## Sources

- Pricing model and 2026-07-01 per-message change: https://developers.facebook.com/docs/whatsapp/pricing/
- 2026-10-01 changes (service billable, 1,000 free/mo, India INR deadline): https://ominiflow.com/blog/whatsapp-api-pricing-update-october-2026 and https://support.wati.io/en/articles/16954666
- Phone number registration and coexistence: https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers and https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users/
- Embedded signup v2 deprecation: https://developers.facebook.com/docs/whatsapp/embedded-signup/
- Test number and get-started flow: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
- BSP pricing: https://www.twilio.com/en-us/whatsapp/pricing , https://codingclave.com/blog/gupshup-whatsapp-pricing-india-2026 , https://richautomate.in/blog/whatsapp-bsp-pricing-index-india-2026
- Unofficial-client ban risk: https://whatsapp.checkleaked.cc/blog/avoid-whatsapp-ban and https://github.com/whiskeysockets/Baileys
