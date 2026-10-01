# Skills runtime wiring: first inspectable slice

Plan only. Follows Memory read projection; parallel private audit permitted. Existing source is not a working owner skill.

## Source audit

context-composer/skills.ts validates attested system rows and builds RuntimeSkillLoader, but connectorSkills is [] and mutableReader returns []. run-loop/adapters.ts local trusted composer returns empty system skills. SqliteSystemSkillRepository exists with validated revision seed, owner-resolved snapshot sources and an existing 25-row query bound. Its returned attestation binds the caller's snapshot and a content revision. The schedule admission/default snapshot date is fixed at July16 with pinned staged snapshot_ref; localTrustedBriefTurnSnapshot() returns Date.now(), and snapshot validation accepts positive safe timestamps through now+60s. Fixed local revision constants are separate from SQLite content-derived revisions. Simply injecting SQLite does not establish historical compatibility, host provenance or owner binding. Do not replace pinned admission dates or reject valid live turn timestamps to make an adapter pass. No production INSERT INTO skills was found in the audited source; seed/UI/rollback remain separate.

## Narrow first code slice to review

Add an optional host-owned system-skill repository to adapter resolution and the local composer, preserve empty default byte-for-byte, and require exact invocation/snapshot attestation compatibility. Seed nothing automatically. No CREATE/ALTER/DDL/config/provider effects to inspect or select skills. Invalid/missing/late rows fail closed. A data row never creates tool permission, budget, grant or identity authority. Existing canary, identity lock/drift, source provenance, budget and trigger selection remain mandatory.

Tests cover both pinned schedule/default and live per-turn snapshot paths with host repository provenance and owner binding. First red tests show one validated existing system row reaches the actual owner-turn prompt, an identity lock stays fixed, and old/other-owner/stale/malformed snapshot data is rejected before prompt admission. Default empty prompt unchanged. Deferred load closes run then resumes: no stale publication. Existing token policy source must own costs and truncation, not an invented count.

## Decisions before any real seed

Determine attestation adapter compatibility from context-composer-sqlite fixtures. Repository claims are evidence of stored data, not independent author approval. Pick a reviewed system procedure already represented by runtime behavior; do not invent skill body rules or standing permissions. Bring exact procedure content and origin/version to independent review. No owner-edit or agent-authored promotion UI in this first slice. No self-rewrite.

Later connector/mutable/edit/rollback stages require explicit version/provenance lifecycle and a verified owner storage/source. Confirm content/authority rules internally first; escalate only a true owner choice, not an architecture preference. No hosted schema/migration/production/seed mutation is authorized by this plan.

## Proof and claim limits

Source tests, exact actual CI jobs and independent adversarial review precede merge/stage. Then one real permitted owner turn must show the selected skill body influenced useful behavior without leaking the body or making unsupported permission claims. Fixture-selected rows alone are not live usefulness, edited-owner capability or autonomous learning proof. Keep ledger18-20 incomplete until their full outcomes are proved.

## Review amendments, code scope

Private wiring/tests limited to fake/local seam; gateway stays fail-closed. Omitted dependency preserves existing prompt/provenance/failure behavior. Owner-turn live snapshot is host Date.now(), accepts now+60s; caller cannot select date/revision. Test July16 historical incompatibility separately from valid live owner turns.

SQL LIMIT25 is an overflow sentinel, not25accepted rows: loader MAX_SKILL_ROWS24,25or more fails closed. Test24accepted/25+rejected and existing body/JSON/token policies unchanged. Absent skills table fails closed withoutDDL.

Repository has no owner identity parameter. It can only be supplied by the verified invocation's own owner host, not request/env selection, not cross-owner reused/global legacy fallback. Content hash proves identity, not curation authority; trusted row origin/version/identity_locked must be grounded before any seed. No seed in this slice.

Use real async repository loading paused across run closure/resume; no stale prompt/tool/provider/sink publication. Fake/local code proof is not a deployed owner skill, gateway coverage or live usefulness. No owner-edit/self-rewrite.
