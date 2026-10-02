# Memory parity against mature agents (first slice)

Layer: external facts from vendor help pages fetched 2026-10-02 (cited); Waldo column is a SOURCE read of beta-mvp plus merged-PR knowledge, not a staging result. Anything marked "verify" has no staging receipt. This is the memory slice of the owner's parity ask; other rows (scheduled tasks, connectors, files) follow the same shape.

Sources:
- ChatGPT Memory: https://help.openai.com/en/articles/8590148-memory-in-chatgpt
- Claude chat search and memory: https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context

## What mature agents do (stated by the vendors)

| # | Behaviour | Source says |
|---|---|---|
| M1 | Ask "what do you remember about me" | ChatGPT: "You can also ask ChatGPT what it remembers about you"; a memory summary with edit and delete |
| M2 | Show where a personalised answer came from | ChatGPT shows Sources under a response (past chat, saved memory, file, email); user can open, correct or delete the source |
| M3 | Correct a remembered fact | ChatGPT: tell it a memory is wrong, or edit it; "Don't mention this again" reduces use without deleting the source |
| M4 | Delete is honest about scope | ChatGPT: deleting a chat does not delete a separate saved memory; remove it from summary, saved memories, chats, files, connected apps; propagation takes time |
| M5 | Save on request and on its own | Claude: saves topics as you chat; "remember this" saves directly |
| M6 | Search past conversations as a visible tool call | Claude: RAG search that "will appear as tool calls" |
| M7 | Per-chat opt out | Claude: incognito chat and a per-chat Memory toggle |
| M8 | Scoped memory | Claude: each project has separate memory |

## Waldo today (verify rows have no staging receipt)

| # | Waldo | Gap |
|---|---|---|
| M1 | `read_memory` tool exists; whether the model reliably lists what it knows in plain words is unproven | verify on staging |
| M2 | Claims carry provenance (source, evidence, status, untrusted/stale marks); replies are meant to rest on tool receipts | answer-level "where this came from" line not shown to the owner; verify |
| M3 | Supersede/correct exists in the claim ops; stale status exists | no "don't mention again" distinct from delete; decide if needed |
| M4 | Forget purges claims, aliases, FTS, and writes a content-free barrier (#585, #586, #590); re-admission blocked | the reply must say honestly which stores were purged and that old chat text may remain; verify wording on staging |
| M5 | Writer saves from conversation and owner statements | verify "remember this" end to end |
| M6 | Episodes/threads search tools exist (`search_episodes`) | recall of synonyms is about 0% without aliases or terms (harness, #581 to #584); real-model check blocked on the owner's key and ceiling |
| M7 | Not found in source | gap; small, owner decision whether wanted |
| M8 | Single owner memory | not needed for a one-owner agent; skip |

## Proposed order for today (engineering merit, no spend)
1. M1, M4, M5 as staging real-user flows with receipts (add to the F-list in STAGING_REAL_USER_FLOWS): "what do you remember about me", "remember X", "forget X" with an honest scope statement.
2. M2: a plain-words source line from the claim's provenance when a memory shaped the answer. Needs a contract decision (where the line is rendered); propose before building, no regex.
3. M6: unchanged, blocked on the key and ceiling.
4. M7: ask the owner once, only if he wants a private/no-memory mode.
