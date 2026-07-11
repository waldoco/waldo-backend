# HEY-163 WorkspaceMount Contract Design

**Decision:** fulfil accepted ADR-0029 and ADR-0076 with a contract-only adapter seam. This is a corrective delivery of accepted architecture, not a new R2 design or a generic filesystem.

## Problem

HEY-14 must read selected user skill files and cache their opaque versions. The current backend has no `WorkspaceMount`, no typed workspace-file vocabulary, and no safe way to express an already owner-bound R2 reader. Letting the loader receive `R2Bucket`, a user id, a prefix, or an object key would violate ADR-0076 and contradict HEY-14's no-fabricated-key boundary.

## Options considered

1. **Recommended — typed logical descriptors behind an owner-bound `WorkspaceMount`.** The contract exposes a closed `WorkspaceFile` union, the single `user_skills` prefix, opaque version/write identifiers, and the five methods ratified in ADR-0076. A later runtime adapter privately maps these descriptors to R2.
2. **Raw R2 bucket/key parameters.** Rejected: leaks storage identity into the loader, permits dynamic key construction, and violates ADR-0076.
3. **A generic string filesystem path.** Rejected: creates traversal, tenancy, and model-controlled path risks; it is specifically ruled out by ADR-0076.

## Contract

`packages/contracts/src/adapters/workspace.ts` will export:

- `WorkspaceFile`, a strict closed union of `{ kind: 'today' }`, `{ kind: 'baselines' }`, `{ kind: 'patterns' }`, and `{ kind: 'user_skill', name: SkillName }`.
- `WorkspacePrefix`, exactly `{ kind: 'user_skills' }`.
- `WorkspaceVersion` and `WorkspaceWriteId`, non-empty branded opaque tokens.
- `WorkspaceBlob`, a strict `{ bytes: Uint8Array, version: WorkspaceVersion }` versioned content
  value used for read results and staged write input.
- `WorkspaceWriteOptions` with optional `expected_version`, and `StagedWorkspaceWrite` with a staged opaque id.
- `WorkspaceMount` with `readFile`, `writeFile(file, content: WorkspaceBlob, options?)`, `list`,
  `commit`, and `discard` methods. No method receives a user id, raw path, bucket name, object key,
  or R2 client.

The write-related types faithfully preserve the ADR-0076 staged protocol but add no runtime writer, sanitizer destination, R2 binding, or commit implementation. Existing `skill_body` sanitation remains the only relevant H14 prompt-admission protection; `workspace_file` remains deliberately absent from the current sanitiser vocabulary until a separate writer-policy decision.

This initial closed vocabulary admits the HEY-14 files only. ADR-0076 also anticipates a typed
cold-archive manifest when `retrieve()` needs one, but neither the current H14 loader nor the
planned H15 V1 recall source has defined that manifest shape. We therefore do not invent an archive
descriptor or re-open the vocabulary with a generic string; a later retrieve slice must add one
explicit descriptor and conformance fixture through the contracts owner.

## Data flow

```text
owner-bound DO constructs mount -> list({kind: 'user_skills'}) -> typed files
                                                |
                                                v
                                          readFile(file) -> bytes + opaque version
                                                |
                                                v
                                          HEY-14 fake-first loader cache
```

No owner value, bucket binding, key, or content appears in this contract's public identity vocabulary.

## Verification

- Strict schema tests reject raw strings, traversal-like names, unknown kinds, extra key/prefix fields, blank opaque tokens, and blob metadata that attempts to carry storage identity.
- A structural fake satisfies all five `WorkspaceMount` methods, proving HEY-14 can test without a provider binding.
- Contract typecheck, focused contracts tests, repository verify wall, diff check, and a contract/security review complete the proof.

## Boundaries

- No `R2Mount` implementation, R2 binding, Wrangler edit, deployment, Supabase action, public endpoint, or deletion workflow.
- No generic archive path, scratch document identity, model-provided filename, or writer sanitation policy.
- No HEY-14 runtime loader code in this branch.
