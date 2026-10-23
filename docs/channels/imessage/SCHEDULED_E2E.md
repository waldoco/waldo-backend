# iMessage-only owner: scheduled work on staging

This check proves that an owner whose only surface is iMessage gets the reminder they set on iMessage, on iMessage, and that its run settles only once the line reports the send.

## Before you start

- Staging runs a release that includes this change. From `packages/runtime`, `npx wrangler deployments list --name waldo-runtime-staging` shows what is deployed.
- Use a test owner whose only surface is iMessage. They have never signed in to the app and have no Telegram or WhatsApp link. In the console, Connections shows iMessage linked and nothing else. Don't use a real tester's account.
- That owner has texted Waldo from this phone at least once since linking. The scheduled pass admits them through the sender they last wrote from.

## Watch the logs (optional)

From `packages/runtime`, in a second terminal:

```bash
npx wrangler tail waldo-runtime-staging --format json | grep -E 'delivery_pending|outbox_delivery|scheduled_admission'
```

These lines carry ids, hop names and codes, never message text.

## Steps

1. From the test owner's phone, text Waldo: `Remind me in 3 minutes to stretch.`
   - **Expect:** Waldo confirms the reminder.
   - **Fail:** Waldo says it cannot message you first.
2. Wait for the reminder.
   - **Expect:** within about a minute of the due time, exactly one iMessage from Waldo with the reminder.
3. Check the tail for the reminder's trace (`reminder:…`). It shows three lines, in this order:
   - `delivery_pending`;
   - `outbox_delivery` with code `awaiting_arrival`;
   - `outbox_delivery` with `ok: true` and detail `delivered`.

   The last line comes after the line reports the send. Until then the reminder's run stays open.

**Optional negative check:**

4. Text Waldo for another reminder 5 minutes out. Before it is due, unlink iMessage in the console.
   - **Expect:** nothing arrives, and the tail shows `scheduled_admission` with `ok: false` and code `dormant`.
   - Link again afterwards.

## Result

- **Pass:** steps 1–3 behave as expected.
- **Fail:** anything else. Note the time and keep the tail lines; they are safe to share.

## Rollback

Revert the merge commit on `beta-mvp`, then redeploy staging. No migration is involved. After the revert, an iMessage-only owner is back to running no scheduled work. Their reminders stay scheduled but nothing sends them, and records already waiting in the delivery outbox are not sent.
