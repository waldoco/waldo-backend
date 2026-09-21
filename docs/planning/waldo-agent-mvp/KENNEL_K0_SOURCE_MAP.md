# Kennel K0: bounded source map

20 September 2026 · local read-only inspection for the Waldo showcase

Local HEAD: `173fb0a875fcee0705d003e1f134ac0118517782`. The checkout has an unrelated modified packaged helper and untracked files; all were preserved. This is local source evidence, not verification of remote main, packaged readiness or deployed runtime behavior.

The [current Kennel instructions](https://github.com/waldoco/Waldo-Kennel/blob/173fb0a875fcee0705d003e1f134ac0118517782/AGENTS.md#L17) require Codex-first serial execution, one persistent provider thread per current WorkUnit Attempt, reuse of the existing session controller, daemon authority and evidence before acceptance. Read their linked product/runtime documents before implementation.

| Existing seam | Source |
|---|---|
| Outcome intake, planning approval, Attempt start/cancel/recovery, proof and acceptance routes | [outcomes.go](https://github.com/waldoco/Waldo-Kennel/blob/173fb0a875fcee0705d003e1f134ac0118517782/backend/internal/httpd/controllers/outcomes.go#L88) |
| Approved worker binding on launch | [attempt_spawn.go](https://github.com/waldoco/Waldo-Kennel/blob/173fb0a875fcee0705d003e1f134ac0118517782/backend/internal/service/session/attempt_spawn.go#L11) |
| Codex start/resume with persistent conversation identity | [driver.go](https://github.com/waldoco/Waldo-Kennel/blob/173fb0a875fcee0705d003e1f134ac0118517782/backend/internal/adapters/chatdriver/codexappserver/driver.go#L414) |
| Existing conversation controller | [service.go](https://github.com/waldoco/Waldo-Kennel/blob/173fb0a875fcee0705d003e1f134ac0118517782/backend/internal/service/chat/service.go#L205) |
| Local adapter ingress and separate authority validation | [harness_endpoints.go](https://github.com/waldoco/Waldo-Kennel/blob/173fb0a875fcee0705d003e1f134ac0118517782/backend/internal/daemon/harness_endpoints.go#L44), [server.go](https://github.com/waldoco/Waldo-Kennel/blob/173fb0a875fcee0705d003e1f134ac0118517782/backend/internal/adapters/harnesscommand/server.go#L85) |
| Persisted command claims and deduplication; material commands rejected | [harness_command_store.go](https://github.com/waldoco/Waldo-Kennel/blob/173fb0a875fcee0705d003e1f134ac0118517782/backend/internal/storage/sqlite/store/harness_command_store.go#L30) |
| Artifact handoff composition/materialization | [handoff.go](https://github.com/waldoco/Waldo-Kennel/blob/173fb0a875fcee0705d003e1f134ac0118517782/backend/internal/artifactstore/handoff.go#L49) |
| Receipt-bound checks and completion classification | [terminal.go](https://github.com/waldoco/Waldo-Kennel/blob/173fb0a875fcee0705d003e1f134ac0118517782/backend/internal/service/outcome/terminal.go#L58) |

The source check did not establish a supported cloud-to-daemon relay. K0 therefore includes a narrow device-initiated authenticated bridge, durable task/Outcome/Attempt mapping, acknowledgements and replay-safe progress/result transport. Keep local endpoints on loopback. Pairing identifies a transport; it cannot approve a plan, expand a workspace grant or provide authority through prompt text. Preserve the native owner decision path initially.

Proof scenario: one explicit test-project attachment, one owner-approved bounded task, one Codex session, a small real change, a prescribed check and artifact/diff/test evidence returned to the same Waldo responsibility. Repeat delivery and disconnect/reconnect without duplicate Attempts; cancellation must reconcile the provider's actual state. Keep health and unrelated personal context out of the work packet. Do not add automatic merge, push or deployment.

Claude adapter source exists, but that does not establish equal readiness; test it separately after K0. Current status prose includes older evidence and partial-path warnings. Refresh the exact implementation baseline and run the selected proof before scheduling the full integration.

No daemon, provider, application or tests were run in this audit. The main reviewer spot-checked routes, command admission and Codex resume against source. See [build-plan K0](../WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md) and [worker guide](WORKER_GUIDE.md) for implementation scope.
