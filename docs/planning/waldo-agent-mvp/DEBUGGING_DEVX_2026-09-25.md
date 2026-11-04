# Debugging DevX - self-serve debugging for the lane (2026-09-25)

Owner ask (2026-09-25 ~01:00): the lane should debug staging itself, end to end, with minimal
dependence on the Mac - and the design must be thought through, not just "put keys in the vault".

This doc is that design. It starts from two verified facts and one platform constraint, then a
trust ladder. Nothing here is implemented yet except where marked SHIPPED.

## 1. What the lane's sandbox can actually run (verified empirically 2026-09-25)

- node v22.23.2, npx, psql 14.23, curl, jq - present.
- supabase CLI 2.117.0 via npx - runs; `db query` supports `--db-url`, `--linked`, `--local`,
  `--project-ref`, `--output-format json` (help output verified live).
- wrangler 4.138.0 via npx - runs.
- Outbound HTTPS to api.supabase.com and api.cloudflare.com confirmed reachable (401/403 = auth
  wall, not network). Langfuse API is plain HTTPS + Basic auth - reachable by the same token.
- Cloud browser: full dashboard sessions with vault fill (the vault types credentials into web
  forms without ever showing them to the lane).

So the sandbox can drive every relevant surface: Supabase (CLI, Management API, psql, dashboard),
Cloudflare (wrangler, dashboard), Langfuse (public API, UI). The only question is credentials.

## 2. The platform constraint that shapes everything

The vault never returns stored values to the agent - `vault fill` types them into browser forms
only. That is a deliberate property, and this design respects it: **API keys cannot flow from the
vault into the lane's shell.** Any design that needs key material in the lane's environment needs
a channel that does not exist today, so this design does not require one.

Consequences:
- Browser-dashboard access works NOW with vault fill / stored browser sessions: Langfuse UI,
  Supabase dashboard (SQL editor, logs explorer, auth config), Cloudflare dashboard (Workers
  live logs).
- CLI/API access (psql, supabase CLI, wrangler tail, Langfuse API) needs key material in the
  sandbox. Deferred to Rung 2 with a named blocker, not faked.

## 3. The trust ladder

### Rung 0 - make the system self-explaining (code, no credentials) - RECOMMENDED FIRST
Most of tonight's debugging dead-ends were not access problems, they were instrumentation gaps:
the tool error text existed but never reached any readable surface. Fix the surfaces first and
most debugging stops needing new access at all.

- S7a: structured redacted error surfacing. Every tool hop and Langfuse span gains a bounded
  `error_class` field (e.g. `GoogleError 401`, `proxy: connection unavailable`, first 120 chars,
  run through the egress-guard redactor). Never tokens, URLs, message or calendar content.
- S7b: Langfuse tagging. Set `WALDO_ENVIRONMENT=staging` in wrangler.jsonc `[vars]`, and have
  the deploy step pass `--var WALDO_RELEASE:<git sha>` so every trace ties to an exact commit.
  (Root cause of tonight's environment=development/release=unknown: both vars unset.)
- S7c: owner-authenticated trace surface: a `/debug` Telegram command (the bot already knows the
  owner's identity on that channel) that returns the last turn's hop chain with redacted error
  classes from the DO trace book. No new credentials, works over the existing authenticated
  channel, egress-guarded like every model-adjacent send.

### Rung 1 - browser dashboards via vault (read-only debugging) - RECOMMENDED NOW
- Vault entries (login kind): Langfuse (email+password), Supabase dashboard, Cloudflare
  dashboard. The lane drives the cloud browser: Langfuse trace inspection, Supabase SQL editor
  reads + edge-function logs, Cloudflare Workers live logs.
- Read-only by construction: the lane is looking, not mutating. Any mutating click (deploy,
  delete, config change) is out of scope and stays with the Mac.
- Revocation: owner deletes the vault entry / signs the browser profile out / changes the
  password. Nothing is stored in the repo, prompts, or logs.

### Rung 2 - key-in-sandbox CLI/API access (defer)
What it would unlock: psql/supabase CLI reads without browser driving, `wrangler tail` from the
lane, Langfuse API queries, scripted cross-correlation.
What it needs that does not exist: a sanctioned secret-to-sandbox channel (vault is fill-only by
design). The minimum set when that channel exists:
- `SUPABASE_DB_URL_READONLY`: connection string for a new `waldo_debug_ro` role - SELECT on
  waldo.* tables, explicitly NOT vault.decrypted_secrets, statement_timeout set. Blast radius:
  read all waldo rows (no tokens - those live in vault, unreadable by the role).
- `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_HOST`: project-scoped; reads traces;
  text capture is off so content exposure stays limited to metadata + redacted fields.
- `CLOUDFLARE_API_TOKEN` scoped Workers Tail:Read on the one account. Blast radius: read worker
  logs (which are already redacted by design).
- A Supabase Management PAT is deliberately NOT on this list: it is account-wide and can manage
  every project - too much blast radius for the value over Rung 1.

### Deploys stay on the Mac (explicit decision point)
Full lane independence would need Workers Scripts:Edit + Supabase deploy rights - that is the
whole production surface in one token. Recommendation: keep deploys Mac-only via ship.sh; the
packet loop for deploys is cheap and the owner already runs it. Revisit only if packet latency
becomes the bottleneck.

## 4. Transcript evaluation path (governed, retention-limited)

- Default stays: LANGFUSE_CAPTURE_TEXT off; Worker log lines carry text:undefined.
- Opt-in window: `/debug text on` (owner Telegram) sets a DO flag with a 30-minute TTL; while
  live, text fields flow to Langfuse AFTER the egress-guard redactor; expiry is automatic and
  logged. No persistent capture mode exists.
- Langfuse project retention set to 30 days; deletion runbook: delete the project traces by
  session id from the Langfuse UI (Rung 1 access suffices).
- The DO conversation store (modelPayload/appPayload) keeps its current behavior; a retention
  sweep (entries older than N days compacted) is a separate slice if the owner wants it.

## 5. What stays Mac-only (and why)

- Deploys (ship.sh) and `wrangler secret put` - production surface.
- `supabase db push`, pgTAP runs, function delete, secrets unset - schema and secret mutation.
- .env custody. The Mac .env is the single source of truth for which project staging points at;
  Rung 0/1 access never includes it.

## 6. Immediate asks

1. Vault entries (Rung 1): Langfuse login, Supabase dashboard login, Cloudflare dashboard login -
  the lane requests them through the vault and the owner fills them once.
2. Approve S7a/S7b/S7c as the next code slice (they are what make every other surface useful).
3. Approve the packet R1 diagnostic already sent (settles which Supabase project is live and
   reads the connection row's own error record - tonight's RCA hinges on it).

## Langfuse trace shape (O1 pass, 2026-09-25)

Audited against langfuse.com/docs/observability/best-practices (fetched live) + the official
langfuse/skills instrumentation guide. Our OTLP exporter already matched most of the good-trace
model (one trace per turn, session per conversation, a generation per model call with usage +
cost, feature tags, environment/release). Fixes in this pass:

1. `langfuse.trace.input`/`langfuse.trace.output` now set on the root span - this is what the
   Langfuse trace list and preview pane read; per-hop observation attrs alone never surfaced a
   preview. Still gated by LANGFUSE_CAPTURE_TEXT.
2. `tool_*` hops now emit observation type `tool` (was generic `span`) - LLM-as-judge targeting
   and tool filtering key on it.
3. TRACE_SCHEMA_VERSION bumped 1 -> 2 (new keys + type rule change).

Staging action (packet v3): set LANGFUSE_CAPTURE_TEXT=true - with it off there are no text
previews at all by design (privacy switch); for single-owner alpha staging it should be on.
Live verification step (his bar: a real trace audited in the UI, not tests alone): send one
telegram turn on staging, open the newest trace, confirm the preview shows the message and reply,
the tree shows pickup/llm_reply/tool_*/send nested under the root, and the llm generations carry
tokens + cost.

## Trace privacy gate (SHIPPED on fix/populated-tool-reads, 2026-09-26)

Owner review on #181 (febc235): free-form detail/error text was reaching every trace sink with no
gate - the OTLP export (`metadata.detail`, `status.message`), the wrangler console JSON line, and
the DO `trace_log.note` column (200-char slice). Model day-plan reasons and provider error
messages are free-form content: they can quote owner schedule context or request fragments.

Fix: one gate at the `log()` fan-out in telegram-owner-do.ts (`gateTraceEntry`,
observability/trace-privacy.ts), so all three sinks see the same gated entry.
- `detail` survives the gate only for hops on a verified content-free whitelist (fixed strings,
  enums, counts, card ids): stop/steer/connect_offer/google_token_migrated/memory_backup/
  egress_scrub/egress_redacted/oauth_exchange/oauth_callback/google_linked/day_plan/nightly_memory/
  brief_sweep/day_card/update_card/console_action. The whitelist trusts its producers; the
  day_plan producer was changed to emit `card=time` pairs only (the model reason is gone from
  detail entirely).
- `error` text never survives the gate; failures leave a typed `code` instead
  (`provider_error`, `send_failed`, `export_failed`). OTLP `status.message` falls back
  error -> code -> 'failed'.
- `LANGFUSE_CAPTURE_TEXT=true` restores the full detail/error/text on every sink, as before.

Proof: `trace-privacy-canary.test.ts` seeds a synthetic marker into a failed hop's detail, error
and turn text, runs the gated entries through all three sinks with capture off, and asserts the
marker appears in none - plus a capture-on control proving the test can see the marker, and a
whitelist case proving count/enum detail still flows.
