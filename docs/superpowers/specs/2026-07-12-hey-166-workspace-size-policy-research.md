# HEY-166 Workspace Size Policy Research

**Question:** Do the accepted workspace, sanitiser, and skill-loader sources ratify an application-level byte cap for `WorkspaceBlob`?

**Answer:** No. None of the routed primary sources defines a numeric byte cap for `WorkspaceBlob`, an R2 workspace read, or workspace metadata.

## Source Routing

| Source | Status | What it can establish |
| --- | --- | --- |
| `waldo-brain@75591543053dbdda6cf7c7f0210f8d16f36c3db8` ADR-0076 | Primary, accepted | Workspace seam, staged-write discipline, and the requirement for a later writer to apply size limits. |
| Same commit, ADR-0024 | Primary, accepted | Named sanitiser destination caps and their units/overflow behavior. |
| Same commit, ADR-0028 | Primary, accepted | Skill loading, R2 cache, prompt-token budgets, and the write-versus-load sanitiser boundary. |
| Current `packages/contracts/src/memory/sanitise.ts` and `prompt/skill.ts` | Primary implementation | The currently owned text-size policy and current absence of a workspace-file destination. |
| HEY-14/HEY-163 Linear facts supplied in this task | Context | HEY-163 asks for a bounded blob/metadata result while deliberately excluding provider wiring and a writable runtime path. |
| DeepWiki | **Consulted as a non-authoritative target/source map** | Identified `WorkspaceMount` as the target and found no numeric cap; accepted ADRs remain authoritative. |
| Cloudflare Workers R2 API reference (consulted 2026-07-12) | Primary provider documentation | `head()` returns metadata including byte `size` without a body; `get()` returns the body stream. |

## Observed Facts

1. ADR-0076 defines `WorkspaceMount` but does not give `WorkspaceBlob` a shape, unit, or numeric size ceiling (`0076-r2-workspace-mount.md:22-34`). Its only size language is in **Write Discipline**: a runtime `commit` follows sanitiser checks, destination policy, size limits, and path validation; generated workspace content needs bounded size/truncation (`:43-47`). That is a writer-policy obligation, not a ratified generic blob limit.

2. ADR-0024 pins hard limits only for named text surfaces: memory-block body 2 KB, sandbox stdout 10 KB, draft document 50 KB, draft email 10 KB, and skill body 5 KB (`0024-scribe-sanitiser-canonical-spec.md:137-147`). Its canonical check applies `output.length` to the selected surface (`:178-185`). No workspace/blob surface appears in that table or the cited sanitiser destination union (`:93-101`).

3. ADR-0028 says ADR-0024 sanitises `skill_body` **before R2 write, not load** (`0028-skill-loader-prompt-builder-integration.md:21-25`). It describes lazy R2 user-skill fetching and a one-hour cache (`:69-74`, `:236-246`) plus a 300-600-token-per-skill prompt budget (`:282-288`), but no raw-byte read limit or blob-metadata limit.

4. Current contracts preserve this ownership split. `sanitise.ts` has `skill_body.max_chars = 5_120` (`packages/contracts/src/memory/sanitise.ts:95-102`) and applies caps in UTF-16 character units only to selected destinations (`:538-549`); `workspace_file` is absent from the destination vocabulary (`:13-25`). `prompt/skill.ts` requires a nonempty, fence-safe `body_markdown` but has no independent length maximum (`packages/contracts/src/prompt/skill.ts:22-42`).

5. Cloudflare's Workers R2 API exposes object metadata, including byte `size`, through `head()` and
   exposes the object body through `get()` separately. A future private `R2Mount` can therefore
   reject an object against an admitted byte policy before reading it into an `ArrayBuffer`; that
   provider detail must not be added to the `WorkspaceMount` loader interface. [Cloudflare Workers
   R2 API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

## Inference

- **[inference]** A universal `WorkspaceBlob` byte cap would conflate two unratified concerns: raw bytes admitted before decoding and already-sanitised text admitted to the prompt. The mount can carry multiple logical file kinds, while the only existing 5 KB rule is specifically the `skill_body` text policy.
- **[inference]** `Uint8Array` is a transport representation, not an application-level resource bound. It cannot by itself satisfy HEY-163's “bounded” acceptance wording in the memory/DoS sense.
- **[inference]** A reader still needs a pre-decode resource policy before it turns a user skill blob into prompt content, but the sources do not authorize this ticket to choose its numeric threshold.

## Conflict

HEY-163's acceptance phrase “bounded `WorkspaceBlob`/metadata result” is more specific than the routed ADRs: it asks for boundedness, while the ADRs supply neither a `WorkspaceBlob` byte value nor a workspace-reader policy owner. It is therefore an unresolved acceptance ambiguity, not evidence that ADR-0024's 5 KB skill-body cap is a blob-byte cap.

## Rejected Option

**Do not copy ADR-0024's 5 KB `skill_body` limit into `WorkspaceBlob`.** It is a sanitised text cap, implemented in character units, and runs before R2 writes. Applying it to all raw byte blobs would invent a unit, a scope, and behavior for static workspace files, binary/invalid-UTF-8 input, and reader admission that no routed source defines.

## Proposed Ownership And Next Step

**[proposed] Do not change the generic `WorkspaceBlob` schema in HEY-163.** Keep the contract as a transport seam and do not claim that it has a ratified application-size bound.

**[proposed] Assign HEY-166 the policy-ratification follow-up before HEY-14 consumes blobs into prompt text or any writer is implemented.** The decision must name:

1. the boundary being capped (raw bytes before decode, sanitised decoded skill text, writer input, or each separately);
2. the applicable logical file kinds;
3. an exact numeric limit and unit;
4. reject versus truncate behavior and content-free observability; and
5. the owner for the reader policy versus ADR-0076's future `workspace_file` writer/sanitiser policy.

The future private adapter should check object metadata against the admitted byte policy before it
calls `get()`/buffers the body. HEY-14 must receive only an admitted `WorkspaceBlob`, never a raw
R2 object, key, size, stream, or cap-bypass flag.

Until that decision exists, HEY-14 must not infer a raw-byte cap from the 5 KB skill-body policy, and a future writer remains blocked on its explicit `workspace_file` destination, sanitisation, size, deletion/export, and metadata-only logging obligations.

## Confidence

- **High:** no routed primary source ratifies an application-level `WorkspaceBlob` byte cap.
- **High:** the existing 5 KB skill-body cap is surface-specific text policy, not a generic raw-byte policy.
- **Medium:** the proposed reader/writer ownership split is the smallest source-consistent next step; the exact cap requires a new ratified policy decision.
