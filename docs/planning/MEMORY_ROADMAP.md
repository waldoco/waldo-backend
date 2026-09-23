# Memory roadmap

The bar is state-of-the-art personal memory. This roadmap merges the locked MVP decision (memory todo, 22 September) with the [unified memory architecture](https://github.com/Pin4sf/Waldo/blob/main/waldo-brain/04-Agent-Harness/memory-architecture-unified-2026-05.md) (May 2026). Status is one of built, next or planned. Following the rule that judgment belongs to the model, classification, extraction and contradiction checks are model-reasoned, not rule-based.

## Locked decisions

- Canonical long-term memory lives in the per-user Durable Object's SQLite.
- The canon starts with four core files: MEMORY_CORE, MEMORY_GOALS, MEMORY_FOLLOWUPS and intelligence-summary.
- Vector search is external (pgvector or Vectorize) and fused with full-text results by reciprocal rank fusion.
- Wearables feed a health-summary lane only. Raw data stays on the phone.
- Health routines and preferences are first-class memory content.

## Stages

| #   | Stage                                                                                                                                                                                                                                             | Status                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Hot conversation state in the owner Durable Object's storage, restored on wake (`src/channels/conversation-store.ts`)                                                                                                                             | Proven live 23 Sept: the gym routine was recalled correctly after a full redeploy |
| 2   | Four core memory files in DO SQLite, readable and editable by the owner                                                                                                                                                                           | Next                                                                              |
| 3   | Scribe write path: an inbox, then model-reasoned extraction and classification into typed halls (facts, preferences, routines, goals, follow-ups, discoveries). Conditional preferences stay whole ("usually 11am; 7:30-8pm when mornings fail"). | Planned                                                                           |
| 4   | Bi-temporal beliefs: a new version supersedes the old one, and "what did Waldo know then" stays answerable                                                                                                                                        | Planned                                                                           |
| 5   | Confidence and provenance: a CARA-style confidence per belief, tagged as said, measured or inferred                                                                                                                                               | Planned                                                                           |
| 6   | Hybrid recall: temporal, full-text and vector pathways fused by RRF (Hindsight TEMPR), plus MMR diversity                                                                                                                                         | Planned                                                                           |
| 7   | Forgetting: ACT-R base-level activation decay on patterns and preferences. Stable facts are exempt.                                                                                                                                               | Planned                                                                           |
| 8   | Reflection: a nightly consolidation and promotion cycle (Hindsight-style Reflect, "Dreaming Mode")                                                                                                                                                | Planned                                                                           |
| 9   | Graph layer: a-mem links and Cognee triplet scoring once enough edges exist                                                                                                                                                                       | Planned                                                                           |
| 10  | R2 archives for old conversation and files, with importance-weighted eviction                                                                                                                                                                     | Planned                                                                           |
| 11  | Supabase queryable layer for the app and dashboard                                                                                                                                                                                                | Planned                                                                           |
| 12  | Memory inspector: see, correct and forget, with forgetting that stays forgotten                                                                                                                                                                   | Planned                                                                           |
| 13  | Memory evaluation: golden cases for Recall@K, staleness and conditional preferences, run in CI                                                                                                                                                    | Planned                                                                           |

## Test scenario

The owner's gym routine is the baseline case: usually 11am, 7:30-8pm when mornings don't work. Stage 1 keeps the exact words through restarts. Stage 3 has to store it as one conditional preference, not a flat "gym at 11am".
