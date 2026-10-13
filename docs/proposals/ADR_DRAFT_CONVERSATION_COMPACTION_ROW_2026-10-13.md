# ADR draft: a compaction row for long conversations (model view only)

Status: DRAFT for the owner's review (owner ruling of 13 Oct, 14:38Z, item 3: "the lead drafts it, and the owner reviews it before anything is built"). Nothing here is built. Once accepted it becomes an ADR in Brain under the next free number; this file is the draft the owner reviews.

Author: the backend lead session (claude.ai/code `session_01ARsyYdWNBCNEUBLNrnbtrP`). Source read at `beta-mvp` `aae96328`.

## 1. Context

**The window drops rows silently.** The owner turn bounds the model's conversation input with a token-aware rolling window: `packages/runtime/src/conversation/window.ts` keeps the newest rows that fit `CONVERSATION_INPUT_BUDGET_TOKENS` (about 100k tokens, the wire ceiling tightened to the model's usable window), oldest rows dropped first, the current owner turn always kept, "overflow degrades to a shorter window, never to a failed turn" (`windowModelMessages`, lines 41–61). `conversation/joined-path.ts:66–70` applies it to the ancestor path before every model call and reports `kept`, `dropped` and the token estimate to the `context_window` trace hop (`channels/owner-turn.ts:254`). Nothing replaces what is dropped: no summary, no marker in the model's view, no note to the owner. A fact the owner stated early in a long thread leaves the turn's context the moment the window passes it, unless the claims store or episode recall happens to carry it.

**What this costs the owner.** The owner named "loses context" as the first of three pains (14:38Z ruling). The window is exactly where a long conversation loses it, and the loss is invisible: the reply simply stops knowing.

**What exists already.** Durable facts go to the claims store (`memory/claims.ts`) through the `remember` path and the nightly pass; episode recall (`search_episodes`) retrieves past rows just in time; the tool-output ledger keeps the newest six tool fragments per kind across turns. None of these is a summary of the conversation's own thread: who asked what, what was decided, what is still open. The contracts package has a working-memory carry-over shape (`contracts/src/runtime/working-memory.ts`: bounded buckets of `summary` + `source_ref` + `source_taint` entries) with no runtime reference today.

**Reference systems.** Anthropic's context-engineering guidance: "Compaction is the practice of taking a conversation nearing the context window limit" and "Structured note-taking, or agentic memory, is a technique where the agent regularly writes notes" (anthropic.com/engineering/effective-context-engineering-for-ai-agents). Claude Code: "Compaction replaces the conversation with a structured summary. System prompt, CLAUDE.md, memory, and MCP tools reload automatically", and the summary keeps "your requests and intent, key technical concepts, ... pending tasks, and current work" (code.claude.com/docs/en/context-window). Letta's `memory_rethink` rewrites a block wholesale; Mem0 and Graphiti keep facts, not threads. The pattern Waldo needs is the Claude Code one applied to the dropped span only: the recent rows stay verbatim, the dropped span becomes one summary.

## 2. Decision (proposed)

**A compaction row.** When the window would drop rows from the model's view, the runtime writes one **compaction row** that summarises the span it drops, and the model's view becomes `[compaction row] + [kept rows]`. The transcript the owner sees keeps every row unchanged; the compaction row exists in the model's view only.

### 2.1 Shape

- A conversation entry with `role: 'compaction'`, `modelPayload` = the summary text, no `appPayload`, `modelProjection: { mode: 'compaction', covers: { from_id, to_id, rows } }` naming the first and last row ids it replaces and how many rows that is. Stored by the **canonical owner conversation store**, the one durable writer of the chain (`conversation/canonical-owner-store.ts`); no new table, no new store.
- The app page builder (`channels/app-api.ts` `appTranscriptPage`) never emits a compaction row (it filters to `user` and `assistant` already, line 197); the Telegram and iMessage transcripts likewise. No app.v1 change.
- The summary is bounded: at most 2,000 tokens (about 8k characters), written in the owner's language, structured as: what the owner asked for and decided; open items and promises Waldo made; facts the owner stated that are not yet in memory, each marked as stated by the owner; nothing about tool mechanics.
- A later compaction summarises `[previous compaction row] + [newly dropped rows]` into one new row (summary of summaries), so the model's view carries one compaction row at a time; the earlier compaction rows stay in storage for forget and audit, outside the view.

### 2.2 When it runs, and who writes

- **Trigger:** at the end of an owner turn (not inside it), when `windowModelMessages` reported `dropped > 0` for that turn, or when the estimated history exceeds 70% of the budget, so the summary is ready before the next turn needs it. At most one compaction per owner per 10 turns and per hour, so a long burst cannot run one per turn.
- **Writer and I/O order:** the compaction is a model call (external I/O) and therefore runs outside the owning SQLite transaction, under the turn's run scope (`scope.admit()` before the call and before the write), and commits its row in its own transaction through the canonical store. If the model call fails, nothing is written and the window keeps dropping oldest, exactly as today: the feature degrades to the current behaviour, never to a failed turn.
- **Judgment:** what to keep in the summary is the model's call under the instruction above; no regex or rule decides what mattered.

### 2.3 Privacy, authority and forget

- **Destination:** the summary is produced through the Scribe with destination `internal_context`, the same destination class as the rows it summarises, and stored with their `source_taint`. Owner health text follows the beta ruling for conversation rows (it may reach model context and owner-channel replies; never logs, audit records, R2 summaries, browser jobs, third-party sends or bulk long-term memory). The compaction row is conversation context, not long-term memory: it is not a claim, it is not promoted by the nightly pass, and it carries no `verification_status`.
- **Numeric health:** the summary instruction says to keep health as the owner's qualitative statements and never as numbers; the Scribe's structured-health check on the `internal_context` destination stays the enforced boundary, as it is for the rows today. (Open question for the owner, §5.)
- **Authority:** a compaction row never grants or records authority. Approvals, receipts, effects and open-loop closure read the ledgers, never the summary; the summary may say "the owner approved X", and the desk still decides from its own rows.
- **Forget:** `redactConversationEntries` covers compaction rows like any row, and a forget that redacts rows inside a compaction's span also redacts the compaction row (the row's `covers` range names the span, so the forget's coverage check can find it). A forget barrier applies to the summary text as to any stored text.
- **Logs and traces:** the `context_window` hop gains a `compacted` count beside `kept` and `dropped`; the summary text follows the trace capture switch like any turn text (never in production).

### 2.4 What stays as it is

- The window's budget, estimator and drop-oldest fallback (`window.ts`) are unchanged; the compaction row is simply the first row the window sees.
- The claims store, episode recall and the tool-output ledger are unchanged; the summary does not write memory.
- Threads (the app's per-thread chains) get the same mechanism per chain once their runtime lands; one compaction row per chain.

## 3. Alternatives considered

1. **Raise the window.** The 100k cap is the cost rule (cheapest-passing routing); doubling it doubles the cost of every long turn and still drops silently past the new line. Rejected.
2. **Retrieval only (episodes).** `search_episodes` already brings back rows the model asks for, but the model cannot ask for what it does not know it lost; retrieval is a complement, not a replacement. Rejected as the sole fix.
3. **Whole-conversation compaction (Claude Code's default).** Replaces everything with one summary; the recent rows the owner is mid-conversation about should stay verbatim. Rejected in favour of summarising the dropped span only.
4. **Per-turn structured notes written to memory.** The claims store already does this for durable facts through `remember` and the nightly pass; conversational continuity ("we were in the middle of planning Thursday") is not a fact to remember forever. Rejected for this problem; the two compose.
5. **Working-memory buckets (the unused contract).** Fixed buckets with caps fit a coding agent's work log; a personal conversation needs prose continuity. The contract can stay for the browser/work paths; not used here.

## 4. Consequences

- **Benefits:** a long thread keeps its decisions and open items in the model's view; the loss becomes legible (the summary says what it covers); cost is bounded (one extra model call per compaction, at most every 10 turns, output ≤ 2k tokens).
- **Costs and risks:** one more row kind in the conversation store and one more place the forget must cover (both tested); a summary can be wrong, which the verbatim kept rows limit and the owner can correct ("that's not what I said" lands as a normal turn, and the next compaction supersedes); the model view changes shape, so the L1 scenario harness needs a case for it.
- **Impact surface:** `conversation/canonical-owner-store.ts` and `conversation-store.ts` (the row kind), `conversation/joined-path.ts` (where the view is assembled), `channels/owner-turn.ts` (the end-of-turn trigger and the trace count), the Scribe destination mapping, `redactConversationEntries`; tests for each; no contract change in app.v1; no Supabase, wrangler or migration change. Feature flag `CONVERSATION_COMPACTION` (`'1'` to enable), default off, so rollback is the flag.

## 5. Decisions the owner is asked to make

1. Accept the compaction row as a conversation-store row kind written by the canonical store (a store change under CLAUDE.md "one durable writer per aggregate": the writer stays the same; the row kind is new).
2. The health policy for summaries: (a) the same as the rows they summarise (qualitative owner health may appear; numbers are instructed out and Scribe-checked), or (b) no health text at all in a compaction row. The draft proposes (a); (b) is one line in the instruction and one assertion in the test.
3. The budget: at most one compaction per 10 turns and per hour, output ≤ 2,000 tokens, flag default off until the eval shows the recall gain (the nightly eval's "recall of something said many turns earlier" scenario is the measure).
4. Whether the owner should ever see the summary ("what Waldo is carrying from earlier"). The draft says no for now; it is a later app surface, contract first.

## 6. Tests and falsifiers (for the build, once accepted)

- A 60-turn conversation where turn 3 states a preference and turn 60 asks about it: with the flag off the model's view lacks turn 3 and the reply cannot know it; with the flag on the compaction row carries it and the reply does (L1 scenario with model-input assertions on both).
- The app transcript page never contains a compaction row; the Telegram transcript neither.
- A forget of a topic stated in the compacted span redacts the compaction row and the next compaction does not reintroduce it.
- Owner messages carrying health numbers: the compaction row carries none (the Scribe check and the instruction), while the qualitative statement survives under policy (a).
- The desk's decisions are unchanged with and without a compaction row that mentions an approval.
- A failed compaction call leaves the chain and the next turn exactly as today.
- Cost: no more than one compaction per 10 turns in a 100-turn scripted run.
