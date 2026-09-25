# Memory + ontology deep review (2026-09-26)

Purpose: map the decided memory ontology (SPOTS_CONSTELLATIONS_AND_DERIVATIONS, VOCABULARY_AND_BRAND, the retrieval-stack verdict) against what is actually built and live, find where the philosophy is not being served, and name the smallest slices that make the ontology deliver its intended value. Source-verified at base a796554 plus pending #196 (forget purge).

## 1. The decided ontology, restated

- Spots (claims): short-term, one plain sentence, kind + evidence + source (stated/confirmed/inferred), seen counts, correct/dismiss/forget by the owner.
- Constellations: long-term directed graph - nodes by life domain with strength, edges with relation, promoted nightly only from repeatedly-seen observation/pattern claims, stale-fading but never silently dropped.
- Barriers: forgotten topics block re-admission; the nightly extractor holds anything touching them.
- Episodes: FTS5 raw evidence every spot can cite.
- Halls: typed rows (facts/events/discoveries/preferences/advice) with trust class + source taint + decision log, staged through the Scribe inbox, trust-filtered at recall (recall/gateway.ts), correctable with provenance (recall/correctable.ts).
- Fetch: the proactive sweep whose findings can become spots; every sweep recorded even when silent.
- Scores (Form/Recovery/Sleep/Signal Pressure/Task Pileup/Mind State/Weight): ship only when every input is real and named; degrade to "not enough data" otherwise.
- The trust half: owner sees every spot and node; "why do you think that" answers from the same records; forget purges derived copies.

## 2. What is actually live (production telegram path, telegram-turn.ts)

| Piece | State | Evidence |
|---|---|---|
| Claims (spots) | LIVE on the chat path | memoryPrompt feeds every turn (telegram-turn.ts:128); claim ops apply post-turn and nightly (applyClaimOps) |
| Constellation promotion | LIVE nightly | telegram-turn.ts:205-206, PROMOTION_SCHEMA; observation/pattern-only promotion enforced |
| Barriers | LIVE | barrierPrompt in exchange/nightly/promotion inputs; touches_forgotten holds in applyClaimOps |
| Episodes FTS | LIVE | search_episodes tool; live-proven pass tg-904957550 |
| Forget | LIVE but was claim-row-only until #196 | purge now covers episodes/backups/legacy/constellation (PR #196, tests-only evidence until deployed) |
| Owner correct/dismiss/forget | LIVE via console actions | telegram-owner-do.ts console act handler |
| Halls (trust classes, taint, scribe-staged writes, corrections) | BUILT, NOT on the production chat path | read_memory/update_memory register only in hooks/registry.ts (trusted RunLoop surface); telegram-turn.ts never touches recall/gateway |
| Fetch sweeps emitting spots | NOT WIRED | the update-card sweep composes cards; no claim ops run on sweep findings |
| Scores (Form/Recovery/...) | NOT BUILT | need health connectors (HealthKit/Health Connect first per owner priority) |
| Vector recall leg | NOT BUILT | acknowledged gap in the retrieval-stack verdict; FTS-only today |

## 3. The central finding: two memory systems, and the governed one is off the live path

The claims layer (simple, prompt-fed, owner-visible) serves production. The halls layer (trust classes, source taint, scribe staging, correction provenance) - the one carrying the governance philosophy - is only reachable from the trusted RunLoop surface, which is not the production chat path (telegram-turn.ts:33-34). Consequences:

- Corrections made through the halls path never reach the claims the chat actually reads; a corrected fact can keep shaping replies.
- Trust classes and taint exist for halls but the live prompt memory (claims) carries no trust class - stated vs inferred exists, but taint (external-origin memory) does not.
- The owner-facing "why do you think that" story is split: claims cite free-text evidence; halls cite structured provenance. Neither cites episode ids, so evidence is not clickable/verifiable as the doc intended.

## 4. Gaps against the decided ontology, by intent

1. Governance duality (section 3) - the biggest one. The ontology says ONE owner-visible memory with trust + correction; the build has two with divergent guarantees.
2. Evidence is free text, not references. Decided: evidence[] pointing at episodes/events/mail. Built: a string. "Why do you think that" cannot deep-link.
3. Fetch does not create spots. Decided: sweeps can emit spots and repeated fetch patterns feed constellations. Built: sweep -> cards only. The proactive layer does not learn.
4. No trust class on live memory. External-origin content can become a claim with source 'inferred' but no taint marker; the sanitizer gates egress, not memory admission.
5. Scores unbuilt (expected - blocked on health connectors), Mind State correctly stays a ghost until self-report exists. No action beyond connectors.
6. Vector recall leg open (known verdict; slots in as ranking addition).

## 5. Recommended slices (smallest-first, regression-led)

M1. UNIFY READ PATH: the chat prompt composes from claims + halls together (halls hits rendered with their trust class), so correction/taint apply to what the model reads. Test: a corrected hall fact displaces the stale claim in the composed prompt; tainted hall rows never render into prompts without their class label.
M2. EVIDENCE REFERENCES: claim evidence gains structured refs (episode:<id>, event:<id>, mail:<id>) alongside text; console "why" view links them. Test: a claim created with an episode ref renders a working lookup.
M3. FETCH-TO-SPOT: the sweep may emit claim ops through the same applyClaimOps admissions path (barriers and touches_forgotten apply unchanged). Test: a synthetic sweep finding lands as an observation claim with evidence; a barrier-blocks-fetch case stays held.
M4. TRUST CLASS ON CLAIMS: claims gain taint (owner-stated vs external-derived); prompt rendering labels external-derived claims. Test: an external-origin claim is labeled in memoryPrompt and can be excluded by policy.
M5. (later, with connectors) scores per the derivation worksheet; vector leg as recall ranking.

## 6. What NOT to change

- The two-layer spots/constellations model itself - it is sound and matches the field's frontier (typed, provenance-carrying memory over plain vector RAG).
- Barriers keeping forgotten topic text (disclosed in #196): re-admission blocking requires it.
- Stale-never-delete on nodes: working as decided.
- The halls scribe-staging design: it is the right write path; the fix is putting it on the live read path, not rebuilding it.
