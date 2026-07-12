# HEY-166 — Workspace Reader Admission ISA Run Contract

**Status:** proposal package merged in PR #58; no runtime or provider implementation is admitted by
this ticket.

## Current

- [observed] ADR-0076 accepts a typed `WorkspaceMount`/`WorkspaceBlob` seam and requires size
  checks for staged writer/commit admission. It does not set a reader byte cap or a blob shape.
- [observed] HEY-163's accepted contract materialises the blob transport as `Uint8Array`; checking it
  in `SkillLoader` is already after buffering.
- [observed] ADR-0024 gives `skill_body` a 5 KB destination policy; the current Scribe contract
  implements that policy as 5,120 UTF-16 code units. Neither is a raw R2-byte limit.
- [observed] ADR-0028 sets the one-hour user-skill cache and a 300–600-token body envelope, but it
  does not define a model-aware token counter or a raw-reader resource bound.
- [observed] HEY-14 requires oversized R2 content to be rejected before buffering, cache, or prompt
  admission.

## Ideal

The future owner-bound R2 mount admits only a bounded, complete, version-consistent set of mutable
user-skill files. The loader receives parsed, Scribe-admitted values only; it never receives a raw
key, bucket client, stream, or provider metadata. Independently loaded system and connector skills
remain usable if the whole user-skill source fails.

## Proposed Decision Boundary

This package proposes a file-class-specific reader policy for `WorkspaceFile { kind: 'user_skill' }`.
It deliberately does **not** add a universal `WorkspaceBlob` cap or a writer path. Numeric values are
engineering proposals pending review; accepted ADR facts are labelled as such in the companion
proposal.

The unresolved canonical wording is material: ADR-0028's pre-write Scribe placement must be
clarified before a reader invokes the same single Scribe seam immediately before cache/prompt
admission. HEY-167 owns canonical ratification of the model-aware token counter's owner, interface,
and fail-closed behavior; it does not implement the counter.

## Scope And Ownership

Owned in this proposal branch:

- `docs/foundation/HEY-166-ISA-RUN-CONTRACT.md`
- `docs/superpowers/specs/2026-07-12-hey-166-workspace-reader-admission-proposal.md`
- `docs/superpowers/plans/2026-07-12-hey-166-workspace-reader-admission.md`
- `docs/superpowers/specs/2026-07-12-hey-166-workspace-size-policy-research.md`

Explicitly forbidden:

- `packages/**`, `wrangler.jsonc`, bindings, provider clients, R2 object access, deployment, live
  secrets, sanitiser vocabulary changes, and any writer/commit path.

## Criteria

1. Reader admission is bounded before a body is buffered, decoded, cached, or sent to the prompt.
2. R2 list truncation, metadata/body races, invalid UTF-8, malformed frontmatter, source shadowing,
   and prompt-budget failure have deterministic, content-free failure paths.
3. The policy preserves ADR-0076's separate staged writer/commit discipline.
4. The policy names the exact acceptance tests HEY-14 must implement after its prerequisites merge.
5. No artifact treats the proposed byte limits, reader Scribe gate, or token counter as already
   accepted ADR behavior.

## Verification

- Read accepted ADR-0024, ADR-0028, and ADR-0076 from
  `waldo-brain@75591543053dbdda6cf7c7f0210f8d16f36c3db8`.
- Read the current H14/H163 Linear contracts and current `prompt/skill.ts` and Scribe contracts.
- Consult the official Cloudflare R2 Workers API for metadata-only `head`, conditional/ranged `get`,
  and `truncated` list behavior; consult the R2 consistency documentation for per-operation strong
  consistency. Public source URLs are recorded only in the proposal.
- Run repository verification and `git diff --check` before publishing this docs-only package.

## Stop Gate

PR #56 merged HEY-163's contract and PR #58 merged this proposed policy package. HEY-14 remains
blocked by HEY-167's human-approved canonical ADR decision. This ticket does not authorize a live
R2 binding, an R2 writer, a deployment, or a canonical ADR edit.
