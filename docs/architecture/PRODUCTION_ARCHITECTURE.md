# Production architecture

Direction for moving from one owner's dev listener to many users. Nothing on this page is built. The current state is in [CURRENT_SYSTEM.md](../CURRENT_SYSTEM.md).

## Decide first: per-user isolation

These are hard to change later, so they come first:

- **Tenancy.** Every record, queue, schedule and connector is keyed by owner. One owner Durable Object is the single writer for that owner's state.
- **Per-user secrets.** Provider tokens, bot credentials and connector grants are stored per owner, never shared across users and never in prompts.
- **Connector provisioning.** Creating, rotating and revoking a user's channel and connector identities is an owner-scoped operation with its own activity entries.

## Always-on channel connectors

Each user gets connectors that run whether or not a dev process is up.

| Channel | Mechanism |
|---|---|
| Telegram | Webhook into the Worker, routed to the owner DO. Replaces the dev long-poll runner. |
| WhatsApp | Business Platform webhook through a supported provider route. |
| Email | Inbound webhook for the user's agent address. Outbound mail goes through the same identity. |
| iMessage | No public API. Needs a hosted phone infrastructure lane. |

Full threading comes first on the Waldo app and on Discord, then Slack. Discord is the chosen test channel for threading: a real bot API with native threads, reactions and typing, the same shape as Slack. The Discord connector comes later in the program. For now it is the documented choice.

Two latency fixes belong in the connector design:

- **Webhooks, not polling.** A webhook delivers the message as it is sent, which removes the poll pickup delay of the dev runner.
- **Streamed replies.** Streaming the model output (or sending the first useful line early) gets the answer in front of the user sooner.

Every connector keeps today's rules: owner-only acceptance enforced in code, duplicate provider events dropped, consequential approvals only on proved approval paths, and the [messaging behavior](../behavior/MESSAGING_BEHAVIOR.md) of ack, typing, progress and honest failure, and the receipt-to-resolved reaction lifecycle.

## Lanes

1. **Per-user email identity.** Each user gets an agent mail address, like Instinct's per-user agent mail, used for inbound and outbound under that user's grants.
2. **Hosted phone infrastructure.** Numbers and devices for SMS, iMessage and WhatsApp, run as a managed service behind the same authority boundary.
3. **Per-user always-on connectors.** The webhook connectors above, provisioned and revoked per user.

## Activity ledger from day one

The activity ledger (`packages/contracts/src/runtime/activity.ts`) records, per owner:

- turns;
- connector events;
- approvals and their decisions;
- last-active time.

Lifecycle and churn tooling is not built now. Because the ledger has this data from the start, inactivity detection later is a reader job over the ledger, not a new write path.
