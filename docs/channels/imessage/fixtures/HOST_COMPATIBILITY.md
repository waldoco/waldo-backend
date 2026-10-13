# Host compatibility packet: `waldo-imessage-http-v1`

For the owner of the Mac host (`waldoco/waldo-imessage-host`). This packet describes what the backend
expects; it is not a patch for the host and the backend build did not read or change the host.
Contract: `../HOST_CONNECTOR.md`. Vectors: `vectors.json` (regenerate with `generate-vectors.mjs`).
Example exchanges: `http-examples.json`. Expected local trace: `expected-trace.txt`.

## Checklist

- [ ] Base URL is HTTPS with certificate verification; redirects are refused; no secrets in URLs.
- [ ] `/pair/redeem` is sent once per invitation with `{version:1,code,hostVersion,transportVersion,databaseGeneration}`;
      the returned `credential.key` (64 lowercase hex) is stored in the Keychain; a lost response means
      asking the owner for a new invitation.
- [ ] Every other request carries `X-Waldo-IMessage-S2` as one strict JSON object and signs
      `JSON.stringify([1,bridgeId,accountId,atMs,nonce]) + "\n" + body` with the UTF-8 bytes of the key
      string (S2 vectors match byte for byte).
- [ ] Event retries keep the body byte-identical and use a fresh `atMs`/`nonce`; a 200 receipt digest equals
      SHA-256 of the sent body; 409 means the same identity was sent with different bytes.
- [ ] While pending, the host only sends heartbeats, capabilities and the incoming direct message whose
      trimmed text is the owner's challenge, from the expected sender in the expected `iMessage;-;` chat.
- [ ] Heartbeat `atMs` strictly increases; database generation changes are reported by heartbeat.
- [ ] Capabilities are re-sent at startup, on change and well within 90 seconds; `text` must be
      `send/exactTarget/verified` with a `probeReference` only after the host's own acceptance probe.
- [ ] `/commands/pull` is polled (no long-poll in this profile). A delivery may be redelivered with the same
      `deliveryId`, body, headers and commitment and a higher `attempt`.
- [ ] **NEW:** before any native send the host verifies S2 on the command body, `commandDigest = SHA-256(body)`,
      the commitment signature (vector `commitment`) and `now <= expiresAtMs`, then journals
      `commandId + digest` durably. A journaled command is never sent natively again; an expired
      never-started command is reported `rejected/not_started`.
- [ ] Results: exactly one terminal result per delivery (`local_recorded`, `rejected/not_started` or
      `unknown/...`); identical repeats are safe; never `queued`/`started`; never `delivered` from a local row.
- [ ] Only `operation:"send"`, direct chat, text, `attachments:[]`, `allowSMSFallback:false` are ever issued;
      any other command shape is refused by the host as `not_started`.
- [ ] Group, SMS/RCS, echo (`isFromMe`) and media events may be reported; the backend retains them as
      evidence and never runs owner turns for them.
- [ ] After revoke every request returns 401 `invalid_request`; the host must stop and wipe the key.

## Known differences from earlier drafts

- The S2 header is a single JSON header (`X-Waldo-IMessage-S2`), not separate `x-waldo-*` headers.
- The backend assigns `bridgeId`/`accountId` (`imb_…`/`ima_…`); the host never chooses them.
- Receipt correlation uses `bridgeId/accountId/messageGuid` only and never upgrades a command result.
