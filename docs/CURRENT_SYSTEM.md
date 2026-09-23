# What is built

Pinned to `beta-mvp` at `6c2489fbc55867c9fa7d3626763ff6957accdb65` (23 September 2026). Re-pin before relying on any line here. The [build plan](planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md) is the target; this page is the current state.

## Live versus contract

Three levels, never mixed:

- **Live:** ran against real providers with recorded evidence.
- **Runtime module:** real code with behavioral tests, not wired into the deployed Worker or owner Durable Object.
- **Contract:** schemas, types and in-memory reference modules in `@waldo/contracts`, with tests.

Nothing added since the September 18 baseline (`e91bee0`) is composed into the deployed Worker (`packages/runtime/wrangler.jsonc`, `run-loop/do.ts`). The live path runs through scripts in `packages/runtime/scripts/`.

## Live

One path is live: a Telegram message from the owner goes through the Joined Conversation Path to OpenAI `gpt-5-nano` and back to Telegram.

| Piece | Source | Evidence |
|---|---|---|
| OpenAI Responses adapter, reasoning effort `low`, 4096 output budget, truncated output classified as oversize | `runtime/src/llm/openai.ts` | response ids `resp_0379e55b…`, `resp_05620c82…` |
| Telegram long-poll intake, standard message fields accepted | `runtime/src/channels/telegram-polling.ts` | updates 904957467-904957470 |
| Owner-only listener with ack reaction, typing, progress line and honest failure | `runtime/src/channels/telegram-listener.ts` | queued owner messages answered |
| Messaging behavior block appended to the composed prompt | `runtime/src/prompt/messaging-behavior.ts` | [MESSAGING_BEHAVIOR.md](behavior/MESSAGING_BEHAVIOR.md) |
| One-shot proof and dev listener | `runtime/scripts/live-proof.ts`, `runtime/scripts/telegram-listener-run.ts` | run in a Codespace |

Limits of the live path:

- Staging Worker `waldo-runtime-staging` serves `POST /telegram/webhook` (commit `06c7eb5`), handing each verified update to `TelegramOwnerDO`. The local runner uses the same code path for development.
- On the staging Worker, each turn's user and assistant entries are saved to the owner Durable Object's storage and restored on wake, so eviction and redeploys keep the conversation. The local runner still keeps history in memory only. The full history goes to the model on every turn; context budgeting is tracked in #145.
- No tools are granted to the Telegram chat. The model is told so and says so.
- Consequential approvals are not accepted over Telegram.

Runner environment: `TELEGRAM_BOT_TOKEN`, `WALDO_OWNER_TELEGRAM_ID`, `OPENAI_API_KEY`, optional `WALDO_TELEGRAM_OFFSET_FILE`. Keep secrets in the Codespace env file, never in the repo.

## Runtime modules

| Module | Source | Commit |
|---|---|---|
| Local S1 chat CLI and explicit OpenAI S2 route | `runtime/src/cli/local-chat.ts` | `d39bc52`, `a6dbf1f` |
| Layered context observability | `runtime/src/context-composer` | `50b1c76` |
| Correctable memory recall: correction, forget, provenance, aggregate-only health summaries | `runtime/src/recall/correctable.ts` | `952b3bd` |
| Joined Conversation Path: owner-bound composer, model, append-only tree, publication record | `runtime/src/conversation/joined-path.ts` | `acfa34e` |

## Contracts

All in `packages/contracts/src/runtime/`.

| Contract | File | Commit |
|---|---|---|
| Resilient conversation core | `conversation-core.ts` | `30b6da1` |
| Branched ConversationEntry with separate model and app projections | `conversation-entry.ts` | `e342770` |
| Management workspace read model and surface projection | `management-workspace.ts` | `96b8f05`, `e51e538` |
| Connection lifecycle | `connection.ts` | `599848a` |
| Typed Google connector operation envelope and proxy | `connector-operation.ts` | `0770e25` |
| Bounded browser session and fallback policy | `browser-session.ts`, `browser-policy.ts` | `142c257`, `ae287d4` |
| Bounded conversation export | `conversation-export.ts` | `61bc02c` |
| Heartbeat status keyed by owner and component | `heartbeat.ts` | `7307fba`, `d4a60b6` |
| Pending approval queue and append-only activity ledger | `approval.ts`, `activity.ts` | `160f8a2` |
| Trusted coordination consent | `trusted-coordination.ts` | `e7253da` |

## Verification at this pin

- Contracts: 86 files, 1645 tests.
- Runtime: 50 files, 1178 tests.
- Typecheck, guards and docs checks pass. CI `verify` runs on every `beta-mvp` push.

## Not built

- Deployed conversation, webhook channels, delivery and scheduling for any of the modules above.
- App wiring, chat management, threading and AG-UI rendering in the Waldo app.
- Management workspace UI.
- Durable storage behind the new contracts.
- Google, browser and email execution against real accounts.
- Per-user tenancy, secrets and connector provisioning. See [production architecture](architecture/PRODUCTION_ARCHITECTURE.md).
