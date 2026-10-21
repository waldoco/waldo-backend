# Channel surfaces - owner ruling 2026-09-26

Supersedes the 23 September ranking (Discord-first). Owner ruling, WhatsApp 26 September 2026 (17:01 IST, corrected 17:02): Telegram is testing-only, kept as an opt-in channel for users who want it; it is not a headline surface. Planned surfaces, in order (availability remains subject to each channel's terms and technical proof):

1. **The Waldo app.** The product. Own surface, no platform dependency.
2. **iMessage + WhatsApp.** Target chat surfaces. Describe the actual app-primary product and WhatsApp's role accurately to Meta; channel positioning alone does not establish eligibility.
3. **Waldo agent mail.** The agent's own email identity, in the pattern of Instinct's and Muse's agent inboxes.

Opt-in extras: Telegram (exists today, testing channel), Discord (official bot; the threading test channel).

## Per-surface detail

### Waldo app
Own surface. Parallel track to all of the below; configures the same per-owner agent/DO.

### iMessage
- No official consumer API. Apple Messages for Business is built for brands (approved MSP, registered business, customer-initiated conversations with limited proactive messages) and requires live-agent escalation.
- **The proposed model is single-identity (owner correction 2026-09-26, the Instinct model):** ONE Waldo iMessage number/Apple ID that users text from their own Apple IDs. Users bring their own devices; Waldo operates one line. Bind each sender identifier to a dashboard account through an explicit verification challenge before routing private context. No per-user hardware is proposed.
- **Experimental bridge: mac-bridge.** BlueBubbles server on one always-on Mac is a technical prototype route (it drives the Messages app, reads the Messages database, sends via AppleScript, and exposes REST + webhooks to the Worker). Reactions/tapbacks are a target for the P3 personality layer. The Mac must stay awake; BlueBubbles issue #750 reports delayed or missing inbound delivery after inactivity on one setup. Test delivery and recovery before relying on it. AirMessage is another bridge to evaluate.
- **Scale hypothesis is single-line throughput, not per-user devices.** One Mac serving beta users is unproven; measure concurrent conversations, delivery latency, rate limits, and recovery. Hosted providers (Sendblue, LoopMessage) offer REST + webhooks (Sendblue lists webhooks on its $100/month tier), but their use of one shared identity and commercial eligibility need validation too.
- **Platform gate:** [Apple says consumer iMessage is intended for family and friends, not commercial activity, and misuse may limit service](https://www.apple.com/legal/privacy/data/en/messages/). A dedicated Waldo Apple ID limits blast radius but does not remove that restriction. Do not present the bridge as an approved production channel. Apple Messages for Business requires an approved MSP and live-agent escalation, so it is a separate route with its own product constraints.

### WhatsApp
- Official route only: Cloud API (or a BSP such as Gupshup/Twilio for hand-holding). Unofficial libraries (Baileys, whatsapp-web.js, WAHA) risk non-deterministic number bans - never on a number that matters.
- **The terms problem, stated plainly:** the WhatsApp Business Solution Terms (last modified 2026-03-06) bar "AI Providers" whose AI is the "primary (rather than incidental or ancillary) functionality" from offering general-purpose assistants, except where Meta is legally required (EEA/Brazil numbers today; EU/Italy/Brazil antitrust probes active, European Commission interim-measures charge sheet April 2026). Meta's AI-provider pricing notice restates it with a January 15, 2026 effective date.
- **App-primary framing:** The app can be the primary product and WhatsApp an access surface only if that accurately describes the service. This is a risk posture, not permission: Meta may still assess the WhatsApp experience itself as a general-purpose AI assistant. Other assistants' apparent availability does not establish Waldo's eligibility. Use a dedicated number rather than a personal number, and verify the current terms and eligibility before a public rollout.
- Build path unchanged: claim the Cloud API test number, wire the webhook, submit business verification (the long pole) in parallel. Embedded signup v4; India Sold-To WABAs move to INR billing by 2026-12-31.

### Waldo agent mail
The agent's own email identity (pattern: Instinct and Muse run dedicated agent inboxes). Waldo already treats inbound email as external content at the scribe and has receipt-truth for sends (#182). Missing: the dedicated agent mailbox/address, its inbound webhook into the owner DO, and the outbound identity policy (when the agent writes as itself vs as the owner).

### Telegram (opt-in)
Exists end-to-end; durable spool ingress (#168). Testing channel and opt-in user channel. Not headline positioning.

### Discord (opt-in)
Official bot; slash commands as HTTPS interactions fit the Worker; ordinary messages need a Gateway WebSocket held open by a DO or small relay. Threading test channel.

## Sources
- WhatsApp Business Solution Terms: https://www.whatsapp.com/legal/business-solution-terms
- AI-provider pricing notice (2026-01-15 effective): https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers
- Ban coverage: https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform/
- EC antitrust charge sheet (2026-04): https://mondovisione.com/media-and-resources/news/european-commission-sends-meta-fresh-charge-sheet-on-possible-interim-measures-t-2026415/
- Faff (WhatsApp assistant operating in India): https://www.faffit.com/ and https://welcome.usefaff.com/terms
- BlueBubbles server: https://github.com/BlueBubblesApp/bluebubbles-server and inactivity issue: https://github.com/BlueBubblesApp/bluebubbles-server/issues/750
- Apple consumer iMessage commercial-use restriction: https://www.apple.com/legal/privacy/data/en/messages/
- Apple Messages for Business constraints: https://register.apple.com/resources/messages/messaging-documentation/faq
- Hosted iMessage providers: https://www.sendblue.com/pricing , https://loopmessage.com/apidocs/
