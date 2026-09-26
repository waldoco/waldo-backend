# Channel surfaces - owner ruling 2026-09-26

Supersedes the 23 September ranking (Discord-first). Owner ruling, WhatsApp 26 September 2026 (17:01 IST, corrected 17:02): Telegram is testing-only, kept as an opt-in channel for users who want it; it is not a headline surface. Official surfaces, in order:

1. **The Waldo app.** The product. Own surface, no platform dependency.
2. **iMessage + WhatsApp.** The chat surfaces. Positioning to Meta: the app is the product; WhatsApp is a surface/extension, not a general-purpose chatbot destination.
3. **Waldo agent mail.** The agent's own email identity, in the pattern of Instinct's and Muse's agent inboxes.

Opt-in extras: Telegram (exists today, testing channel), Discord (official bot; the threading test channel).

## Per-surface detail

### Waldo app
Own surface. Parallel track to all of the below; configures the same per-owner agent/DO.

### iMessage
- No official consumer API. Apple Messages for Business is built for brands (approved MSP, registered business, customer-initiated only) - wrong shape for a personal agent.
- **The model is single-identity (owner correction 2026-09-26, the Instinct model):** ONE waldo iMessage number/Apple ID that every user texts from their own Apple ID. Users bring their own devices; waldo only ever operates one line. User verification is matching the sender's phone number or Apple ID email to their dashboard account. No per-user hardware anywhere.
- **Bridge: mac-bridge.** BlueBubbles server on one always-on Mac (the spare iMac works; any always-on macOS host does - it drives the Messages app, reads the Messages database, sends via AppleScript, exposes REST + webhooks to the Worker). Reactions/tapbacks supported (matters for the P3 personality layer). The Mac must stay awake - BlueBubbles issue #750 documents inbound delivery stopping after Mac inactivity; power settings and a watchdog are part of the setup. AirMessage is the fallback; BlueBubbles is the more active project.
- **Scale question is single-line throughput, not per-user devices.** One always-on Mac serves all users at beta scale. At volume, hosted providers (Sendblue, LoopMessage) run real Apple hardware for one line with REST + webhooks (Sendblue lists webhooks on its $100/month tier) - that is the throughput route, still a single waldo identity.
- Risk: self-hosted bridging is outside Apple's terms for the host account; the bridge identity is a dedicated waldo Apple ID, never a personal one.

### WhatsApp
- Official route only: Cloud API (or a BSP such as Gupshup/Twilio for hand-holding). Unofficial libraries (Baileys, whatsapp-web.js, WAHA) risk non-deterministic number bans - never on a number that matters.
- **The terms problem, stated plainly:** the WhatsApp Business Solution Terms (last modified 2026-03-06) bar "AI Providers" whose AI is the "primary (rather than incidental or ancillary) functionality" from offering general-purpose assistants, except where Meta is legally required (EEA/Brazil numbers today; EU/Italy/Brazil antitrust probes active, European Commission interim-measures charge sheet April 2026). Meta's AI-provider pricing notice restates it with a January 15, 2026 effective date.
- **The honest read of the app-primary framing:** Faff (Faff Technologies Pvt Ltd, Bangalore) operates a WhatsApp-based personal-assistant service on a +91 number today; their terms frame it as a human-executed task service (wallet, onboarding call, human agents) where the AI is ancillary. Poke was barred after public launch and is back only in Brazil under regulatory pressure. Instinct runs a US number in invite beta, below the enforcement radar. So: the "app is the product, WhatsApp is an extension" framing is the strongest available position and matches how Faff survives, but it is a risk posture, not a permission - if the WhatsApp surface itself reads as the full general-purpose assistant, Meta can still call the AI primary on that surface. Enforcement is discretionary and rises with visibility. The number must be dedicated, disposable infrastructure, never a personal number.
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
- Poke Brazil carve-out: TechCrunch Poke launch coverage; Instinct US-number WhatsApp: WIRED (2026).
- BlueBubbles server: https://github.com/BlueBubblesApp/bluebubbles-server and inactivity issue: https://github.com/BlueBubblesApp/bluebubbles-server/issues/750
- Apple Messages for Business constraints: https://register.apple.com/resources/messages/messaging-documentation/faq
- Hosted iMessage providers: https://www.sendblue.com/pricing , https://loopmessage.com/apidocs/
