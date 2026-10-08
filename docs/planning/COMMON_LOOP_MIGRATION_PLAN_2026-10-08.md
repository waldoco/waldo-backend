# Legacy path to common loop: migration plan (Core), 2026-10-08

Owner direction 11:12 (relayed by main): remove the legacy path, one agent loop (the common DO) with all tools, remove unnecessary classifier/sanitiser/validator bottlenecks, a bare owner message just runs with defaults. Keep: approvals before sends, purchases and calendar writes; secret protection (egress); explicit owner restrictions (honored, never fatal).
Rule per slice: move one tool family to common, delete its legacy handler, red-first, trace on staging as an ordinary user, Telegram never broken between slices. State words: merged / live / tested are always reported separately.

## Where we are (evidence)
- Common admits ~15 of ~70 tools; legacy path has ~49 handlers. Owners route by `commonActive()` (per-owner env activation AND no legacy restriction row, telegram-owner-do.ts:267).
- Trace tg-904958345/346 (11:06-11:08): his chat is on legacy custody, classifier "uncertain", mail/calendar not offered, confirmation loop. Pushed: #903 B2 (stay legacy on restriction), #912 circuit break, #910 scribe (strict first, lenient oversize retry), 35ffa02c task-source (unready/expired are not narrowings).

## Stage-by-stage (turn-loop analysis, 10 stages) and the slice that removes each
1. Webhook edge: KEEP (auth, routing).
2. DO admission/dedupe: KEEP identity + dedupe; delete unlink-epoch revalidation chain in slice 8.
3. Common custody binding (telegram-owner-do.ts 261-491): replace by execution row + status `uncertain` + one notice. Slice 8.
4. Classifier + task-source gate (owner-turn.ts 343, 538): DELETE. Slice 1 makes owner defaults the only source rule; explicit owner restrictions become plain data checked at the tool boundary. Slice 1.
5. Scribe on owner text/context: DELETE inbound sanitise on the turn path; keep egress-only (`sanitiseVerifyOnly`, egress scrub, SECRET_PATTERNS). Slice 2.
6. Canary composition and revision re-composition: DELETE. Slice 2.
7. Model call (provider.ts): keep circuit breaker; drop scribe guard sites with 5. Slice 2.
8. Tool dispatch (dispatcher.ts): keep permission/ACL; drop per-call custody re-verification. Slice 8.
9. Approvals: KEEP; flip `ownerToolApproval` so only sends/purchases/calendar writes ask. Slice 7.
10. Delivery gate: simplify to one daily proactive cap + one cooldown. Slice 9.

## Slices, ordered by user value (effort is honest; days are focused engineering days incl. CI and staging trace)
1. Mail/calendar/tasks/drive READS on common with defaults (no ask). Needs: common path taking his chat (clear/replace his legacy restriction row via DO), `ownerReadSources` defaults, read tools already admitted (get_communication, search_communication, read_thread, query_calendar, get_tasks, read_drive). Delete legacy read handlers + task-source classifier for the owner chat. 1.5-2d. Acceptance: "what is on my calendar tomorrow and new mail" answers with no confirmation.
2. Remove inbound scribe/canary from the turn path (stages 5-7): keep egress secret redaction. 1-1.5d. Acceptance: no scribe_sanitise errors on turns; secret in tool output still redacted on egress.
3. Reminders + standing orders (OWNER_OWN_LISTS family, list/create/cancel). State migration: reminders/standing-orders rows stay in owner DO SQLite, common handlers read the same tables (no copy). 1.5d.
4. Memory read/write/forget (read_owner_context, read_memory, search_episodes, forget). State: same DO SQLite and Supabase memory rows; forget coverage gate (owner-turn.ts ~676 "Recall limited while forgetting coverage incomplete") becomes a note, not a block. 2-3d. Risky: forgetting semantics are owner-protective; keep.
5. Brief/day card and proactive sweeps (brief_sweep, day_card, update_card hops, 200+ errors/7d) on common with Google health circuit-break (#912). 2d.
6. Health/context reads (health_context). 1d once Supabase RPC is shared (same project, owner-confirmed).
7. Sends and calendar writes behind approvals (gmail send/draft, createEvent, moveEvent, cancelEvent): approval desk on tool boundary only. 2-3d. Existing approvals.ts card desk reused; state: pending approvals rows migrate by id, no loss.
8. Delete custody machinery and the legacy turn path (stages 2-3, 8; commonActive routing; legacy handlers still left). 2-3d, after 1-7 are live and clean for 48h.
9. Delivery gate simplification. 1d.
10. Files/compute (#906, Dalda) and browser (Dalda, handed off): admitted into the common loop by their owners; Core only reviews the tool-admission contract.
Total on my lane: about 14-19 working days serially; slices 1-2 are the ones that change daily use, 3-4 next. Parallelisable: 2 with 3 (disjoint files).

## State migration (owner DO SQLite and Supabase)
- owner_task_source_scope: unready/uncertain rows are not narrowings (35ffa02c). For his owner, clear the `narrowed`/pending row once via a one-shot migration so common takes the chat; explicit owner restrictions are kept as `owner_restrictions` data (id, families, set_by_owner_at).
- approvals, reminders, standing orders, loops: stay in place; common handlers read the same tables. Each slice ships an id-preserving read adapter before deleting the legacy handler.
- google:accounts, google:health, google:probes: unchanged (DO storage); Supabase waldo.connections is the token source of truth.

## Needed so a bare owner message just runs with defaults
`commonActive()` true for his owner; `ownerReadSources` defaults; no classifier ask; approvals only at the tool boundary for external effects; one status `uncertain` notice instead of a block; egress-only redaction.

## Open decisions (one-liners)
- OK to clear his legacy task-source row (narrowed/pending) in his DO as part of slice 1?
- Keep forgetting-coverage block or downgrade it to a warning (slice 4)?
- Delivery caps: which single daily proactive cap number (slice 9)?
