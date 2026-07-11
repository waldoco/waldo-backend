# HEY-166 — Proposed User-Skill Workspace Reader Admission Policy

**Decision status:** proposed engineering policy, pending review and the canonical ADR clarification
tracked in HEY-167. It is not a new accepted ADR and it does not change the generic `WorkspaceMount`
contract.

## Authority And Evidence

| Source | Established fact | Policy consequence |
| --- | --- | --- |
| ADR-0076 (accepted) | `WorkspaceMount` is typed and paths are allowlisted; staged writer/commit admission needs sanitiser, destination, size, and path checks. | Keep the generic mount unchanged. Do not treat a reader as a writer or give every blob a universal cap. |
| ADR-0024 (accepted) and current Scribe contract | ADR-0024 names a 5 KB `skill_body` policy; the current contract implements it as 5,120 UTF-16 code units, and sanitisation has one existing seam. | Reuse the current exact body limit only after decoding. It is not a raw-byte limit. |
| ADR-0028 (accepted) | Mutable skills are lazy R2 reads cached for one hour; bodies target 300–600 tokens; largest trigger K is 8. | Use the one-hour TTL and preserve the K values. A model-aware counter and hard envelope enforcement remain proposed. |
| HEY-14 (current execution contract) | Reject oversize before buffering/cache/prompt admission; no private data in telemetry; no fabricated exclusion for an object never loaded. | Pre-buffer checks belong in the private mount and source failures are separate from the closed eligibility enum. |
| [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) | `head()` is metadata-only; `get()` can be conditional and ranged; list can return fewer than its limit and callers must inspect `truncated`. | Bound a refresh before body reads, conditionalise each read, and never infer completeness from list length. |
| [Cloudflare R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) | Binding reads and lists are strongly consistent per operation. | No eventual-consistency sleeps; a multi-object refresh still verifies every listed version before it becomes a cache snapshot. |

Cloudflare's per-isolate memory ceiling is a platform safety limit, not this application's admission
policy, and is not used to derive any value below.

## Narrow Applicability

This policy applies only to mutable `WorkspaceFile { kind: 'user_skill' }` reads in the future
owner-bound R2 mount. Static context files and all staged writer/commit behavior retain their own
accepted or future policy owners.

## Proposed Bounds

| Boundary | Value | Status and rationale |
| --- | ---: | --- |
| descriptors per user-skill refresh | 16 | **Proposed.** Twice ADR-0028's largest K (8), allowing ranking alternatives without reading an arbitrary unbounded prefix. |
| frontmatter bytes | 4 KiB | **Proposed.** Bounded before parsing so unbounded YAML-like metadata cannot consume the raw-file allowance. |
| raw bytes per user-skill file | 20 KiB | **Proposed.** A 5,120-unit UTF-16 body can be up to 15,360 canonical UTF-8 bytes; the remaining envelope accommodates bounded frontmatter and delimiters. |
| total raw bytes per refresh | 320 KiB | **Proposed.** Exactly 16 × 20 KiB; it is checked before any body is buffered. |
| decoded `body_markdown` | 5,120 UTF-16 code units | **Current contract value implementing ADR-0024's 5 KB `skill_body` policy.** It is revalidated after decode/Scribe admission. |
| cache TTL | 1 hour | **Accepted source-backed value.** ADR-0028's mutable-user-skill cache lifetime. |
| per selected skill | 600 model tokens | **Proposed hard admission maximum pending HEY-167.** ADR-0028 supplies a 300–600-token target/envelope, not a model-aware enforced rejection rule. |
| selected-skill aggregate | `600 × K(trigger)` | **Proposed hard admission maximum pending HEY-167.** It would be 4,800 for `user_message`; the existing 3,000 constant describes only default K=5, not every trigger. |

Every overflow is rejected, never truncated. Truncation changes an instruction-like document and is
not authorised for this surface.

## Required Admission Sequence

1. Construct a fresh owner-bound mount for one refresh. No model output supplies a bucket, key, or
   prefix.
2. Internally call R2 `list` with a hard probe limit of 17 and `include: []`. The future HEY-14
   binding/config path must use compatibility date `2022-08-04` or later (or
   `r2_list_honor_include`) so that `include: []` is honoured. Immediately project returned objects
   to only `size`, `version`, and `etag`; drop every HTTP/custom metadata value without retaining or
   logging it. Reject the entire user-skill source if `truncated` is true, more than 16 entries are
   returned, a descriptor is invalid, or a duplicate logical descriptor appears. Sort descriptors
   deterministically before any read; never silently select an arbitrary first page.
3. Treat each listed metadata `size` as an untrusted numeric input: require a finite safe integer in
   `[0, 20 KiB]`, sum all sizes, and reject the entire source if the sum exceeds 320 KiB. Retain the
   listed opaque version/ETag only inside this one refresh.
4. Call metadata-only `head` for **every** descriptor before any `get`. Each must still match the
   preflight opaque version/ETag and a valid admitted size. Otherwise fail the entire refresh;
   discard the temporary snapshot and do not mix versions.
5. Only after all heads succeed, call conditional `get` for each descriptor with its ETag and
   `{ offset: 0, length: 20 KiB + 1 }`. A failed precondition has no body and is a source failure;
   verify body presence explicitly before stream consumption. The range is the provider-side body
   cap; consume the stream with a local cumulative-length guard rather than blindly calling
   `arrayBuffer()`: before appending a chunk, reject and cancel if it would exceed the admitted
   metadata size. Require returned version, ETag, and exact byte length to match the admitted
   metadata before continuing.
6. Ignore `httpMetadata`, `customMetadata`, and `contentEncoding`. Do not decompress, Base64-decode,
   call `text()`, repair replacement characters, or use a user-provided content type.
7. Copy the admitted byte view to an exact-length buffer, then fatal-decode UTF-8. Reject NUL and
   disallowed control bytes after decoding; invalid UTF-8, an over-limit frontmatter block, or an
   invalid constrained frontmatter document also fails the entire refresh. The cache never retains
   raw bytes or a view backed by a larger provider buffer.
8. Parse only a finite V1 markdown/frontmatter grammar. The file starts with `---` on the first line
   and has a closing `---` line within the first 4 KiB; exactly the 13 strict `Skill` header keys are
   allowed, each key occurs once, and no other header key, anchor, alias, tag, merge key, nested
   object, implicit coercion, or parser default is accepted. Scalar/list types must match the strict
   `Skill` shape without coercion: `trigger_types` has at most 16 values, `required_tools` at most
   32, `required_connectors` at most 16, every list member at most 100 code units, and
   `trigger_condition` at most 1,024 code units. The implementation adds the current `skill_body`
   5,120-unit cap to `body_markdown` and revalidates the result through the strict `Skill` contract.
9. Require trusted owner-bound DO `SkillRow` state for lifecycle/security fields; R2 frontmatter is
   not authoritative. The parsed name, version, provenance, `identity_locked`, and `provisional`
   values must match the trusted row. `skillRowSchema` invariants then prevent a user skill from being
   provisional and an agent-authored skill from claiming `intervention` or `fetch_alert`. Require
   `descriptor.name === skill.name`, allow only `user` or `agent_authored` with
   `identity_locked: false`, and reject a collision with a bundled system or connector identity.
10. Apply the existing single Scribe `skill_body` seam with `source_taint: 'external'` and the
    **current invocation's** canary tokens immediately before a value reaches cache/prompt admission.
    It must not write back or create a second sanitizer. Revalidate the complete `Skill` after
    Scribe returns its in-memory replacement body. This is a proposed clarification of ADR-0028 and
    cannot be claimed as accepted until HEY-167 lands.
11. Cache only the complete parsed, bounded, version-attested, Scribe-reduced snapshot, owner-scoped
    and versioned, for at most one hour. Every cache hit runs the same Scribe `skill_body` admission
    again with current canaries and `source_taint: 'external'` immediately before prompt use; a new
    rejection discards that cache entry and drops the user source for the load. Do not key the cache
    by canary and never cache raw bytes, provider metadata, failures, or a partial user-source result.
    Invalidate on ADR-0028's user-skill creation, Settings edit, and Dreaming promotion/revert, on
    user deletion of a listed skill, and on TTL expiry.
12. HEY-167 must ratify the model-aware counter's owner, interface, and fail-closed behavior before
    HEY-14 implements the proposed 600-token per-skill and `600 × K(trigger)` hard rejections.
    Until then, the ADR-0028 envelope is an expected budget, not a proof that a byte/character value
    is prompt-safe.

The mount's private list/ETag snapshot avoids torn objects and mixed listed versions for a refresh.
It must not claim a cross-object storage transaction or use a sleep to simulate one.

## Failure And Observability Policy

Any list, preflight, version race, body-length, decode, parse, provenance, Scribe, or token-budget
failure drops the entire mutable user-skill source for that load. Independently loaded system and
connector sources continue normally. A valid, non-invalidated cache hit is eligible only for the
current-session Scribe pass above. On TTL expiry or explicit invalidation, discard the prior snapshot
before refresh; a refresh failure neither serves nor repopulates stale cache, and never extends TTL.
An invalidation increments a generation/epoch, so an in-flight refresh may write cache only when its
starting generation still matches.

Failures use a closed, content-free category such as `workspace_source_rejected`,
`workspace_version_changed`, `workspace_decode_invalid`, `workspace_parse_invalid`,
`workspace_scribe_rejected`, or `workspace_prompt_over_budget`. No category or metric label may
contain body text, R2 key/path, skill name, owner/user identifier, version/ETag, provider error, or
run identifier. An unreadable object is not a `SkillExclusion`: the current exclusion enum represents
only successfully loaded skills that later fail an eligibility stage.

## Required HEY-14 Test Matrix

| Case | Required proof |
| --- | --- |
| descriptor limit, truncated list, duplicate, malformed descriptor | no body read; whole user source fails; system/connector results survive |
| compatibility/include metadata | compatible binding honours `include: []`; mount projects only size/version/ETag and retains/logs no HTTP/custom metadata |
| exact 20 KiB and 20 KiB + 1 | exact object may proceed; over-limit `head` causes no `get` or buffer |
| total 320 KiB and N+1 | source fails before the first body buffer |
| lying metadata/ranged body | provider range plus local cumulative guard bounds the body; length mismatch reaches neither decode nor cache |
| list/head/get version race | all heads complete before the first get; explicit missing body/mismatch means no retry sleep, parse, cache, or prompt entry |
| invalid UTF-8, NUL/control, compression metadata bait | fatal/control rejection with no repair, decompression, or logged content |
| frontmatter delimiter, duplicate key, cardinality, coercion, or hostile parser feature | no cache/prompt entry |
| descriptor/name mismatch or missing/mismatched trusted `SkillRow` | no cache/prompt entry |
| user-provisional or agent-authored safety-trigger claim | trusted lifecycle invariants reject the mutable source |
| proposed 600-token boundary and K=8 | pending HEY-167: 600 would admit, 601 would reject, and `user_message` would cap at 4,800 |
| cache hit with new canary, create/edit/delete, Dreaming promotion/revert, TTL, stale version, two owners, in-flight refresh | current-session Scribe reruns; explicit invalidation triggers, owner isolation, no stale repopulation, no raw-byte retention |
| all failure paths | only closed content-free telemetry; never a fabricated per-skill exclusion |

## Handoff And Blocking Decision

HEY-14 may consume this policy only after:

1. HEY-163's typed mount seam is merged;
2. this HEY-166 proposal is reviewed and accepted; and
3. HEY-167 resolves the canonical reader-Scribe/token-counter authority.

The implementation owner must add the private R2 mount and its fake-R2 tests in HEY-14's isolated
worktree. No R2 binding, writer, deployment, or canonical ADR edit is part of this proposal branch.
