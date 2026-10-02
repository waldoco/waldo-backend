# Edge skip-store for Drive reads: implementation spec for Codex

Status: spec only. Layer: SOURCE reading of beta-mvp; nothing deployed or tested live. Core edits no edge, migration or DO file.

## Authority
- Owner, 10:17:53 PM IST (phonemsg-01M3YR7R9PGF9SQ2BHYM4VZ8HJ): "If the skip store or TTL is making sense then we can do it for point number two" (point two = Drive read result retention), and to unblock what is easy on engineering merit. This delegates the skip-store vs TTL choice to engineering merit; it is not an approval of any particular design.
- Choice: skip-store (option A in `EDGE_READ_LEDGER_PROPOSAL_2026-10-02.md`), an engineering-merit decision by main, no migration.
- Earlier, separate: the owner's 8:11:06 AM "1. Yes" to Drive reads without an approve button. Retention was not put to him then.

## Core side (done, PR for this spec)
`connections.ts` `mcpCall` now sends `read_only: true` in the `mcp_call` wire body only when the host intent is `readOnly` and its id starts with `mcpread:`. Today's edge ignores the unknown field, so this changes nothing live until the edge reads it. Effect intents and a `readOnly` flag on any other id never send it. Test: `test/mcp-read-wire.test.ts`.

## Edge change (Codex), in `supabase/functions/connector-proxy/index.ts`, `op === 'mcp_call'`
1. Add `read_only?: boolean` to `Body`.
2. Add an edge-owned registry (a const or env JSON, not read from the request): exact `server_url` (scheme, host, path) mapped to a set of tool names. Initial entry: `https://drivemcp.googleapis.com/mcp/v1` with `list_recent_files`, `search_files`, `get_file_metadata`. `read_file_content` is NOT listed.
3. Skip the ledger only when ALL hold: `body.read_only === true`; `body.intent_id` matches `/^mcpread:[0-9a-f]{64}$/`; (server_url, tool) is in the registry. Then call the same dispatch function directly, without `intentDispatch`, so no `proxy_idem_claim` or `proxy_idem_store` runs and no result is written anywhere.
4. Everything else is unchanged and fails closed: any other MCP tool, an unlisted server, `read_only` missing or false, or a non-`mcpread:` id goes through `intentDispatch` exactly as today. A read_only call for an unlisted tool must NOT be skipped and must NOT be rejected differently from today.
5. Keep the signed-request check, the `proxy_secret` lookup, token refresh, health recording and revoked-connection denial on the skip path. A revoked connection or inactive owner must still deny.
6. Logging: op, tool and outcome only, as today. Never arguments or results.

## Tests (extend `packages/runtime/test/connector-proxy-entry.test.ts`, same fixtures)
- Registered read with `read_only: true` and a valid `mcpread:` id: returns data, and the fixture records NO `proxy_idem_claim` and NO `proxy_idem_store` hop.
- Same call repeated: dispatches twice (no replay), both return data.
- `read_only: true` with an unlisted tool (e.g. `synthetic_write`) or `read_file_content`: still goes through the ledger (claim hop present).
- `read_only: true` with a non-`mcpread:` id (e.g. `approval:mcp`): still goes through the ledger.
- `read_only` absent on a registered read tool: still goes through the ledger.
- Draft, send and calendar effects: unchanged (existing tests).
- Revoked connection or missing secret on the skip path: still `connection unavailable` / `intent_unavailable` as today, no dispatch.
- No new table or migration; confirm pgTAP is untouched.

## After the edge change lands (Codex confirms)
- Release to staging. Then, in `telegram-owner-do.ts` (Codex's file), pass `this.env.MCP_READ_INTENTS === '1'` as the third arg of `readMcpToolHandler` and set that var on staging. Not before the edge change is live.
- `read_file_content` stays refused. Enabling it is a separate decision (it returns file text).
- Then Core runs the live Drive proof (needs the Drive consent path; the stored grant still has no Drive scope).

## Not decided here
Any retention of `proxy_idempotency` rows that already exist; the Google reconnect/consent path.
