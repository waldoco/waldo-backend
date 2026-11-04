# Brain / hands / files: where Waldo already stands - 2026-09-24

Owner question, after the Vercel Drives announcement: are we already following the agent-decomposition principles (brain = model + harness, hands = tools + computer + browser, files = memories + skills + repos), and should we use Vercel Drives, aside.com, kernel.sh, Browserbase or Cloudflare's browser product?

## Short answer

Yes, Waldo's runtime was built decomposed from day one - the pasted thread describes our architecture, not a gap in it. The one layer Waldo does not have yet is browser/computer "hands", and when that need lands, Cloudflare's Browser Run is the fit. None of the four products he named needs buying today.

## What we already do, mapped to his frame

Brain (model + harness, fluid compute):
- The harness runs on Cloudflare Workers with a per-owner Durable Object. No stateful server, no Mac Mini. Restarts and rollouts are normal life.
- Durable event log: conversation state is an event-sourced tree (ConversationTree, persisted per turn, restored on wake), and provider calls are durably keyed with idempotency and reconciliation (RunLoopDO writes the intent before any I/O; a retry reconciles instead of double-spending). That is the property Vercel gets via Workflow; we have it in the DO.

Files (decoupled storage):
- Durable state lives outside the compute: Supabase Postgres + Vault (tokens, connections, settings), DO sqlite for hot per-owner state. Nightly memory consolidation ("dreaming" in his paste) already runs as DO-scheduled work (consolidate/promote) with no machine to boot and no disk to mount.
- The one stateful-computer dependency we DO have is the build loop (codespace + his Mac). That is developer tooling, not product infrastructure. Worth saying to him plainly so the analogy doesn't land in the wrong place.

Security/auditability (his "you can't run a secure agent otherwise"):
- The token custody hard line is exactly this principle: connector-proxy is the only code that touches OAuth tokens; the model, DO and Worker never see one. Plus the sanitiser/scribe layer, hooks, canaries, and a routing-policy gateway on every model call.

## The actual gap: hands

Waldo has no browser or computer-use tools today (tools are Google calendar/mail, web search, reminders, loops). Nothing in the current queue requires them. When a need lands (bookings, web tasks with logins):

| Option | Fit for Waldo | Cost |
|---|---|---|
| Cloudflare Browser Run | Native Workers binding, same vendor as the runtime, sessions driven over CDP/Puppeteer/Playwright. Dev covered by free tier (10 min/day). | $0.09/browser hour + $2/concurrent browser |
| Kernel | Fast boot (<30ms), per-second metering, standby mode. Strong, but a new vendor for features we don't need yet. | about $0.06/GB-hour, metered per second |
| Browserbase | Mature fleet, stealth, proxies, compliance. Aimed at scaled scraping/agent fleets; overkill at owner + invitees. | $20/mo entry, then $0.12/browser hr |
| Aside | An end-user AI browser product, not infrastructure. Not a dependency option; at most a reference. | n/a |
| Vercel Drives | Solves sandbox-attached disks. Waldo's durable storage is Supabase + DO, so there is nothing to mount. | n/a |

## Recommendations

1. Do nothing now: no purchase, no migration. The decomposition principles are already how Waldo is built.
2. When a browser-hands need lands, start with Cloudflare Browser Run (same vendor, free tier covers development, pennies at our scale). Re-evaluate Kernel only if stealth or fleet features become real requirements.
3. Keep the discipline as features land: any future hands layer is its own service with no token access - the connector-proxy line extends to it.
4. Optional hygiene, his call: de-risk the build loop's dependence on his Mac (a second build host or CI), so "the agent runs without a stateful computer" is also true of how we build it.

## Sources

- Vercel Drives beta: https://vercel.com/changelog/drives-for-vercel-sandbox-are-now-in-public-beta and https://vercel.com/docs/sandbox/pricing
- Cloudflare Browser Run: https://developers.cloudflare.com/browser-run/pricing/ and https://www.cloudflare.com/pricing.md
- Kernel: https://kernel.sh/docs/info/pricing and https://www.kernel.sh/ai-library/kernel-vs-browserbase-2026
- Browserbase: https://browserbase.com/pricing/ and https://docs.browserbase.com/account/billing/plans
- Aside: https://aside.com/ and https://docs.aside.com/help/get-started

## Owner decisions (24 September 2026)

- Browser: Cloudflare Browser Run confirmed for initial development when browser capabilities land. Kernel and Browserbase stay on the shelf unless a fleet need appears.
- Git author on the build Mac stays as-is.

## Consumer compute: Kennel as the consumer hands/computer tier

The dev build loop (codespace + the owner's Mac) is dev tooling. It cannot be the consumer answer: no consumer ships their agent a Mac. The owner's proposal is Kennel (waldoco/Waldo-Kennel), and the K0 source map (docs/planning/waldo-agent-mvp/KENNEL_K0_SOURCE_MAP.md) supports it.

How Kennel slots into brain/hands/files:

- Brain stays put: Workers + per-owner DO, event-sourced, no change.
- Files stay put: Supabase Postgres + Vault outside the compute.
- Kennel is the consumer computer: a daemon on the user's own machine that takes outcomes through intake with planning approval, binds an approved worker on launch, runs Codex sessions with persistent conversation identity and resume, and returns receipt-bound artifacts and diffs. Command admission is separate from ingress, persisted claims dedupe, and material commands are rejected without approval.

Token hard line: preserved by construction. connector-proxy remains the only code that touches Waldo-side tokens. Kennel executes with the consumer's own local CLIs and provider accounts; Waldo tokens never reach the device. The one gap the K0 audit found is the cloud-to-daemon relay: K0's answer is a narrow device-initiated authenticated bridge (no inbound ports on the consumer machine), durable task/outcome mapping, replay-safe progress transport. That design is the right shape; it is specified, not yet proven.

Alternatives, honestly:

- Cloud computer per consumer (Vercel Sandbox + Drives, or Cloudflare containers): real product, but cost scales per consumer, the consumer's data leaves their device, and we would still need the governed-executor story Kennel already has. Fine for dev, weak for consumer privacy and unit cost.
- Browser-only via Browser Run: covers web tasks, not local files, apps, or dev work. Complementary to Kennel, not a replacement.
- Kennel: near-zero marginal infra per consumer, data stays on the device, and the governance seams already exist in source. Costs: distribution, updates, and support burden for a desktop daemon, and the K0 proof has not run yet.

Recommendation: yes, Kennel is the consumer tier. Sequence it honestly: run the K0 proof scenario first (one owner-approved bounded task, one Codex session, a small real change, prescribed check, artifact/diff/test evidence returned), then the Claude adapter separately. Do not promise consumer compute before that proof lands.
