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
