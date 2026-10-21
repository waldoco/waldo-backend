# Files and artifacts flow: state and bounded first slice (proposal)

Status: proposal for review. Layer: SOURCE reading of beta-mvp f29c104. Nothing deployed or run live. Core takes the flow as an engineering-merit decision under the owner's standing "decide on merit, log it" grant, after Dalda's relay via main on 2026-10-02 7:34 PM. This is not an owner approval of the scope. Console, Durable Object and sign-in files stay Codex's single-writer files; every change there is a seam ask below.

## What already exists (verified in source)
Two stores, not one:
1. Artifacts (agent working documents): `channels/artifacts.ts` (metadata in the owner DO, bodies in R2 behind `ArtifactBodies`), tools create/list/read/revise (`artifactHandlers`), owner link page `/console/artifacts` (`artifact-delivery.ts`, `artifactPage`), PDF export (`artifact-exports.ts`, `artifact-export-download.ts`, route constant `/console/exports`, 5 MiB cap, merged #564/#566, inert and unregistered).
2. Workspace files (`packages/workspace`, #424): `workspaceStore` with revisions, provenance (`owner_upload | agent_generated | provider_import | sandbox_output`), limits (10 MiB file, 100 MiB owner, 500 files), R2 bodies with owner binding and admission. Console routes already wired in the DO: `/console/workspace` list, `/console/workspace/file` authenticated download by id and revision, `/console/workspace/upload`, `/console/workspace/remove` (`workspace-host.ts`, `console-workspace`). Agent-facing adapters `workspaceHandlers` (list, read, write text) exist as pure functions and the file comment says Core and contracts own tool registration and ACLs.

## Gap against the delegated flow
| Need | State |
|---|---|
| Create/upload | Owner upload route exists. Agent write exists only as an unregistered adapter (text/plain and text/markdown only). |
| Durable private storage | Workspace store plus R2 exist. Artifact bodies in R2 have no eviction fallback documented. |
| Console browse/preview | List page exists. No preview for artifacts and workspace in one place. |
| Authenticated download | Workspace file download exists. Artifact export route is built but not registered or routed. |
| Agent retrieval | Artifact read tool is registered. Workspace read/list/write are NOT registered as tools. |

## Proposed first slice (Core only, no DO/console files)
Goal: the agent can list, read and write workspace files through registered tools, with correct taint and ACLs. This is the smallest piece that makes the existing durable store usable by the agent.
1. contracts: add `workspace_list`, `workspace_read`, `workspace_write` tool names, arg schemas (strict, the same field sets the adapters accept), `TOOL_PERMISSIONS` triggers (owner-initiated triggers only; none for unattended or external triggers), and handler declarations. `workspace_read` result stamped `external` (file bodies can hold provider text); `workspace_write` stamped null with `mutates_state: true` and `operation_id` required for idempotent retry.
2. runtime: thin handler wrappers in a new `tools/live/workspace.ts` that call `workspaceHandlers(store)` and read the dispatcher `ctx` (turn and call ids) to derive the `operation_id` rather than trusting a model-supplied one.
3. Tests: dispatcher-level taint and ACL tests, an unattended-trigger refusal test, idempotent retry returns the same revision, oversize and wrong-mime refusal, and a guard that no workspace tool is `connector_backed`.
4. Docs: a section tying artifacts and workspace together (which tool for which job) in the prompt-facing tool descriptions, with no behavior rules by text matching.

Files (all Core): `packages/contracts/src/tools/permissions.ts` (+test), a new contracts schema file, `packages/runtime/src/tools/live/workspace.ts` (new), its tests, `docs/`.

## Implementation notes to fold into the slice
- `operation_id`: strip any model-supplied value and derive it from dispatcher ctx (user, turn, tool call). The model never chooses it.
- Decide on purpose whether `workspace_write` joins `PRIVILEGED_ACTION_TOOLS` (reviewer suggests yes) or is limited to the `user_message` trigger. Record the choice and the reason in the PR.
- Trigger names must match the real trigger enum; "owner-initiated" means `user_message`. The tool allowlist must match `TOOL_PERMISSIONS` exactly.
- Add `workspace_list` and `workspace_read` to `EXTERNAL_ORIGIN_TOOLS`.
- Update the `permissions.test` pins deliberately, in the same PR, not by loosening them.

## Seam asks for Codex (via main)
- Register the three handlers in the owner DO tool list and pass the workspace store (`workspaceOwnerHost`) into them. Only this wiring is Codex's.
- Register the PDF exporter and mount `/console/exports` without shadowing `/console/artifacts/` (route design in the earlier export slice, exporter over 5 MiB is never downloadable).
- R2 body-eviction fallback for artifacts: when `bodies.get` returns null, `read_artifact` should return a typed `body_unavailable` and not an empty string. Core can ship the typed result; the DO wiring needs no change.

## Not in this slice
Console preview UI (dashboard lane, Core projections then Codex route), provider imports into the workspace, sandbox outputs, and any change to console sign-in. No spend, no secrets, no staging deploy; release is Codex's.
