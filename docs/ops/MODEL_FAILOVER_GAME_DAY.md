# Model failover game day (staging)

This is a plan. It has not been run. Running it changes staging secrets, so it needs the owner's explicit go-ahead and a named operator. It never touches production.

## What it proves

With OpenAI unavailable on staging for 30 minutes:

- the owner's turns are answered by the second provider (`claude-sonnet-5-5`), and side jobs by `claude-haiku-5-5`;
- the shared breaker opens after three provider misses and later turns stop asking OpenAI;
- no turn tells the owner "please try again" because of the outage;
- when OpenAI comes back, the breaker cools down and turns return to the primary.

It does not prove the deferred answer (R-4). Until R-4 lands, a turn that fails on both providers still ends the way it did before this work.

This plan is written for `WALDO_MODEL_PROVIDER=openai`. With `anthropic`, the roles reverse: the operator replaces `ANTHROPIC_API_KEY` instead, owner turns should be answered by `gpt-6.1-terra` and side jobs by `gpt-6-luna`, and the breaker opens on `anthropic`. Voice transcription and `browse_page` keep working, since they use the OpenAI key.

## Preconditions

1. R-1, R-3 and R-5 are merged and deployed to staging. `scripts/staging-gate.mjs --expect-sha <sha>` passes.
2. `ANTHROPIC_API_KEY` is set on the staging Worker (`wrangler secret put ANTHROPIC_API_KEY --env staging`, by someone holding the key). Without it, every Anthropic step fails as `auth_failed` and the game day only exercises the old failure path.
3. Telemetry's turn event v9 (#1320) is deployed, so `llm_*` hops carry `provider` and `fallback_fired`.
4. Two testers are available on Telegram and the app, using fictional data only.
5. The current OpenAI key's value is held by the operator so it can be restored. The value is never pasted into tickets or chat.

## How OpenAI is turned off

Replace the staging `OPENAI_API_KEY` with a key OpenAI rejects, for example `wrangler secret put OPENAI_API_KEY --env staging` with the input `gameday-off`. Every OpenAI call then gets a 401, which the adapter maps to `auth_failed`. `auth_failed` counts toward the breaker.

Side effects of this switch. Expect them, don't count them as failures:

- Voice-note transcription and `browse_page` also use `OPENAI_API_KEY` and fail for 30 minutes.
- Updating a secret deploys a new Worker version. Each Durable Object starts a fresh isolate, so every breaker starts closed.

A provider-side outage (429s, 5xx, timeouts) looks different on the wire. The fault-injection suite (`packages/runtime/test/fault-injection.test.ts`) covers those classes with the real adapters. This switch only exercises the routing.

## Run sheet

| Time | Action | Watch |
| --- | --- | --- |
| T-10 | Baseline: each tester sends three ordinary messages and one tool request (calendar or reminder). | Langfuse staging: `llm_reply` hops show `provider: openai`, `fallback_fired: false`. |
| T0 | Operator replaces `OPENAI_API_KEY`. Note the new version id. | `wrangler tail --env staging` shows the deploy. |
| T0-T30 | Every 2 minutes, each tester sends a message. Every 10 minutes they also send a tool request and a voice note. | Per turn: `provider: anthropic`, `fallback_fired: true`. A `provider_breaker` hop with `detail: openai` appears once per Durable Object, then later turns show `skipped` attempts for OpenAI. No reply reads "Sorry - I hit a problem". Tool effects appear once. |
| T30 | Operator restores the original `OPENAI_API_KEY`. | New version id. |
| T30-T40 | Testers send three messages each. | `provider: openai` returns once each breaker's 30 s cooldown has passed. |

## Stop early if

- an owner turn repeats a tool effect (a duplicate reminder, card or send);
- replies contain another provider's raw output (thinking text, tool-call JSON);
- `ANTHROPIC_API_KEY` errors (`auth_failed` on `anthropic` steps): the fallback is not configured, so restore OpenAI and fix the precondition;
- staging cost per turn (cost ledger, T-2) goes above three times the baseline.

To stop, restore `OPENAI_API_KEY` and record the time.

## Record afterwards

- Turns attempted and answered, split by provider, and how many fell to the floor or failed.
- Time from T0 to the first `provider_breaker` hop for each Durable Object.
- Any duplicated effect or leaked output, with the trace id.
- Eval scores on the fallback model compared with the baseline (plan target: within 10%), from a separate eval run pinned to `claude-opus-5-5`.
- Version ids for the switch and the restore.
