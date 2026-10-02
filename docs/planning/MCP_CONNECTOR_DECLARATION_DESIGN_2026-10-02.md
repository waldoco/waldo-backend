# Per-server connector declaration for MCP tools (design)

Status: design for review, source layer only. Follows #570 (handler-declared `requires_connector`, `connectorBackedTools`). No code in this PR.

## Source facts (beta-mvp 4eb6b33)

- `call_mcp_tool` and `read_mcp_tool` are single tool names with one handler each (`tools/live/mcp.ts`). The ACL intersection (`tools/acl-intersection.ts`) works on tool names, so it cannot tell a Drive server from a server that needs no connector.
- The connector need is already declared per server in config: `McpServerConfig.auth === 'google'` and `requires` (a Google feature; drive is read-only). `mcpServers()` parses it. `read_mcp_tool` is offered only for servers with `auth: 'google'`, a read-only `requires`, `allow_tools` and `read_tools` (mcp.ts, `readable` filter).
- When Google is missing the handlers already return a typed `McpConnectError` reason (`not_connected`, `reauth_needed`, `scope_missing`) with the feature, which becomes a connect card. That path works without any ACL change.
- #570 left both MCP handlers unmarked because a static flag would wrongly mark a non-Google server as connector-backed.

## Options

A. Mark the handler from config at registration. The factory sets `requires_connector: true` only when every configured server it can serve is `auth: 'google'`. Mixed or non-Google config leaves it unmarked. No contract change; one factory change per handler. `read_mcp_tool` is all-Google by construction (its server filter), so it is always marked when any readable server exists. `call_mcp_tool` is marked only when all configured servers are Google-auth.
B. Split the ACL entry per server (`read_mcp_tool:<server>`). Exact, but changes the `ToolName` union, grants and manifests. A contract change with host fallout. Not needed while the config holds one MCP server.
C. A dynamic declaration (a function on the handler returning the server names that need a connector) plus a per-server finding in the ACL result. Exact without renaming tools, but adds a second declaration channel next to the boolean.

## Recommendation

Do A now. It closes the omission risk with the smallest change, and its failure mode is conservative in the right direction for read tools: marking can only degrade a call when the connector is unavailable. Treat a mixed `call_mcp_tool` config as an open finding, not a silent default: the handler stays unmarked and the typed reconnect path above still gives the owner the right card. Move to B when a second, non-Google MCP server is actually configured, and not before.

## Tests (for the implementing PR)

1. Config with only a Drive server: both handlers marked, so `connectorBackedTools` lists `call_mcp_tool` and `read_mcp_tool`.
2. Config with a Drive server plus a non-Google server: `read_mcp_tool` marked, `call_mcp_tool` unmarked.
3. No servers configured: neither handler is offered, and neither is marked.
4. The #571 probe guard extended to the MCP handlers: any handler whose execution reaches `googleAuth.resolve` must be marked, using a stub that records the call.
5. Existing `read_tools`, `allow_tools` and typed-reconnect tests stay green.

## Not in scope

Host binding of `connector_backed` in `telegram-owner-do.ts` (Codex's file; it passes `connectorBackedTools(handlers)` into `intersectToolAcl`). Drive-only incremental consent (#553). Any hosted or production change.
