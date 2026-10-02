# Per-server connector declaration for MCP tools (design)

Status: design for review, source layer only. Follows #570 (handler-declared `requires_connector`, `connectorBackedTools`). No code in this PR.

## Source facts (beta-mvp 4eb6b33)

- `call_mcp_tool` and `read_mcp_tool` are single tool names with one handler each (`tools/live/mcp.ts`). The ACL intersection (`tools/acl-intersection.ts`) works on tool names, so it cannot tell a Drive server from a server that needs no connector.
- The connector need is already declared per server in config: `McpServerConfig.auth === 'google'` and `requires` (a Google feature; drive is read-only). `mcpServers()` parses it. `read_mcp_tool` is offered only for servers with `auth: 'google'`, a read-only `requires`, `allow_tools` and `read_tools` (mcp.ts, `readable` filter).
- When Google is missing the handlers already return a typed `McpConnectError` reason (`not_connected`, `reauth_needed`, `scope_missing`) with the feature, which becomes a connect card. That path works without any ACL change.
- #570 left both MCP handlers unmarked because a static flag would wrongly mark a non-Google server as connector-backed.

## Options

A. Mark the handler from config at registration. No contract change; one factory change. Applies to `read_mcp_tool` only (all-Google by construction). See the recommendation for why `call_mcp_tool` is excluded.
B. Split the ACL entry per server (`read_mcp_tool:<server>`). Exact, but changes the `ToolName` union, grants and manifests. A contract change with host fallout. Not needed while the config holds one MCP server.
C. A dynamic declaration (a function on the handler returning the server names that need a connector) plus a per-server finding in the ACL result. Exact without renaming tools, but adds a second declaration channel next to the boolean.

## Recommendation

Do A for `read_mcp_tool` only. It is all-Google by construction (its server filter), so the handler is marked whenever it is offered, and a marked read tool can only be removed when the connector is unavailable, which is the right outcome for a read that would fail anyway.

`call_mcp_tool` stays unmarked, on purpose. With a desk wired in (`mcp.ts`, the `if (desk)` branch) the handler only proposes: it stores a proposal and returns `applied: false`, and no Google connector is touched until the owner approves the card. Marking it would remove the proposal path whenever connectors are down, and the owner could no longer be asked. Execution after approval already surfaces a typed `McpConnectError` failure line. Without a desk the handler calls `executeMcp` directly and fails with the typed reconnect error; that surface (tests, console) does not need the ACL flag. Revisit if a desk-less production surface for `call_mcp_tool` appears.

Per-server ACL entries (B) wait until a non-Google MCP server is actually configured.

## Host-slice requirement (Codex seam, not in this PR)

The ACL `connectors` input is a list of tool names, not Google features. The host must list `read_mcp_tool` as available only when the required feature of at least one readable server (drive today) is actually granted on the connected account, and must leave it out when the grant lacks that feature. Passing "Google connected" alone would admit `read_mcp_tool` for an account that has no Drive scope, which is today's staging state. The host also passes `connectorBackedTools(handlers)` as `connector_backed`.

## Tests (for the implementing PR)

1. Config with a Drive server and a desk: `read_mcp_tool` marked, `call_mcp_tool` not marked, so `connectorBackedTools` lists only `read_mcp_tool`.
2. No servers configured: neither handler is offered, and neither is marked.
3. A Drive server plus a non-Google server: `read_mcp_tool` still marked (it only serves Google servers), `call_mcp_tool` unmarked.
4. With the connector unavailable, the ACL result removes `read_mcp_tool` and keeps `call_mcp_tool`, so the proposal path survives.
5. The #571 probe guard extended to `read_mcp_tool`: a stub that records `googleAuth.resolve` must be reached only by a marked handler.
6. Existing `read_tools`, `allow_tools` and typed-reconnect tests stay green.

## Not in scope

Host binding of `connector_backed` in `telegram-owner-do.ts` (Codex's file; it passes `connectorBackedTools(handlers)` into `intersectToolAcl`). Drive-only incremental consent (#553). Any hosted or production change.

## Decision 2026-10-02: owner-button-free Drive reads carry a host intent

Finding (source, beta-mvp 739e1b3): the proxy rail's `mcpCall` throws `intent_required` when no host intent is passed, and the edge also rejects a missing one. `read_mcp_tool` called `executeMcp` without an intent, so every proxy-mode Drive read failed `intent_required` before the network. Staging traces at 7:47-7:48 PM IST showed this on `drive/list_recent_files`.

Decision (main's decision under the owner's overnight delegation, not owner-approved): `read_mcp_tool` derives `mcpread:<sha256 of [user, turn, toolCall]>` from the dispatcher context, the same shape `draft_email` uses, and never takes an intent from model args. It requires `turnId` and `toolCallId` and refuses without them.

Held: only `list_recent_files`, `search_files` and `get_file_metadata` take this path. `read_file_content` stays refused (`forbidden`) until the intent ledger's storage of results is confirmed not to persist Drive file text. `call_mcp_tool` and its desk path are unchanged.
