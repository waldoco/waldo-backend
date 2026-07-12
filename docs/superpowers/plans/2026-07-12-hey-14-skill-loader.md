# HEY-14 — Mutable Skill Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Implement the fake-first runtime SkillLoader required by ADR-0028 and accepted ADR-0083: it merges independent system, connector, and mutable sources; applies the five-stage eligibility pipeline and deterministic top-K selection; and admits mutable bodies only through bounded, version-attested, canonical-Scribe reads and exact model-attempt budget proof.

**Architecture:** The runtime loader is a deep module with one public loading call. Its private mutable reader owns bounded acquisition, strict transport/frontmatter evidence, trusted-record reconstruction, Scribe cache admission, cache generation invalidation, and content-free source failure. The loader owns source merge, filters, ordering, mutable prompt re-admission, and the budget-failure precedence. The existing REASONS serializer remains the only renderer for fragments and the final fence. RuntimeLLMProvider mints an opaque budget capability for each actual model attempt; it neither selects a model in the loader nor calls a live tokenizer/provider.

**Tech Stack:** TypeScript 5.9.3, Zod 4.4.3, Vitest 4.1.9, Cloudflare Workers test pool 0.16.20. No new dependency, R2 binding, configuration, or external service.

## Current → Ideal → Gap Contract

| State | Contract |
| --- | --- |
| Current | [observed] The accepted contracts define the loader result shape, filter vocabulary, top-K values, canonical Scribe implementation, REASONS wrapper syntax, and retrying RuntimeLLMProvider. [observed] There is no runtime skills module, bounded mutable reader, cache, route-bound counter, R2 binding, or prompt-builder implementation. |
| Ideal | [proposed] One deep fake-first loader returns the existing SkillFilterResult shape, keeps independently loaded static sources available after a mutable failure, and allows a mutable body into cache/prompt only after the ADR-0083 sequence. Each route attempt gets a model/revision-bound capability that proves the exact canonical fragment and block envelopes. |
| Gap | [blocked] The current canonical serializer exposes only wrapSkills(skills): string. ADR-0083 requires its exact fragment and block artifacts for counting and later insertion, so the ticket's older “no contract changes” line must be reconciled before code changes. |

## Authority Reconciliation and Preflight Gate

- [observed] HEY-14 describes its impact surface as “no contract changes”; that text predates accepted ADR-0083.
- [observed] ADR-0083 requires the canonical serializer to produce opaque SkillPromptFragment and SkillPromptBlock artifacts through renderSkill and renderBlock, while preserving one serializer.
- [inference] A source-compatible additive extension to packages/contracts/src/prompt/reasons.ts is unavoidable. Calling wrapSkills([skill]) for a per-skill count includes the outer fence, while reproducing the skill tag in runtime would create a forbidden second serializer.
- [observed] The human approved this narrow ticket-scope exception on 2026-07-12: modify only prompt/reasons.ts and its tests to expose canonical fragment/block artifacts plus a serializer revision, preserving wrapSkills() output byte-for-byte. No schema/result-shape or other public-contract change is approved.

## Global Constraints

- ADR-0024 is the one mutable-body policy. Call existing prepareWithScribe in memory with skill_body, external taint, and the invocation's current canaries. Do not add a sanitizer, vocabulary, or write-back.
- ADR-0076 continues to own staged writer validation and commit discipline. This reader never calls writeFile, commit, or discard and does not use the already-materialized WorkspaceMount.readFile() path to claim pre-buffer safety.
- The private source is owner-bound at construction. Its methods, errors, tests, telemetry, and cache keys must not expose a raw bucket, R2 key, owner selector, body, prompt, health datum, secret, object version, or tokenized text.
- The implementation remains fake-first: no R2Mount, Wrangler/config/binding change, real provider/tokenizer call, deployment, Cloudflare/Supabase action, package/lockfile change, prompt-builder wiring, writer/commit code, or universal WorkspaceBlob cap.
- Mutable read limits are HEY-166's user-skill-only bounds: at most 16 descriptors (probe at 17), at most 4 KiB frontmatter, at most 20 KiB raw bytes per file, at most 320 KiB per refresh, and at most 5,120 decoded UTF-16 code units. They are not generic storage limits.
- A cache entry may contain only a complete, version-attested, Scribe-admitted reconstructed Skill snapshot and its opaque internal version/generation/expiry. It never retains raw bytes, streams, frontmatter, storage metadata, identifiers, or failure results; TTL is at most one hour.
- A counter is a proof capability, not an estimate. Unavailable, unmapped, unpinned, serializer-mismatched, or failed counting produces no skills block for that attempt. Never use byte or character length as a fallback.
- Keep observed, inference, proposed, and blocked labels in handoff and Linear material. Use synthetic neutral fixture text only.

## Exact Owned-file Manifest

| Action | File | Purpose |
| --- | --- | --- |
| Modify, only after preflight approval | packages/contracts/src/prompt/reasons.ts | Canonical opaque fragment/block rendering and revision; preserve wrapSkills compatibility. |
| Modify, only after preflight approval | packages/contracts/src/prompt/reasons.test.ts | Lock renderer composition and byte-identical legacy output. |
| Add | packages/runtime/src/skills/budget.ts | Opaque resolved budget capability and fail-closed default capability. |
| Add | packages/runtime/src/skills/mutable-reader.ts | Private bounded reader, trusted reconstruction, Scribe cache admission, cache invalidation. |
| Add | packages/runtime/src/skills/loader.ts | Deep source merge/filter/rank/re-admission/budget module. |
| Modify | packages/runtime/src/llm/provider.ts | Mint one budget capability per actual attempt and pass it to rendering. |
| Add | packages/runtime/test/mutable-skill-reader.test.ts | Deterministic fake-R2/cache/Scribe/writer-spy matrix. |
| Add | packages/runtime/test/skill-loader.test.ts | Filter/ranking/budget/independent-source tests. |
| Modify | packages/runtime/test/llm-provider.test.ts | Primary/reduced/fallback capability-minting proof. |
| Add at completion | docs/foundation/HEY-14-PHASE-HANDOFF.md | Evidence-led next-phase handoff; no secret/content values. |

Not owned: packages/contracts/src/adapters/workspace.ts, packages/runtime/src/do-schema.ts, wrangler.jsonc, generated binding types, live R2/provider adapters, run-loop prompt assembly, writers/committers, deployments, and external resources.

---

### Task 1: Extend the one canonical REASONS serializer without changing its rendered bytes

**Files:**

- Modify: packages/contracts/src/prompt/reasons.ts
- Modify: packages/contracts/src/prompt/reasons.test.ts

**Interfaces:**

- Consumes: Skill from packages/contracts/src/prompt/skill.ts.
- Produces: branded opaque SkillPromptFragment and SkillPromptBlock string artifacts, a fixed serializer revision, renderSkill(skill), renderBlock(fragments), and the existing wrapSkills(skills).
- Compatibility requirement: wrapSkills([]) stays the empty string; every nonempty current fixture stays byte-for-byte identical.

- [x] **Step 1: Write RED renderer tests before implementation**

    - A one-skill fragment is exactly the inner skill element and never includes available-skills.
    - renderBlock([fragment]) creates the exact outer fence and renderBlock([]) is the empty block.
    - Multiple canonical fragments join with exactly one blank line.
    - wrapSkills([skillA, skillB]) equals renderBlock([renderSkill(skillA), renderSkill(skillB)]) and preserves all existing locked fixtures.
    - The revision is fixed and only consumed by the budget factory; no caller supplies it.

- [x] **Step 2: Run RED**

    npx -y pnpm@10.34.4 --filter @waldo/contracts test -- reasons

    Expected: fail because the artifact types/functions/revision do not yet exist.

- [x] **Step 3: Implement the smallest canonical artifact seam**

    - Keep the actual skill-tag string construction in renderSkill only.
    - Compose the outer wrapper and separator in renderBlock only.
    - Make wrapSkills a compatibility delegator through those two functions; do not change its signature, schema, empty result, tag spelling, whitespace, escaping behavior, or output.
    - Keep artifacts opaque at TypeScript boundaries; do not add a second renderer, parser, or renderer input sourced from user content.

- [x] **Step 4: Run GREEN and non-vacuity check**

    npx -y pnpm@10.34.4 --filter @waldo/contracts test -- reasons
    npx -y pnpm@10.34.4 --filter @waldo/contracts typecheck

    Temporarily alter the block separator in the implementation, confirm the exact-output test fails, restore it, and do not commit the deliberate mutation.

**Task 1 evidence (2026-07-12):** RED observed the missing artifact exports. The final focused
contracts run passed 49 files / 1,197 tests, contracts typecheck passed, and git diff --check was
clean. A separator mutation made the exact-output assertions fail and was restored. Independent
review found no P0/P1 issue; its P2 opacity-test finding was fixed in 04a13b8 and re-reviewed
approved.

---

### Task 2: Add a private, fail-closed route-attempt budget capability

**Files:**

- Add: packages/runtime/src/skills/budget.ts
- Modify: packages/runtime/src/llm/provider.ts
- Modify: packages/runtime/test/llm-provider.test.ts

**Interfaces:**

- Consumes: ModelName, the canonical serializer revision, SkillPromptFragment, and SkillPromptBlock.
- Produces: ResolvedSkillBudget with only countRenderedSkill(fragment) and countRenderedBlock(block), plus CountResult:

      { ok: true, tokens: number }
      { ok: false, code: 'unavailable' | 'unmapped_model' | 'unpinned_revision' | 'count_failed' }

- The provider-owned factory receives the actual attempted model and serializer revision, closes over the pin/revision/counter, and returns a capability that exposes none of those values to the loader/caller.
- When no capability is injected, it returns unavailable. There is no character/byte approximation and no live tokenizer integration in HEY-14.

- [x] **Step 1: Write RED provider tests**

    - A render callback receives one opaque capability for the configured model attempt.
    - A gateway-failed primary/fallback path causes a second render with a newly resolved capability for the fallback model; a first-attempt count cannot be reused.
    - The factory receives the exact canonical serializer revision and only the provider's chosen model, never a model from prompt/loader input.
    - Existing render callbacks and provider behavior remain compatible when they ignore the new field.

- [x] **Step 2: Run RED**

    npx -y pnpm@10.34.4 --filter @waldo/runtime test -- llm-provider

- [x] **Step 3: Implement the minimal closed capability**

    - Add the capability to RuntimeLLMRenderInput and mint it immediately before each input.renderRequest call in RuntimeLLMProvider.complete().
    - Keep the resolver dependency optional and fail closed by default.
    - Do not modify gateway request construction, provider network behavior, model roster, or fallback policy.
    - Do not put tokenizer model/revision strings on RuntimeLLMRenderInput or telemetry.

- [x] **Step 4: Run GREEN**

    npx -y pnpm@10.34.4 --filter @waldo/runtime test -- llm-provider
    npx -y pnpm@10.34.4 --filter @waldo/runtime typecheck

**Task 2 evidence (2026-07-12):** RED observed missing factory/capability delivery, then
capability opacity/count-normalisation failures before their implementations. The final focused
runtime run passed 22 files / 570 tests, runtime typecheck passed, and git diff --check was clean.
Independent review found that asynchronous counter proof could not traverse a synchronous renderer;
cac6c80 widened the renderer return source-compatibly and awaits it before validation/egress. The
follow-up review approved the fix and confirmed primary/retry/fallback each receive a fresh capability.

---

### Task 3: Build the private bounded mutable reader and its deterministic fake-R2 matrix

**Files:**

- Add: packages/runtime/src/skills/mutable-reader.ts
- Add: packages/runtime/test/mutable-skill-reader.test.ts

**Interfaces:**

- Private owner-bound read source: a logical descriptor list, metadata head, and conditional bounded stream. No public member accepts or returns a bucket, raw object key, owner selector, provider client, object path, raw blob, or body string.
- Private trusted-record resolver: returns owner-bound SkillRow records by logical SkillName only. It is injected for fakes; the current DO table is not treated as a production owner-bound resolver.
- Private reader result: either complete reconstructed mutable Skills or a closed, content-free source-failure category. It never emits a fabricated SkillExclusion for an unloaded object.
- Cache API: read/refresh through a max-one-hour cache and invalidate() generation hook. A refresh captures generation before I/O and can write only if it still matches after full admission.

**Read algorithm, in required order:**

1. Probe the logical list with a maximum of 17. Reject truncation, more than 16, duplicates, or non-mutable/trusted-row absence as a whole-source failure.
2. Head every descriptor before any body read. Reject a per-object value above 20 KiB or a cumulative value above 320 KiB before body acquisition.
3. Perform only a conditional/ranged stream for each headed version. Reject no-content, a different version, short/overrun stream, or an invalidation generation change; never retry/sleep.
4. Stream only within the proven bound, fatal-decode UTF-8 with a final flush, and reject NUL/disallowed controls, invalid byte sequences, or decoded text above 5,120 UTF-16 code units.
5. Parse a finite frontmatter grammar no larger than 4 KiB. It must use an opening and closing delimiter and exactly the 13 strict Skill header keys once each (every Skill field except body_markdown), with scalar/list syntax matching the strict Skill shape and no coercion. Reject unknown keys, duplicates, YAML anchors/tags/merges/nesting, oversized list members, and trusted-field mismatches. Do not add or import YAML.
6. Reconstruct every authority-bearing field from the trusted SkillRow; R2 contributes only body_markdown. Revalidate a full Skill through prepareWithScribe(skill, skillSchema, skill_body, external, currentCanaries) immediately before cache insertion.
7. Admit an entire refresh atomically only after every candidate succeeds. Store only reconstructed Scribe-admitted Skills and opaque internal version/generation/expiry facts. Do not write any admitted/modified content to storage.

- [x] **Step 1: Write RED reader tests in small vertical slices**

    1. Exact 20 KiB is permitted while 20 KiB + 1 rejects before any body read, buffer, decoder, parser, cache write, or prompt use.
    2. The list probe rejects 17/truncated/duplicate logical descriptors; all metadata heads happen before the first body request; the 320 KiB aggregate is enforced.
    3. Conditional no-content, metadata/body validator mismatch, short stream, overrun stream, and concurrent invalidate-after-read discard the whole refresh without a retry timer or cache write.
    4. Split invalid UTF-8 where failure is detected only by TextDecoder's final flush; reject controls and decoded over-limit content.
    5. Reject malformed delimiters, unknown/duplicate/coerced/nested/anchor/tag frontmatter and evidence/trusted-row mismatch. Assert attacker-provided values cannot change trusted provenance, trigger, tools/connectors, effectiveness, lifecycle, rank, or wrapper attributes.
    6. Prove Scribe runs before cache entry and re-runs on a cache hit with new canaries; a denial evicts the affected mutable cache entry/source and no raw bytes/frontmatter survive.
    7. A writer-shaped fake's write/commit/discard spies remain untouched. No test fixture contains a real owner/key/bucket or private text.

- [x] **Step 2: Run focused RED after each slice**

    npx -y pnpm@10.34.4 --filter @waldo/runtime test -- mutable-skill-reader

- [x] **Step 3: Implement only enough to pass each slice**

    - Use TextDecoder('utf-8', { fatal: true }) with stream decoding and a final decode() call.
    - Use fixed numeric constants scoped to this private reader, with names that make their user-skill-only purpose explicit.
    - Do not log. If an injected telemetry callback is needed for a later seam, give it only a closed failure category and add an assertion that it cannot receive body/identity/version fields.
    - Keep Scribe as an import/call to the existing prepareWithScribe implementation; test its invocation through a module spy that delegates to the real implementation, not an alternate sanitizer.

- [x] **Step 4: Run GREEN plus adversarial no-sleep proof**

    npx -y pnpm@10.34.4 --filter @waldo/runtime test -- mutable-skill-reader
    npx -y pnpm@10.34.4 --filter @waldo/runtime typecheck

    Use fake timers in a race fixture to prove no retry/backoff timer is scheduled. Temporarily remove the generation check, confirm the in-flight invalidation assertion fails, restore it, and do not commit the deliberate mutation.

**Task 3 evidence (2026-07-12):** The deterministic fake-reader suite passed 23 runtime test
files / 593 tests, runtime typecheck passed, and git diff --check was clean. It covers exact and
over raw/list boundaries, all-heads-before-open, list/head/body validator races, exact stream
length, final-flush UTF-8, strict 13-field JSON frontmatter, trusted reconstruction, body-only
canonical-Scribe admission followed by full-Skill revalidation, cache TTL/current-canary
re-admission/eviction, inactive-record complete attestation, generation invalidation/no timers,
and writer-operation spies. Removing the generation guard made the in-flight invalidation assertion
fail; it was restored. Two independent reviews plus package re-review approved a6d9480..b138338.

---

### Task 4: Compose the deep loader: sources, five filters, deterministic selection, re-admission, and budget precedence

**Files:**

- Add: packages/runtime/src/skills/loader.ts
- Add: packages/runtime/test/skill-loader.test.ts

**Interfaces:**

- Consumes: independently loaded static system and connector sources, the private mutable reader, TriggerType, TOOL_PERMISSIONS, current canaries, connector availability, user-state facts, SKILL_TOP_K/default, canonical renderer artifacts, and the attempt budget capability.
- Produces: the existing SkillLoader<RuntimeSkillLoadContext>.loadForTrigger(ctx) → SkillFilterResult. No second public loader method and no model choice in the loader.
- User-state facts are owner-bound/injected: dismissed_today, provisional_reverted, identity_drift, and priority_pin. SkillRow.pinned is never used as priority_pin because it remains an archival exemption.

**Selection algorithm:**

1. Load system and connector sources independently; load the mutable reader as a third source. A mutable read/admission failure drops only that whole source with no fabricated exclusion.
2. For each loaded candidate, append typed exclusions in stage order: trigger mismatch; ACL required_tools subset failure against TOOL_PERMISSIONS[trigger]; unavailable required connector; then dismissed/provisional floor/provisional revert/identity drift.
3. Rank remaining candidates by priority_pin descending, effectiveness descending, last_used descending with null last, then name ascending as the deterministic final tie-break. Select published K for the trigger or default 5.
4. Render each selected candidate only through renderSkill and count the resulting opaque fragment. If a viable counter reports a mutable selected fragment above 600, drop the entire mutable source, rerun selection from independently loaded static sources, and never truncate.
5. A counter unavailable/unmapped/unpinned/mismatched/error, a static fragment above 600, or a final canonical block above 600 × K clears selected so the existing empty wrapSkills result emits no available-skills fence.
6. Immediately before a selected cached mutable candidate contributes to the result, call the same canonical Scribe seam with current canaries. A denial evicts mutable cache and drops the whole mutable source before static reselection. The final block counted in this task must equal the canonical block later obtained by wrapSkills(selected).

- [ ] **Step 1: Write RED filter/rank tests**

    - Zero sources returns { selected: [], excluded: [] }.
    - Each of the five eligibility stages produces the closed contract reason, including ACL privilege escalation and disconnected connector.
    - User-state combinations cover dismissed_today, provisional floor, provisional revert, and identity drift; SkillRow.pinned does not influence priority.
    - Rank order covers priority pin, effectiveness, last_used, null last_used, and name tie-break; default K and user_message K=8 are locked.
    - A malformed/unavailable mutable source leaves independently loaded system and connector candidates selectable with no mutable-source SkillExclusion.

- [ ] **Step 2: Add RED budget/preference tests**

    - Exact 600 fragment passes; mutable 601 with a viable counter drops the entire mutable source and reselects static candidates.
    - unavailable, unmapped_model, unpinned_revision, count_failed, or serializer mismatch produces selected: [] and therefore no available-skills block.
    - A static 601 fragment and an otherwise valid final block over 600 × K also produce selected: [].
    - Default K and user_message K=8 final-block envelopes are tested against canonical renderBlock artifacts, not body lengths.
    - Current-canary re-admission on a mutable cache hit is observable; prompt denial evicts it and reselects static sources.

- [ ] **Step 3: Run RED**

    npx -y pnpm@10.34.4 --filter @waldo/runtime test -- skill-loader

- [ ] **Step 4: Implement minimal deep composition**

    - Keep helper functions private to loader.ts unless a test needs fake construction through the documented constructor.
    - Preserve only the existing SkillFilterResult output shape and exclusion vocabulary.
    - Keep source failure and token proof state separate from per-skill exclusions.
    - Do not construct REASONS wrapper text in runtime; use only canonical renderSkill/renderBlock/wrapSkills artifacts.

- [ ] **Step 5: Run GREEN and correctness mutation checks**

    npx -y pnpm@10.34.4 --filter @waldo/runtime test -- skill-loader
    npx -y pnpm@10.34.4 --filter @waldo/runtime typecheck

    Temporarily reverse the final name tie-break and temporarily replace the 601 mutable branch with truncation. Confirm the matching assertions fail, restore both, and do not commit either deliberate mutation.

---

### Task 5: Verification wall, security/QA break pass, Linear evidence, and phase handoff

**Files:**

- Modify only if verification reveals a task-owned defect: files in the manifest above.
- Add: docs/foundation/HEY-14-PHASE-HANDOFF.md after all evidence is complete.

- [ ] **Step 1: Run the targeted matrix**

    npx -y pnpm@10.34.4 --filter @waldo/contracts test -- reasons
    npx -y pnpm@10.34.4 --filter @waldo/runtime test -- mutable-skill-reader
    npx -y pnpm@10.34.4 --filter @waldo/runtime test -- skill-loader
    npx -y pnpm@10.34.4 --filter @waldo/runtime test -- llm-provider
    npx -y pnpm@10.34.4 -r typecheck

- [ ] **Step 2: Run the repository wall**

    npx -y pnpm@10.34.4 verify
    git diff --check

    [blocked] The initial baseline's Docker-backed Supabase verification cannot run in this environment. Record that environmental limitation precisely; do not represent full verify as green unless its Docker subset actually passes.

- [ ] **Step 3: Adversarial QA and review**

    - Invoke the project break-feature workflow: map all reader/cache/prompt paths, then run adversarial QA against the exact failure matrix.
    - Run a focused security review for untrusted mutable prompt content, cache data minimization, content-free telemetry, and the no-writer boundary.
    - Run a contract review against ADR-0024, ADR-0028, ADR-0076, ADR-0083, and the HEY-166 bounds. Resolve all P0/P1 findings before PR.

- [ ] **Step 4: Publish state without advancing dependent work**

    - Update HEY-14 with source links, test evidence, the Docker verification gap if still present, and its actual status.
    - Create the phase handoff with [observed]/[inference]/[proposed]/[blocked] sections. State that HEY-15 becomes ready only after HEY-14's reviewed merge; HEY-16 remains blocked by HEY-14/15; HEY-143 remains independent and still lacks real-provider/R2/staging/sink/deployment proof.
    - Do not start HEY-15, HEY-16, or HEY-143 until HEY-14 is reviewed and merged.

## Acceptance Evidence Map

| ADR-0083 outcome | Planned proof |
| --- | --- |
| H14-1 bounded private acquisition | Task 3 exact-boundary/head/no-body-read tests |
| H14-2 complete version-attested cache only | Task 3 all-head/conditional/stream/generation tests |
| H14-3 R2 is body-only evidence | Task 3 strict parser/trusted reconstruction/tamper tests |
| H14-4 existing Scribe at cache and prompt edges | Task 3 module-spy/cache test plus Task 4 current-canary re-admission |
| H14-5 model-attempt exact proof | Task 1 artifact equality, Task 2 fallback minting, Task 4 600/601/K tests |
| H14-6 source-local versus global failure precedence | Task 4 static survival and no-fence tests |
| H14-7 no writer/data exposure | Task 3 writer-shaped fake/no-logger assertions and review |
| H14-8 fresh worktree/ISA/verification | this plan, baseline record, Task 5 wall/review/handoff |

## Completion Definition

HEY-14 is complete only when the narrow contract exception is approved, all task checkboxes have evidence, the fake-R2 matrix and route-attempt fallback proof pass, review/QA findings are resolved, the actual repository verification result is recorded without masking the Docker gap, and a reviewed PR is merged. Until then, HEY-15, HEY-16, and HEY-143 do not start.
