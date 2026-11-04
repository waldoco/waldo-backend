# Chain of Recall / Inline & Spill: handoff for Ansh (4 Nov 2026, beta-mvp 8455b0b9)

Step 3 of the DeepSeek Super-agent design. No code was written. [verified] = I read the source; [explorer] = from a read-only subagent with file:line refs, so check before you build on it.

**Goal:** every object the agent recalls carries a stable ref to an existing row, plus one-line summaries of its neighbours. The model can then walk the graph hop by hop instead of searching blind. Full content stays behind the existing read tool for that kind.

## What exists
- `src/history/archive.ts` [verified]: `search_history` unions `background_runs`, `task_jobs`, `schedule_runs`, `history_archive` and decided `ledger` cards. Refs are `<source>:<id>` / `ledger:<id>`, and there is no read-by-ref mode. `historyArchiveForgetStore` redacts the archive.
- `src/channels/episodes.ts` [verified]: the `episodes` FTS5 table is `entry_id, speaker, at, text`, with no surface and no chat. Its ref is the rowid, and `search_episodes {ref}` reads one row whole.
- `src/memory/turn-recall.ts` [verified]: the per-turn `<recalled>` block already does Inline & Spill for claims (the `c12 stub` lines). Episode hits are snippets plus a ref, with no neighbours. The budget is `RECALL_MAX_CHARS` 3000.
- `src/conversation/tool-output-store.ts` [verified]: `to-N` handles are in memory and last one conversation only. The only durable trace is the `toolout:` KV ledger (6 rows, summaries of at most 500 chars) [explorer].
- `forget-barrier.ts` [verified]: `OWNER_STORE_TOOLS = read_memory, search_episodes, search_history`. Results from these tools drop a whole item when it holds a topic.
- Why trail #1846 is OPEN, not merged [verified]. Don't depend on `tools/why-trail.ts` until it lands.

## Where the links already live [explorer]
- **Surface and chat:** `ConversationEntry.chatId` and `.surface`, stored in DO KV (`conversation-store.ts`, `canonical-owner-store.ts`). Entry ids are prefixed `tg-/app-/whatsapp-/imessage-`, and replies end `-reply`. Order comes from the `parentId` chain only.
- **Runs:** `background_runs.parent_id` holds the turn id or the schedule id. On `task_jobs`, `origin` holds the turn id or `machine:<job>`, and `brief_json` holds `conversation_ref` / `approval_id`; the brief is cut to `{title}` when the job settles. `schedule_runs.schedule_id` links back to its schedule.
- **Cards:** `ledger.origin_run_ref` links to the turn or run. `approval_presentations.conversation_ref` links to the chat. `payload_json` holds `thread_id`/`message_id` (mail) and `event_id`/`calendar_id` (calendar).
- **Mail and calendar Waldo touched:** `observed_mail`, `loop_mail_sources`, `agent_mail_threads`, `calendar_last_seen`, `event_briefs`, and the effect ledger KV `owner:effect:*`. Ids that were only read in a chat turn are NOT recorded anywhere.
- **Claims:** `claims.source_ref = 'owner, <entry id>'`, which links a claim to its turn. Nightly claims carry no ref.

## Proposed design [proposed]
1. **One ref grammar**, kind-prefixed, with no new table: `ep:<rowid>` (bare digits stay accepted), `background_runs:/task_jobs:/schedule_runs:/ledger:<id>` (as today), `c<id>` (claims), `to-N`. Mail and calendar go in as `mail:<thread_id>` / `event:<event_id>`, and only when an existing row above holds the id.
2. **Neighbour resolver** `history/neighbours.ts`: given a ref, return at most 4 `{ref, rel, line}`. `rel` is one of prev/next/raised/from/acts_on/learned. Links come only from the columns listed above. Each line is cut to about 80 chars: a word cut, no digits from health rows, zone words only (ADR-0081).
3. **Spill through existing tools:** add a `ref` mode to `search_history` (one entry plus its neighbours), and let `search_episodes {ref}` return the turn's surface, chat and neighbours. Add `surface` to episode hits; joining `entry_id` to the entry's `chatId` gives it without changing the schema. The tool descriptions name which tool reads each prefix.
4. **Inline:** in `recallForTurn`, each episode hit gains `· whatsapp · near: ledger:x "send to Priya", c41`, inside the same 3000-char budget. The model decides whether to hop.
5. **Forget:** neighbour lines are built at read time from rows the purge already redacts. They still cross the barrier as `owner_store` and are checked with `holds()` like recall lines. Add a test that a held topic in a neighbour drops that neighbour and keeps the parent.
6. **Switch:** `WALDO_RECALL_CHAIN` is "1" in `env.staging.vars` and "0" in the top-level vars. Declare it in `telegram-webhook.ts` Env and assert it in `test/health-provisional-switch-declared.test.ts`. Do not add it to the preview allowlist.
7. **Measure:** add a scripted scenario in `scenarios/catalog.ts` (copy `tools-search-episodes`). Seed a WhatsApp entry from last week next to an app entry and a card, then count `modelRequests[turn].length` with the switch off and on. The scripted gateway reports a fixed 10/10 tokens per call, so count prompt and output characters for tokens, or use the nightly recorded mode.

**Open questions:** (a) Are the mail and calendar ids that were only read worth recording? That would need a new row, so check it against "no new authority store". (b) `to-N` is not durable, so it can be a neighbour only within the same conversation.
