# Handoffs, 12 October 2026

The owner is starting successor sessions because the lane sessions have grown too long to hold their context. Each lane wrote its own handoff from [`HANDOFF_TEMPLATE.md`](HANDOFF_TEMPLATE.md), and the alignment session collected them here.

**A successor:**
1. reads this page first, then its own handoff;
2. re-verifies every SHA before acting.

**State when collected** (about 20:20Z on 11 Oct):
- `beta-mvp` is `21a70277`;
- staging serves `726ad0e7`, from `/healthz`;
- app `main` is `46e9e669`.

## The goal, in the owner's words

> full usable app ready + tested and backend agent working ready + tested (both app + telegram with continuity ready for whatsapp and imessages when they arrives)

## Handoffs and restart order

| Order | Lane | Handoff | Restart after |
|---|---|---|---|
| 1 | L3: approvals, app contracts, Google connect | [`L3_HANDOFF_2026-10-12.md`](L3_HANDOFF_2026-10-12.md) | its handoff. #1070 merged as `21a70277`; waldo-brain #36 waits for the owner. |
| 2 | L4: Waldo app | [`L4_HANDOFF_2026-10-12.md`](L4_HANDOFF_2026-10-12.md) | its handoff. #74–#76 are merged and the Simulator pass is done. Its successor runs in waldo-app, where the path in its starter prompt doesn't exist; its collection notes give the command that reads this copy. |
| 3 | L1: health plane and staging deploys | [`L1_HANDOFF_2026-10-12.md`](L1_HANDOFF_2026-10-12.md) | its handoff. It has captured the 503's code, so its log tail is no longer needed. Its successor re-arms the tail to confirm L2's fix after deploying it. |
| 4 | L2: owner identity and delivery router | [`L2_HANDOFF_2026-10-12.md`](L2_HANDOFF_2026-10-12.md) | its fix for the 503 is in a PR with red-first tests, or written down in its handoff. L2 holds the critical path. |
| 5 | Alignment | [`ALIGNMENT_HANDOFF_2026-10-12.md`](ALIGNMENT_HANDOFF_2026-10-12.md) | the handoffs are collected and merged. |

All four lane handoffs are here. Each starts with collection notes: what changed between the lane writing it and the alignment session collecting it. Each ends with a starter prompt for its successor.

**Other sessions:**
- **Audit.** It is the only writer of the ledger (#1057) and keeps its own lane file. It restarts on the same template when the owner chooses.
- **Browser lane.** It is preparing the staging browser PR (ledger D17).
- **Latency session.** Done once #1072 is decided. #1061 merged as `c3b17f6a`.
- **Finished, awaiting the owner's yes to archive:**
  - Autocompact 600k update;
  - Triage the 71 open backend PRs;
  - Find why event-route Telegram sends are blocked on staging;
  - Waldo app-backend handoff.

## What "done" means: checks, not claims

**Staging state:**
- Main chat loads history and answers, for the owner's account and for a fresh account.
  - Today GET `/app/v1/chat/main` answers 503 with `history_invalid` (L1's capture at 20:10Z): a stored row in the owner's canonical history fails its shape check.
  - L2 is fixing it on branch `l2/app-history-skip-invalid-rows` (`0692b4b2` at 20:25Z). Its PR opens after the gates pass.
  - The fix covers only the Main-chat read: a display read skips shape-invalid rows that match their witness. The strict `load()` that turns use is unchanged, so whether app sends still fail is open.
- Proactive messages are armed at first app use (#1066) and arrive in the app at the times the owner set.

**On a real iPhone,** built from source because there is no TestFlight:
- **The golden path:**
  - sign in with Google or email, an invite, and the 18+ checkbox;
  - connect Google;
  - give health consent and ingest Apple Health, then see scores;
  - get an answer in Main chat;
  - complete an approval round trip: approve, "Not now" and "Don't do this";
  - have a reminder fire.
- **Push:** a reminder push arrives on the iPhone from the APNs sandbox, once S7 lands (L2's plan; it needs owner decisions).

**Continuity across channels.** Probe: send a message on Telegram, then open Main chat in the app.
- Does the message show there?
- Does Waldo recall it?
- And the reverse.

This is a likely gap today:
- App turns write the canonical store, and Telegram writes the legacy `conv:*` rows.
- The episodes index and nightly consolidation can't see app chat (Audit verified this; L2 has a proposal).
- It's an L2 acceptance item.

**Ready for WhatsApp and iMessage** means a channel adapter at the existing channel seam, with:
- the same owner authority boundary;
- the same canonical transcript;
- the same delivery gate.

What's missing today:
- the WhatsApp adapter is used only by its test;
- iMessage is Ashish's draft #1017, whose migration needs renumbering, plus the host repo's draft #1;
- both need the canonical-store path, not the legacy rows, before continuity holds.

**Deletion:** deleting a throwaway account from the app removes everything (#1064, #1069). The owner has to sign up the account.

**Promises:** Audit's probes Q1–Q10 run in the app with the owner's go, and their results land in the ledger.

**Design:** the register `APP_DESIGN_SYSTEM_GAPS.md` is closed, or Suyash accepts what remains.

**Long sessions:** the working set and out-of-view note (options C and A in [`LONG_CONVERSATIONS_BRIEF.md`](../LONG_CONVERSATIONS_BRIEF.md)) ship with their eval.

## Open owner decisions, all in one place

1. **The time-zone write:** pick L2's option. The alignment session recommends (a), write only while the stored zone is the UTC default. Say it in L2's session.
2. **#1066:** merge after the 503 is fixed.
3. **Push (S7):**
   - choose the provider (direct APNs recommended, no new processor);
   - give the go for a preview deploy to test whether Workers reach APNs over HTTP/2;
   - security-review the token read path;
   - create the APNs key and enter it in the secrets store yourself.
4. **Apple sign-in:** recommendation is to keep it dropped for the beta, and add it before App Store submission if guideline 4.8 requires it. Check the current text then.
5. **The 6:30 notification:** decide the rule that releases an overnight Needs You as one push at wake time, with Suyash.
6. **Kennel and iMessage scope.** Rulings 4 and 13 put them in this push; the ledger's §9 Wave 6 and CLAUDE.md say later.
7. **Merges:**
   - Pin4sf/waldo-landing#18 (publishes the site);
   - Pin4sf/waldo-brain#36 (the reminder-push ADR);
   - Pin4sf/waldo-brain#35 (after Suyash's review and the font-licence call);
   - waldoco/waldo-backend#1072 (the race fix);
   - #1057 and #1058 (Audit);
   - L2's fix for the 503, once its PR is up.
8. **Lane proposals for rows no lane holds:** ledger §12 on #1057.
9. **The website's Connectors page** still shows Waldo sending through Telegram in its example scenes, and lists Telegram as "Working today". Reworking the illustrations needs Suyash.
10. **The website's Calendar and Tasks labels** say "read only", but Waldo asks for `calendar.events` and `tasks`. Change the copy or the scopes.
11. **The website's "example model provider" row names Anthropic,** but chat runs on OpenAI. It's hedged, so low urgency. The final privacy policy needs the real processor list.
12. **Staging browser spend cap (D10).**
13. **Health numbers the owner types are stored in the canonical transcript without filtering.** This needs an ADR answer under the beta ruling.
14. **Archiving the four finished sessions.**
15. **The owner's own hands:**
    - the throwaway-account test;
    - the real-iPhone run;
    - the message to Suyash;
    - Google's consent screen and verification.

## Kennel (Ashish's desktop work)

- **On `outcome-loop`,** 469 commits ahead of `main`, last merged 2 Oct:
  - the device bridge's pairing, socket and per-device storage;
  - a local "Connect to Waldo", off by default.
- **Backend:** the bridge (v0.2.3) is merged and bound on staging, but only console actions reach a device. No agent tool or delivery route does, and the coding-agent handoff is a fake executor.
- **Drafts:**
  - Kennel #250–#252, which are green;
  - backend #1006, #1017 and #1063, which are behind `beta-mvp`.
- **Before Kennel is a usable presence,** these must land:
  - #251 and #252;
  - a query handler;
  - an agent tool and a delivery route to the device;
  - the K0 handoff seam;
  - a release that includes the bridge.
