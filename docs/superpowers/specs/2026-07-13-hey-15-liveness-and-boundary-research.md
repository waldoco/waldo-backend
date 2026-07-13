# HEY-15 — Recall liveness and hostile-boundary research

Status: research decision note with an implemented-outcome addendum; this document itself makes no runtime, test, contract, Linear, or external-system change.
Date: 2026-07-13 IST.

## Source method

- [observed] Local canonical sources: [ADR-0031](</Users/shivanshfulper/Developer/Pin4sf/waldo-brain/01-Waldo/Architecture%20Decision%20Records%20%28ADR%29/0031-recall-before-act-wiring.md:97>), [recall contract](../../../packages/contracts/src/memory/recall.ts), [episode contract](../../../packages/contracts/src/memory/episode.ts), [ISO contract](../../../packages/contracts/src/core/error.ts), and the current [runtime gateway](../../../packages/runtime/src/recall/gateway.ts).
- [observed] Primary external standards: [ECMAScript `Promise.all`](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-promise.all), [ECMAScript `PerformPromiseAll`](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-performpromiseall), [ECMAScript `IsArray`](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-isarray), [ECMAScript iterator acquisition](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-getiterator), [ECMAScript Date Time String Format](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-date-time-string-format), [ECMAScript `Date.prototype.toISOString`](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-date.prototype.toisostring), and the [WHATWG DOM abort model](https://dom.spec.whatwg.org/#aborting-ongoing-activities).
- [blocked] Primary standards establish language/platform behavior, not an industry-consensus implementation recipe. This note therefore does not claim a broader “frontier” consensus; its recommendation is the smallest design that is correct under the standards and Waldo’s accepted ADRs.

## Decision summary

| Finding | Smallest H15-compatible decision |
| --- | --- |
| A failed source can wait forever for a hung sibling. | [proposed] Start both reads, tag each rejection with its closed source class, and await their **unwrapped** `Promise.all` inside the fail-open source boundary. The first observed rejection returns the all-empty ADR-0031 result immediately; a pending sibling does not delay it. |
| A valid Array can own a hostile iterator. | [proposed] Before row admission, take a bounded, descriptor-based snapshot of a same-realm plain array; do not use `for…of`, spread, `Array.from`, `slice`, or an array method on source-owned input. Reject holes, accessors, wrong prototypes, malformed descriptors, and any inspection error atomically. |
| ECMAScript Date extends beyond the repository’s ISO schema. | [proposed] Make `9999-12-31T23:59:59.999Z` (`253_402_300_799_999`) the injected-clock upper bound. The first expanded-year millisecond is rejected before either source starts. |
| Should H15 add cancellation or a timeout? | [proposed] No. The direct `Promise.all` repair restores liveness for the reported “one fails, one hangs” case without widening the read seam. A total-deadline/cancellation design belongs to a separately admitted real-adapter slice with an explicit deadline owner and cooperative `AbortSignal` support. |

## Observed evidence and hypotheses

### 1. Parallel source failure versus sibling hang

- [observed] ADR-0031 requires parallel fan-out and says a retrieval throw or timeout must produce an empty result while generation continues. [ADR-0031 fan-out](</Users/shivanshfulper/Developer/Pin4sf/waldo-brain/01-Waldo/Architecture%20Decision%20Records%20%28ADR%29/0031-recall-before-act-wiring.md:97>) [fail-open policy](</Users/shivanshfulper/Developer/Pin4sf/waldo-brain/01-Waldo/Architecture%20Decision%20Records%20%28ADR%29/0031-recall-before-act-wiring.md:192>)
- [observed at `c742c70`] The gateway converted each source rejection to an `{ ok: false }` fulfillment and then awaited `Promise.all` of both wrappers. A hung wrapper therefore prevented the normal failed-result branch from running.
- [observed] ECMAScript specifies that `Promise.all` rejects with the first passed promise that rejects; `PerformPromiseAll` gives every input the aggregate promise’s reject function, rather than waiting for all inputs to settle. [Promise.all](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-promise.all) [algorithm](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-performpromiseall)

Two hypotheses were tested against those sources:

1. [rejected] Keep `captureSource()` and add a second `Promise.race` around it. That retains a separate timer policy and still makes the known failure path depend on timing.
2. [accepted inference] Preserve the original rejection through the aggregate while replacing its detail with a private closed error type. A rejection then wins independently of a non-settling sibling and carries no source error text into telemetry or the result.

[proposed] The gateway should have a private `RecallSourceUnavailable` with a closed `'memory' | 'episode'` classification and an underlying cause retained privately for debugger inspection; each source wrapper catches any synchronous throw or rejection and throws that private type. The outer aggregate catches only that type, emits the existing content-free `failed/source_unavailable` event, and returns `empty(query, duration)`. It must not use `Promise.allSettled`, because that explicitly waits for all inputs to settle.

[inference] If both sources fail in the same turn, the source class is the first rejection observed by the runtime; no product property requires deterministic attribution of two simultaneous failures. The test should assert the event’s closed vocabulary, not a scheduler-dependent source ordering.

**Falsifier:** a deferred fake whose episode promise never settles and whose memory promise rejects must still make the recall promise resolve to the canonical all-empty result without releasing the episode fake. If it does not, reject this approach.

### 2. Array classification and hostile iterators

- [observed at `c742c70`] The pre-repair gateway accepted `Array.isArray(rows)`, read `.length`, then used `for…of` to admit rows.
- [observed] ECMAScript’s synchronous iterator acquisition obtains `@@iterator` using `GetMethod` and calls it. Therefore an own iterator or proxy `get` trap can run during `for…of`. [GetIterator](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-getiterator) [GetMethod](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-getmethod)
- [observed] `Array.isArray()` delegates to `IsArray`, which returns true for a proxy whose target is an array and may throw for a revoked proxy. It is a type check, not a safe-data snapshot. [Array.isArray](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.isarray) [IsArray proxy rule](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-isarray)

[proposed] Replace source-array traversal with one private helper conceptually equivalent to:

```ts
function boundedRowSnapshot(value: unknown, limit: number): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) return null;

    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) return null;
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch {
    return null;
  }
}
```

This is deliberately a **bounded data-descriptor snapshot**, not a generic array conversion: it examines at most the configured 5 or 3 indices, does not call `@@iterator`, refuses holes/accessors/subclasses, and gives the existing row validators a clean ordinary array to traverse.

- [blocked] ECMAScript provides no userland operation that conclusively distinguishes an ordinary array from every proxy around one. A proxy can trap prototype/descriptor inspection. The proposed helper catches inspection failure and never invokes the iterator, but it cannot claim that hostile JavaScript objects execute no trap at all. That stronger property requires the future real source to decode bytes/rows into ordinary data before this gateway, not a new H15 sanitiser or serializer.

**Falsifier:** an array/proxy whose `get` trap throws specifically for `Symbol.iterator` must neither invoke that trap nor expand the row count; an accessor element, sparse array, revoked proxy, or over-limit length must yield atomic all-empty failure and closed telemetry.

### 3. Clock contract versus Date range

- [observed at `c742c70`] The gateway permitted every valid ECMAScript Date millisecond through `8_640_000_000_000_000`, then emitted episode query timestamps through `toISOString()`.
- [observed] The shared contract uses Zod’s ISO datetime schema for all recall time fields. [error.ts](../../../packages/contracts/src/core/error.ts:3) [episode.ts](../../../packages/contracts/src/memory/episode.ts:24)
- [observed] In the installed repository dependency, the existing schema accepts `9999-12-31T23:59:59.999Z` and rejects `+010000-01-01T00:00:00.000Z`; Node’s `toISOString()` produces exactly those strings at adjacent numeric milliseconds. This is a local, reproducible contract observation, not an external behavior claim.
- [observed] ECMAScript permits time values to approximately ±273,790 years and specifies signed six-digit expanded years beyond 9999; `toISOString()` emits the ECMAScript Date Time String Format. [Date format and expanded years](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-date-time-string-format) [`toISOString`](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-date.prototype.toisostring)

[proposed] Replace the broad ECMAScript maximum with `ISO8601_4_DIGIT_MAX_MS = 253_402_300_799_999`. Keep the existing non-negative safe-integer requirement. Treat a clock outside that range as an internal invariant violation: fail before reads start, emit no recall telemetry, and expose no clock value. This preserves the current “invalid injected clock is not a source failure” separation. [observed after repair] This proposal is now implemented and covered by the focused suite.

**Falsifier:** at the maximum, the generated `time_range.to` must be exactly `9999-12-31T23:59:59.999Z` and satisfy `episodeSearchArgsSchema`; at maximum + 1, neither read must be called.

## Abort and deadline assessment

- [observed] `AbortController` signals cancellation; APIs must choose to accept the signal and reject or otherwise act on it. The WHATWG standard explicitly describes APIs as being encouraged to react to `abort()` and recommends an API accept a signal in its own input dictionary. [DOM aborting activities](https://dom.spec.whatwg.org/#aborting-ongoing-activities)
- [observed] `OwnerBoundRecallReads` currently has no signal/deadline parameter and H15 is deliberately fake-first with no real storage/provider adapter. [gateway.ts](../../../packages/runtime/src/recall/gateway.ts:75)

[inference] Adding a timer or `AbortController` now would add a deadline policy without a ratified budget and cannot force a non-cooperative hung fake to stop. It would make this narrow source-failure repair look like real-adapter liveness proof when it is not.

[proposed] Defer total-hang cancellation until a separately admitted real-read adapter owns all of the following: invocation deadline, timer lifecycle, signal propagation through every leg, abort-versus-source-failure telemetry, resource cleanup, and a test with a cooperative source. The eventual interface should accept `AbortSignal` explicitly rather than rely on a gateway-side `Promise.race` alone.

## Required tests for the repair

1. [proposed] Memory rejects while episode remains unresolved: both reads were launched; gateway resolves all-empty and emits one closed `failed/source_unavailable` event before the episode is released.
2. [proposed] The symmetric episode-rejects/memory-hangs case.
3. [proposed] Both source failures: result is all-empty; event fields remain one of the closed allowed values, with no scheduler-order assertion and no exception text.
4. [proposed] A direct ordinary array with an own hostile `Symbol.iterator` still admits its bounded data descriptors, proving the implementation did not iterate source-owned input.
5. [proposed] Accessor element, sparse array, revoked proxy, and over-limit array each fail atomically before row admission/Scribe and emit only the closed failure event.
6. [proposed] Maximum four-digit clock produces schema-valid timestamps; the first expanded-year millisecond rejects before source calls.

## Ticket-compatible recommendation

[proposed] Accept exactly the three targeted fixes above into H15: direct tagged `Promise.all` rejection, bounded descriptor snapshots, and the four-digit ISO clock maximum. Do not add an alternate sanitizer, a universal data cap, a new public contract, real I/O, a real-time performance assertion, or a cancellation/deadline feature.

[blocked] A real adapter still needs separately reviewed end-to-end timeout/cancellation proof. That future work must not be represented as complete merely because this fake-first gateway returns quickly after one sibling fails.

## Implemented outcome — 2026-07-13

- [observed] The review repair implemented the three recommended boundary changes: unwrapped tagged `Promise.all` failure handling, bounded own-data-descriptor snapshots, and the four-digit ISO clock limit. The private source failure now retains its cause without returning or emitting it.
- [observed] Final hardening additionally constructs a recall result before calling observational telemetry, classifies private errors by `WeakSet` identity rather than hostile `instanceof` reflection, and re-admits the optional generic hint through the existing Scribe seam before it can enter a query or result.
- [blocked] This outcome still does not establish a total deadline when both fake reads hang, real adapter provenance, cancellation, prompt composition, provider behavior, or deployment proof.
