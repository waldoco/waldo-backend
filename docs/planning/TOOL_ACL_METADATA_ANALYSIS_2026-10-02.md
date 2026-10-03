# Tool ACL: where connector classification lives, and denial reasons

Status: analysis plus a small contracts change (draft PR). Layer: SOURCE. Not wired to any host. Origin: engineering follow-up relayed by main from the Codex admission lane on 2026-10-02 ("tool eligibility must not arbitrarily suppress"); not an owner decision recorded by Core.

## 1. Is there a canonical connector-backed classification?

No. I checked contracts and runtime at beta-mvp e9a45fc (5958a8f plus #556).

- `TOOL_PERMISSIONS` (contracts/src/tools/permissions.ts) maps trigger to tool names only.
- `EXTERNAL_ORIGIN_TOOLS`, `PRIVILEGED_ACTION_TOOLS`, `GENERAL_AGENT_TOOLS` (contracts/src/tools/handler.ts) classify taint and privilege, not connector dependence. `EXTERNAL_ORIGIN_TOOLS` is broader than connector-backed (it includes `web_search`, `read_artifact`, `search_episodes`).
- `connectIntentSchema` (contracts/src/tools/connect-intent.ts) lists the Google features (calendar, mail, tasks, availability, drive, docs, sheets, slides) but not which tool needs which.
- The tool-to-feature link exists only as a hardcoded argument inside each handler: `withGoogle(google, 'calendar' | 'mail' | 'tasks' | 'availability', ...)` in packages/runtime/src/tools/live/google.ts (query_calendar, get_communication, search_communication, read_thread, get_tasks, draft_email, send_email, query_availability). For MCP tools the feature comes from the server config's `requires` (runtime/src/tools/live/mcp.ts), so it is per server, not per tool name.

`search_connector`: it is a tool name in the union and in `EXTERNAL_ORIGIN_TOOLS`, but no runtime handler exists for it (the only source mention is a comment in prompt/reasons.ts saying it and `execute_code` have no handler). Its connector dependence cannot be verified, so I do not classify it as connector-backed. The test list therefore leaves it out, and a host that lists it gets a `connector_backed_not_registered` finding.

Consequence: any host-supplied `connector_backed` list is a second copy that can drift from the handlers, which would suppress or admit the wrong operation.

## 2. Proposal (not in this PR): handlers declare their own connector requirement

Add an optional field on `ToolHandler` (contracts/src/tools/handler.ts), for example `requires_connector?: ConnectFeature`, where `ConnectFeature` is the closed enum already in `connectIntentSchema`. The google handlers set it from the same constant they already pass to `withGoogle`, so there is one source. The host derives `connector_backed` from the registered handlers (registered handlers are the authority for what is installed). MCP-backed tools resolve per server from `requires`. This is a small runtime plus contracts change; it should land before the host slice binds `intersectToolAcl`. Until then `connector_backed` is host-supplied and the tests say so.

## 3. Distinct denial reasons (in this PR)

Contract change in contracts/src/tools/acl-intersection.ts. All additive except the result shape, which gains fields (the helper has no callers yet).

- Grants unavailable (absent): `denied`, reason `grants_unavailable`, all tools denied.
- Grants stale: `denied`, reason `grants_stale`, all tools denied. A source reports `stale` when it exists but its freshness check failed; the contract does not decide staleness.
- Connectors unavailable or stale: connector-backed tools removed, the rest stay; `degraded` is `connectors_unavailable` or `connectors_stale`.
- Every removed tool carries a closed reason: `not_in_trigger` (normal, not a defect), `not_granted`, `connector_unavailable`, `connector_not_listed`.
- Config or naming defects are findings and never remove a tool: `granted_tool_not_registered` (a grant names a tool that is not installed) and `connector_backed_not_registered` (the connector list names a tool that is not installed).
- Fail closed stays for GRANTS: with no grant metadata nothing is admitted. It does NOT hold for `connector_backed`: that list is host-supplied, and if the host omits a connector tool from it, the tool is admitted even while connectors are unavailable or stale. Nothing in the contract can detect that omission; the only defect it reports is a listed name that is not registered. An empty available grant set admits nothing and is not the same as unavailable.

## 4. Tests

Reachable-tool cases use real registered names (query_calendar, get_communication, get_tasks, read_artifact, export_artifact, read_mcp_tool, web_search): all admitted with nothing removed when installed, granted and connected; each removal has its own reason; a tool outside the trigger is `not_in_trigger`; stale vs unavailable grants and stale connectors are distinct; defects are findings and keep legitimate tools.

## 5. Merge precondition and host tests

Precondition: the `requires_connector` declaration on handlers, and a `connector_backed` list derived from the registered handlers, must land before any host binds `intersectToolAcl`. Without it, a host omission silently admits a connector tool (see section 3). This change adds no caller, so it is safe to merge alone; binding is what is gated.

Host test required in the slice that binds it: when the freshness check on grants or connector metadata fails, the result is `grants_stale` or `connectors_stale` (not `unavailable`, and not admitted). The contract only takes the status the host passes, so only a host test can prove staleness is reported.

## 6. Open

- The staleness source (what makes grants or connector metadata stale) is a host decision, not defined here.
- Whether `not_granted` should be surfaced to the model or only logged is a host and policy decision; the contract only returns the reason.
