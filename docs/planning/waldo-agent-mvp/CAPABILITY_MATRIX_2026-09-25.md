# Capability matrix - Waldo vs Instinct vs Hermes vs OpenClaw (2026-09-25)

Owner ask (10:34): full capability matrix, what's missing in Waldo, how to build each gap
production-grade, shopping specced India-first but portable (US/Japan/SEA), 1Password as vault
picker vs the build-over-Notte vault spec (9ea2ddb), harness pillars others have that we lack.
"Armis" confirmed = Hermes. Sources primary, URLs inline. Instinct column = capability surface
relayed by main (public, user-legible; no internals).

## 1. The matrix

| Capability | Waldo today | Instinct | Hermes | OpenClaw |
|---|---|---|---|---|
| Messaging channels | Telegram (live); WhatsApp specced (3c271e7); console web | iMessage, WhatsApp, Slack, voice, email | Telegram, WhatsApp, Slack, Discord + more via toolsets | 20+ incl iMessage, WhatsApp, Signal, Matrix, Teams, Zalo, LINE, IRC |
| Email/calendar/files integrations | Google calendar read + draft email (live); gmail send banned pending approval rail | Gmail/Calendar/Drive/Slack/Linear/Notion/GitHub read+write | broad via MCP toolsets | via plugins/MCP |
| Browser automation | Browserbase arc (browse_page/act) with egress guard | browser w/ persistent sign-ins | yes | yes (nodes + browser) |
| Voice in/out | STT via smallest.ai (telegram voice notes); no TTS | voice notes + TTS | transcription + ~10 TTS providers | voice via companion nodes |
| Vision input | typed (LLMAttachment) but no channel wires it | yes | yes | yes (camera/screen nodes) |
| Proactive loop | yes - scheduler, day cards, loops, proactivity setting (CORE, live) | standing monitors + event subscriptions + scheduled reminders | scheduled tasks | cron jobs, heartbeats, standing orders, task flow, webhooks, Gmail PubSub/IMAP triggers |
| Memory | episodes, spots, constellation, correctable memory, nightly consolidation (live) | memory filesystem + observation DB | memory (file-based) | memory + sessions in Gateway |
| Approvals/consent rail | approval desk + undo + consent tickets (live) | review-before-send as default | approval patterns via plugins | pairing approvals for unknown senders |
| Secrets custody | Supabase Vault + connector proxy; fill-only vault spec'd (9ea2ddb) | vault-held card, vault links, never in chat | env/config | on-host config; sandboxing guide |
| Multi-user | invite gate + per-owner DOs + identity isolation (today) | per-user agents + i2i coordination | multi-user deployments | one Gateway, personal or shared team deploy; access groups |
| Extensibility | contract-typed tools, scenarios; NO plugin system | skills (platform + personal) | 3 plugin types + toolsets + MCP | plugin SDK + ClawHub marketplace + skills |
| Harness/verification | L1 scenario harness + pinned gates + bug log + pgTAP (nobody else has this) | wake triggers gate fires (condition-checked) | evals culture at Nous | QA channel plugin for deterministic scenarios |
| Real-world actions | none live (no shopping/food/rides/travel) | shopping+checkout, food, rideshare, restaurant, flights incl check-in/boarding passes | via MCP connectors | via plugins |
| Subagents/orchestration | no | main + task agents | subagent delegation | background tasks + multi-agent routing + Task Flow |

## 2. Harness pillars others have that Waldo lacks

1. **Standing orders** (OpenClaw): permanent owner-authorized operating programs ("always do X
   when Y"). Waldo has earned-trust grants in memory but no typed surface. Build: a
   standing_orders table + console section + a hook that matches events against orders. Attach
   to the existing scheduler/approvals rail. Alpha-worthy.
2. **Background task tracking** (OpenClaw): long runs as first-class trackable/resumable objects.
   Waldo's scheduler fires one-shots. Build: tasks table + DO-side progress hops in the trace
   book + console list. Medium.
3. **Plugin SDK + marketplace** (OpenClaw ClawHub, Hermes toolsets, Claude plugins): the
   capability-inventory finding stands - wire ONE MCP client handler (call_mcp_tool is already
   typed, no live handler) and connectors become config. Plugin SDK is post-alpha.
4. **Event ingestion breadth** (OpenClaw Gmail PubSub/IMAP triggers): Waldo's loops are
   timer-driven. Build: webhook ingress channel reusing the telegram-webhook shape (auth header,
   route to owner DO). Cheap, high value.
5. **Pairing/unknown-sender gating** (OpenClaw): Waldo's invite gate covers this for alpha.
6. **Multi-agent routing / subagents**: post-alpha; design after MCP client lands.

## 3. 1Password vs the 9ea2ddb vault spec

1Password developer surface (verified 2026-09-25, 1password.dev): service accounts scoped to one
vault (least privilege), secret reference URIs (op://), SDKs + op CLI, per-item usage reports,
and an official AI-agent integration tutorial whose own security notice says "avoid passing
secrets to the model; use short-lived scoped tokens" - 1Password's published position matches our
custody invariant 1 verbatim.

Comparison against the spec's build (Supabase Vault + fill broker over the browser boundary):
- Custody boundary: 9ea2ddb chose build BECAUSE Notte is managed third-party custody failing
  ADR-0075. 1Password is also third-party custody - BUT per-owner, not per-platform: each owner's
  secrets live in THEIR 1Password account under THEIR service account. Waldo-the-platform holds
  nothing. That is arguably stronger than Waldo holding every tenant's secrets, and it flips the
  ADR-0075 analysis: the credential boundary moves to the owner's own vault.
- Picker UX (his ask): 1Password desktop/mobile IS the picker - biometric-gated, already on his
  devices, collection UX problem solved for free. Our spec's console collection UX is unbuilt.
- Broker fit: the 9ea2ddb fill broker is backend-agnostic. op:// refs resolve at fill time
  exactly like {{vault:...}} refs. Same invariants: model sees refs, broker checks origin,
  audit log records fills.
- Costs: per-owner setup friction (needs a 1Password account + service account); op CLI in the
  browser-execution environment; revocation is owner's own 1Password action (good).

RECOMMENDATION: hybrid. Keep Supabase Vault as system-of-record for CONNECTOR tokens (ADR-0075
unchanged - those are platform-minted OAuth secrets). Add 1Password as an optional per-owner
backend for OWNER-ENTERED secrets (logins, cards) via service-account + op:// refs in the fill
broker. This kills the console collection-UX build, gives biometric picker UX, and strengthens
multi-tenant custody. Decision is his: it amends 9ea2ddb's scope, not its invariants.

## 4. Shopping/commerce, India-first and portable

The rail that ports across regions: cart-prep + approval + payment-rail handoff. Waldo never
holds a raw payment instrument in model view (custody invariant); the owner confirms the final
state (cart, address, total) before money moves - same shape as Instinct's vault-card + confirm.

India specifics:
- UPI is the dominant rail and CANNOT be completed autonomously: a UPI collect/intent requires
  the owner's own UPI app authentication. Design for it: agent builds cart, owner gets one
  approval with the UPI intent; payment completes in GPay/PhonePe. This is a FEATURE fit for the
  approval rail, not a limitation.
- COD still matters for a long tail of merchants; address formats are locality+pincode, courier
  norms differ (Bluedart/Delhivery tracking).
- Merchants: Amazon.in/Flipkart/Myntra for retail; Blinkit/Zepto/Instamart for grocery
  (10-min delivery changes the checkout UX - deep links to a pre-built cart beat form-filling).
Portability: US = card checkout via vault fill; Japan = konbini-pay/PayPay handoff (same
owner-completes-payment shape as UPI); SEA = Shopee/Grab with COD/e-wallet mix. The constant is
the handoff; the variable is a per-region payment-rail adapter. Build order: adapter interface +
India UPI adapter first, US card second (proves portability with the smallest second adapter).

Build path for Waldo (production-grade, attaches to existing rails): shopping tools in contracts
(search_cart, prepare_checkout, confirm_order) with PRIVILEGED approval binding on confirm_order
(money = existing approval desk), browser execution via the Browserbase arc with the fill broker
for payment fields, scenario pins for each rail hop, and the honest not-built answer until live.

## 5. Gap -> build map (every gap, production path, priority)

| Gap | Build path | Rail it attaches to | Priority |
|---|---|---|---|
| MCP client handler | one live handler for call_mcp_tool (typed, unwired) behind ACL | contracts + hooks | ALPHA leverage |
| Voice out (TTS) | pick one provider (smallest.ai already wired for STT) | telegram media seam | alpha |
| Vision input | wire LLMAttachment through telegram photos | existing media pipeline | alpha |
| Standing orders | table + console + event matcher | scheduler + approvals | alpha |
| Webhook/event ingress | generic webhook channel | telegram-webhook shape | alpha |
| Background tasks | tasks table + trace hops + console list | scheduler | post-alpha |
| Plugin SDK | after MCP client proves the seam | contracts | post-alpha |
| Subagents | after standing orders + tasks | DO routing | post-alpha |
| Shopping rail | section 4 | approvals + browser + vault | post-alpha |
| Wearable/CRS connector | per VISION_VS_CURRENT - top post-alpha connector | connectors | post-alpha |

Sources: github.com/openclaw/openclaw, docs.openclaw.ai (automation, channels, clawhub),
hermes-agent.nousresearch.com docs (features, tools/toolsets), 1password.dev (ai-agent SDK
tutorial, service accounts, secret references), developers.openai.com/codex,
blog.modelcontextprotocol.io (registry), plus today's repo reads.
