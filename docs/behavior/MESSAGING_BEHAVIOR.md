# Messaging behavior

How Waldo behaves on messaging surfaces (Telegram today). The code is the source of truth; this page describes it.

## Owner-only

`TelegramOwnerListener` (`packages/runtime/src/channels/telegram-listener.ts`) answers only when both the sender and the private chat match the configured owner Telegram id. Every other update is ignored: no model call, no reaction, no reply. The poll offset still advances so ignored updates are not re-read.

## Never feel stalled

For each owner message the listener:

1. reacts with 👀 at once so the owner sees it landed (see Reactions for how it changes when the turn resolves);
2. shows "typing…" immediately and refreshes it every 4 seconds while working;
3. sends one short progress line if the reply takes longer than 8 seconds;
4. sends the reply; on any failure it sends an honest short apology instead of going silent.

Reaction and typing failures never block the reply.

## Reactions

Every messaging channel follows the same reaction lifecycle on the owner's message:

1. **Receipt.** 👀 goes on as soon as the message arrives.
2. **Resolved.** When the reply is sent, the same reaction is replaced by one that fits the outcome and mood. The model picks it (🙏 for thanks, 🎉 for good news, 🤣 for a joke). When the choice is missing, invalid or still 👀, the done reaction is used instead.
3. **Failed.** When the turn fails, the reaction becomes the failure reaction, never a done mark, and the honest failure message is sent.

The model's choice runs alongside the reply and never delays it. Each channel limits which reactions an agent can set, and code enforces the limit, not the prompt.

| Channel | What an agent can set | Done / failed | Status |
|---|---|---|---|
| Telegram | One emoji from the Bot API [ReactionTypeEmoji](https://core.telegram.org/bots/api#reactiontypeemoji) allowlist: 73 emoji, `TELEGRAM_REACTIONS` in `packages/runtime/src/channels/reactions.ts`. A new reaction replaces the bot's previous one. ✅ is not on the list. | 👌 / 😢 | Built |
| WhatsApp | Any emoji, as a [reaction message](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/reaction-messages/) on a received user message. | ✅ / 😢 | Not built |
| Slack | Any emoji by name, including workspace custom emoji, via [reactions.add](https://docs.slack.dev/reference/methods/reactions.add). | ✅ / 😢 | Not built |
| Discord | Unicode or custom emoji ([reaction object](https://docs.discord.com/developers/resources/message)). | ✅ / 😢 | Not built |
| iMessage | Six classic tapbacks, plus any emoji or sticker on [iOS 18 and later](https://support.apple.com/guide/iphone/react-with-tapbacks-iph018d3c336/ios). What an agent can set depends on the hosted phone lane. | ✅ / 😢 | Not built |
| Waldo app | Our own UI, so any reaction can render. | ✅ / 😢 | Not built |

The Telegram list was copied from the Bot API page on 23 September 2026. Recheck it when upgrading. For channels not yet built, confirm the provider's current reaction support, and whether a new reaction replaces the old one, when the connector is built.

## Voice

`messagingSystemPrompt` (`packages/runtime/src/prompt/messaging-behavior.ts`) appends the messaging behavior block after the composed REASONS prompt without changing it:

- short, plain, warm; answer first;
- light small talk only when it fits and never before the answer;
- say what it is doing when a request needs more work;
- claim only the tools granted for the chat, and say so plainly when there are none;
- at most one clarifying question.

## Runner

`packages/runtime/scripts/telegram-listener-run.ts` is a dev runner: long-polls `getUpdates` (message updates only), persists the offset to a file, and routes each owner turn through the Joined Conversation Path with the live model. It runs in the Codespace and stops when the Codespace stops. An always-on deployment would use a webhook on the Worker and is a separate decision.
