# ADR draft: owner sign-in (OAuth) for third-party MCP servers

Status: proposal. On 15 Oct the owner approved designing this sign-in path; building and enabling it need separate approval. It becomes an ADR in Brain under the next free number, amends one line of ADR-0075, and stays non-authoritative until `accepted-adrs.json` is regenerated. Source was read at `beta-mvp` `b3325dfd`, and external sources were checked on 15 Oct 2026. ADR-0049 and ADR-0075 were read from the local waldo-brain checkout; I did not confirm that checkout matches the pin `be08c4af`.

## 1. Context

**Problem.** The owner reports that Waldo's datacenter browser is blocked (403, blank or failing pages) by Blinkit, BigBasket, District, BookMyShow, IRCTC, MakeMyTrip, Goibibo, Agoda, Zepto, Swiggy Instamart and Zomato. That comes from the owner's 14 Oct probe; I did not re-run it. Some of these services publish official MCP servers with per-user OAuth. Using a provider-sanctioned API is the durable route; scraping their web front ends is not.

**What exists today** (read in source):
- **MCP tools.** `call_mcp_tool` (`tools/live/mcp.ts`) proposes an `mcp_call` desk card per call showing masked raw JSON args. `read_mcp_tool` runs Google catalogue reads with no card. Servers come from `WALDO_MCP_SERVERS`. A Google bearer is refused off `googleapis.com`, and the code leaves third-party OAuth to "the generic flow's job (RFC 9728)".
- **Custody.** Google tokens live in Supabase Vault (`waldo.connections`). The `connector-proxy` Edge Function mints tokens and runs calls; the owner DO holds only a connection id. Disconnect deletes the Vault secret and never calls the provider's revoke endpoint.
- **Consent** (`connectors/google-consent.ts`). One record per attempt in the owner DO: a single-use nonce, a PKCE S256 verifier and a 15-minute TTL, with HMAC-signed state. A replayed callback gets the recorded outcome and never redeems the code twice. Chat carries only a first-party `/c/<ticket>` link; the provider URL is minted on click.
- **Desk.** An uncertain `mcp_call` settles `uncertain` and is never re-run.
- **Google-only today:** the `connections.provider` check, the edge `mcp_call` host regex and `connectIntentSchema.service`. `sanitiseDestinationSchema` lacks the `connector_write` destination that ADR-0024 and ADR-0075 name.

**Gates.**
- `ADR_RECONCILIATION.md` (row ADR-0021/0049): generic MCP stays disabled "until a measured use case, data policy, adapter contract, and eval gate exist". Section 3 covers each.
- ADR-0049: privileged actions with tainted arguments must route to a human, and MCP needs a server allowlist.
- ADR-0075: Vault custody, plus the line "MCP is not the connector integration layer", which this draft amends.

**MCP spec, revision 2026-07-28** (modelcontextprotocol.io, checked 15 Oct):
- **Authorization.** Clients **MUST** discover through RFC 9728 metadata, send the RFC 8707 `resource` "in both authorization requests and token requests", record the issuer with the PKCE verifier and validate `iss` (RFC 9207). They "**MUST NOT** send tokens to the MCP server other than ones issued by the MCP server's authorization server".
- **Registration.** Priority is pre-registered, then Client ID Metadata Documents (CIMD), then DCR, which "is deprecated". Credentials are keyed to the issuer.
- **Security best practices.** Confused deputy, token passthrough, SSRF in discovery, and state-handle hijacking ("a handle is a name, not a capability").
- **Tools.** Clients "**MUST** consider tool annotations to be untrusted unless they come from trusted servers".
- **Transport.** The revision is stateless and requires `_meta` on every request. Waldo's transport speaks the 2025-06-18 `initialize` handshake.

**Swiggy** (mcp.swiggy.com/builders, checked 15 Oct):
- **Auth.** Four servers: `/food`, `/im`, `/dineout`, `/scenes`. OAuth 2.1 with PKCE, RFC 9728/8414 metadata and DCR only. Multi-tenant platforms use a "delegated auth" track whose redirect allowlist is fixed at onboarding.
- **Scopes** (`mcp:tools`, `mcp:resources`, `mcp:prompts`) are "server-level, not read/write-split".
- **Tokens.** Access tokens last 5 days. Refresh tokens last 30 days and **rotate**. Codes last 120 s. Redirect URIs must match exactly.
- **Production gating.** An application (it asks for "static IP ranges or gateway IPs"), then staging "green for ≥ 48 hours", "idempotency guards for order placement" and "user-visible cart confirmation".
- **Ordering.** `place_food_order` takes `addressId`, `paymentMethod`, UPI flags and a note. It acts on the server-side cart, has no idempotency key, and its docs require the user to confirm address and payment. UPI returns `PENDING_PAYMENT` with a `bridgeUrl`, then `check_payment_status` and `confirm_order`. SwiggyPay debits inline.
- **Data.** Swiggy is fiduciary and the integrator is processor. "Do not persist user PII longer than needed to serve the current session"; no training without consent and a DPA; inference outside India needs a DPA and transfer mechanisms.
- **Versioning.** Description-only changes fall outside the 6-month promise.

**Zepto** `[unverified by me; both first-party pages returned 403]`. Coordinator research reports OTP sign-in and a redirect allowlist limited to known clients (Claude, VS Code, Postman, localhost); no documented multi-tenant track or DCR; real orders; UPI Reserve Pay payment.

**Zomato.** Coordinator research reports personal use only, with no third-party apps. Not designed for here.

## 2. Decision

Waldo connects each owner, by OAuth, to a **reviewed registry** of third-party MCP servers. Tokens stay in Vault behind the connector-proxy edge, as Google's do. The model reaches each server only through a typed **adapter** at the existing MCP seam: a tool allowlist with zod schemas, Waldo-written descriptions, and a class on every tool.

### 2.1 Which servers

- **The registry lives in code**, in `connectors/mcp-registry.ts`, shared with the edge like `GOOGLE_MCP_SERVERS`. Each entry pins:
  - the canonical resource URI and the issuer;
  - the authorize and token endpoints;
  - the client mode and the scopes;
  - the protocol revision;
  - the egress and payment-link hosts;
  - for each allowlisted tool, its class and a hash of its `name`, `description`, `inputSchema` and `annotations`;
  - default spend caps and a kill switch.
- **Owners never add URLs.** Deploy config may enable or narrow an entry but never add one, which is what `governed()` already enforces for Google.
- **Adding a server** requires four things:
  1. a security and terms review;
  2. the registry entry and adapter, merged through the gate with the section 3.4 evals;
  3. a migration widening `connections.provider`;
  4. the switch flipped in deploy config.
- **Endpoints are pinned at review.** Runtime never follows discovered metadata URLs, which removes the SSRF class. A daily drift check compares live metadata and `tools/list` against the pins.

### 2.2 Client identity, per server

- Use **pre-registered** credentials where the provider issues them.
- Use **CIMD**, hosted on Waldo's origin, where the server advertises `client_id_metadata_document_supported`.
- Use **DCR** only when it is the provider's only path, as it is for Swiggy, on its delegated-auth track. The edge registers once per environment, not per owner, with the exact allowlisted redirect. The credentials go into Vault keyed by issuer.

### 2.3 Connect flow, on every surface

1. A call to an unconnected registry server returns a typed connect intent (`connectIntentSchema.service` widens additively). The model says so in plain words, and the host renders the surface's affordance: a `/c/<ticket>` link on Telegram or iMessage, or the Connections row in the console or app. No link enters model text, and there are no slash commands.
2. On click, the owner DO runs `startConsent`, generalised from Google. It records the nonce, PKCE verifier, redirect, server id, issuer and resource under a signed 15-minute state.
3. The owner signs in at the provider in the browser; Waldo never sees an OTP. The callback hits one Worker path, which drops forged state before the DO wakes. The DO checks `iss` and settles the attempt once.
4. The edge exchanges the code, sending `resource` on both requests, and stores the tokens. The DO receives only a connection id.
5. "Connected" is claimed only after `tools/list` succeeds with the new token and every pinned hash matches.

A replayed callback gets the recorded outcome, and a foreign or expired nonce settles `invalid`. Signed state, the DO-held nonce and the ticket hash bind each callback to one owner.

### 2.4 Token custody

- **Where tokens live.**
  - Refresh tokens, access tokens and their expiry live only in Vault, behind `SECURITY DEFINER` wrappers scoped by `owner_id_for(do_name)`.
  - Third-party servers run **proxy-mode only**. The DO-bearer branch stays Google-only, with no `local:` fallback.
  - Tokens never appear in DO SQLite, prompts, logs, traces, event payloads or fixtures.
- **Refresh.**
  - The edge reuses an access token until 10 minutes before it expires.
  - A rotated refresh token is written by compare-and-set through a new `connection_rotate(expected_digest)`. The edge is the single writer for each connection.
  - If a refresh is lost or races another, the connection is marked `reauth_needed` and the owner gets one reconnect notice (`reauthNoticeTransition`). There is never a silent retry.
- **Revocation.**
  - On disconnect (from the console, the app, or a plain-language request), the edge first calls the provider's revoke or logout endpoint, then deletes the Vault secret. If the provider call fails, the local delete still happens and the failure is logged by code only.
  - Account deletion already removes `waldo.connections` and their Vault secrets (migration `20260928130000`). It gains a best-effort provider logout first.

### 2.5 Authority

Swiggy's scopes carry no read/write split, so the **adapter class is the only authority seam**. Every allowlisted tool sits in one of four classes. Swiggy Food, for example:

| Class | Rail | Swiggy Food tools |
|---|---|---|
| read | connection grant (below), no card | `search_restaurants`, `get_restaurant_menu`, `search_menu`, `get_food_cart`, `fetch_food_coupons`, `get_food_orders`, `get_food_order_details`, `track_food_order`, `get_food_delivery_status`, `get_payment_options`, `check_payment_status`, `get_addresses` |
| cart write | one card per proposed cart | `update_food_cart`, `flush_food_cart`, `apply_food_coupon` |
| spend | one card per order, plus the budget check | `place_food_order`; `checkout`, `book_table` and `place_event_order` on the other servers |
| excluded | not callable | `create_address`, `delete_address`, `report_error`, cancellation (Swiggy routes it to customer care) |

- **Reads run under a scoped, revocable grant**, not a card for every call. Swiggy's food recipe uses about seven tools, so a card per call does not fit. Connecting creates that grant: this owner, this server, read-class tools only, within the adapter's parameter schemas, expiring with the connection. Each call re-checks it at dispatch against the connection status, the kill switch and the review state. Disconnecting revokes it. It is not a preauthorised capability: the owner creates it by signing in, and it never covers a write. Its budget is the turn's bounded-work limit plus the provider's rate limit. Its time limit is the connection's lifetime, rechecked on every call. Both are sized to real errands, not set to block them.
- **Cart edits need a card.** They change the live cart that the owner's phone app also shows, and their arguments come from tainted search results, so ADR-0049 routes them to the desk. One card shows the whole proposed cart, not one card per item.
- **Orders use a frozen intent.**
  1. The order card is rendered from a fresh `get_food_cart`. It shows the items, the total, the restaurant, the address as the owner's own label, and the payment method. This is Swiggy's own "user-visible cart confirmation".
  2. The card stores a digest of that cart.
  3. At dispatch, the effect path re-checks the connection, the kill switch and the budget against the fresh total.
  4. It then re-reads the cart. If the digest does not match, the order is refused ("the cart changed"), and nothing is placed.
- **No idempotency key, so no retries.** Swiggy's own checklist requires an idempotency guard. An uncertain dispatch settles as `uncertain` and is never retried, which is today's `mcp_call` desk rule. The owner is told, and reconciliation goes through `get_food_orders`.
- **One retry owner after payment.** The order's desk effect polls `check_payment_status` within the provider's interval and cap, then calls `confirm_order` once. The order card already covers `confirm_order`, because it is the same frozen intent; a second card would ask twice about one spend. The model never calls it. "Placed" is said only after `confirm_order` succeeds.
- **Payment always happens in the provider's own flow.**
  - A UPI `bridgeUrl` or `upiIntentUrl` is checked against the registry's payment hosts. The host delivers it as a button; the model never types it.
  - Cash on delivery commits spend immediately, so it still needs the card.
  - **SwiggyPay and UPI Reserve Pay are excluded in the zod enums.** SwiggyPay debits inline (Swiggy docs). Reserve Pay is a pre-authorised mandate debit `[inference; no source read]`. If it is Zepto's only rail, Phase 2 needs an owner decision.
  - Waldo never holds a VPA, card data or any other payment credential.
- **Budget.** The owner sets a per-order cap and a rolling daily cap in the console. These caps are deterministic because spend is a hard safety boundary, not a judgment call.

### 2.6 Prompt-injection and tool-poisoning defences

- **Pinned descriptions.** The model reads Waldo's adapter descriptions, never the provider's. A hash change moves the server to `review_needed`, whether it is found on connect, in the daily drift check, or through a schema-mismatch error. While in that state, every call is refused with a typed reason, and the owner is told once.
- **Tainted results.** Results are `source_taint: 'external'`, go through the Scribe at `internal_context`, and are validated against the adapter's output schemas.
- **Output never grants authority.** "Order this" text inside a result is content. ADR-0049's gate routes any action that follows to a card.
- **Outbound free text** (`noteToRestaurant`) goes through a new additive Scribe destination, `connector_write`. It blocks health values and secrets unless the owner asked to share that item.

### 2.7 Observability

- **Trace hops are content-free.** `mcp_connect` records the server and outcome kind; `mcp_token_refresh` records ok/code; `mcp_call` records server, tool, class, ms, ok and code; `mcp_drift` records match or mismatch; `mcp_payment_poll` records the terminal status.
- **Labels come only from closed sets.**
- **Never recorded:** tokens, codes, addresses, cart contents, amounts, order ids, or provider error text.
- **Cost:** calls per owner per day are logged, never used as labels.

## 3. The four reconciliation conditions

**3.1 Measured use case.** The use case is errands at Indian consumer services that the browser cannot reach.
- **Measure:** the errands-bar eval cases that fail on blocked sites today, plus the 14 Oct probe re-run and recorded before enablement.
- **Success bar:** a test account completes search, cart, an approved order and tracking on Swiggy Food, with no browser fallback.

**3.2 Data policy.**
- **Sent to the provider:** search text, item ids, address ids (never the address text), the payment method, and a Scribe-checked note.
- **Received from the provider:** saved addresses (PII), order history, menus, and payment links.
- **Storage:**
  - Provider results live only in the turn's context.
  - Nothing enters memory unless the owner confirms it.
  - Receipts are stored as Evidence and minimised to order id, merchant, status, total and time, with **no address**. This keeps PII to the session, as Swiggy requires.
  - Disconnect deletes provider-derived rows.
- **Model egress.** Waldo's inference is outside India, so addresses and order history need Swiggy's DPA and transfer mechanisms first. Until then, the adapter shows the model address labels only ("Home"), and the full address appears on the card alone. No Swiggy data is used for training.
- **Consent text, shown before redirect:** "Waldo will search Swiggy, read your saved addresses and past orders, and fill your cart. Waldo asks you before every cart change and every order, and you always pay in Swiggy's own payment screen. Disconnect any time in Connections."
- **Terms.** Swiggy permits AI assistants, forbids resale or sharing of access, and requires attribution. The founder must review the full terms and the DPA.

**3.3 Adapter contract.**
- Each server gets `connectors/mcp/<server>.ts`: zod input and output schemas for every allowlisted tool, with valid and invalid tests (ADR-0029).
- Both `call_mcp_tool` and `read_mcp_tool` dispatch through it, and the tool's class picks the rail.
- The registry pins `protocolVersion`. Any of the following counts as **contract drift**, moves the server to `review_needed`, and is never loosened silently:
  - a different negotiated version;
  - a changed hash;
  - a schema failure.
- A provider MAJOR version bump gets a new adapter version.

**3.4 Eval gate.**
- **Workerd scenarios against a fake provider.** Connect: denied, expired, replayed, forged state, `iss` mismatch. Read grant re-checked after disconnect and kill switch. Cart card; order card from a fresh cart; **cart changed between card and dispatch**; uncertain order, never retried; UPI pending, paid, then `confirm_order` exactly once; **SwiggyPay or Reserve Pay refused**; over budget; track. Revoke through all three paths; token expiry; **refresh-rotation loss**; provider down. **Changed tool description disables the server**; injected "order this" result yields a card, never an effect; off-registry payment link dropped. Trace assertions: no token, address or amount.
- **Live checks.** On Swiggy staging with a separate test account (never the owner's), then one production order of at most ₹200 with owner sign-off: connect, search, cart, order, track, disconnect. Each step has a recorded receipt.

## 4. Considered options

- **Owner-added URLs:** rejected. They bring SSRF, tool poisoning, no review and no DPA. Today's deploy-config-only registry was also rejected, because it has no typed tools and no pins.
- **Per-owner DCR:** rejected. It creates N clients for no gain and widens the confused-deputy surface.
- **A bearer token held in the DO:** rejected for the same reason as ADR-0075 option B: an injected loop would own the account. A third-party token broker was also rejected, because it adds a processor that holds Indian PII.
- **A card for every call:** rejected as unusable with roughly 7 tools per order, and raw JSON is not reviewable. **No cards for writes:** rejected under ADR-0049, given server-side carts and no idempotency key.
- **Runtime metadata discovery:** rejected. Pins plus the drift check give the same freshness without SSRF.
- **Residential-egress browser as the primary path:** rejected. It is fragile and exposed to site terms, and the owner ruled Browserbase out on 14 Oct. It remains a separate track.

## 5. Consequences

- **ADR-0075 is amended.** "MCP is not the connector integration layer" becomes "MCP is a connector integration layer for reviewed registry servers only, under this custody".
- **Impact surface.** Additive: `connectIntentSchema`, `connectServiceArgsSchema`, `sanitiseDestinationSchema` (`connector_write`), the app.v1 connect intent (tell the app lane), and desk card kinds `mcp_cart` and `mcp_order`. One migration widens `connections.provider` and adds `connection_rotate`. The edge host check moves to the registry. Touched code: `mcp.ts`, `approvals.ts`, the console Connections page and the Waiting labels.
- **Rollback.** A per-server kill switch refuses every call and hides the connect affordance.

## 6. Open questions for the owner

1. **Static IPs.** Swiggy's form asks for "static IP ranges or gateway IPs", and Cloudflare egress is shared. Should the founder ask Swiggy whether this is mandatory, or should we add a fixed-IP egress gateway (cost, plus one more processor)?
2. **DPA.** Should we sign Swiggy's DPA and transfer terms for inference outside India? Until then, the model sees address labels only.
3. **Phase-1 server.** I recommend Swiggy Food (read, cart and order behind cards). Dineout `book_table` is the lower-spend alternative.
4. **Cards per order.** The default is two cards per order: the cart, then the order. The alternative is a single card covering items, address, method and a **maximum total**. On approval, the host builds the cart and places the order only if the items match and the total is within that ceiling. This is fewer taps, but the owner sees fees after approving. Which do you want?
5. **Budget defaults.** What should the per-order and daily caps be, and is cash on delivery allowed in phase 1?
6. **Founder actions.** Apply to Swiggy's delegated-auth or enterprise track: staging, a demo, a security contact, and the 48-hour green staging run. Accept the MCP terms. Ask Zepto for a commercial multi-tenant track and a redirect allowlist for Waldo's callback, which Phase 2 (Instamart, then Zepto) depends on.
