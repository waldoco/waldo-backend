# Capability matrix, first edition - 2026-09-27 (post merge-wave stable point)

Standing milestone practice (owner 2026-09-26 23:54 + 01:10 steering): at each stable point,
full matrix Waldo vs Instinct / Meta Muse / Hermes / OpenClaw - capabilities, use cases,
open-loop handling; matched / missing / recommended; every gap becomes roadmap. The north
star is Waldo === Instinct in capabilities. This is the first edition under that practice; it
supersedes the 2026-09-25 matrix where they disagree (15 merges + the bridge doc landed
between the two). Waldo column = beta-mvp @ b0dd7a1, COMMITTED (gates green), not deployed
unless marked LIVE from the last staging proof. Instinct column = its public, user-legible
surface as relayed by main. Muse facts from the 2026-09-25 benchmark (primary sources inline
there). Hermes/OpenClaw facts from CAPABILITY_INVENTORY + primary docs mined 2026-09-25.

## 1. The matrix

| Capability | Waldo (beta-mvp b0dd7a1) | Instinct | Meta Muse | Hermes | OpenClaw |
|---|---|---|---|---|---|
| Channels | Telegram LIVE; WhatsApp committed end-to-end (webhook verify+HMAC, directory routing, gated sends, link codes, voice notes transcribed as of tonight); console web | iMessage, WhatsApp, Slack, voice, email | WhatsApp-first (Meta surfaces) | Telegram, WhatsApp, Slack, Discord + toolsets | 20+ incl iMessage, WhatsApp, Signal, Matrix, Teams, LINE |
| Email/calendar/files | Google calendar read + event briefs LIVE; draft_email typed (approval-halted); gmail send unwired pending approval rail | Gmail/Calendar/Drive/Slack/Linear/Notion/GitHub read+write | Meta ecosystem connectors | broad via MCP toolsets | via plugins/MCP |
| Browser automation | Browserbase browse_page/browse_act behind egress guard + approval-bound submits | cloud browser with persistent sign-ins | browser sub-agent, a11y-tree only, takeover-pause | yes | yes (nodes + browser) |
| Voice in/out | STT via smallest.ai on Telegram AND WhatsApp (tonight); no TTS (B1, post-alpha by owner call) | voice notes + TTS | voice via Meta surfaces | transcription + ~10 TTS providers | voice via companion nodes |
| Vision input | typed (LLMAttachment), unwired on channels (A6) | yes | yes | yes | yes (camera/screen nodes) |
| Proactive loop | scheduler multiplexer + heartbeat tick (30 min, quiet/acted recorded), day cards, event briefs, loops, C3 dedupe+missed-run, C4 run history - all committed tonight | wake schedules (cadence/clock/exact, trigger-gated) + event subscriptions + standing monitors | background work + cron | scheduled tasks | cron, heartbeats, standing orders, task flow, Gmail PubSub/IMAP triggers |
| Memory | episodes, spots, constellation, claim store with origin classes + admission gate + consolidation validation + nightly speaker-split grounding (all committed tonight); owner-correctable; exportable typed rows | memory filesystem + observation DB + indexed recall | Meta-VM memories, inspectable/downloadable; trains on trajectories by default (opt-out) | file-based memory | memory + sessions in Gateway |
| Approvals/consent | approval desk, payload-bound ledger entries (sha256, replay-verbatim), undo, consent tickets LIVE | review-before-send default, earned-trust grants | HITL strict capabilities (one-time/session/task/time-bounded, exact-scope) | via plugins | pairing approvals for unknown senders |
| Secrets custody | Supabase Vault + connector proxy (no token reaches model/DO/worker); fill-only vault spec'd; 1Password hybrid recommended | vault-held card, vault links, secrets never in chat | authd surrogate tokens, single-use merchant-locked cards | env/config | on-host config |
| Multi-user | invite gate + per-owner DOs + identity isolation; WhatsApp/telegram/console multi-provider presences committed | per-user agents + i2i coordination | per-user dedicated VM | multi-user deployments | one Gateway, personal/team |
| Extensibility | contract-typed tools, scenario harness, no plugin system; MCP client handler A4 pending | platform + personal skills | self-written tools/skills + self-authored connectors | 3 plugin types + toolsets + MCP | plugin SDK + ClawHub |
| Harness/verification | L1 scenario harness, pinned CI gates (4 runtime shards + supabase pgTAP + lineage guard), pgTAP, bug log; schedule_runs truthful history | wake triggers gate fires | safety classifiers + red-team/bounty program | evals culture | QA channel plugin |
| Real-world actions | none live; India-first shopping rail specced (UPI handoff, owner completes payment) | shopping/checkout, food, rideshare, restaurant, flights incl check-in | purchases w/ single-use cards + HITL | via MCP | via plugins |
| Subagents | subagents v1 committed (#224) | main + task agents | subagent swarms | subagent delegation | background tasks + multi-agent routing |

## 2. Use cases (day-one set, matched)

Owner-priority use cases from the 2026-09-26 packet section 5, against what each agent ships
today: reminders/routines (Waldo LIVE; all four match), calendar prep briefs (Waldo LIVE;
Instinct matches; others partial), past-due nudges (Waldo committed tonight via heartbeat;
Instinct matches via monitors; OpenClaw via heartbeats; Hermes/Muse partial), voice-note
capture (Waldo committed tonight on both channels; Instinct/Muse/Hermes match), meal logging
(Waldo A9 pending - Muse's flagship artifact is literally Meal Tracker, validating the
priority; Instinct covers via logging+proactive patterns), shopping (all trail Instinct's
live rail; Waldo's India-first spec stands), multi-channel reach (Waldo Telegram LIVE +
WhatsApp committed; Instinct matches on more channels), owner-correctable memory with
provenance (Waldo committed tonight: origin classes + admission gate + console holds;
Instinct matches; Muse partial - trains by default; Hermes/OpenClaw file-based, no gate).

## 3. Open-loop handling (the comparison the owner asked for by name)

| | Waldo | Instinct | Meta Muse | Hermes | OpenClaw |
|---|---|---|---|---|---|
| Open-loop record | typed loops table (open/due/snoozed), owner-visible, agent-maintained | durable todos + observation-backed follow-ups | background work objects | task list primitives | task flow |
| Detection | heartbeat tick scans past-due open loops every 30 min with per-occurrence cooldown (no flood) | wake schedules + subscriptions fire on condition, trigger-gated | cron + background sweeps | scheduled checks | heartbeat + cron |
| Delivery truth | schedule_runs: one row per fire, decision (quiet/acted) + delivery (pending/sent/failed) recorded; terminal states never re-sent; pending = recoverable crash window | delivery receipts per channel; sent != delivered stated honestly | HITL-bound actions | logs | session logs |
| Missed-run policy | C3: after a gap, fire latest elapsed occurrence once, never a burst; chunk-drained catch-up (tonight's wedge fix) | wake threshold/catch-up semantics | not published | not published | not published |
| Escalation | volume + quiet hours + renotify cooldown; owner-set proactivity | quiet hours + owner preferences | Sentinel ask-flow | manual | standing orders |
| Gap | held-brief release after quiet hours (H1b) and due-reminder coverage inside the heartbeat scan remain the documented follow-up slice; event-driven (non-timer) loop triggers are A8 | event subscriptions already live | - | - | Gmail PubSub/IMAP triggers live |

## 4. Matched / missing / recommended (every gap -> roadmap)

MATCHED (Waldo at parity or better, honestly):
- Deterministic approval binding, custody hard line, egress guard - parity with Muse's
  Sentinel/authd shape at the content layer; exceeds on no-training and portability.
- Proactive scheduler core: dedupe + missed-run + truthful run history is now at parity with
  Instinct's wake discipline; OpenClaw/Hermes publish nothing equivalent on missed runs.
- Memory correctness story: origin classes + admission gate + correctable claims exceeds
  every column except Instinct's (parity).
- Verification: scenario harness + pinned gates + pgTAP remains the column nobody else has.

MISSING (each maps to an existing program item - this is the roadmap cross-reference):
1. WhatsApp proactive templates (24h window) -> nine-item #1 remainder W5; owner-side Meta
   approvals gate it, lane-side design follows the loop taxonomy.
2. Event-driven ingress (Gmail PubSub-class) -> nine-item #2/A8; OpenClaw's PubSub trigger is
   the reference.
3. Gmail live handlers + email ingress hygiene (OTP/magic-link filtering, Muse gap) -> A1 +
   the Muse benchmark's highest-value adoption; must land before alpha testers connect inboxes.
4. MCP client handler (connectors as config) -> A4/nine-item #4; the leverage move.
5. Vision input wiring (A6) + meal/workout logging (A9) -> nine-item #6 day-one set.
6. TTS voice-out -> B1 (owner moved post-alpha; Instinct/Muse/Hermes all have it).
7. Real-world action rail (shopping India-first) -> B2; rides approval desk + browser + vault.
8. H1b heartbeat remainder (held-brief release) -> nine-item #2 remainder, next lane slice.
9. Artifact store + background task tracking -> A5 (owner: built in alpha, not specced).
10. Standing orders typed surface -> A7 (OpenClaw pattern; Muse's grant taxonomy adopted).

RECOMMENDED (not gaps, advantages to press):
- "Your intelligence, carryable": typed exportable memory + model-agnostic harness - say it
  in onboarding; Muse cannot match without cannibalizing lock-in.
- Trust surface ("Your Waldo" console section) per the Muse benchmark spec; the dashboard
  work tomorrow should ride it.
- India-first money story: UPI owner-completes is a trust feature, not a limitation.

Sources: CAPABILITY_MATRIX_2026-09-25.md, WALDO_VS_META_MUSE_BENCHMARK_2026-09-25.md,
CAPABILITY_INVENTORY_2026-09-25.md, HARNESS_COMPARISON_2026-09-25.md, BUILD_PLAN_2026-09-25.md,
WHATSAPP_CHANNEL_SPEC_2026-09-25.md, tonight's merge line (#224 subagents, #223/#232 heartbeat,
#234 admission gate, #235 origin classes, #237 consolidation validation, #233 C3+missed-run,
#239 console holds, #240 WhatsApp voice) on beta-mvp @ b0dd7a1.
