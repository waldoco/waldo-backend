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

September 29 Dots addendum: the Dots column is from [owner-supplied transcription attributed to OpenAI](https://openai.com/index/introducing-dots/) (not independently fetched or tested). It is a reported product claim, not an independently verified capability, measured result or update to Waldo's dated b0dd7a1 state. The September 25 matrix remains a historical snapshot.

## 1. The matrix

| Capability | Waldo (beta-mvp b0dd7a1) | Instinct | Meta Muse | Dots* | Hermes | OpenClaw |
|---|---|---|---|---|---|---|
| Channels | Telegram LIVE; WhatsApp committed end-to-end (webhook verify+HMAC, directory routing, gated sends, link codes, voice notes transcribed as of tonight); console web | iMessage, WhatsApp, Slack, voice, email | WhatsApp-first (Meta surfaces) | ChatGPT desktop/web/mobile, Slack and Teams; voice calls. Texting described as coming, not live. | Telegram, WhatsApp, Slack, Discord + toolsets | 20+ incl iMessage, WhatsApp, Signal, Matrix, Teams, LINE |
| Email/calendar/files | Google calendar read + event briefs LIVE; draft_email typed (approval-halted); gmail send unwired pending approval rail | Gmail/Calendar/Drive/Slack/Linear/Notion/GitHub read+write | Meta ecosystem connectors | Claims 4,000+ app plugins and connected work; exact app/method coverage unverified. | broad via MCP toolsets | via plugins/MCP |
| Browser automation | Browserbase browse_page/browse_act behind egress guard + approval-bound submits | cloud browser with persistent sign-ins | browser sub-agent, a11y-tree only, takeover-pause | Separate cloud computer and browser, inspectable by owner; practical site success unmeasured. | yes | yes (nodes + browser) |
| Voice in/out | STT via smallest.ai on Telegram AND WhatsApp (tonight); no TTS (B1, post-alpha by owner call) | voice notes + TTS | voice via Meta surfaces | Voice call described; exact voice-note/TTS surfaces not specified. | transcription + ~10 TTS providers | voice via companion nodes |
| Vision input | typed (LLMAttachment), unwired on channels (A6) | yes | yes | Not stated in supplied launch transcription. | yes | yes (camera/screen nodes) |
| Proactive loop | scheduler multiplexer + heartbeat tick (30 min, quiet/acted recorded), day cards, event briefs, loops, C3 dedupe+missed-run, C4 run history - all committed tonight | wake schedules (cadence/clock/exact, trigger-gated) + event subscriptions + standing monitors | background work + cron | Always-on multi-project work and read-only background app research claimed; safety/precision unmeasured. | scheduled tasks | cron, heartbeats, standing orders, task flow, Gmail PubSub/IMAP triggers |
| Memory | episodes, spots, constellation, claim store with origin classes + admission gate + consolidation validation + nightly speaker-split grounding (all committed tonight); owner-correctable; exportable typed rows | memory filesystem + observation DB + indexed recall | Meta-VM memories, inspectable/downloadable; trains on trajectories by default (opt-out) | Learns preferences and feedback; storage, correction and deletion semantics not described. | file-based memory | memory + sessions in Gateway |
| Approvals/consent | approval desk, payload-bound ledger entries (sha256, replay-verbatim), undo, consent tickets LIVE | review-before-send default, earned-trust grants | HITL strict capabilities (one-time/session/task/time-bounded, exact-scope) | Custom Rules allow/ask/block, auto-review of consequential actions and Activity View claimed. | via plugins | pairing approvals for unknown senders |
| Secrets custody | Supabase Vault + connector proxy (no token reaches model/DO/worker); fill-only vault spec'd; 1Password hybrid recommended | vault-held card, vault links, secrets never in chat | authd surrogate tokens, single-use merchant-locked cards | Saved passwords can be used for supported sites without exposing them to model; custody proof unobserved. | env/config | on-host config |
| Multi-user | invite gate + per-owner DOs + identity isolation; WhatsApp/telegram/console multi-provider presences committed | per-user agents + i2i coordination | per-user dedicated VM | Primary dot per person; specialist enterprise dots in pilot with separate identities; rollout limits apply. | multi-user deployments | one Gateway, personal/team |
| Extensibility | contract-typed tools, scenario harness, no plugin system; MCP client handler A4 pending | platform + personal skills | self-written tools/skills + self-authored connectors | 4,000+ app plugins claimed; self-authored skill/plugin semantics not stated. | 3 plugin types + toolsets + MCP | plugin SDK + ClawHub |
| Harness/verification | L1 scenario harness, pinned CI gates (4 runtime shards + supabase pgTAP + lineage guard), pgTAP, bug log; schedule_runs truthful history | wake triggers gate fires | safety classifiers + red-team/bounty program | Safety monitoring described; no public comparable run/score in supplied text. | evals culture | QA channel plugin |
| Real-world actions | none live; India-first shopping rail specced (UPI handoff, owner completes payment) | shopping/checkout, food, rideshare, restaurant, flights incl check-in | purchases w/ single-use cards + HITL | Could prepare invoice and send after approval in cited early-tester example; no generalized checkout claim. | via MCP | via plugins |
| Subagents | subagents v1 committed (#224) | main + task agents | subagent swarms | Multi-project work; future teams of dots mentioned, not claimed shipped. | subagent delegation | background tasks + multi-agent routing |

## 2. Use cases (day-one set, matched)

Owner-priority use cases from the 2026-09-26 packet section 5, against what each agent ships
today: reminders/routines (Waldo LIVE; original peer set matched; Dots has no comparable reminder claim in the supplied text), calendar prep briefs (Waldo LIVE;
Instinct matches; other original peers partial; Dots not specified), past-due nudges (Waldo committed tonight via heartbeat;
Instinct matches via monitors; OpenClaw via heartbeats; Hermes/Muse partial; Dots claims proactive research without comparable nudges), voice-note
capture (Waldo committed tonight on both channels; Instinct/Muse/Hermes match; Dots voice calls, not specified voice-note capture), meal logging
(Waldo A9 pending - Muse's flagship artifact is literally Meal Tracker, validating the
priority; Instinct covers via logging+proactive patterns), shopping (the original peer set trails Instinct's live rail; Dots checkout not established; Waldo's India-first spec stands), multi-channel reach (Waldo Telegram LIVE +
WhatsApp committed; Instinct matches on more channels; Dots claims ChatGPT/Slack/Teams with texting future), owner-correctable memory with
provenance (Waldo committed tonight: origin classes + admission gate + console holds;
Instinct matches; Muse partial - trains by default; Hermes/OpenClaw file-based, no gate; Dots claims learning from feedback without correction semantics).

## 3. Open-loop handling (the comparison the owner asked for by name)

| | Waldo | Instinct | Meta Muse | Dots* | Hermes | OpenClaw |
|---|---|---|---|---|---|---|
| Open-loop record | typed loops table (open/due/snoozed), owner-visible, agent-maintained | durable todos + observation-backed follow-ups | background work objects | Multi-project activity claimed; persistence schema not described. | task list primitives | task flow |
| Detection | heartbeat tick scans past-due open loops every 30 min with per-occurrence cooldown (no flood) | wake schedules + subscriptions fire on condition, trigger-gated | cron + background sweeps | Read-only background app research claimed; trigger mechanics unverified. | scheduled checks | heartbeat + cron |
| Delivery truth | schedule_runs: one row per fire, decision (quiet/acted) + delivery (pending/sent/failed) recorded; terminal states never re-sent; pending = recoverable crash window | delivery receipts per channel; sent != delivered stated honestly | HITL-bound actions | Activity View; delivery receipt semantics unverified. | logs | session logs |
| Missed-run policy | C3: after a gap, fire latest elapsed occurrence once, never a burst; chunk-drained catch-up (tonight's wedge fix) | wake threshold/catch-up semantics | not published | Not stated. | not published | not published |
| Escalation | volume + quiet hours + renotify cooldown; owner-set proactivity | quiet hours + owner preferences | Sentinel ask-flow | Custom Rules and automatic action review; exact escalation outcomes untested. | manual | standing orders |
| Gap | held-brief release after quiet hours (H1b) and due-reminder coverage inside the heartbeat scan remain the documented follow-up slice; event-driven (non-timer) loop triggers are A8 | event subscriptions already live | - | No comparable Dots internal-run proof. | - | Gmail PubSub/IMAP triggers live |

*Dots entries are owner-supplied launch-text claims, not independently verified or operationally tested. Do not infer parity or assume texting, specialist dots, or all app plugins are available today.

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
