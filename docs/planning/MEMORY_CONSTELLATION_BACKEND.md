# Memory constellation: evidence-backed backend slice

Plan only. Sequenced behind PR501 staging and C2 plan review. Reference graph concept is approved visually; it is not yet a live backend feature in the new console.

## Existing source, not a blank slate

memory/claims.ts already owns claims, constellation_nodes, constellation_edges, supporting_spots JSON, eligible promotion gates, correction, purge and content-free forget barriers. applyPromotion admits nodes only with two owner-origin observation/pattern claims on different dates; associations require both endpoints admitted in that pass. Strength is an uncalibrated estimate, not probability. Current edge evidence_count is model input, not independently proved source references. Claim origin/date alone does not prove distinct original evidence. Legacy console.ts has node/edge views and node forget; the new console Memory route is unavailable.

Reuse existing stored context. Never fake a populated live graph from the concept fixtures. Never infer authorization from a pattern. Missing, stale or invalid support must remain visible as unavailable/unsupported, not receive synthesized evidence.

## First implementation proposal: schema-free read projection

A pure, versioned projection joins stored claims, nodes, edges and support IDs into a graph with stable owner-scoped IDs, distinct node types, provenance/status, exact existing evidence notes/source_ref, supported links and explicitly unverified associations. Validate malformed supporting_spots, missing/forgotten/retired claims, cross-owner IDs, dangling/self edges, duplicate support, inconsistent dates and invalid strength. No promotion or model request at read time. No invented certainty or count. Link to original evidence only when a verified retrievable reference exists; otherwise retain exact recorded source note and say original evidence unavailable. Never fabricate message URLs.

Expose through the authenticated owner console seam after auditing actual snapshot/auth/cache contracts. Read-only projection must not start owner initialization, mutate stored memory, or leak another owner's context. Empty Memory has an honest empty state. Pagination/size bounds come from existing console policy or a reviewed decision, not arbitrary model constants.

## Correctability proposal and limits

Claims already have correction/dismiss/confirm/forget mechanics; audit exact current semantics before exposing controls. Proposed graph controls route to the same authenticated owner actions with CSRF and captured item/version. Selected pattern can inspect its actual support. Dismiss pattern must not erase its source claims. Forget must remove eligible node links and prevent later UI/history re-exposure, with honest pending/incomplete receipts under C2 purge maintenance. Confirming interpretation cannot convert unsupported source facts into truth or a standing action grant.

Existing schema does not visibly include node confirmation/dismissal version fields or edge-level source refs. Do NOT silently add tables/columns/DDL. Inspect exact supported statuses and compatible existing representations first. If reliable correction CAS, node confirmation or evidence-grounded edge writes require schema changes, bring the minimal schema/version/migration/retention choices to the owner before implementation. Until then ship read-only evidence projection or keep affected controls unavailable, never cosmetic success.

## Later mutation slice, not authorized by this plan

Audit nightly promotion original-source independence, contradiction/staleness, association evidence and exact receipts. New pattern/edge writes require source-grounded support, atomic captured-scope local commits and effect/purge handling from C2. No new model spend/config/SQL rollout/production or live memory deletion under this plan. Original owner approval must be inspected before runtime mutations or owner-visible effects; agent relays orient the task but create no authority.

## Review and adversarial proof

Red-first pure projection fixtures: malformed JSON, duplicated claims, same original source on different days, missing source_ref, legacy provenance, forgotten support, stale node, invalid count/strength, hostile HTML/instructions, dangling cross-owner edge. Actual DO read/auth tests verify isolation and no writes on projection. Correctability tests require CAS/replacement, purge-version competition, failed partial deletion, no accidental source removal on dismissal, no completed receipt until verified. Cross-store cleanup remains phase-based uncertainty, not rollback.

Independent source/design review plus adversarial pass before coding or merge. Exact-head actual CI jobs and staging visual/live tests precede live-feature claims. A populated synthetic screenshot never counts as stored-context proof. Keep unimplemented correction/edge provenance gaps explicit on the issue.

## Reviewer corrections and read-only gate

The current promotion gate proves two distinct owner-origin claim IDs and dates, NOT independent observations. last_confirmed is saveNode(active)'s model-selected timestamp, NOT owner confirmation. seen_count is model operation count; edge evidence_count is model input clamped to >=1. strength is a clamped estimate, NOT confidence. UI labels must retain these meanings.

Projection separates stored support links, node interpretations and unverified association edges. An evidence note is writer text, not an authenticated quote. Preserve agent/shared/untrusted/legacy NULL origin labels and source_ref validity. Identical source_ref on different dates cannot become independent support.

Read path must not call claimStore() initialization (CREATE/ALTER/FTS). Missing schema is unavailable/partial, never a blank/empty graph that implies no context. Read adapters inspect existing schema without writes under the actual owner's auth boundary. IDs are table-local and must be qualified by owner scope plus kind; claim and node IDs can collide. No raw source_ref URLs become links. Resolve supports before pagination or mark support incomplete, never downgrade absent pages into missing evidence.

Suppress purging/forgotten payload; expose only count/status of unavailable support where safe. Do not overstate forget completeness. Confirm/dismiss/CAS actions are not authorized by this read-only plan. Read-only implementation scope independently recovered from original WhatsApp voice wamid.HBgMOTE3NTU4NjU5OTMxFQIAEhggQUM3ODNEMjMzQ0REQjRFNTM2QURDM0Q5M0VEMjZGQ0EA, runtime transcription job audiotxjob-01M3V8MJJHWX15RM3Q5X8AGF6S in the main chat at13:47. Both transcripts request actual backend logic for working constellation nodes. Final plan delta cleared at4a78189; only read-only projection code/tests released. Schema/migrations and correction mutations remain separately held.

Add adversarial fixtures for identical source_ref across dates, legacy writer-asserted quotes, model-set last_confirmed, NaN/Infinity count/strength, claim/node ID collision, absent schema without writes, incomplete pagination, purging suppression and hostile content inert rendering.
