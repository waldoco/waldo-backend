# Build plan - 2026-09-25 (post capability-matrix)

Where every approved piece fits. Approvals from the owner's 10:41 IST message: 1Password hybrid,
harness pillars from OpenClaw/Pi/Hermes (standing orders, background tasks, webhook ingress,
events scheduling), real-world actions planned as real capabilities (shopping India-first),
production-grade web console/dashboard backed end-to-end by the backend, health/productivity
incentive folded into the commerce loop.

Steering from his 11:13 IST message (verbatim in lane context): voice-out moves OUT of alpha to
post-alpha; background task tracking moves INTO alpha; meal tracking (priority) + workouts join
alpha explicitly to feed the proactive loop and the shopping integration.

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
| A5 | Background task tracking (tasks table, trace hops, console list) + typed artifact store (DO SQLite metadata + R2 bodies, provenance/taint, read-on-demand - the audit's workspace answer; owner 11:44: BUILT in alpha, not specced) + Workflows evaluation for durable runs | owner moved it into alpha 11:13 and reaffirmed 11:44 | none |
| A6 | Vision input wiring (LLMAttachment typed, no channel uses it) | telegram photos -> model; also the meal-photo path | none |
| A7 | Standing orders (typed): scope/trigger/gate/escalation rows, injected via context composer, enforced by scheduler | owner-approved; OpenClaw pattern mined (auto-injected AGENTS.md programs) | scheduler + approvals (exist) |
| A8 | Generic webhook/event ingress channel | mirrors telegram-webhook shape; event-driven beats polling; evaluate a Queue buffer per Cloudflare's event pattern (audit) | none |
| A9 | Meal + workout logging (meals first) | owner added 11:13: feeds the proactive loop and shopping | none; photo logging uses A6 later |
| O1 | Observability: Langfuse full-run tracing fix (wrap the whole agent run, nest tool calls, capture inputs/outputs with scrubbing intact) + logging DX pass + CF Workers observability settings | owner 11:45: trace previews unusable = alpha debugging degraded; rides the tracing todo | none |
| V1 | Vector recall leg: Cloudflare Vectorize index + Workers AI embeddings as a recall RANKER over the FTS/hall recall set (not a redesign; typed rows stay the source of truth) | owner 11:44 folds the audit's vector gap into alpha: paraphrase recall degrades agent work quality | needs Vectorize + Workers AI binding in the staging deploy packet (P0.1 v3) |

### Fold-in decisions (owner 11:44 + 11:45)

The CLOUDFLARE_ADAPTATION_AUDIT deferrals, re-filtered against his bar ("small things can degrade
the entire experience and the agent's ability to perform the work"):

- Artifact store -> alpha, built inside A5 (was already folded; now confirmed build-not-spec).
- Vector leg -> alpha as V1 (recall ranker over existing FTS/hall recall; typed rows remain truth).
- Langfuse tracing fix + logging DX -> alpha as O1, placed BEFORE A5: it instruments every later
  slice and the A3 live proof. Cost: one lane session + one staging redeploy line.
- A8's Queue buffer evaluation -> stays an evaluation inside A8, now bias-to-adopt if the wrapper
  is thin (Queues are the CF-native event buffer; the evaluation decides, honest cost recorded).
- STAYS post-alpha, with the reason: B1 voice-out (text + cards carry alpha conversations);
  Cloudflare Browser Rendering swap (Browserbase covers browse/cart-prep today; custody + cost
  review not an experience gap); CF Workflows ADOPTION (evaluated in A5, adopted only if durable
  long runs need more than our DO-alarm Scheduler).

## P2 - post-alpha (ordered)

| # | Slice | Notes |
|---|---|---|
| B1 | Voice-out (TTS via smallest.ai, already the STT provider) | owner moved it post-alpha 11:13; text + cards carry alpha |
| B2 | Shopping rail: adapter interface + India UPI adapter (cart-prep -> approval with UPI intent -> owner completes in GPay/PhonePe) | CAPABILITY_MATRIX section 4; money rides the approval desk + fill broker; cart content reads A9 meal/staples history |
| B3 | US card adapter (proves portability cheaply), then JP (konbini/PayPay) and SEA (e-wallet/COD) | same owner-completes-payment shape |
| B4 | Food ordering, rideshare, restaurant, flights (incl check-in/boarding passes) | each = adapter on the B2 rail + browser arc |
| B5 | Health-incentive commerce loop: CRS-aware nudging on grocery/food orders (suggest the better cart, not a lecture) | differentiator; copy discipline per "not a health app" warning - incentive framing, no diagnosis; reads A9 |
| B6 | Wearable/CRS connector (Oura/Apple Health first) | the vision doc's missing READ half; top post-alpha connector |
| B7 | 1Password fill-broker backend (op:// refs via op CLI at fill time) | VAULT_SPEC amendment (owner-approved today) |
| B8 | Plugin SDK (after MCP client proves the seam); subagents/multi-agent (after standing orders + tasks) | OpenClaw ClawHub + Hermes toolsets are the references |
| B9 | Dashboard v2: production web console/dashboard | see below |

## Meal + workout logging spec (A9 - his 11:13 ask, meals are the priority)

Data model: one table `waldo.health_logs` (owner_id, kind 'meal' | 'workout', logged_at, source
channel, payload jsonb). Meal payload: free-text description, optional item list, approximate
calories when the model can infer them honestly (stored as an estimate, never presented as
measured). Workout payload: type, duration, notes. Migration + pgTAP + canonical lists per the
standing rule. This is health-adjacent data: same custody posture as CRS - lives in the per-owner
DO/Postgres path, never leaves except to the owner, and the "not a health app" framing stands
(log and nudge, never diagnose).

Ingestion paths, in order: (1) chat free-text on every channel - "log lunch: dal, rice, paneer"
-> agent calls a `log_meal` / `log_workout` tool (same permissions class as set_reminder:
user_message + proactive triggers can READ but only owner-confirmed turns write); (2) console
quick-add on the dashboard (backend-handled like every other console action); (3) photo logging
lands with A6 - Telegram/WhatsApp photo -> vision parse -> confirm card -> log.

How it feeds the loops: recent meals join the context the proactive beats already read (morning
wag / evening close can reference eating patterns without new plumbing); the B2 grocery cart
reads meal + staples history to propose the refill cart; B5's nudging reads the same rows. So A9
is the data foundation B2/B5 consume - it must land before them, which the ordering reflects.
Slice-order ripple: none inside P1 (A9 depends on nothing); B2 and B5 now list A9 as a dependency.

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
  mileage (S6 + gmail send rail) and A9 exists (the cart reads meal history).
- Voice-out (B1) blocks nothing; WhatsApp alpha works text-first. Photo meal logging is the only
  A9 sub-feature with an internal dependency (A6).

## Harness notes mined today (primary sources)

- OpenClaw standing orders: program = scope + triggers + approval gates + escalation, kept in
  auto-injected workspace files so every session loads them (docs.openclaw.ai/automation).
  Waldo's typed version: standing_orders rows -> context composer -> scheduler enforcement.
- Pi (pi.dev): minimal harness with extension/skill/theme packages via npm/git, RPC + SDK modes,
  tree-structured branchable session history, model switching mid-session. Takeaways for Waldo:
  extension packaging format later (B8); session-tree idea maps onto our episode store for
  "branch from here" debugging of agent runs.
- Hermes (per CAPABILITY_INVENTORY): three plugin types, 40+ toolsets, voice stack.

## 2026-09-29 addendum: multi-owner observability, evaluation and cost

This is a forward plan, not a claim that these controls are deployed. Track A's public-web
connection-level boundary and negative-case live proof stay ahead of readiness claims. The
owner-parametric Langfuse exporter and DO trace table exist; a consented second-owner turn
has not yet proven isolation, export and queryability end to end.

1. **Multi-owner acceptance and safety:** use a consented second account to prove onboarding,
   route to its own DO, owner-keyed browser/connector state, a denied cross-owner read and
   action, trace attribution and failure lookup. Do not mark cohort-ready based on a code
   path or a founder-only probe. Keep regression cases for wrong-owner and private-network
   requests in exact-head CI and staged live probes.
2. **Correlated, privacy-gated telemetry:** propagate one request/turn/run correlation ID and
   server-verified owner identity across ingress, DO, LLM, tool/connector, browser/proxy,
   provider send and receipts. Capture typed outcome/error, duration, retry/idempotency,
   release and prompt version, plus export failures. Define per-surface coverage and alert
   on missing traces, elevated denials or failed exports. Cloudflare invocation logging and
   tracing remain off until sensitive request URLs are reviewed; never blanket-enable text
   capture to solve a debugging gap. Stage a sampled, privacy-tested trace rollout separately.
3. **Evaluation flywheel:** pin each escaped live failure into a replay dataset; score checked
   sources, outcome success, truthful capability, owner isolation and effect safety. Compare
   exact-head releases against a baseline in CI, with human-reviewed sampled live scores and
   owner feedback. Roll back when a release regresses rather than relying on a green unit suite.
4. **Per-owner cost ledger and dashboard:** persist an immutable owner-scoped usage event per
   model/provider call (trace/run ID, time, provider request ID, model, input/cached/output
   tokens, optional reasoning, price-version and tier, estimated USD, pricing status). Aggregate
   per day/feature/model with explicit unpriced counts and provider-bill reconciliation. Show
   estimates, not invoices. The existing 500-row DO trace ring and flat one-model price table
   are insufficient for durable per-owner economics; the current long-context tier is missing.
   Use Langfuse's user-filtered metrics for trace diagnosis, not as a replacement owner ledger.
5. **Voice versions:** manage editable persona text by Langfuse labels with trace-linked version,
   stable per-owner beta variants, tested local fallback and rollback. Keep hard safety/effect
   rules in code. Conformance tests should tie tool manifest, ACL, schema and handlers together.

Primary design sources: [Langfuse evaluation](https://langfuse.com/docs/evaluation/overview),
[Langfuse cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking),
[Langfuse metrics API](https://langfuse.com/docs/metrics/features/metrics-api),
[Cloudflare Workers observability](https://developers.cloudflare.com/workers/observability/),
[Cloudflare traces](https://developers.cloudflare.com/workers/observability/traces/),
[OWASP multi-tenant security](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html).

## 2026-09-29 addendum: trust-calibrated product and test sequence

The owner's September 29 strategy pack and voice direction set the product target: Waldo should carry meaningful work across the person's health (optional), life and work without carelessly spending attention, money or private context. The [trust/calibration research](TRUST_AND_CALIBRATION_LEARNINGS_2026-09-29.md) and the original owner-authored 36-case `Waldo_Benchmark_Cases_v2.jsonl` (SHA256 `fc651ed0e02bf53d3875d2497637f9f9309db794b6ce02386227a04b7155211f`) are design inputs, not shipped behavior or test results. The original 84-scenario Whole-Person Atlas supplies the ecosystem loop: desired outcome, context, trigger, next step, permission, action/handoff, evidence and follow-through. Atlas v2's W01–W24 and R25–R36 are all `not_run`; the earlier extraction is lossy and must not be the fixture source. Core/Bridge/Expansion/Future are illustrative, not release promises.

### Current-seam inventory before changing policy

- The [accepted product plan](../WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md) explicitly keeps accepted security invariants and wire contracts binding until amendment. [Implementation contracts](IMPLEMENTATION_CONTRACTS.md) call for purpose-scoped, frozen per-turn capability manifests, owner/resource/effect-bound connector operations, data-class model egress policy, exact approval and source-of-record reconciliation. Do not mistake those written contracts for deployed proof.
- The current Telegram responder's `telegramOwnerApproval` lets first-party state changes proceed and halts `execute_action` and delete/restore. Send-message, Gmail-send, MCP and browser-submit paths make proposals through the approval desk rather than executing directly. This supports useful preparation but does not prove every authorization, recipient, race or idempotency branch in live use. Improve the scoped permission path and positive-control capability; do not make outside effects automatic by deleting the gate.
- The existing L1 `scenario-harness.test.ts` runs scripted model rounds over in-memory SQLite, connector stubs and hop assertions. It does not provide independent model-answer scoring, two-owner persistent resets, timed source changes, intercepted sends/charges or real Telegram ingress. Its separate Vitest config is included by repository `verify`, but a green unit run is not a W/R benchmark pass.
- [Public-web boundary](PUBLIC_WEB_READ_BOUNDARY_2026-09-29.md): #354 only wires an optional Stagehand proxy parameter; at this writing the PR is open, one runtime shard failed, and the six-host read ceiling and Posterbot failure remain. A checked URL and optional proxy setting are not connection-path enforcement. Do not lift the ceiling until redirect, DNS rebinding, subresource and bypass negatives, staging receipt and successful Posterbot page-reading turn are proved.

### Ordered slices and review gates

1. **Capability and permission map.** For each W/R case, identify the real current surface, required source, tool and effect class, expected useful outcome, protected data, source of approval, cost to undo and readback. Label missing tools `unsupported`; do not convert fixture permission prose into a live grant. Preserve destination-scoped disclosures, review of final recipient plus words for a send, and a fresh checked total/final state for wallet-bearing effects. First-party memory/tasks can be low-friction within authenticated scope; external sharing, irreversible effects, money and changed terms need their own evidence. A standing grant must be explicit, revocable and scoped, not inferred from repeated behavior.
2. **Useful narrow tool paths.** Complete the existing day-plan/follow-up loop before a connector catalog: source-backed research, correctly scoped retrieval, correction of pending plans, draft/review/send only on the authorized route, provider receipt, monitored follow-through and a truthful stop. Build no-health positive controls (W23), correction after queued work (W21), offline handoff status (W17) and stop/revoke (W24). Kennel receives only a bounded, redacted execution packet and returns a verified result. Ambient capture is selective, inspectable, revocable and measured for value against exposure/review burden. Health stays optional, non-diagnostic and private.
3. **Network and trust boundaries.** Keep public-page read apart from browser action and provider effects; gate the former on connection-level egress proof. Negative tests include external instructions requesting extra retrieval, wrong-owner or wrong-recipient substitutions, stale source, unknown refund terms, provider timeout, repeated callback, human-assist disclosure and conflicting provenance (R25/R26/R30/R34/R35). Record provider-side final state, not a model's assertion. Any proposal that reduces an existing security property needs a separate explicit ADR: name the old protection, proposed new behavior, owner/user benefit, counterexample, compensating controls, migration/rollback and tests. Flag it to the owner before merge. A general voice request to update guardrails is not approval of a specific weakening.
4. **Isolated runner before scores.** Start with the 16-case v1.1 holdout plus nine-case capability overlay and original W/R development cases, keeping an unseen release holdout separate. Build fake mail/calendar/files/web and provider adapters with two owner stores, controllable clock/source revisions, model input separated from oracle, intercepted outbox/charge log, reset per trial and an ingress path that exercises the real Telegram turn. Run both negative and positive permission branches. Pin exact SHA, model, fixture hashes, source snapshot, tool trace, final answer and authoritative state. Report `pass`, `fail`, `blocked`, `unsupported` and `not_attempted` distinctly; three independent repetitions yield pass@1 and all-three reliability. Do not aggregate away any sensitive leak, unapproved send or charge. A correct ask/wait/stop/no-buy passes only when it is the useful authorized outcome; blanket refusal fails when a permitted path remains.
5. **Failure-to-fix loop.** Run a small case family once adapters exist, record every failure's source and authorization trace, fix the narrowest defect, rerun unchanged cases and adversarial neighbors, then widen to W01–W24/R25–R36. A test specification or scripted L1 run is never a scored real-ingress result. Report verified usefulness, constraint fidelity, continuity, growth, conscious spending, calm proactivity and operational quality separately in a pilot; the proposed 12-person/four-week pilot is a learning design, not proof of benefit.

No change in this addendum grants a real send, purchase, share, broader model-data egress, unguarded network read or production release. This is a sequencing and test record; implementation and ADR changes require their own reviewed diffs and exact-head, staged proof.
