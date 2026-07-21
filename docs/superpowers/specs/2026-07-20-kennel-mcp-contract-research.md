# Kennel desktop-companion MCP contract research

Status: source-backed research only. This note changes no Kennel code, protocol, ticket, or runtime configuration.
Date: 2026-07-20 IST.

## Scope and method

- [observed] Read-only inspection of `C:\Users\Gladius\Documents\Waldo\kennel`, including all production Swift targets, tests, fixtures, package manifest, README, and repository guide. No Kennel build or live-provider interaction was run.
- [observed] Kennelâ€™s declared boundary is a native macOS continuity companion: `KennelCore` owns versioned contracts and deterministic reduction; `KennelCodexAdapter` normalizes official Codex Hooks/App Server input; UI renders semantic projection rather than domain truth. `C:\Users\Gladius\Documents\Waldo\kennel\AGENTS.md:3-16`.
- [observed] This report does not inspect Linear; that is a separate source owned by the coordinator task.

Two hypotheses were tested:

1. Kennel already exposes a live MCP/desktop transport whose schema the Waldo MCP must call.
2. Kennel currently specifies a future-facing, fixture-normalization contract only.

[observed] Hypothesis 2 is supported: the README explicitly excludes live hook installation, local IPC, managed App Server control, persistence, and permissions UI from this slice, and says commands, approvals, deep links, and live connectivity remain disabled. `C:\Users\Gladius\Documents\Waldo\kennel\README.md:67-76`. The app merely creates a resting Island store and passive panel; it starts no adapter, listener, or service. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\Kennel\KennelMain.swift:10-15`.

**Falsifier:** a future committed Kennel implementation of a local transport/registered MCP tool or an end-to-end provider-command executor would replace this conclusion.

## Contract the Waldo MCP must preserve

### 1. Transport and integration boundary

- [observed] No HTTP, stdio, WebSocket, XPC, Unix-socket, URLSession, or MCP-server implementation exists in Kennelâ€™s source tree. Its only executable program is the macOS accessory application. `C:\Users\Gladius\Documents\Waldo\kennel\Package.swift:7-43`; `C:\Users\Gladius\Documents\Waldo\kennel\Sources\Kennel\KennelMain.swift:24-33`.
- [observed] The two available ingestion seams are in-process Swift functions: `normalizeHook(Data, context:)` and `normalizeAppServer(Data, context:)`, each returning a `KennelEventEnvelope`. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCodexAdapter\CodexEventAdapter.swift:36-39`, `112-115`.
- [observed] `ObservationPlane` reserves `hooks`, `appServer`, and `mcp`, but the current Codex manifest declares only Hooks and App Server protocol versions and no MCP protocol/version. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCore\ProviderContracts.swift:19-23`; `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCodexAdapter\CodexCapabilityManifest.swift:16-20`.
- [inference] The Waldo MCP needs a new, explicit local-desktop transport/handshake layer. It must feed the normalized event boundary rather than treat the reserved `.mcp` enum case as proof of a working transport.

### 2. Inbound event envelope and correlation

- [observed] Every outer event requires `eventID`, `schemaVersion`, `occurredAt`, and a typed user/agent/system/care event. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCore\KennelEvents.swift:41-64`.
- [observed] Agent events further require provider, schema version, `sessionID`, time, provenance, sensitivity, and minimized payload; optional fields are thread, turn, item, correlation, and causation identifiers. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCore\ProviderContracts.swift:157-201`. IDs are distinct string-backed Codable/Sendable types, so an integration must not collapse session/thread/turn/outcome/loop/judgment/evidence IDs into one untyped identifier. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCore\Identifiers.swift:3-58`.
- [observed] Reducer compatibility is major-version gated: an event with a different major version fails; duplicate outer `eventID`s are ignored before reduction and are omitted from the returned ledger. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCore\KennelReducer.swift:23-49`; test proof: `C:\Users\Gladius\Documents\Waldo\kennel\Tests\KennelCoreTests\KennelReducerReplayAcceptanceTests.swift:48-59`.
- [inference] A future MCP event-publishing tool must provide stable event IDs and retry using the same event ID. It may offer minor-version forward compatibility, but must reject/renegotiate a major mismatch.

### 3. Supported provider messages and minimized data

- [observed] The capability manifest advertises only four observations: `sessionStarted`, `permissionRequested`, `turnStarted`, and `turnCompleted`; it declares an empty command list, unsupported approvals, empty deep links, and fail-open observation degradation. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCodexAdapter\CodexCapabilityManifest.swift:4-21`. The test locks this claim down. `C:\Users\Gladius\Documents\Waldo\kennel\Tests\KennelCodexAdapterTests\CodexEventAdapterTests.swift:11-22`.
- [observed] Normalized payloads are only session-started `{ workingDirectoryName, startSource, initialState }`, permission-requested `{ judgmentID, toolName, reason? }`, turn-started, turn-completed `{ completed|interrupted|failed, evidence? }`, and session-stopped. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCore\ProviderContracts.swift:105-155`.
- [observed] Hooks support only `SessionStart` and `PermissionRequest`. Session start retains the last component of `cwd`; a permission request retains `tool_name` and only `tool_input.description`. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCodexAdapter\CodexEventAdapter.swift:51-102`. The test explicitly asserts that command content is dropped. `C:\Users\Gladius\Documents\Waldo\kennel\Tests\KennelCodexAdapterTests\CodexEventAdapterTests.swift:48-67`.
- [observed] App Server support is only `thread/started`, `turn/started`, and `turn/completed`; the latter two require a separately injected session ID, while unrecognized thread status becomes `stale` and unsupported completion status is rejected. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCodexAdapter\CodexEventAdapter.swift:127-214`, `232-242`.
- [observed] Fixture provenance says production retains bounded identity, state, an approval reason, and provenance, and discards transcript paths, command content, thread previews, and raw payload after normalization. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelTestSupport\Fixtures\README.md:3-15`.
- [inference] The MCP must treat raw prompts, transcripts, shell command content, repository paths, tool item arrays, and thread previews as inadmissible for Kennelâ€™s public state. It should send only the minimized contract above.

### 4. Admission: size, provenance, consent, and session linkage

- [observed] Raw provider input is rejected above 64 KiB before JSON decoding; malformed/unsupported payloads and missing App Server session context have closed typed adapter errors. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCodexAdapter\CodexEventAdapter.swift:23-32`, `40-48`, `155-157`, `224-230`.
- [observed] The adapter stamps provider `codex`, contract v1, provenance plane/schema/source version, and `privateMetadata` sensitivity on every normalized event. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCodexAdapter\CodexEventAdapter.swift:245-270`.
- [observed] Before an agent event affects state, the reducer requires an existing policy for the eventâ€™s provenance plane, the observation to be allowed by that policy, and an already-linked session. Otherwise it fails with `missingConsent`, `observationNotAllowed`, or `missingSession`. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCore\KennelReducer.swift:147-165`. A consent policy is plane-scoped and additionally carries purpose, allowed observation set, retention, model-sharing, write authority, pause, and delete-on-revocation fields. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCore\ProviderContracts.swift:264-296`.
- [inference] The desktop connection cannot be authenticated merely by a Codex `sessionID`: current code has no desktop-user identity, authentication token, or device-binding contract. The future MCP/IPC handshake must define that owner/device identity and establish consent plus `linkedSession` before publishing provider events.

### 5. Commands, approvals, and error conventions

- [observed] The domain reserves command kinds (`start`, `continue`, `steer`, `answer`, `approve`, `deny`, `interrupt`, `archive`, `exactReturn`) and an `AgentCommand` requires `sessionID`, declared write authority, idempotency key, and timeout. Result statuses are `succeeded`, `denied`, `timedOut`, `unavailable`, or `failed`, with evidence and optional reason. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCore\ProviderContracts.swift:33-54`, `258-345`.
- [observed] A user answer to a pending judgment requests a `sendCommand` effect, but the current reducer neither executes it nor checks the commandâ€™s declared authority against the stored consent policy. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCore\KennelReducer.swift:101-110`. Current capability truth remains: commands and approvals are unsupported. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCodexAdapter\CodexCapabilityManifest.swift:13-15`.
- [inference] Do not expose any MCP write/approval tool as Kennel-integrated until the executor validates session ownership, consent/write authority, idempotency, timeout, and provider capability. The MCP must not rely on the present reducer as the authorization enforcement point.

### 6. State semantics and UI consumption

- [observed] Agent Session, Outcome Verification, and Open Loop are separate state machines joined by IDs. Their public states and evidence types are defined in `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCore\DomainContracts.swift:3-123`.
- [observed] Codex completion only makes an outcome `ready`; the user must explicitly accept it before its open loop becomes `resolved`, and only then can it close. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCore\KennelReducer.swift:112-143`, `188-208`; acceptance test: `C:\Users\Gladius\Documents\Waldo\kennel\Tests\KennelCoreTests\KennelReducerReplayAcceptanceTests.swift:26-46`.
- [observed] The public UI output is an `IslandProjection` with semantic state, density, title/detail, placement, and reduced-motion flag; effects are reposition, persist a judgment, or send a command. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelCore\KennelProjection.swift:3-96`. The UI only renders that projection. `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelUI\IslandShellView.swift:11-44`.
- [inference] MCP-facing status should be derived from this semantic state/evidence model rather than reporting a provider completion as an accepted user outcome.

### 7. Platform/configuration and test gate

- [observed] Kennel is a macOS 15+, Apple-Silicon-first accessory app, bundle identifier `com.heywaldo.Kennel`; it uses a nonactivating, non-key status-bar panel. `C:\Users\Gladius\Documents\Waldo\kennel\AGENTS.md:20-23`; `C:\Users\Gladius\Documents\Waldo\kennel\Support\Kennel-Info.plist:5-24`; `C:\Users\Gladius\Documents\Waldo\kennel\Sources\KennelSystem\IslandPanel.swift:4-31`.
- [observed] There is no environment-variable, account, endpoint, authentication, or IPC configuration in this repository. The event ledger is in memory; durable SQLite replay is explicitly future work. `C:\Users\Gladius\Documents\Waldo\kennel\README.md:69-76`.
- [observed] The declared validation baseline is deterministic Swift tests plus build and app-bundle verification. `C:\Users\Gladius\Documents\Waldo\kennel\AGENTS.md:34-40`; `C:\Users\Gladius\Documents\Waldo\kennel\README.md:43-55`. Live provider work must first conform to public fixture Adapter seams; fake providers must not ship. `C:\Users\Gladius\Documents\Waldo\kennel\AGENTS.md:29-31`.

## Immediate MCP design constraints

1. [proposed] Start with an observation-only, local authenticated bridge that emits the v1 normalized event envelope. It needs explicit desktop-user/device binding because Kennel has none yet.
2. [proposed] Use a capability discovery response derived from `ProviderCapabilityManifest`; today it must report no commands, approvals, deep links, or live connectivity.
3. [proposed] Require event ID idempotency, max 64 KiB provider payloads, full provenance, prior consent, and an already-linked session before reduction.
4. [proposed] Preserve the minimization rule: do not send/store raw transcripts, paths, commands, previews, or model/user content in Kennel event state.
5. [blocked] A state-query/status IPC/API, durable ledger, transport authentication, session-linking flow, consent persistence/revocation, and command executor are not specified by current Kennel code. They need an explicit cross-repo contract before implementation; no existing Kennel API can be truthfully claimed for them.
