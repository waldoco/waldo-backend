# Vision (April brainstorm) vs current build - 2026-09-25

Source: owner's "Waldo - The Full Vision Brainstorm" (April 2026, 833 lines). His framing: very old,
too health-focused, REFERENCE not requirements. Verdicts: POSSIBLE NOW (code exists), PARTIAL
(skeleton exists, a named piece missing), NOT YET, SURPASSED (build beat the doc's imagination).

## The honest headline

The doc's core promise - "reads your body AND acts on what it finds" - is exactly half built.
The ACT half (proactive loop, calendar adjustments, console, approvals, memory) exists and is
live-verified. The READ half (wearable/CRS data source) has NO ingestion path: no Oura/Apple
Health/Whoop integration exists anywhere in the code. Every "CRS 74" moment in the doc depends on
it. That is the single biggest vision gap and it is a connector, not a rewrite.

## Part by part

- Part I (body computation nobody can see): PARTIAL. The agent acts on state and context; the body
  signal itself is absent. The pitch holds the moment one wearable connector lands.
- Part II, Domain 1 (Morning Intelligence / Morning Wag): PARTIAL. Day cards + morning loop +
  calendar context exist. Missing: overnight-biology read (no data), calendar MOVE action is
  propose-only (propose_calendar_change) which is arguably better than the doc's auto-move.
- Domain 2 (energy/deep-work protection): PARTIAL. Deep-work protection and sequencing exist as
  loop behaviors/prompt-level; no focus telemetry. "Blocking your calendar and setting DND" needs
  a calendar-write tool with approval - propose + approve rail exists, auto-block deliberately not.
- Domain 3 (stress detection/regulation): PARTIAL-thin. Detection without wearable signal is
  text-tone only; regulation nudges possible via loops.
- Domain 4 (sleep/recovery): NOT YET (no data source).
- Domain 5 (social/relationship): PARTIAL. Communication context via connected mail exists in the
  connector architecture (Google), relationship memory exists (episodes/correctable memory).
- Domain 6 (physical): NOT YET. Domain 7 (cognitive quality): PARTIAL via reflection loops.
- Part III (personas): NOT CODE. But the alpha-tester gate shipped today (invites, per-owner DOs,
  identity isolation) is the prerequisite for ANY persona beyond the owner.
- Part IV (60+ micro-automations): PARTIAL. Platform for all of them exists (scheduler, loops,
  reminders, day cards, console). Each automation is content on that rail. Catalog-worthy ones to
  add as scenarios: meeting-prep 30-min-before, travel-buffer nudge, weekly review.
- Part V + VII (pitch/communication): NOT CODE. Doc's "what NOT to say" still worth a read before
  landing page copy. SURPASSED in one way: the doc sells from biology; the build's actual demo
  magic (harness-proven agentic reliability) is a story the doc didn't have.
- Part VI (constellation, Waldo-as-MCP-server endgame): NOT YET - and today's capability inventory
  says the FIRST move is the reverse: Waldo as MCP CLIENT (one handler, connectors become config).
  Server-side MCP is post-alpha.
- Part VIII (things other agents can't do): SURPASSED directionally - the doc lists proactive +
  biology; the build added consent rails, undo, honest degradation, per-owner isolation, and a
  pipeline harness none of the surveyed agents have.
- Part IX (financial, driving, smart home, shopping, travel...): NOT YET, correctly. All are
  connector-shaped post-alpha expansions; the MCP-client move makes them cheap later.
- Part X (April market research): SUPERSEDED by CAPABILITY_INVENTORY_2026-09-25 (Hermes/Codex/
  Claude Code current-state). Its "wellness graveyard" warning stands: Waldo must not present as
  a health app.

## What the doc changes about today's queue

1. Wearable/CRS connector goes on the post-alpha list at the TOP - it is the vision's core.
2. WhatsApp spec (shipped today) already absorbs the 24h-window reality for proactive loops.
3. Scenario catalog additions from Part IV: meeting-prep, travel-buffer, weekly review.
4. Nothing in today's queue (console sign-in, multi-user, WhatsApp) is contradicted by the doc.

## Older HTML docs

Hunt still open: the April brainstorm mentions prior docs; none surfaced in repo or downloads yet.
