# Staging teardown

The staging Worker `waldo-runtime-staging` runs on the Cloudflare testing account. Remove it when testing is done so nothing keeps billing. Durable Object storage bills only while the objects and their stored data exist.

Run from `packages/runtime` with `CLOUDFLARE_API_TOKEN` loaded from the local env file:

```bash
# 1. Point Telegram away from the Worker first (the bot stops answering).
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook"

# 2. Delete the Worker and its associated resources, including Durable Object data.
npx wrangler delete --name waldo-runtime-staging

# 3. Check that nothing is left.
npx wrangler deployments list --name waldo-runtime-staging   # expect "does not exist"
```

Worker secrets are deleted with the Worker. Rotate the Telegram bot token and OpenAI key separately if they were exposed during testing.

Source: [wrangler delete](https://developers.cloudflare.com/workers/wrangler/commands/workers/) deletes the Worker and all associated developer platform resources.
