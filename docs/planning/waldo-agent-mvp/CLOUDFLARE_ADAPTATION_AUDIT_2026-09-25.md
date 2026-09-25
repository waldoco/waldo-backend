# Cloudflare adaptation audit - 2026-09-25

Owner question (11:33/11:35): without a workspace layer does the agent generalize properly, how
does Cloudflare's own agent platform (Project Think / Agents SDK) approach this, do we need
Cloudflare browser/computer-use, and is our current system properly adapted to the platform?

Sources: developers.cloudflare.com/agents/ (Agents platform overview, updated Jun 2026) and
/agents/harnesses/think/ (Project Think harness reference), fetched live this run.

## Per-primitive verdict

| Primitive | What Cloudflare recommends | What Waldo does | Verdict |
|---|---|---|---|
| Durable Objects | Agent class per session/user: durable identity, local SQLite, scheduling, recoverable execution | Per-owner TelegramOwnerDO with its own SQLite (memory halls, approval ledger, scheduler, traces) | PROPERLY ADAPTED - same flagship pattern, arrived at independently |
| Harness | Project Think: opinionated loop (tools, persistence, streaming, workspace file tools, approvals, sub-agent RPC) | Own harness: typed tool contracts, ACL per trigger, L1 scenario tests, approval desk | ADAPTED, divergent by choice - Think's approvals are per-tool-call UI; ours are payload-bound ledger entries (stronger). Think is inspired by Pi, same reference we mined |
| Memory/retrieval | DO SQLite + Vectorize for semantic; AI Search product | DO SQLite halls (trust/taint typed) + FTS5 episodes; no vector leg | PARTIAL GAP - the known vector gap; Vectorize is the platform-native slot-in when we schedule it (post-alpha) |
| Workspace/files | Think ships workspace file tools (agent scratch files) | No agent scratch layer. Episodes (searchable history), files channel (owner documents), R2 skill playbooks | REAL GAP, moderate - see below |
| Browser/computer-use | Browser Rendering + Sandbox (code exec) as tools | Browserbase for browse_page/browse_act (live); execute_code typed but dispatchable nowhere (ADR-0050) | ADAPTED for alpha - current path covers shopping cart-prep, console, browsing arcs. CF Browser Rendering is a candidate swap post-alpha (cost/latency/cookie custody), not a need |
| Queues | Queue buffers in front of event consumers | Webhook -> waitUntil -> DO direct | MINOR - A8 (webhook/event ingress) should evaluate a Queue buffer; note added to that slice |
| Scheduling/workflows | Agents SDK scheduling + Workflows for durable multi-step runs | Own Scheduler on DO alarms | ADAPTED for alpha - A5 background task tracking should evaluate Workflows for long durable runs; note added |
| Observability | Workers traces / Agents dashboard view | Langfuse OTLP + per-owner trace book | ADAPTED (deliberate external choice) |

## The workspace question, honestly

What a workspace layer buys: scratch state the agent iterates on across steps and sessions
(half-built documents, research notes, extracted data), file-shaped working memory the model can
re-read cheaply, and artifacts a long task produces along the way.

What we already have: episodes cover "what happened" (searchable), halls cover "what is true"
(typed, trusted), R2 playbooks cover "how to do X" (skills), the files channel covers owner
documents. What none of those cover: "what I'm in the middle of making" - the agent's own
working artifacts. That is where generalization genuinely suffers without a workspace: multi-step
tasks that span turns (a research brief built over an hour, a shopping shortlist refined across
messages) today have to live in conversation text or be regenerated.

Typed-version proposal (fits the posture): an artifact store, not loose markdown - DO SQLite
metadata (name, kind, provenance, taint, revision) with bodies in R2, addressed by trace id,
exposed through typed read/write tools in the same permission classes as other writes. It lands
naturally WITH A5 (background task tracking): a long run's working set and its task row are the
same lifecycle. Added to A5's scope note in the build plan. A freeform always-injected notes file
stays rejected for the injection reasons already recorded; artifacts are read on demand, never
auto-injected.

## Plan changes from this audit

1. A5 (background tasks) gains: artifact store per above + evaluate Workflows for durable runs.
2. A8 (webhook ingress) gains: evaluate a Queue buffer per CF's event-consumption pattern.
3. Vector leg: confirmed Vectorize as the platform-native implementation when scheduled
   (post-alpha; already the recorded gap).
4. No alpha blocker anywhere in this audit. No vendor swap needed: Browserbase stays for alpha.
