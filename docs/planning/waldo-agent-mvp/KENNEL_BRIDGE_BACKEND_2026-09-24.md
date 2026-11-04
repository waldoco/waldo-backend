# Waldo <-> Kennel bridge: backend half (2026-09-24)

The owner's end experience (his WhatsApp, 6:52 PM): Kennel is the workhorse on the MacBook - Waldo, from WhatsApp/mobile/anywhere, orchestrates the user's existing agents (Claude, Codex) through it, acts on the machine, and absorbs machine state (minimi-style capture + open loops) into Waldo's context. The gap he names is real: every cloud personal agent is blind to the user's machine. This doc is the Waldo-backend half; the Kennel-side build is Ashish's half. Both feed one bridge doc he reviews before anything goes back to Ashish.

## 1. Industry check: how cloud agents reach local machines (sources at foot)

- **Claude Code Remote Control** (code.claude.com/docs/en/remote-control.md): claude.ai/code and the mobile app attach to a session *running on your machine*. Sessions teleport cloud<->local (`--cloud`, `--teleport`). This is the closest shipped analog to his vision - phone steers a local session. Its limits are exactly our opening: per-session, dev-scoped, single-agent, no persistent machine presence, no memory beyond the repo.
- **OpenClaw** (docs.openclaw.ai/architecture): inverts our topology - a long-lived Gateway ON the user's hardware owns all messaging surfaces; nodes and control-plane clients connect to it over WebSocket. Proves the local-gateway pattern works at 77+ channels, but the trust model is "your hardware is the center"; ours is "the cloud agent is the center, your machine is a paired device."
- **Tunnels** (VS Code Remote Tunnels, Cloudflare Tunnel, Anthropic's MCP tunnels): the converged transport standard - the local component dials OUT (WebSocket/cloudflared), the cloud side is the control plane, nothing listens on the user's network. No NAT piercing, no exposed ports.
- **minimi**: per-user MCP relay link into any LLM; INFERENCE (deep dive d527383): query text transits their servers even though storage stays on-device. Our bridge keeps both directions inside our own perimeter.

Conclusion: the standard is settled - outbound-only persistent connection from the machine, cloud control plane, queued commands, streaming results. We are not inventing transport; we are inventing the persistent, memory-integrated, multi-agent device layer on top of it.

## 2. What Kennel is in Waldo's architecture: a new primitive - device

Not a channel (channels are user-facing surfaces with human senders; Kennel's peer is a machine). Not a tool (tools are synchronous, model-invoked capabilities; machine jobs are async, minutes-long, and Kennel also pushes unprompted observations). New primitive: **device** - a paired machine that (a) accepts async jobs, (b) streams observations, (c) advertises capabilities, (d) has an online/offline state the owner can see. Ships as a first-class seam beside channels/, tools/, connectors/: devices/.

## 3. Auth: pairing, not passwords

- Pairing reuses the shipped link-code primitive (SHA-256 at rest, single-use, short-lived): owner says "pair my Mac" in any channel or the console; Waldo shows a one-time code; the Kennel app takes it.
- On redeem, Kennel generates a device keypair (ed25519) locally; the private key never leaves the Mac. The backend stores device row: owner, pubkey, declared capabilities, label ("Shivansh's MacBook"), created/last-seen.
- Every device request carries an ed25519 signature over (timestamp, method, path, body-hash) - no bearer token to leak, which keeps the custody hard line intact. Replay window enforced by timestamp + nonce table in the DO.
- Scope: a device is bound to exactly one owner DO and its declared capability set (capture classes, job classes). Revocation = delete the device row; the DO rejects its signatures immediately. "Devices" page joins the thin console app (list, label, revoke).
- Multi-device is free in this model (n devices per owner) even if beta ships one.

## 4. Transport and presence

- Kennel dials out: WSS to the worker (`/devices/connect`), HMAC-routed to the owner's RunLoopDO, which holds the live socket. Worker remains the thin router it already is.
- Offline Mac (asleep/closed): the DO keeps queued jobs with TTLs; the owner sees honest state ("queued until your Mac wakes") instead of silent failure. Observations spool on-device and batch on reconnect.
- Heartbeat + capability advertisement every connect; last-seen drives the console device page and the model's context ("your Mac is offline" is a fact Waldo can say).

## 5. Memory path: where machine state lands

- Kennel-captured context arrives as **episodes** (raw, timestamped, device-tagged, scope-tagged) via a batched ingest route - the same seam telegram episodes already use (channels/episodes.ts).
- Distillation stays where it belongs: the existing scribe/claims pipeline turns episodes into claims. **Decision needed: provenance vocabulary.** CLAIM_SOURCES today = stated/confirmed/inferred. Machine-captured claims are a distinct trust class: recommend adding `machine` as a fourth source (deliberate contracts change - pinned tests ripple per the roster/hash rules, planned in the same commit). Until that lands, machine claims ingest as `inferred` with `evidence: "kennel:<device-label>"` - works today, but blurs a trust line the dashboard memory explorer will want to show.
- Spots/constellations: unchanged - machine-derived claims strengthen the same constellation domains (projects, routines); the memory explorer gains a "machine" facet.
- Privacy scoping is enforced at INGEST, not just capture: capture scopes (what Kennel may watch - apps, windows, hours) are owner settings stored in the DO; the ingest route drops anything out of scope even if a misbehaving client sends it. Forget barriers and deletion flows (scoped + account) already cover machine data; the account-deletion probe extends to device rows and machine episodes.

## 6. Open loops from machine state

Kennel proposes; Waldo disposes. Kennel emits **loop candidates** (idempotency-keyed: e.g. `uncommitted:waldo-backend:2h`, `unsent:draft-to-sam`) to the ingest route. The loopBook in the DO stays the single registry: dedupe on device key, Waldo decides surfacing under the owner's proactivity settings, closure evidence (commit landed, draft sent) arrives the same way and Waldo closes the loop. Kennel never opens or closes user-visible loops itself - same discipline as every other loop writer.

## 7. Orchestration: Waldo -> Claude/Codex on the Mac

- One new model-visible tool: `delegate_to_machine` (async). Args: job class, prompt/payload, workspace, timeout. The run-loop writes a job row in the DO, delivers over the device socket (or queues offline), and SUSPENDS; the result arrives as a device job-result message and resumes the run with the tool output. This rides the existing trusted-v2 suspend/resume and run-journal audit - no new run-loop machinery.
- Job classes are an allowlist, not arbitrary shell: `claude_code_task` (spawn/steer a Claude Code session via Kennel's harness), `codex_task`, `machine_state_query`, `file_read`/`file_write` (path-scoped), `notify_local`. Arbitrary shell is the one class gated behind an explicit per-job owner confirm from a channel - judgment stays with the model, the deterministic gate sits only on the genuinely destructive line (his law).
- The owner experience this produces: "have Claude finish the auth slice on my Mac and tell me when it's green" - from WhatsApp, walking around. Waldo orchestrates, Kennel executes, the loop closes in-chat. That is the differentiator he described, and nothing shipped does it.

## 8. Backend APIs to expose (all new worker routes are HMAC/signature-verified thin pass-throughs to the owner DO)

1. `POST /devices/pair` (owner session) - mint pairing code. `POST /devices/redeem` - Kennel trades code + pubkey for device registration.
2. `GET /devices/connect` (WSS upgrade, device-signed) - the live socket.
3. `POST /devices/jobs` (from run-loop) / job status + result callbacks over the socket.
4. `POST /devices/episodes` - batched, scoped, idempotent ingest.
5. Memory query tools for Kennel (search_claims / open_loops / recent_context) - same surface as the memory-MCP proposal in the minimi deep dive; Kennel becomes its first consumer before we expose it to third-party LLMs.
6. Console: devices page (list/label/revoke), capture-scope settings.

## 9. Build slices (each gated + live-verified per standing rules)

1. Device pairing + socket + heartbeat (no jobs, no capture) - exit: Kennel app pairs with a code, socket live, console shows the device, revoke kills it.
2. `machine_state_query` + `notify_local` - exit: owner asks Waldo from WhatsApp "is my build done"; Waldo answers from the Mac.
3. Episode ingest + capture scopes + `machine` claim source - exit: machine context shows in the memory explorer with the right facet; out-of-scope ingest provably dropped.
4. Loop candidates - exit: a seeded uncommitted-change candidate becomes a loop Waldo surfaces, and closes on evidence.
5. `claude_code_task` orchestration - exit: the WhatsApp-to-Claude-Code round trip above, audited in the run-journal.

## 10. Open questions for the owner

1. `machine` as a fourth claim source - approve the contracts ripple? (recommend yes)
2. Arbitrary-shell job class: per-job confirm (recommended) or banned outright at beta?
3. Capture defaults: which scopes ON by default at pairing (recommend: app/window titles only; full text opt-in)?
4. Beta: single Mac enforced, or multi-device from day one (model supports it either way)?
5. Claude Code sessions on the Mac run under his Claude subscription - acceptable, or does Kennel need its own API billing path?

Sources: code.claude.com/docs/en/remote-control.md, code.claude.com/docs/en/mobile, code.claude.com/docs/en/claude-code-on-the-web, docs.openclaw.ai/architecture, developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel, platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/concepts, github.com/microsoft/vscode (cli/src/tunnels), projectminimi.com. Repo facts: memory/claims.ts (CLAIM_SOURCES), channels/loops.ts (loopBook), channels/episodes.ts, run-loop/do.ts (RunLoopDO alarm/resume), identity/console-auth.ts + waldo_owners migration (link-code primitive).
