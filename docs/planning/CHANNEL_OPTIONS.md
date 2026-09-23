# Channel options: Discord, iMessage, WhatsApp

Researched on 23 September 2026. Recheck vendor terms and prices before building each one.

## Discord

- **Route.** An official bot. [Slash commands and buttons arrive as HTTPS interactions](https://docs.discord.com/developers/tutorials/hosting-on-cloudflare-workers), which fits the Worker. Ordinary messages need a live [Gateway](https://docs.discord.com/developers/events/gateway.md) WebSocket connection. On Cloudflare that means a Durable Object that keeps the socket open, or a small always-on relay. The slice has to prove which one.
- **Message content.** Message text needs the privileged `MESSAGE_CONTENT` intent, except in DMs with the bot and messages that mention it. An owner DM works without approval.
- **Cost.** Free.
- **Fit.** Good. It's also our threading test channel.

## iMessage

- **No official consumer API.** [Apple Messages for Business](https://register.apple.com/resources/messages/messaging-documentation/faq) needs an Apple-approved messaging service provider and a registered business. The customer starts every conversation, and the business can't message again after the customer ends one. That's built for brands, not a personal agent.
- **Hosted providers.** Services such as [Sendblue](https://www.sendblue.com/pricing) and [LoopMessage](https://loopmessage.com/apidocs/) run real Apple hardware and expose a REST API and webhooks. Sendblue charges a flat fee per line per month and lists webhooks on its $100/month tier, with no per-message fees. This is the production route for per-user iMessage.
- **Self-hosted.** [BlueBubbles](https://docs.bluebubbles.app/server) runs on a Mac signed in to iMessage. It reads the Messages database and sends through AppleScript. It works for the owner on his own Mac at no cost, but it doesn't scale per user, and the Mac has to stay on.
- **Fit.** Good for the owner prototype through BlueBubbles, and for production through a hosted provider.

## WhatsApp

- **Official route.** The [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started): a business phone number, webhooks for inbound messages, and [per-message pricing](https://developers.facebook.com/docs/whatsapp/pricing/) with a 24-hour customer service window.
- **Blocker.** The [WhatsApp Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms) (last modified March 6, 2026) prohibit "AI Providers" from using the platform when AI is the "primary (rather than incidental or ancillary) functionality". The terms name general-purpose AI assistants. Waldo is a general-purpose personal agent. The only carve-out is for users with European Economic Area or Brazil numbers. Indian numbers (+91) are outside it. The rule has been in force since [January 15, 2026](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform/).
- **Unofficial libraries.** Libraries that drive WhatsApp Web break WhatsApp's terms and risk the number being banned. Not recommended.
- **Fit.** Blocked for our main market unless the owner decides otherwise after reading the terms.

## Recommended order

1. **Discord.** Official and free, the owner DM needs no approval, and it becomes the threading test channel. The only new piece is keeping the Gateway connection up.
2. **iMessage.** Prototype through BlueBubbles on the owner's Mac, then move to a hosted provider for per-user production.
3. **WhatsApp.** On hold. The official API bars general-purpose AI assistants outside EEA and Brazil numbers.

The Waldo mobile app connection runs in parallel with these, because it is our own surface.
