# Overnight decisions, 12 Oct 2026

Decisions the orchestrator made on the owner's behalf under the brief ([ORCHESTRATOR_BRIEF_2026-10-12.md](ORCHESTRATOR_BRIEF_2026-10-12.md)). These are **delegated decisions, not owner rulings.** Each says how to reverse it. Owner rulings are quoted in the brief and the log, never restated here as decisions.

| # | Time (UTC) | Question | Decision | Alternatives | Why | Reverse by | Unblocked |
|---|---|---|---|---|---|---|---|
| D1 | 21:45 | Merge order for L2's send-path follow-up and #1066 | Follow-up first, then #1066 after it is brought up to the current `beta-mvp` with a merge from base, so its CI runs on today's base | Merge #1066 now (CI 6/6 is from 19:08Z, before #1074); merge both together | #1066's proactive deliveries use the same strict `load()`, so they would fail for an account with a bad row until the follow-up lands (L2's report). CI on a stale base is weaker evidence. | Merge #1066 first in the morning; nothing irreversible | L2 |
