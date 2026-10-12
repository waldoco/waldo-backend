# Orchestrator brief, 13 Oct 2026 [proposed, pending the owner's yes]

**The plan of record is Ansh's "Waldo Build Bible"** (Claude Doc, 12 Oct), §7 Phase 1. HEAD code wins over it and over this brief.
- **Goal:** both founders run the daily loop on their own phones: Suyash on iPhone with Apple Watch, Ansh on Android with Galaxy Watch.
- **Acceptance (owner ruling, 13 Oct, about 02:00 IST):** phone testing comes later. For now, a Simulator run the sessions make on their own, with screenshots and a trace id, is acceptance. The owner does not approve each run.
  - **Simulator devices:** each testing session uses its own. L4 has `iPhone 17 Pro` (3D82E6D8); the orchestrator has `iPhone 17` (18AC0C6B).
  - **Sign-in:** a human signs in once per device. The app session lasts 12 hours today, and 30 days after PR B, so PR B comes first.

## State at handover (12 Oct, 20:10Z)

- **Staging = `beta-mvp` = `d704ffff`** (version `b6b2c5ec`; rollback `8fe4c98a`).
  - Live: app-path scheduled work (#1086, #1087), history fixes (#1074, #1075, #1080), G1 (#1091), the per-origin ring (#1098), schedule guards (#1090, #1092), Weight (#1089) and the overlap net (#1099).
  - Nothing has run on a physical phone.
- **#1101 (E15, app-first routing):** CI green, and the review passed. It's owner-merge.
  - Six non-blocking follow-ups are in `OVERNIGHT_LOG_2026-10-12.md` (20:07Z).
  - It keeps one Telegram dev copy, which conflicts with the Bible's "no copy" (decision 1 below).
- **#1100 (PR 0):**
  - Based on `87b3194`; DIRTY against `d704ffff`.
  - Its rebase crosses G1's D16 filter and taint stamp, and #1098's ring, in `owner-turn.ts` and `tool-loop.ts`. Review those two files after the rebase.
  - Its `v6` class rename blocks `wrangler rollback` to any earlier version. Cloudflare docs: rollbacks are not allowed across a DO class lifecycle change. So the PR's rollback note is wrong.
  - It supersedes #1088.
- **App `main` `3862bb26`:** #89 has three follow-up findings, one MEDIUM: a new hold drops the server's Retry-After. The app repo has no CI.

## Lanes [proposed]

| Lane | Owns | First work |
|---|---|---|
| Backend runtime (one session) | `packages/runtime/src/channels/**`, `skills/**`, `identity/**` | #1101 merge; #1100 split (the behaviour now, the rename later) and rebased; the rest of PR A; PR B (30-day session, `created_at` producer, interrupted-turn row) |
| App (one session) | waldo-app `app/**`, `src/**` | EAS project and dev client, origin in config, an iPhone build for Suyash; #89 follow-ups; app CI (typecheck plus jest); Home Brief row; dead-code deletion |
| Android native (only if an EAS cloud build works) | waldo-app `android/**`, native health module | An internal APK for Ansh (no Android SDK on the Mac); `expo-symbols` fallbacks; Samsung range reader and ingest; FCM |
| Founders | Their phones | Run the loop checklist daily; file each failure with its trace id in one tracking issue |
| Ashish | Credentials | EAS signing, the APNs key and FCM, Google OAuth status |

No second backend lane until #1101, #1100, PR A and PR B are through the hot files.

**Parked, each with its record left in place:**
- L1: health plane (the zone-clipping gap, the trend query across versions, #1083 Form v2);
- L3: standing grants (E16, `STANDING_GRANTS_ADR_DRAFT_2026-10-12.md`);
- the audit lane (#1057, #1058);
- browser (#1032, Bible Phase 2);
- iMessage (#1095, Ashish, Phase 5);
- the PR 998 re-cut, which stops.

## Rules [proposed]

- **Merge:** CI green and the guards pass.
  - The owner merges only PRs touching a migration, a DO class or migration lineage, auth or sessions, a new health destination, or a new external integration. These get one independent review.
  - Other PRs merge on green.
- **Staging deploy:** a standing go for green tips (Worker only). Migrations and DO class changes need the owner's yes, with a forward-only rollback plan.
- **Coordination:** one tracking issue for phone evidence and decisions. Messages only to unblock. No running log.

## Decisions for one sitting (recommendations in the owner's reply, 12 Oct 20:15Z)

1. **Telegram copy of proactive messages:** keep one dev copy (E15), or none (Bible).
2. **Push provider:** direct APNs (11 Oct ruling; the spike passed), or Expo Push for both platforms (Bible).
3. **iPhone install:** builds from source (11 Oct "no TestFlight"), or TestFlight internal (Bible).
4. **Brief push:** "Your Brief is ready" (Bible), or never (design system).
5. **#1100 over #1088,** and split the class rename out of #1100.
6. **Merge order:** #1101, then #1100 rebased once.
7. **Instruction files** rewritten to one page per repo as the first PR of the new session.
8. **A standing go for staging deploys** of green tips.
