# HEY-15 Review Repair — ADR-0031 Liveness and Hostile Source Boundary

**Goal:** Repair the three review findings in `c742c70` while preserving the existing public `RecallGateway<RuntimeRecallContext>` seam, the canonical single Scribe implementation, and H15's fake-first scope.

**Architecture:** `createRuntimeRecallGateway()` remains the one deep module. Its private source-acquisition implementation starts both owner-bound reads in parallel, keeps an underlying source or inspection cause only on its private failure error, and lets the first tagged rejection reach ordinary `Promise.all` fail-open handling. Only a closed source/admission class reaches telemetry. A second private implementation helper snapshots only bounded own data descriptors from a same-realm Array that passes descriptor inspection before row admission. Userland cannot distinguish every transparent proxy; permitted inspection traps may run, and a throwing inspection is a source failure. Callers, contracts, and source adapters gain no new method or selector.

## Governing sources

- [observed] ADR-0031 specifies parallel raw `Promise.all` fan-out and advisory fail-open on source failure; a failure must not block generation.
- [observed] `episodeSearchArgsSchema` uses the existing shared `iso8601Schema`, which accepts four-digit UTC years and rejects the first expanded-year `Date#toISOString()` output.
- [observed] The review of `c742c70` found a waiting-on-hung-sibling liveness bug, hostile array iterator/descriptor bypass, and clock-contract mismatch.
- [observed] `docs/superpowers/specs/2026-07-13-hey-15-liveness-and-boundary-research.md` links primary ECMAScript/WHATWG sources and documents why a total deadline/cancellation seam is not claimed by this fake-first ticket.

## Decision

- [decision] Source failures use private tagged rejections through unwrapped `Promise.all`; the first observed unavailable source produces one content-free `failed/source_unavailable` event and a canonical all-empty result immediately. The private error retains a cause for debugger inspection, while only the closed source class crosses the telemetry interface.
- [decision] A source response is usable only after a bounded descriptor snapshot verifies a same-realm Array, a valid own length at or below the source bound, and every present index as an own data descriptor. Unused own properties—including a hostile `Symbol.iterator`—are never invoked or copied and therefore do not control the snapshot; holes, accessor indices, subclasses, malformed descriptors, and inspection failure are source failures before Scribe or row admission. A cooperative proxy may pass this inspection; userland cannot prove its absence.
- [decision] Clock acceptance is the intersection of a non-negative safe integer and the existing ISO contract: maximum `253_402_300_799_999` (`9999-12-31T23:59:59.999Z`).
- [decision] The optional contract hint is re-admitted through the existing `prepareWithScribe()` implementation using `skillSchema.trigger_condition`, `system_prompt`, conservative `external` taint, and the existing recall-query character bound. Non-canary rejection omits the hint; a current canary is a typed security halt. Its closed telemetry class is `hint`, which is an input-admission origin, not an ADR-0031 fan-out leg.
- [decision] Private error classes are recognized by module-private `WeakSet` identity rather than `instanceof` on caught hostile values. This retains a real security halt while making a proxy-thrown row error row-local again. Recall results are constructed before observational telemetry is invoked.
- [blocked] A both-sources-hang deadline, `AbortSignal`, source cancellation, timer ownership, real adapter, or real performance proof remains outside H15.

## Test-first repair slices

1. **First-failure liveness:** memory rejects while episode remains pending, then the symmetric case. Assert both calls launch, recall resolves all-empty before releasing the sibling, and telemetry remains closed. Do not assert scheduler-dependent attribution when both sources reject.
2. **Hostile source array:** own hostile `Symbol.iterator`, sparse array, accessor index, extra own property, subclass/proxy inspection failure, and over-limit array. Assert atomic all-empty source failure, no row/Scribe admission, and no iteration of the supplied iterator. A normal bounded array remains admitted in source order.
3. **Clock contract:** exact four-digit ISO maximum constructs a schema-valid episode time range; the next millisecond rejects before either source call or telemetry.
4. **Regression wall:** focused suite, runtime suite, recursive typecheck, scoped forbidden-dependency scan, diff check, and independent task review.

## Constraints

- Do not change contracts, Scribe, sanitizer vocabulary, prompts/rendering, writer/commit paths, SQL/DO/R2/provider/binding/migration/deployment code, or external systems.
- Do not expose source errors, bodies, prompts, queries, identifiers, health data, keys, or secrets in telemetry or tests.
- Do not use `Promise.allSettled`, `Promise.race`, a timer, `AbortController`, source-owned `for…of`, spread, `Array.from`, `slice`, or source array methods to solve these findings.
