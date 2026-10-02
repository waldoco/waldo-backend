# Edge ledger and Drive read results: proposal (docs only)

Status: proposal for Codex (edge/migration lane). Core edits none of it. Layer: SOURCE reading of beta-mvp; nothing deployed or tested live. Drafted by Core on main's relay of Dalda's leads (2026-10-02, unverified by Core until checked below).

## Verified facts
- `supabase/functions/connector-proxy/index.ts`: `mcp_call` with an `intent_id` runs through `intentDispatch` -> `executeProxyIntent`, which claims via `proxy_idem_claim` and stores via `proxy_idem_store`.
- `supabase/migrations/20260926110000_waldo_proxy_idempotency.sql`: table `waldo.proxy_idempotency (owner_id, connection, pkey, digest, status, result jsonb, created_at)`, primary key (owner_id, connection, pkey). `proxy_idem_store` writes the full result.
- `20260930060000_waldo_proxy_intent_integrity.sql`: claim/store return null/false for an inactive owner or a revoked connection. Revocation therefore denies replay but does not delete rows.
- No TTL, prune or cron touches the table anywhere in the repo. Rows go only on owner delete (cascade).
- Keying is intent plus connection: a reused intent on another connection is a new row and runs again; it cannot replay another account's result.

## Problem
Owner-button-free Drive reads (PR #573) would write file names, owners and snippets into a table with no expiry. Replay of a read has no value (reads are idempotent and a stale listing is worse than a fresh one).

## Options (smallest first)
A. Skip the ledger for read-only MCP calls in the edge. The edge keeps a server-side registry of read tools per server (list_recent_files, search_files, get_file_metadata for the Drive entry) and, for a registered read, calls the provider without claim/store. The caller's `readOnly` flag is never the authority: only the edge registry decides. Effects are unchanged. No schema change, no retention to manage, no result stored.
B. Keep the ledger for reads but add `expires_at` and a purge (scheduled delete of rows past a short TTL, for example 24h, and null out `result` on read rows). Needs a migration, a job and a pgTAP test, and still holds results for the TTL.

Recommendation: A. It removes the stored data instead of bounding it, and it needs no purge job. Retry of a lost read response just reads again.

## Edge-side requirements for A
- Registry key: (server_url host and path, tool). Unknown tools keep today's ledger path (fail closed).
- Still require a valid host intent id and the signed request, so an unregistered caller cannot use this path to skip effects bookkeeping.
- Log only op, tool and outcome as today; never arguments or results.
- Test: a registered read does not create a row; a non-registered MCP tool still does; a draft/send is untouched; a revoked connection still denies.

## Not decided here
- `read_file_content` stays refused until the edge change lands, because it returns file text.
- Owner decision on unattended Drive reads stays open; the 08:11 AM yes covered read_tools only.
