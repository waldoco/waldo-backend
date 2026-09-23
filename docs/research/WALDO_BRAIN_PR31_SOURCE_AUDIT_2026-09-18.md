# Waldo Brain PR #31 — Independent Source and Adoption Audit

**Date:** 2026-09-18

**Scope:** documentation-only review of Waldo Brain PR #31 at exact head `43be41e1a24af5d901eb6b68d9a63e1c32dfa6f7`

**Purpose:** verify the source register and adoption/proof register before their lessons change the canonical backend PR #138 plan

**Authority:** evidence and review record only; this document does not amend an ADR, authorize implementation, or replace the canonical plan

## Executive conclusion

PR #31 is a strong research record and its central architecture conclusions are sound: durable responsibility must live outside a model context; builder harness, customer runtime, control plane, and execution environment are different layers; a skill or persona file is not authority; external effects need provider-aware concurrency and reconciliation; and security cannot rest on prompts.

The source audit does **not** justify a framework migration or a broad plugin/browser build. It supports keeping Waldo's owner, consent, policy, canonical-state, effect, and receipt seams while buying or reusing replaceable execution components below those seams. The fastest credible build remains one complete personal-agent corridor—app conversation, governed memory, Google Calendar, then Gmail/meeting/proactivity—before connector breadth.

The register needs three editorial corrections and several evidence labels:

1. Call S01–S32 **32 source-register entries**, not “32 primary sources.” The set deliberately mixes official API contracts, product documentation, preprints, builder reports, practitioner essays, a curriculum index, marketing, and one local clean-room synthesis.
2. Distinguish what the source establishes from a Waldo design or policy conclusion. In particular, early privacy/isolation, source admission, non-resurrection, capability authority, scanner distrust, account lifecycle, global identity claims, health evidence, relationship cryptography, and provider eligibility are substantially Waldo conclusions—not direct findings of the cited source.
3. Do not name GPT-6 Astra as the reviewer of PR #31 unless reviewer provenance is separately recorded. The checked PR files establish a review packet and answers, not the model identity that produced them.

The current PR #138 plan already incorporates R1–R7 well. The most valuable **additional** learnings are narrower:

- evaluate reliability with repeated-trial measures that expose consistency and severe failures, not only average task success;
- cap evaluator, retry, recovery, and scheduler work under one aggregate budget with an explicit plateau/no-progress stop;
- treat Cloudflare alarm retries as finite (up to six automatic retries), and add repair/dead-letter semantics rather than assuming “at least once” means eventual completion;
- split automation desired state from persisted scheduled occurrences, reconcile drift, and make quiet no-op assessments first-class;
- permit deterministic no-model scheduled jobs where a model adds no value, and prohibit recursive scheduling/delegation by default;
- prove that a skill scanner actually ran, pin content hashes and provenance, separate installation from activation, and support emergency revocation;
- disable AI Gateway logging explicitly at both configuration and request boundaries and test payload-versus-metadata behavior;
- require reusable libraries and managed execution products to sit behind Waldo contracts with observable behavior and conformance tests; “library first” is not an excuse to outsource owner authority.

## Method and confidence

The two PR #31 research files and the Addy reference note were read from the exact Git object, not a moving branch. Every S01–S32 entry was then checked against the linked source itself. For S25–S27, the paper abstract and full HTML were read. For S29 and S30, every API link in the combined entry was checked. S32 was checked against both the current Folk homepage and the complete local clean-room note.

Evidence classes used below:

- **A — normative/official:** API contract, platform documentation, or specification. High confidence about the documented version; still time-sensitive unless version-pinned.
- **B — primary empirical:** paper/preprint or first-party experiment with methods and limitations. Medium-to-high confidence within the studied setup; no automatic generalization.
- **C — first-party builder/product report:** useful implementation evidence or vendor documentation, but selected by the author and not independent validation. Medium confidence.
- **D — practitioner synthesis/marketing/index:** valuable hypothesis or product signal, not proof of reliability or internal architecture. Low-to-medium confidence.

Retrieval was successful for 31 entries. The Hermes cron page (S23) failed in the direct renderer; its current indexed official-page content was available, so that row is marked partial and should be refreshed against a pinned source revision before implementation. Product documentation, public homepages, and vendor behavior are time-sensitive.

## Source-by-source audit

| ID | Type / authority / access | What the actual source supports | Boundary, correction, and Waldo disposition |
|---|---|---|---|
| S01 | [Agent Harness Engineering](https://addyosmani.com/blog/agent-harness-engineering/) — practitioner engineering essay, **D**, read | A harness is the surrounding tools, configuration, context, sandbox, and loop. It should be improved from observed failures, with progressive disclosure, hooks, earned instructions, and safe execution boundaries. | The source does **not** itself establish that Waldo's privacy/isolation floor must precede real users; that is a valid Waldo safety inference. **Adopt** failure-driven harness improvement and sandboxing; do not cite this essay as proof of a specific launch gate. |
| S02 | [Agent Skills](https://addyosmani.com/blog/agent-skills/) — practitioner engineering essay, **D**, read | Useful skills encode workflows, checkpoints, evidence, scope, and exit conditions rather than long prose. Progressive disclosure can reduce irrelevant context. | Coding-agent guidance is not a runtime permission or supply-chain specification. **Adopt** procedure/checkpoint shape; bind execution to Waldo grants, manifests, versions, tests, and revocation. |
| S03 | [Loop Engineering](https://addyosmani.com/blog/loop-engineering/) — practitioner engineering essay, **D**, read | Initiation, execution, checking, and durable progress form an outer loop; automations, worktrees, skills, connectors, subagents, and external state are composable parts. The article is explicitly exploratory and notes cost. | PR #31 correctly separates development worktrees from customer requests. **Adopt** the responsibility loop; **reject** copying a coding-factory topology into the personal-agent runtime. |
| S04 | [Own the Outer Loop](https://addyosmani.com/blog/own-the-outer-loop/) — practitioner engineering essay, **D**, read | Independent checks and answerability should sit outside executor self-report; human review needs bounded backpressure rather than endless approval. | The examples are software-production oriented. **Adapt** to effect receipts, source-of-record checks, escalation, and Acceptance; do not make “human in the loop” a vague universal control. |
| S05 | [Agentic Autonomy Levels](https://addyosmani.com/blog/agentic-autonomy-levels/) — practitioner engineering essay, **D**, read | Agency and orchestration are separate dimensions. Autonomy should depend on risk, reversibility, evidence, scope, tools, stop conditions, escalation, and budget. | “Grant by capability and resource” is Waldo's sound formalization, not a measured result in the essay. **Adopt** typed capability/resource/time/budget grants and avoid one global autonomy level. |
| S06 | [AGENTS.md](https://addyosmani.com/blog/agents-md/) — synthesis of other studies, **D**, read | Concise, unusual, discoverable repository guidance can help; generated redundant overviews can increase cost and fail to improve outcomes. | The essay is not the primary empirical record and discusses more than one study. Use S25 for the registered experiment. **Adopt** short navigation and measured utility; do not delete necessary safety rules merely to reduce tokens. |
| S07 | [Long-running Agents](https://addyosmani.com/blog/long-running-agents/) — practitioner synthesis, **D**, read | Long-horizon reasoning, long-running execution, and persistent agency differ. External state, re-entry, recovery, and verification carry responsibility beyond one context. | It is synthesis, not a recovery guarantee. **Adopt** durable task/effect state and resume reconciliation; reject “keep the model alive” as continuity architecture. |
| S08 | [Agent course index](https://addyosmani.com/agents/) — curriculum index, **D**, read | It is a useful map of 19 agent-engineering topics. | The index is neither evidence nor proof that each lesson was reviewed. **Defer** it as navigation only; cite the actual underlying source for every build decision. |
| S09 | [Effective Harnesses for Long-running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — first-party builder experiment, **C**, read | An initializer plus incremental coding sessions, structured feature state, progress records, version control, one feature at a time, and end-to-end tests improved resumption in a full-stack demo. The article acknowledges generalization work remains. | This is a coding-task recipe, not customer-runtime proof. **Adapt** explicit initialization, resumable state, and bounded increments to Waldo's builder workflow; keep user runtime state typed and canonical. |
| S10 | [Harness Design for Long-running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) — first-party builder experiment, **C**, read | Planner/generator/evaluator roles and browser evaluation improved one app-generation task, but model changes altered the value of context resets. The demonstrated evaluator harness was far more expensive and still imperfect. | Do not canonize a separate evaluator or reset strategy. **Adopt** ablation by model/task and require cost, attempt, wall-time, and plateau ceilings before evaluator loops enter a gate. |
| S11 | [Managed Agents](https://www.anthropic.com/engineering/managed-agents) — first-party architecture report, **C**, read | Durable append-only sessions, a harness, and disposable sandboxes can be separated; credentials can remain in a vault/proxy unreachable from the sandbox. | This is a provider architecture, not a migration mandate. **Adopt** stable session/executor interfaces and secret brokering; keep Waldo policy and canonical state provider-independent. |
| S12 | [Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — first-party guidance, **C**, read | Context is finite; smaller high-signal instructions, tools, data, and history can outperform indiscriminate inclusion as context quality degrades with scale. | The source does not say relevance may authorize a source. **Adopt** selective composition and measured compaction only after owner, purpose, consent, and source admission. |
| S13 | [Demystifying Evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) — first-party evaluation guidance, **C**, read | It distinguishes task, trial, grader, trajectory, outcome, and harness; recommends multiple trials, isolated environments, transcript inspection, balanced action/no-action cases, calibrated judges, and source-of-record outcome checks. It distinguishes `pass@k` opportunity from `pass^k` consistency. | This is strong builder guidance, not a formal standard. **Adopt** repeated-trial consistency and severe-failure metrics, explicit no-action cases, and environment-grounded outcomes in every gate. |
| S14 | [Harness Engineering](https://openai.com/index/harness-engineering/) — first-party builder report, **C**, read | Agent-legible repositories, short navigation, structured docs, UI/log visibility, sandboxes, and mechanical boundaries improved a coding project. It also notes that a custom implementation can be preferable to an opaque dependency. | The setting is an internal coding repository, not Waldo's customer runtime. **Adopt** legibility and enforceable seams. Use libraries/products only when their behavior is observable and conformance-testable below Waldo authority. |
| S15 | [Context Engineering Lessons](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) — vendor builder report, **C**, read | Stable prefixes can improve cache economics; append-only event serialization, context-aware tool masking, and retrievable offloading can preserve useful information. | Vendor-reported local choices are not universal optima; hosted APIs may not expose the same controls, and filesystem offloading is neither literally unlimited nor automatically safe. **Adapt** exact admitted-context/policy-version cache keys and recoverable references; deletion and revocation override cache value. |
| S16 | [12-Factor Agents](https://github.com/humanlayer/12-factor-agents) — open architecture guidance, **D**, read | It favors owning prompts, context and control flow; unifying execution and business state; pause/resume; focused agents; and modular concepts rather than an all-in framework. | It is not controlled evidence or a security spec. **Adopt** narrow composable seams and reducer-like state transitions; a separate context is not a sandbox or privilege boundary. |
| S17 | [Pi Coding Agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) — practitioner builder account, **D**, read | A small provider abstraction, tool set, session format, and inspectable core can be effective; context handoff and cross-provider serialization have semantic compromises. | The tool explicitly embraces trusted-local unrestricted access and lacks hosted-user safety rails. **Adopt** small inspectable cores and version-bound provider transforms; **reject** YOLO filesystem/shell defaults for Waldo users. |
| S18 | [AI Adoption Journey](https://mitchellh.com/writing/my-ai-adoption-journey) — practitioner self-report, **D**, read | Reproducing one's own work creates good tasks; clear planning, rapid feedback, verification, and knowing when not to use an agent improve practice. | Anecdote is not a general benchmark. **Adopt** dogfooding and failure-corpus collection; require controlled gates before translating personal productivity into product claims. |
| S19 | [The Lethal Trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) — practitioner threat-model analysis, **D**, read | Private data, untrusted content, and external communication together create prompt-injection/exfiltration risk; prompt instructions alone are insufficient. | It is a threat model supported by examples, not a complete security proof. **Adopt** data-to-action separation, destination allowlists, taint/provenance, and no arbitrary egress from inbox/web contexts. |
| S20 | [Agent Skills specification](https://agentskills.io/specification) — public format specification, **A**, read | `SKILL.md` defines metadata/body plus optional scripts, references, and assets. References may load on demand. `allowed-tools` is experimental and implementation-dependent. | The format does **not** itself provide trusted progressive disclosure, sandboxing, permission, or safe execution. **Adopt** the portable authoring format only behind Waldo admission; never treat `allowed-tools` as authoritative. |
| S21 | [OpenClaw agent workspace](https://docs.openclaw.ai/concepts/agent-workspace) — official current product docs, **A/C**, read | Workspace files separate operating guidance, persona, user context, identity, and memory; configuration, credentials, and session databases live elsewhere. The workspace is the default working directory, not hard isolation, and tool notes do not grant tool availability. | Current implementation docs are time-sensitive. **Adopt** file roles as editable projections/interfaces only; keep credentials, canonical state, grants, and audit outside them. |
| S22 | [OpenClaw heartbeat](https://docs.openclaw.ai/gateway/heartbeat) — official current product docs, **A/C**, read | Heartbeat behavior is implemented by scheduler/configuration/session machinery, not a filename. Current docs expose cadence, quiet/no-op behavior, event wakes, rate limits, persistent monitor state, and repair of stale schedule records. | Version-pin before reuse. **Adopt** desired-state-versus-persisted-occurrence reconciliation, quiet no-op assessments, and flood controls; do not make `HEARTBEAT.md` a scheduler. |
| S23 | [Hermes cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) — official current product docs, **A/C**, **partial** | Indexed current docs describe create/edit/pause/resume/remove, fresh sessions, skills, deterministic no-agent jobs, event triggers, retries, delivery, tool subsets, and user-owned model/reasoning selection. Scheduled children cannot recursively schedule by default. | Direct-page retrieval failed, so refresh against a pinned release before implementation. **Adopt** no-model jobs when deterministic, per-job tool sets/model choice, and no recursive scheduling by default. Do not infer Waldo's ledger/recovery correctness from the feature list. |
| S24 | [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) — official current product docs, **A/C**, read | It documents discovery, activation, skill stacking, platform restrictions, provenance/content hashes, updates, quarantine, and scanning. Some external scanner paths are advisory and can be skipped when binaries are missing. | Popularity or a nominal “scan” is not containment. **Adapt** provenance hashes, source update/review, install-versus-activate separation, actual-scanner attestation, quarantine, rollback, and emergency revocation. **Defer** arbitrary code-bearing skills. |
| S25 | [Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988) — preprint empirical study, **B**, abstract and full paper read | Across 138 CTXBench tasks and 300 SWE-bench Lite tasks, developer-written context showed only a small nonsignificant average gain in one reported comparison, while LLM-generated context increased cost and did not improve performance. Agents followed instructions and used more tools/tests. | Limited to Python repository issue tasks, a small repository set, one sampled completion per setting, and generated artifacts. **Adopt** concise measured instructions; the paper does not justify deleting all repo guidance or making customer-runtime claims. |
| S26 | [Clawdrain](https://arxiv.org/abs/2603.00902) — security preprint, **B**, abstract and full paper read | A handcrafted malicious skill produced substantial token amplification in one OpenClaw/Gemini setup; recovery can itself add cost, and interface design affects stealth. | The experiment is one product/version/model, one main attack design, fresh sessions, and approximate usage accounting. **Adopt** aggregate agent/tool/verifier/recovery budgets and no-progress termination. Do not claim that all external skills are malicious or that the measured multiplier generalizes. |
| S27 | [LongMemEval](https://arxiv.org/abs/2410.10813) — benchmark preprint, **B**, abstract and full paper read | Its 500 questions exercise information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention over long synthetic histories; it provides useful memory-retrieval dimensions. | It does not test deletion, non-resurrection, provenance, authorization, tenant isolation, or health safety. **Adopt** its dimensions as a subset of memory evals; retain separate correction/deletion/security tests. |
| S28 | [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) — official platform contract, **A**, read | Each Durable Object has one alarm. Delivery is at least once, with exponential-backoff automatic retries up to six; multiple logical jobs require durable state. Deleting an alarm is best-effort and may not prevent an already scheduled retry. | “At least once” is not indefinite recovery. **Adopt** occurrence IDs and dedupe, then add a repair/watchdog and explicit exhausted/dead-letter state after the finite retry horizon. Cancellation must remain generation-aware. |
| S29 | [Gmail drafts guide](https://developers.google.com/workspace/gmail/api/guides/drafts), [`drafts.send`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send), [`messages.send`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send) — official API contracts, **A**, all links read | A draft is a stable container whose contained message can be replaced and receive a new message ID; sending a draft deletes it and creates a sent message. Gmail documents sending a draft or a supplied raw MIME message, but no atomic compare-and-send precondition for the mutable draft. | R2 is correct. **Adopt** an immutable approved RFC 5322/MIME snapshot through `messages.send`, with exact hash/recipient/header/attachment/thread binding. This changes provider-draft semantics, is not exactly once, and still needs timeout reconciliation while preserving the external draft. |
| S30 | [Calendar versioned resources](https://developers.google.com/workspace/calendar/api/guides/version-resources), [event creation](https://developers.google.com/workspace/calendar/api/guides/create-events) — official API contracts, **A**, both links read | `If-Match` with an `etag` makes update/delete fail with `412` after a concurrent change. Inserts do not support conditional modification, but a permitted client-chosen event ID can make duplicate create attempts fail instead of creating another event. | R5/A06 are well supported. **Adopt** persisted create IDs before I/O, `If-Match` on mutation, and fresh proposals after conflicts. Validate ID format/collision behavior and keep timeout/absence outcomes indeterminate until reconciled. |
| S31 | [Cloudflare AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/) — official platform docs, **A**, read | Logging can include prompts and responses and is enabled by default. It can be disabled globally or per request; a separate payload flag retains metadata while omitting payload. Storage and deletion behavior are documented. | A canary only observes known capture paths. **Adopt** global logging-off plus an explicit per-request `cf-aig-collect-log: false`, test defaults/regressions, and distinguish no payload from no metadata. This does not prove downstream model-provider retention. |
| S32 | [Folk Personal AI homepage](https://www.folk.com/) plus [the exact clean-room note](https://github.com/Pin4sf/waldo-brain/blob/43be41e1a24af5d901eb6b68d9a63e1c32dfa6f7/03-References/research/folk-personal-agent-product-engineering-clean-room-dissection-2026-08-03.md) — current vendor marketing plus dated synthesis, **D**, both read | The current homepage supports a text-native “friend,” memory/check-ins, skills, reminders, multiple messaging surfaces, a read-only Plaid link, and a draft-then-user-sends money workflow. The clean-room note records a wider dated public-doc review with explicit unknowns. | Marketing does not prove internal architecture, reliability, or safety. **Retain R7:** Folk Personal AI and folk CRM are separate products. Refresh volatile feature claims before competitive testing; adopt relational conversation and user-finalized sends, not “remembers forever” or broad opaque authority. |

## Cross-check of adoption and proof records A01–A18

| Record | Source fidelity | Audit disposition |
|---|---|---|
| A01 — narrow builder navigation | **Supported** by S06, S14, and S25 within builder repositories. | Keep. Test discoverability and task impact; preserve necessary safety rules and historical discoverability. |
| A02 — static skill lifecycle | **Partly supported.** S02/S20/S24 support workflow shape, packaging, hashes, discovery, and updates. Waldo-specific admission, authority, eval, rollback, and revocation are additional requirements. | Keep, but add scanner-executed attestation, install/activation separation, emergency revoke, and upstream-change re-review. |
| A03 — progressive context loading | **Supported for relevance/efficiency** by S12/S15. Cross-owner exclusion, stale-consent avoidance, and source admission are Waldo security requirements, not source findings. | Keep. Cache key must cover owner, purpose, admitted-source digest, consent/source revision, and policy/tool/model versions. |
| A04 — recoverable payload references | **Architecturally justified but not demonstrated by S01–S32.** S07/S11/S16 support external durable state; the exact lost-byte issue comes from the PR #138 architecture review. | Keep R1 as P1. Label it a design-risk finding until fault injection reproduces or disproves each crash boundary. |
| A05 — immutable approved Gmail send | **Strongly supported** by S29's API semantics and the PR review's race analysis. | Keep R2. Add exact MIME canonicalization/hash tests, idempotency/reconciliation caveat, and provider-draft preservation. |
| A06 — Calendar provider concurrency | **Strongly supported** by S30. | Keep R5. Also test custom-ID format/collision, `409`/duplicate behavior, external move/delete, stale etag, and ambiguous absence. |
| A07 — early account lifecycle | **Not derived from S01–S32.** It comes from the app/backend architecture review and Waldo's isolation invariant. | Keep R3 as a G0 prerequisite, but do not present it as source-register validation. It is a design-risk finding until adversarial account-switch tests run. |
| A08 — unified automation lifecycle | **Supported in mechanism** by S22/S23/S28; Waldo's authority, ledger, and delivery proof remain additional. | Keep. Add desired-state/scheduled-occurrence reconciliation, quiet no-op, finite retry exhaustion, repair/dead-letter, and deterministic no-model jobs. |
| A09 — restart/reconciliation budget | **Supported in principle** by S07/S11/S26/S28. | Keep. Aggregate model, tool, verifier, recovery, and scheduler work; prove recovery cannot reset or evade the budget. |
| A10 — bounded delegation | **Supported as architecture guidance** by S05/S16; inherited authority/cancellation is Waldo's control design. | Keep deferred until selected. Default to no nested delegation or recursive scheduling; require child tool subset, deadline, cancellation generation, and aggregate budget. |
| A11 — isolated execution | **Supported as a risk and architecture direction** by S11/S14/S17/S19/S21, but no cited source certifies a Waldo vendor. | Keep behind G7. Require vendor-specific tenant/session isolation, network/egress, secret brokerage, trace/redaction, cleanup, takeover, and adversarial conformance evidence. |
| A12 — defer arbitrary plugins/self-modification | **Well supported as a risk-based disposition** by S20/S24/S26. | Keep. Format compatibility, scan status, or popularity is not executable trust; re-entry needs source/license/version/hash, containment, eval, rollback, and revocation. |
| A13 — global channel-identity claims | **Not established by S01–S32.** It is a concurrency conclusion from the PR #138 ownership model. | Keep R4 before G8 and label its provenance correctly. Prove it with concurrent claims, partial activation, expiry, recycle, revoke/relink, and late callbacks. |
| A14 — memory non-resurrection | **Not supported by LongMemEval.** S27 tests recall/update/abstention, not deletion or resurrection. This is a Waldo privacy invariant. | Keep, but cite Waldo deletion/admission design and dedicated adversarial tests rather than S27 as proof. Include transcripts, summaries, caches, indexes, backups within policy, scheduled jobs, and correction propagation. |
| A15 — health-pattern evidence | **Not supported by this register.** None of S01–S32 validates Waldo health thresholds, causal claims, clinical language, or HealthKit behavior. | Keep the gate, but require separate health/scientific and Apple-source evidence. Do not imply the harness research validates G5/G5b. |
| A16 — outcome/trajectory evals | **Strongly supported** by S13 and usefully stressed by S25–S27. | Keep. Add consistency-oriented repeated-trial metrics, severe-failure rules, action/no-action balance, fixed source-of-record graders, and evaluator cost/plateau stops. |
| A17 — defer relationship crypto critical path | **Prudent but not validated by this source set.** | Keep the defer. Re-entry requires a separate protocol/threat-model/security review; do not use general harness sources as cryptographic assurance. |
| A18 — external eligibility gates | **Correct policy, not an empirical result of the register.** | Keep. Use current provider terms, official API access, authorized test tenants, regional/platform restrictions, and distribution-review evidence at release time. Competitor access proves nothing about Waldo eligibility. |

## Corrections and clarifications for PR #31

These do not overturn the review. They make its provenance and certainty precise.

1. Replace “primary-source register” with “source register,” or classify entries by authority. S06 summarizes studies, S08 is an index, S32 includes marketing and a local synthesis, and many Addy/practitioner pieces are useful secondary interpretation.
2. Mark the last clause of S01 (“isolation and privacy must precede real users”) as **Waldo inference/policy**.
3. Mark S05's capability/resource grant as **Waldo adaptation**, not a directly tested claim.
4. Mark S12's “relevance never substitutes for source admission” as **Waldo security rule**.
5. Clarify S20: the format enables implementations to load content progressively, but the specification does not guarantee progressive disclosure or execution control; `allowed-tools` is experimental.
6. Mark S24's scanner/popularity statement as **Waldo supply-chain conclusion** and add the documented risk that an advisory scanner may not run when its binary is absent.
7. State explicitly that S27 does not support A14 non-resurrection. It only contributes recall/update/abstention fixtures.
8. Label A04, A07, A13, A14, A15, A17, and A18 as architecture/policy records whose decisive evidence comes from the PR review, Waldo invariants, or future domain-specific proof—not the S01–S32 corpus alone.
9. Describe R1 and R3 as high-confidence **design-risk findings**, not reproduced production incidents. R2 and R5 have direct provider-contract support; all still require runtime fault/race tests.
10. Preserve R7 and keep Folk Personal AI separate from folk CRM in every market/eval fixture.

## Incremental additions for the canonical PR #138 plan

The canonical plan already reflects the main PR #31 findings. Add only the following details; do not create a competing roadmap.

### G0/G1 — context, skills, and account floor

- Include an exact admitted-context digest and owner/purpose/consent/source/policy/tool/model versions in cache and resume identity.
- If static skills ship, record whether each required scanner actually executed; fail admission when a mandatory scanner is unavailable. Separate discovered, installed, reviewed, activated, revoked, and quarantined states.
- Do not replay provider-native reasoning/tool artifacts across models unless a versioned transform is explicitly tested; treat lossy transforms as new untrusted context.

### G2 — Calendar

- Add custom event-ID validation/collision and duplicate-create response handling to the existing timeout/etag tests.
- Keep absence after an ambiguous mutation as indeterminate until the operation-specific reconciliation budget is exhausted.

### G4 — Gmail and proactivity

- Canonicalize and hash exact MIME plus envelope, recipients, headers, attachments, and thread-binding inputs before approval.
- Model automation as desired responsibility plus durable occurrence records. Reconcile missing/stale schedule materialization.
- Add an explicit exhausted/dead-letter state and repair path after Cloudflare's finite automatic alarm retries; alarm deletion alone is not proof a pending retry cannot run.
- Prefer deterministic no-model delivery/reconciliation jobs where appropriate; prohibit a scheduled child from creating new schedules or children unless specifically granted.

### Every gate — evaluation, cost, and observability

- Add consistency-oriented repeated-trial metrics (for example, all-trials-pass for critical flows), action/no-action balance, and predeclared severe-failure rules alongside average task success.
- Bound generator, tool, evaluator, recovery, and scheduler work in one aggregate budget. Stop on repeated identical state, no new evidence, or a declared plateau.
- For AI Gateway, configure logging off globally **and** send an explicit per-request no-log header. Test that content is absent, distinguish residual metadata, and keep vendor/downstream retention as a separate claim.

### Buy/reuse rule

Use a library, managed browser/computer service, scheduler primitive, connector toolkit, or agent framework only when:

1. Waldo retains owner identity, policy, consent, canonical state, approval, effect, reconciliation, receipt, deletion, and Acceptance;
2. the product sits behind a small replaceable port;
3. every write-capable operation has a typed manifest and current grant;
4. failure, timeout, cancellation, revocation, and ambiguous-success behavior are observable;
5. tenant/session/secret/egress isolation is testable; and
6. version, cost, retention, and rollback are pinned and measurable.

This rule favors reuse without turning third-party convenience into Waldo authority.

## What to adopt, defer, and reject now

### Adopt now

- Durable responsibility state and resume reconciliation.
- One complete app → owner boundary → model → Calendar/Gmail → source receipt corridor.
- Correctable, provenance-bearing memory projections with explicit forget/non-resurrection tests.
- Provider-aware concurrency, immutable approval artifacts, and indeterminate states.
- Desired-state automations, occurrence ledgers, deterministic jobs, quiet no-op, and aggregate budgets.
- Small stable ports for model, connector, artifact/browser executor, scheduler, and channel adapters.
- Repeated-trial, trajectory, no-action, severe-failure, and source-of-record evaluation.

### Defer until the core corridor passes

- General browser/computer use beyond a bounded vendor spike and user takeover.
- Arbitrary installable plugins, scripts, MCP servers, and self-modifying skills.
- Broad connector catalogs, general inbox monitoring, and cross-user protocol expansion.
- Relationship cryptography implementation until its own accepted threat model exists.
- Health-pattern claims beyond the separate scientific/HealthKit evidence gate.

### Reject

- A greenfield agent-framework rewrite.
- A persona, memory, skill, heartbeat, or progress file as canonical state, authority, credential store, or scheduler.
- Model/tool/provider “done” as external Outcome proof.
- Global YOLO authority, unrestricted hosted shell/filesystem defaults, or prompt-only browser safety.
- Claims of exactly-once external effects, universal no-retention, full isolation, or competitor parity without operation-specific evidence.

## Materials read

Exact PR #31 files:

- [Harness engineering lessons and adoption register at `43be41e`](https://github.com/Pin4sf/waldo-brain/blob/43be41e1a24af5d901eb6b68d9a63e1c32dfa6f7/03-References/research/waldo-harness-engineering-lessons-and-adoption-2026-09-18.md)
- [Backend PR #138 architecture review at `43be41e`](https://github.com/Pin4sf/waldo-brain/blob/43be41e1a24af5d901eb6b68d9a63e1c32dfa6f7/03-References/research/waldo-backend-pr138-architecture-review-2026-09-18.md)
- [Addy agent-skills reference note at `43be41e`](https://github.com/Pin4sf/waldo-brain/blob/43be41e1a24af5d901eb6b68d9a63e1c32dfa6f7/03-References/repos/addyosmani-agent-skills.md)
- [Folk clean-room note at `43be41e`](https://github.com/Pin4sf/waldo-brain/blob/43be41e1a24af5d901eb6b68d9a63e1c32dfa6f7/03-References/research/folk-personal-agent-product-engineering-clean-room-dissection-2026-08-03.md)

External sources:

- S01–S08: [Harness Engineering](https://addyosmani.com/blog/agent-harness-engineering/), [Agent Skills](https://addyosmani.com/blog/agent-skills/), [Loop Engineering](https://addyosmani.com/blog/loop-engineering/), [Own the Outer Loop](https://addyosmani.com/blog/own-the-outer-loop/), [Autonomy Levels](https://addyosmani.com/blog/agentic-autonomy-levels/), [AGENTS.md](https://addyosmani.com/blog/agents-md/), [Long-running Agents](https://addyosmani.com/blog/long-running-agents/), and [course index](https://addyosmani.com/agents/).
- S09–S13: Anthropic's [long-running harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [long-running app experiment](https://www.anthropic.com/engineering/harness-design-long-running-apps), [managed-agent architecture](https://www.anthropic.com/engineering/managed-agents), [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), and [eval guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
- S14–S19: OpenAI's [Harness Engineering](https://openai.com/index/harness-engineering/), Manus's [context lessons](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus), HumanLayer's [12-Factor Agents](https://github.com/humanlayer/12-factor-agents), Mario Zechner's [Pi account](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), Mitchell Hashimoto's [adoption journey](https://mitchellh.com/writing/my-ai-adoption-journey), and Simon Willison's [Lethal Trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/).
- S20–S24: [Agent Skills specification](https://agentskills.io/specification), OpenClaw [workspace](https://docs.openclaw.ai/concepts/agent-workspace) and [heartbeat](https://docs.openclaw.ai/gateway/heartbeat), Hermes [cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) and [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).
- S25–S27: [Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988), [Clawdrain](https://arxiv.org/abs/2603.00902), and [LongMemEval](https://arxiv.org/abs/2410.10813), including their full arXiv HTML.
- S28–S32: Cloudflare [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/); Gmail [drafts](https://developers.google.com/workspace/gmail/api/guides/drafts), [`drafts.send`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send), and [`messages.send`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send); Calendar [versioned resources](https://developers.google.com/workspace/calendar/api/guides/version-resources) and [event creation](https://developers.google.com/workspace/calendar/api/guides/create-events); Cloudflare [AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/); and the current [Folk Personal AI homepage](https://www.folk.com/).

## Overall confidence

- **High:** API semantics and platform behaviors explicitly documented by Google and Cloudflare; direct content of the three preprints within their reported setup; exact contents of PR #31 at the pinned commit.
- **Medium:** first-party builder reports and official implementation docs, because they describe selected systems and versions rather than independent general benchmarks.
- **Low-to-medium:** practitioner essays, product marketing, and competitive feature claims; they are useful for hypotheses and UX parity, not reliability, security, or architecture proof.
- **Blocked/partial:** a direct render of the Hermes cron page. Indexed official content was reviewed, but implementation must refresh and pin the exact selected Hermes version.

The evidence is sufficient to refine the plan and gates. It is not sufficient to claim that the resulting agent, any connector, browser vendor, skill ecosystem, or competitor-parity target is implemented or production-ready.
