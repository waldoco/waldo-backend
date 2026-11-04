# Public-web read boundary

29 September 2026. This is an implementation decision and acceptance plan, not a claim that the browser is now open or safe for arbitrary public URLs.

## Owner decision and live failure

Shivansh chose public-web reads rather than a growing host list in his 12:56 IST WhatsApp voice reply to the two-route question. The exact user turn is `wamid.HBgMOTE3NTU4NjU5OTMxFQIAEhggQUNBREZCQ0JCMzI5NTE3Qjk0MDM3RDFDNEZCQTY1RUUA`. The effect, credential and owner-isolation boundaries remain separate. The 12:51 owner-only Posterbot turn on staging release `dfa85cf` (Langfuse trace `tg-904957792`) searched for Cloudflare Workers documentation, then `browse_page` failed `forbidden:egress_denied` before Browserbase navigation. Waldo truthfully said it could not open the page. `wrangler.jsonc` staging has six named hosts, not `developers.cloudflare.com`. Cloudflare Observability listed 51 successful events and zero errors in the last-hour overview; that did not show this tool denial as a Worker error. The source and health readback do not establish a successful research task.

## Boundary to build

Separate public-page reads from code-execution `allow_hosts` and from approval-bound external effects. Remove the six-host ceiling for browser reads only when the browser's *network path* enforces the safety floor, not merely its typed input:

1. At admission, accept only absolute HTTP(S) URLs without URL credentials. Reject local aliases, numeric/private/link-local/reserved addresses, cloud metadata names and unsupported schemes. Continue exact owner and tool authorization checks. Do not use the old list as a disguised general-web limit.
2. Send browser traffic through a controlled egress proxy or another provider path that can block at the actual connection. Resolve each hostname there, reject every non-global address, bind the request to the checked destination to prevent DNS rebinding, and repeat the check for each redirect and resource request. No proxy bypass or direct-browser route. If this route cannot be verified end to end, fail closed and say the page is unreadable.
3. After navigation, record actual URL, response status and the read page source. Extraction remains tainted external data. A successful page load is not evidence that an effect happened. The model may summarize the read page and cite its observed URL; no page text changes instructions or permission.
4. Keep browsing spend/time quotas and a per-owner/session trace. Do not log credentials, cookies, full page bodies or secret URLs in general-purpose event logs.

The present Stagehand hosted API calls `sessions/start -> navigate -> extract -> end`. Waldo's egress hook only inspects the supplied URL. It does not observe DNS resolution or intermediary redirects. Do **not** replace the host check with a string-only public-IP check and label it SSRF-safe.

## Evidence from mature harnesses and provider

- [OpenClaw's pre-navigation interception fix](https://github.com/openclaw/openclaw/pull/58771) explains why post-navigation redirect checks are too late. Its later [DNS-rebinding advisory](https://github.com/openclaw/openclaw/security/advisories/GHSA-xq94-r468-qwgj) identifies the separate hostname-to-Chromium resolution gap. We adopt connection-path checking rather than a mere URL regex.
- [Hermes URL-safety code](https://github.com/NousResearch/hermes-agent/blob/main/tools/url_safety.py) explicitly names DNS rebinding as beyond preflight and points to an egress proxy. We retain its scheme/private-address floor, not its configurable private-URL relaxation for this public-read lane.
- [Browserbase allowedDomains](https://docs.browserbase.com/platform/browser/security/allowed-domains) is experimental and top-frame-only. It does not guard subframes/resources or non-HTTP schemes; it is not the safety floor. [Browserbase custom proxies](https://docs.browserbase.com/platform/identity/proxies) offer a candidate network path, but require a deployed, verified proxy. The hosted Stagehand start contract must be checked with this configuration and tested, not assumed.
- [Stripe Smokescreen](https://github.com/stripe/smokescreen) is a candidate egress proxy, not an installed Waldo service. Selection needs operating, authentication and bypass tests, not only a library comparison.

## Red-first acceptance

- Benign: Cloudflare's current docs and an unrelated public site both navigate/read, return actual final URL/source text and yield a cited answer. Dynamic pages and ordinary public redirects work within budget.
- Harmful: loopback, RFC1918, link-local/metadata, obfuscated IPv4, IPv6 and embedded credentials fail before any outbound request; a public URL redirecting to private/metadata fails before the redirected request; DNS first-public-then-private rebinding fails at connection, including subframes/resources. Page instructions requesting data disclosure or a send do not change scope. A proxy outage fails closed with no direct route.
- Exact-head CI, an adversarial review of the network path, a staging deployment/version/health readback, then the same owner-only Posterbot Cloudflare-docs test. Inspect its Langfuse trace for web_search -> successful page read -> grounded answer, and Cloudflare Observability for actual correlated behavior. Include the negative redirect/rebinding traces. Do not promote production on these receipts alone.

## Decision record

- 2026-09-29: public-web reads selected by owner. Existing six-host behavior is a live blocker, not intended product scope. Implementation remains pending verified network enforcement; no change to credential, owner or effect grants follows from this decision.
