# Messaging behavior

How Waldo behaves on messaging surfaces (Telegram today). The code is the source of truth; this page describes it.

## Owner-only

`TelegramOwnerListener` (`packages/runtime/src/channels/telegram-listener.ts`) answers only when both the sender and the private chat match the configured owner Telegram id. Every other update is ignored: no model call, no reaction, no reply. The poll offset still advances so ignored updates are not re-read.

## Never feel stalled

For each owner message the listener:

1. reacts to the message (default 👀) so the owner sees it landed;
2. shows "typing…" immediately and refreshes it every 4 seconds while working;
3. sends one short progress line if the reply takes longer than 8 seconds;
4. sends the reply; on any failure it sends an honest short apology instead of going silent.

Reaction and typing failures never block the reply.

## Voice

`messagingSystemPrompt` (`packages/runtime/src/prompt/messaging-behavior.ts`) appends the messaging behavior block after the composed REASONS prompt without changing it:

- short, plain, warm; answer first;
- light small talk only when it fits and never before the answer;
- say what it is doing when a request needs more work;
- claim only the tools granted for the chat, and say so plainly when there are none;
- at most one clarifying question.

## Runner

`packages/runtime/scripts/telegram-listener-run.ts` is a dev runner: long-polls `getUpdates` (message updates only), persists the offset to a file, and routes each owner turn through the Joined Conversation Path with the live model. It runs in the Codespace and stops when the Codespace stops. An always-on deployment would use a webhook on the Worker and is a separate decision.
