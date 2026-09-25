# Build plan - 2026-09-25 (post capability-matrix)

Where every approved piece fits. Approvals from the owner's 10:41 IST message: 1Password hybrid,
harness pillars from OpenClaw/Pi/Hermes (standing orders, background tasks, webhook ingress,
events scheduling), real-world actions planned as real capabilities (shopping India-first),
production-grade web console/dashboard backed end-to-end by the backend, health/productivity
incentive folded into the commerce loop.

## P0 - owner-side gates (nothing lane-side blocks these)

1. Packet v2 (10:17): deploy pull, owner-row bootstrap (email + is_admin), db push + pgTAP,
   auth-config PATCH, live sign-in curl test. Unblocks: console email sign-in LIVE, admin invites.
2. Resend domain answer. No domain -> onboarding@resend.dev works for his own sign-in test today;
   alpha tester code emails need a verified domain (3 DNS records).
3. Meta business verification start (days of review; gates nothing about coding).
Lane can drive the browser for 3 if he wants; 1-2 are his hands.

## P1 - alpha (this week, lane-side, in order)

| # | Slice | Why now | Depends on |
|---|---|---|---|
| A1 | Gmail live handlers (gmail tools typed, unwired) | connector breadth is the alpha story | connector proxy (live) |
| A2 | WhatsApp W1-W3 (schema literals, webhook, API caller + DO ingress) | spec 3c271e7; test number works unverified | none lane-side |
| A3 | S6 live proof (connect funnel end-to-end on staging) | closes the connect-flow arc | P0.1 |
| A4 | MCP client handler (call_mcp_tool typed, unwired) | ONE handler -> connectors become config; the leverage move | none |
| A5 | Voice-out (TTS via smallest.ai, already STT provider) | WhatsApp users send voice notes; voice reply is table stakes | none |
| A6 | Vision input wiring (LLMAttachment typed, no channel uses it) | telegram photos -> model | none |
| A7 | Standing orders (typed): scope/trigger/gate/escalation rows, injected via context composer, enforced by scheduler | owner-approved; OpenClaw pattern mined (auto-injected AGENTS.md programs) | scheduler + approvals (exist) |
| A8 | Generic webhook/event ingress channel | mirrors telegram-webhook shape; event-driven beats polling | none |

## P2 - post-alpha (ordered)

| # | Slice | Notes |
|---|---|---|
| B1 | Background task tracking (tasks table, trace hops, console list) | OpenClaw pattern; long runs become first-class |
| B2 | Shopping rail: adapter interface + India UPI adapter (cart-prep -> approval with UPI intent -> owner completes in GPay/PhonePe) | CAPABILITY_MATRIX section 4; money rides the approval desk + fill broker |
| B3 | US card adapter (proves portability cheaply), then JP (konbini/PayPay) and SEA (e-wallet/COD) | same owner-completes-payment shape |
| B4 | Food ordering, rideshare, restaurant, flights (incl check-in/boarding passes) | each = adapter on the B2 rail + browser arc |
| B5 | Health-incentive commerce loop: CRS-aware nudging on grocery/food orders (suggest the better cart, not a lecture) | differentiator; copy discipline per "not a health app" warning - incentive framing, no diagnosis |
| B6 | Wearable/CRS connector (Oura/Apple Health first) | the vision doc's missing READ half; top post-alpha connector |
| B7 | 1Password fill-broker backend (op:// refs via op CLI at fill time) | VAULT_SPEC amendment (owner-approved today) |
| B8 | Plugin SDK (after MCP client proves the seam); subagents/multi-agent (after standing orders + tasks) | OpenClaw ClawHub + Hermes toolsets are the references |
| B9 | Dashboard v2: production web console/dashboard | see below |

## Console/dashboard production-grade bar (his 10:41 ask)

The backend already serves the console end-to-end (sessions, CSRF actions, admin, files, traces,
connect flow). "Proper web console and dashboard" means: the worker keeps owning auth, data and
actions (no parallel backend); the front-end becomes a real dashboard surface over the same
DO/console routes. Backend gaps to close for that: JSON API responses alongside the HTML pages
(same handlers, content-negotiated), pagination on trace/activity lists, and the B1 task list as
a first-class endpoint. No new auth surface, no client-side secrets, same CSP/noindex posture.

## What does NOT block what

- P0.1 blocks only A3 and live multi-user sign-in; all other P1 slices proceed.
- P0.2 blocks alpha-tester code emails only; WhatsApp channel (A2) is independent of email.
- P0.3 blocks nothing lane-side; W5 (proactive templates) waits on it, W1-W4 don't.
- B-slices never block alpha; B2 starts only after the approval desk has live money-adjacent
  mileage (S6 + gmail send rail).

## Harness notes mined today (primary sources)

- OpenClaw standing orders: program = scope + triggers + approval gates + escalation, kept in
  auto-injected workspace files so every session loads them (docs.openclaw.ai/automation).
  Waldo's typed version: standing_orders rows -> context composer -> scheduler enforcement.
- Pi (pi.dev): minimal harness with extension/skill/theme packages via npm/git, RPC + SDK modes,
  tree-structured branchable session history, model switching mid-session. Takeaways for Waldo:
  extension packaging format later (B8); session-tree idea maps onto our episode store for
  "branch from here" debugging of agent runs.
- Hermes (per CAPABILITY_INVENTORY): three plugin types, 40+ toolsets, voice stack.
