# Overnight log, 12 Oct 2026

Orchestrator session `local_281f8c04-1fc5-41f4-8fc8-4ac9e6558cf3`, branch `docs/overnight-2026-10-12`. Brief: [ORCHESTRATOR_BRIEF_2026-10-12.md](ORCHESTRATOR_BRIEF_2026-10-12.md). Decisions: [OVERNIGHT_DECISIONS_2026-10-12.md](OVERNIGHT_DECISIONS_2026-10-12.md).

Tags: **[verified]** observed in this session; **[inference]** concluded, not observed; **[unverified]** reported by a lane or not checked.

## 21:34Z: start

- Permission mode: already `auto` (`get_session` self) **[verified]**. No switch needed, no approval card.
- `caffeinate -i -t 21600` running, pid 84717, until about 03:34Z **[verified]**.
- Heartbeat cron `29a6d33d`, `3,23,43 * * * *` local (IST), so :33/:53/:13 UTC **[verified]**.
- Branch `docs/overnight-2026-10-12` from `origin/beta-mvp` `4bb040f5` **[verified]**.
- Lane messages sent, all four queued (lanes mid-turn): L1 `6087534c`, L2 `8de61d87`, L3 `920478bc`, L4 `9499f8ab` **[verified]**.

State at 21:40Z:
- `beta-mvp` `4bb040f5` (#1073 merge); #1074 merged as `f74a2e38`, an ancestor **[verified]**.
- Staging `/healthz` reports `{"ok":true,"release":"4bb040f5"}`, so L1 has deployed the tip with #1074 **[verified]**.
- App `main` is `c2ccd5d0` (#77, approvals-defer re-pin from `21a70277`, merged 21:30Z), not `46e9e669` as the brief said **[verified]**.

L2 report (21:40Z) **[unverified until reviewed]**:
- #1074 fixes only the main-chat GET. App turns (`restored()`, `owner-turn.ts:622`) and scheduled app delivery (`appDeliveryFor`) still use the strict `load()`, so sends and app deliveries still fail for an account with a bad stored row.
- A failed send logs only `app execution outcome unconfirmed` with no code (`telegram-owner-do.ts:766`).
- Second trap: `ConversationTree.append` throws `conversation parent not found` (`conversation-entry.ts:98`) when the bad row is a parent, not the leaf.
- L2 is building the follow-up red-first: `load()` skips with the #1074 rule, children of a skipped row re-link in memory to the nearest loadable ancestor, a skipped leaf resolves to its nearest loadable ancestor, fixed log codes. Canonical-history loader change: independent review required.
- #1066 head `0bab0a41`, CI 6/6 from 19:01Z (before #1074); merge the follow-up first or together.
- The day-plan record for L3's Brief `latest` needs a DO ALTER: held for the morning (DO migration lineage).
