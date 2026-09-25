# Waldo vs Meta Muse - Benchmark (2026-09-25)

Owner ask (12:20): study Meta's Muse security/safety post in detail; are we on par, where do
we exceed/trail, capability metrics, and our special advantages (ownership of memory and
intelligence, portable anywhere, vs Meta's ecosystem lock-in) + the Kennel angle.
Sources: research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse
(fetched live, full text), Muse app screenshots (Artifacts library + System Files browser),
x.com/dps/status/2103161493722419334 (fetched via syndication, verbatim). Honest, no marketing.

## What Muse is (facts, from their post)

Per-user dedicated cloud VM; agent harness in a systemd-nspawn "runtime cell"; safety services
outside the cell (hatch-safety classifiers, privsep connector workers, authd credential store,
Sentinel as sole permission authority for connector actions + all network egress with L4/L7
SSRF checks); surrogate tokens swapped for real credentials at the network boundary (the agent
never sees secrets); kernel-level taint tracking decides auto-allow vs ask; HITL approvals are
strict capabilities (one-time/session/task/time-bounded/perpetual, exact-scope match); email
connector filters OTPs/password-reset/magic links; browser sub-agent sees only the
accessibility tree, no JS exec, user takeover pauses the agent; purchases use single-use
merchant-locked amount-limited cards with HITL every time; $300k bug bounty; Confidential VM
(cryptographic Meta-can't-see) announced for later this year. Trajectories ARE used for model
training by default (opt-out switch).

## Security: on par / exceed / trail (verified against our code)

ON PAR (same principle, different primitive):
- Never show credentials to the model: our custody hard line (no bearer/refresh token reaches
  model, DO, or Worker; vault fill-only broker) = their authd surrogation.
- Deterministic boundaries under the model: our ACL ceiling + fail-closed dispatcher +
  egress-guarded caller = their Sentinel egress + privsep, minus their kernel enforcement.
- Approval binding: our payload-bound ledger entries (sha256 digest of canonical bytes, tamper
  fails closed, replay-verbatim) = their capability-bound approvals. Their grant taxonomy
  (session/task/time-bounded) is richer - ADOPT for A7 standing orders.
- Taint: our source_taint classes through memory/recall/tool outputs = their kernel taint,
  at the content layer instead of the network layer.

EXCEED:
- Training: they train on trajectories by default; Waldo never trains on owner data. State it.
- Portability/lock-in: Muse memories live in a Meta VM (inspectable, downloadable - good) but
  the agent itself is Meta's model + Meta infra + Meta ecosystem connectors. Waldo's memory is
  typed rows the owner can export, model-agnostic harness, channels the owner already uses.
  "Your intelligence, carryable" is real and they can't match it without cannibalizing lock-in.
- Money custody: they hold payment rails (wallet, single-use cards); our B2 flow never takes
  card custody (UPI intent, owner completes in their own app). Simpler trust story for India.

TRAIL (honest):
- Email ingress hygiene: they filter OTPs/password resets/magic links from agent-visible mail.
  WE DO NOT - our gmail read path surfaces everything. ADOPT: deterministic filter + classifier
  on the gmail read/ingress path before alpha testers connect real inboxes. Highest-value gap.
- Isolation depth: nspawn cell + eBPF + seccomp vs our DO/Worker sandbox. Theirs survives a
  fully rogue agent with kernel enforcement; ours relies on toolchain discipline. Acceptable
  for alpha (single-owner, gated effects), not a forever answer.
- Browser guardrails: a11y-tree-only, no-JS, takeover-pause vs our Browserbase sessions.
  ADOPT the a11y-tree + pause-on-takeover rules when browser work deepens (post-alpha swap
  evaluation already recorded).
- Red teaming/evals program + bug bounty: we have adversarial-test discipline per bug but no
  standing eval suite for injection resistance. PLAN: an injection canary eval set (we have
  canary tokens already - wire them into a recurring scenario pack).

## Capability benchmark (from their post + the app screenshots)

Muse ships: background work + subagent swarms, self-written tools/skills, cron, real computer
(compile code), browser with takeover, purchases, connectors + self-authored connectors,
Artifacts library (user-facing things the agent made: Meal Tracker, Calendar Hero, Portfolio,
recipes, family games), System Files browser (raw runtime-cell tree).

Waldo alpha mapping: background tasks + artifact store (A5) ~= their artifacts; standing
orders (A7) ~= their crons; MCP client (A4) ~= self-authored connectors via config; browse
(Browserbase) ~= their browser minus takeover; meal logging (A9) - note their flagship
artifact is literally "Meal Tracker", validating A9's priority; console = our System Files
answer, trust-first (below). NOT in alpha: code execution (ADR-0050, deliberately), subagent
swarms, purchases.

## The transparency surface (his 12:22 idea, now specced)

Muse's System Files tree exists BECAUSE secrets live outside the runtime cell (dps's post
confirms this is the design reason). Ours should be a TRUST surface, not a folder dump -
console section "Your Waldo", riding existing endpoints:
- What Waldo knows: memory halls browsable by hall with trust/taint badges (read-only views
  over the existing recall queries).
- What Waldo can touch: connected services with scopes (existing accounts/health endpoints),
  standing orders (A7 rows), tool ACL ceiling rendered human-readable.
- What Waldo did: the approval ledger (exists) + recent access log (trace hops exist).
- What Waldo is making: artifact store list (A5) - our Artifacts answer.
Every row owner-deletable/correctable. This is the surface locked-ecosystem players cannot
honestly offer; dps's post is the proof the transparency itself is marketable.

## Kennel angle (his new direction)

- Apple accessibility capture -> understanding what the user is doing/working on -> memory
  layer over it: maps to our halls + episodes as a new ingest source (taint: device-observed,
  owner-owned). Pairs with the artifact store (Kennel sessions produce working artifacts).
- Kennel's original job - orchestrating the user's existing coding agents on an open
  standard: MCP is the standard (A4 client shipped today; Kennel as MCP SERVER exposing
  coding-agent orchestration is the symmetric move - Waldo calls Kennel through the same
  call_mcp_tool rail). Post-alpha, but the standard is now load-bearing in both directions.

## Compared against

Meta's Muse security post (full text, live), dps X post (verbatim via syndication), Muse app
screenshots (owner-provided), our current code (verified per claim). dps full-activity review:
only the one post fetched so far; a full timeline needs a logged-in browser session - flagged
as follow-up, not guessed.
