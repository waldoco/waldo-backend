# Forget coverage audit (source review, 2026-10-02)

Docs only. Source review at beta-mvp; nothing was run on staging, no hosted check, no claim that any store is clean at runtime.

## Covered by existing tests (packages/runtime/test/forget-coverage.test.ts, forget-derived-stores.test.ts)
claims, episodes (row redacted in place, FTS verified), memory backups, legacy spots and core files, constellation nodes, the rolling conversation store, recent tool-output summaries, derived cards and day-plan text, surviving claims that quote the forgotten text. Failure paths: durable pending intent, failed store named in the receipt, retry resumes, KV-survivor not settled until verified clean, incomplete reported rather than success.

## Not shown to be covered (needs review, not a finding of leakage)
1. Scheduler and loop tables created in src/tracer/schema.ts: journal, run_candidates, loop_observations, outbox, held_candidates, schedule, schedule_runs, heartbeat_notified. I found no forget, purge or redact reference under src/tracer. Whether any of them can hold forgotten text (for example outbox or held candidate bodies, schedule payloads) is unverified.
2. Trace and analytics sinks: src/observability has trace-privacy.ts and otlp-turns.ts. I did not verify that exported traces (and any external project history, for example Langfuse) exclude or can retract forgotten text.
3. Run journal, goals and responsibility stores: no forget reference found; contents not inspected.
4. Out-of-reach categories that must be named honestly in any "forgotten" claim: external services, backups outside the runtime, copies the owner shared.

## Proposed next slices (red-first)
- A synthetic-topic test that writes the marker through every store above that accepts text, forgets it, and asserts absence per store, with an explicit "incomplete" receipt for any store not yet handled.
- Decide per store: redact in place, delete, or prove it never holds content. No claim of "forgotten" until fresh-state verification finds nothing active.
