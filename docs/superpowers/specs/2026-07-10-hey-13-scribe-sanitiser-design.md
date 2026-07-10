# HEY-13 Scribe Sanitiser Design

## Objective

Install one deterministic Scribe sanitiser Module that owns structured content classification and is
invoked before current persistence and egress side effects. Keep absent product writers absent and
leave live-provider and cloud effects disabled.

## Chosen Interface

The contract exposes one structured function shape:

```ts
type SanitiseInput = {
  payload: JsonValue;
  destination: SanitiseDestination;
  canary_tokens: CanaryTokens;
  source_taint: SourceTaint;
};

type SanitiseResult =
  | {
      ok: true;
      payload: JsonValue;
      source_taint: SourceTaint;
      redactions: Redaction[];
    }
  | {
      ok: false;
      check: SanitiseCheck;
      reason: SanitiseFailureReason;
    };

function sanitise(input: SanitiseInput): SanitiseResult;
```

The runtime implementation is pure, synchronous, provider-free, deterministic, and exported from
`packages/runtime/src/scribe/sanitiser.ts`. Hooks are adapters to this interface; they do not own
recursive traversal or policy. Persistence owners invoke the same function before synchronous SQLite
transactions.

## Policy Order

1. **Canary and secret leakage:** exact session canaries and high-confidence credential formats deny
   immediately. No payload or value enters denial evidence.
2. **Health lockout:** scan keys and values together across strings, numbers, arrays, records, aliases,
   units, CSV, quoted and encoded forms. Raw health and numeric derived health deny at all current
   generic destinations. Nonnumeric derived views require a strict ADR-0081 envelope and explicit
   destination eligibility.
3. **PII:** replace email, phone, payment card, IPv4, and street address content. Emit aggregate counts
   by redaction kind only.
4. **Instructions:** two or more distinct hostile patterns deny. A single weak pattern is replaced and
   allowed, preserving ADR-0024's false-positive policy.
5. **Destination policy:** validate aggregate serialized size, JSON depth, array length, object field
   count, key syntax/length, and destination payload kind. Strict caller-owned Zod schemas remain the
   exact field allowlists for tool args, run state, trace details, evidence, and telemetry.

The structural preflight rejects cycles, non-JSON values, and impossible encodings without attempting
to classify them as policy content. It is not an alternate check order.

## Destination Mapping

The existing ADR-0024 names stay canonical. `r2_summary` and `outbox` are added to the same enum so
ADR-0081 grants cannot be implicit:

| Side-effect owner | Destination |
| --- | --- |
| memory inbox/block candidate | `memory_block` |
| system instruction text | `system_prompt` |
| trigger context, tool results, run checkpoint | `internal_context` |
| R2 bounded nonnumeric summary contract | `r2_summary` |
| trace, replay, test evidence, operational metadata | `audit_log` |
| pre-outbox delivery candidate / opaque persisted payload | `outbox` |
| final user/channel content | `send_message` |
| draft/sandbox/skill surfaces | their existing named destination |

There is no R2 or channel implementation in this PR. Their destination policy is fail-closed contract
coverage for future writers.

## Structured Health View

HEY-13 does not implement `HealthComputationAuthority` or alter Form math. It adds a nonnumeric,
strict destination view containing:

```ts
{
  authority: 'backend';
  algorithm_version: 'form.safte-fast.v1';
  form_zone: FormZone;
  trend: 'improving' | 'steady' | 'declining' | 'insufficient';
  freshness: 'fresh' | 'stale';
  missing_components: CrsPillar[];
  confidence_band: 'high' | 'medium' | 'low';
  provenance_refs: string[];
  destination_eligibility: ('trigger_prompt' | 'volatile_run' | 'r2_today_summary' |
    'r2_baselines_summary' | 'runtime_trace')[];
}
```

Opaque references use a bounded identifier grammar and cannot encode subjects, provider accounts,
database keys, or values. The sanitizer checks that the requested destination has a matching
eligibility grant.

## Encoded Corpus Boundary

Detection generates analysis views without replacing ordinary text merely because it resembles an
encoding:

- JSON `\\uXXXX` escapes;
- RFC 3986 percent-encoded UTF-8 octets;
- RFC 4648 Base64 and Base64URL tokens that decode to printable UTF-8.

At most two decode passes are followed. A decoded representation may not exceed the destination cap
or four times its encoded input. Recognized malformed/over-expanding content denies as
`invalid_payload`. Archive/compression decoding and arbitrary character sets are excluded.

## Persistence Shapes

`RuntimeRunRecord` gains strict schemas for:

- fake-first context: source, trigger, nonnumeric body state, session time, allowed tools, taint;
- persisted get-CRS tool calls validated before checkpoint;
- content-free tool-result summaries;
- sanitized final delivery text and source;
- roster-owned model/fallback/count metadata;
- ambient external taint;
- a finite failure-reason vocabulary.

Trace details become an event-discriminated strict union. Evidence metadata and metric labels become
closed low-cardinality schemas. Replay failures reuse the finite run reason rather than arbitrary text.

## Provider and Tool Ordering

- Requests: Scribe system/messages, then PreLLM hooks, then gateway.
- Gateway results: PostLLM canary/Scribe/medical chain before returning.
- Template results: the same PostLLM chain; no early return.
- Tool args: ACL and strict tool schema, then Scribe, autonomy/taint/egress, then handler.
- Tool results: validate result and taint, then Scribe before model/context use.
- A custom hook registry extends required safety hooks; it cannot replace them.

## Medical Gate

A separate pure medical-claim Module implements the existing `medical_gate` hook. It denies
diagnosis, condition/risk, symptom interpretation, direct prescription/supplement, and dosage-shaped
claims. The immutable Brain examples are golden tests. It does not become a sixth Scribe check.

## Denial Semantics

- Pre-provider denial: zero gateway calls.
- Pre-tool denial: zero handler calls.
- Checkpoint denial: candidate is not written; run stores only `scribe:<reason>`.
- Trace denial: original detail is dropped and a content-free `scribe_denied` event records destination
  and reason.
- Delivery/outbox denial: no gate/outbox row and no sink call.
- Replay/evidence denial: no unsafe fixture is returned.

## Alternatives Rejected

- **Regex hook only:** cannot classify keys/numbers or protect non-hook writes.
- **Schemas only:** cannot redact free text or detect encoded hostile content.
- **Per-writer sanitizers:** duplicates policy and recreates drift.
- **LLM judge:** nondeterministic, circular, costly, and prohibited by ADR-0024.
- **Block all numbers:** breaks ordinary counts/times and was rejected by ADR-0024.
- **Invent R2/channel/memory product writers:** expands HEY-13 into other tickets and creates fake proof.

