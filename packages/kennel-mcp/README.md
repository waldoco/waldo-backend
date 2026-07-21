# Kennel observation MCP

A local-only stdio MCP that admits minimized Codex lifecycle observations and, when configured, delivers the admitted v1 envelope to Kennel through an authenticated loopback receiver. It does not execute commands, resolve approvals, close loops, or expose transcripts, paths, command text, or previews.

## Browser observer (Windows validation)

```powershell
node packages/kennel-mcp/dist/console.js
```

Open `http://127.0.0.1:4179`. The browser cannot speak stdio, so this development-only page launches its own stdio client/server pair on loopback and exercises the actual MCP tools. It covers the same four events that Kennel receives: `session_started`, `permission_requested`, `turn_started`, and `turn_completed`.

## Codex stdio configuration

Use the built server as a local Codex MCP command. The session ID and consented event kinds are explicit:

```powershell
node packages/kennel-mcp/dist/stdio-server.js --session-id codex-session-1 --allow session_started,permission_requested,turn_started,turn_completed
```

## Kennel delivery

On macOS, start Kennel's loopback receiver and create a random, local-only token. Pass the receiver endpoint as an argument and the token only through the process environment:

```powershell
$env:KENNEL_DELIVERY_TOKEN = '<at-least-32-character-local-token>'
node packages/kennel-mcp/dist/stdio-server.js `
  --session-id codex-session-1 `
  --allow session_started,permission_requested,turn_started,turn_completed `
  --kennel-delivery-url http://127.0.0.1:4178/v1/observations
```

The delivery URL is restricted to `127.0.0.1` or `::1`, HTTP only, with the exact `/v1/observations` path. When delivery is configured, the MCP acknowledges an event only after Kennel returns `202`; a rejected or unavailable receiver returns `KENNEL_DELIVERY_FAILED` and leaves the event retryable under the same `eventId`.

## Contract

Every event is strict v1 JSON, no larger than 64 KiB, linked to the configured session, scoped by consent, and deduplicated by stable `eventId`. Kennel's `KennelMCPAdapter` maps the same envelope into `KennelEventEnvelope` with `ObservationPlane.mcp` and existing minimized payload types. The delivery path contains no command, approval, deep-link, or loop-closure channel.