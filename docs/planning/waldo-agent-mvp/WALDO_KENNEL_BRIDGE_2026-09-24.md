# Waldo <-> Kennel bridge: unified design (2026-09-24)

Converges the two lane halves - Waldo-backend (KENNEL_BRIDGE_BACKEND_2026-09-24.md, 243ee3d) and Kennel (kennel lane, 6:56 PM, grounded in the Kennel repo at outcome-loop tip). This is the one doc the owner reviews before anything goes back to Ashish.

## The end experience (owner's words, WhatsApp 6:52 PM)

Kennel = Waldo's home on the MacBook. (1) Workhorse: Waldo orchestrates the user's existing agents (Claude, Codex) through Kennel. (2) Machine eyes: Waldo, from WhatsApp/mobile/anywhere, knows and acts on the state of the user's Mac. (3) Minimi-style capture: machine-state + open loops from the Mac enrich Waldo's user context. The gap named: Instinct and every cloud agent is blind to the user's machine; Claude Code/Codex are machine-local but blind to the owner's life. The bridge joins them.

## Shipped truth on both sides

**Waldo backend**: per-owner DO with claims memory (stated/confirmed/inferred), loopBook open-loop registry, episode seam, run-loop with suspend/resume + run-journal audit, link-code pairing primitive, invite-gated console, Vault + connector-proxy custody (no bearer token reaches model/DO/Worker).

**Kennel** (STATUS.md, re-read tonight): stages 0-3 done (contract freeze, persistent Codex substrate, compatibility negotiation, durable owner-command authority incl. pairing + owner-proof ingress), 4-9 partial (harness connection, intake, planning, serial execution, verification custody, integration), 10-12 unstarted. Codex-only harness today; Claude adapter is Stage 12. The orchestration spine (admission, custody fences, exclusive worktree leases, immutable-tree verification) is substantial. NO ambient capture exists - that subsystem is new.

## Industry check (fresh sources, details in the backend half)

Cloud control plane + local component dialing OUT over WebSocket/tunnel is the settled pattern (Claude Code Remote Control, VS Code/Cloudflare/MCP tunnels). OpenClaw inverts it (gateway on user hardware). Nobody ships the owner's vision: a persistent personal agent, living in messaging apps, orchestrating agents on your machine, with life-memory attached. Claude Code Remote Control is the nearest analog and is per-session, dev-scoped, memoryless beyond the repo.

## The bridge: two directions, one pairing, two vocabularies reconciled

The lanes named the same thing from two sides. Reconciled:

- **Device** (backend vocabulary) = how the pipe authenticates: one-time pairing code (shipped primitive), ed25519 device keypair on the Mac (private key never leaves), signed requests, revocation = delete the device row, visible online/offline state.
- **Paired remote owner channel** (Kennel vocabulary) = what authority flows over the pipe: Waldo is a new principal class at Kennel's S1 owner-authority surface. Pairing authenticates transport only; Waldo-originated content is non-authoritative for material transitions (Contract/Plan approval, external effects, Accept) unless it carries the separate one-time owner proof - Kennel's existing propose-vs-authorize split, carried over unchanged.

Both are true simultaneously; they are the two directions of one bridge:

**Direction A - Waldo -> Kennel (commands, orchestration):** Waldo requests missions the way the desktop owner does today (Contract, Plan approval, Watch, Decide) via remote command ingress onto Kennel's typed owner-command model. Routine classes can be owner-delegated by policy; material transitions round-trip to the owner on whatever surface he's holding - approve a Kennel plan from WhatsApp is the killer feature, and it composes with the backend's channel-verified session: the owner's WhatsApp reply IS the proof relay.

**Direction B - Kennel -> Waldo (observations, memory):** one-directional sync over Kennel's trigger-backed CDC rail (change_log tail; the sync sender is a new daemon subscriber, not a second event authority). Kennel ships typed, derived context episodes - never raw streams, never screen recordings - push-with-ack, idempotent, versioned, offline-spooled. Backend ingests via the devices episode route, enforces capture scopes at ingest (dropping out-of-scope data even from a misbehaving client), and distills through the existing claims pipeline. Waldo owns user memory; Kennel owns mission facts; neither edits the other's store.

## Machine capture (Kennel's new subsystem)

AX-tree-first (structured ~100ms reads from the OS, no vision model), pixels-on-demand via ScreenCaptureKit only when a visual check is needed. TCC consent per capability class (Accessibility and Screen Recording are separate macOS grants; user flips them once in System Settings; no programmatic grant exists; dev-binary rebuilds silently revoke). Explicit opt-in UX, app allow/deny list, sensitive-app exclusion by policy, visible capture indicator in kennel-island. Local-first SQLite buffer with retention caps. Kennel's edge over minimi: it has GROUND TRUTH about repo state (workspacewatch, mission state) - unfinished builds, failing tests, uncommitted worktrees - not just pixels. Pattern proofs: andelf/axcli, Bambushu/screenread.

## Joint contracts (the shared surface, deliberately small)

1. **Pairing + capability advertisement** - code mint/redeem, key registration, declared capability classes, heartbeat. (Backend /devices/pair + /devices/redeem + WSS connect; Kennel K1 finishes its public pairing API - a listed P0 gap - for exactly this consumer.)
2. **Episode schema + ack protocol** - typed context episodes (app/window focus, work-session boundaries, artifact refs, machine-derived loop candidates), idempotency keys, versioned packets, ack/replay rules. The ONLY hard Kennel->backend contract.
3. **Command/mission protocol** - Waldo-originated owner commands (typed, owner-proof semantics), mission projection exposure (Watch/Decide), job results. (Kennel K2/K3; backend delegate_to_machine.)
4. **Memory read API** - search_claims / open_loops / recent_context for Kennel; same surface as the memory-MCP proposal, Kennel as first consumer.

## Orchestration model

Backend adds ONE model-visible tool, `delegate_to_machine` (async: run-loop suspends, job result resumes it, run-journal audits). Job classes map onto Kennel's governed-command + coding-profile machinery, each class its own owner-delegated capability: mission_task (Codex today; Claude when the adapter lands), machine_state_query, path-scoped file ops, notify_local. Reconciled on shell: NO raw-shell job class exists at beta - everything rides Kennel's custody/effect fencing (their K6 rule subsumes my per-job-confirm proposal; arbitrary shell is not exposed as a class at all).

## Merged build program (dependency-ordered; K = Kennel slice, B = backend slice)

1. **K1 + B1 - Pairing**: Kennel's public pairing API + backend device registration/WSS/heartbeat. Exit: Kennel pairs with a code from any Waldo channel, socket live, console shows the device, revoke kills it.
2. **K2 + B2 - First round trip**: command ingress + machine_state_query/notify_local. Exit: from WhatsApp, "is my build done" answered from the Mac.
3. **K3 - Mission projection** (Kennel's own Stage 9 P0 gap, shared dependency): Waldo can Watch/Decide. Exit: mission state visible + approval from WhatsApp with owner proof.
4. **K4 - Capture subsystem** (largest new surface): TCC consent UX, AX collector, policy store, island indicator.
5. **K5 + B3 - Catalog + sync**: episode store, CDC subscriber, ack protocol, backend ingest + capture scopes + `machine` claim source. Exit: machine context in the memory explorer, correctly faceted; out-of-scope ingest provably dropped.
6. **K6 + B5 - Governed actions + agent orchestration**: mission_task job classes, loop-candidate closure. Exit: "have Codex finish the auth slice, tell me when green" - the WhatsApp-to-agent round trip, audited end to end.

## Owner decisions (both lanes, deduplicated)

1. **Capture defaults**: off-until-enabled per capability class (both lanes recommend) vs on-at-install.
2. **Waldo's authority at beta**: propose-only, or owner-delegated routine classes from day one? Material transitions stay owner-proof either way.
3. **Claude adapter (Stage 12) pull-forward?** Codex-only covers a first bridge; the full "Claude and Codex" promise needs it.
4. **Capture residency**: do raw episodes ever leave the Mac, or only derived/synced summaries? (Both lanes lean derived-only.)
5. **`machine` as a fourth claim source** (backend contracts ripple; recommend yes - keeps machine-observed a distinct trust class in the memory explorer).
6. **Stage 10 supervisor**: Kennel grows a local Mission Supervisor, or Waldo IS the supervisor remotely over the same typed protocol? Strategic call; the bridge design supports either.
7. **Priority/interleave**: K1-K3 finish existing P0 gaps and align with Kennel's own stage plan; K3 forces some interleave with the Stage 7-9 finish. Confirm ordering.
8. **Multi-device at beta** or single Mac (the model supports either).
9. **Claude usage on the Mac runs under the owner's Claude subscription** - acceptable, or Kennel needs its own API billing path?

## Sources

code.claude.com/docs/en/remote-control.md, code.claude.com/docs/en/mobile, docs.openclaw.ai/architecture, developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel, platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/concepts, projectminimi.com, github.com/andelf/axcli, github.com/Bambushu/screenread. Repo facts: waldo-backend memory/claims.ts, channels/loops.ts, channels/episodes.ts, run-loop/do.ts, identity/console-auth.ts; Kennel STATUS.md, PRODUCT.md, architecture/persistent-mission-runtime.md, harness-connection-and-authority.md, architecture.md 5.3, packages/cloud-client.
