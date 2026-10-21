# What forget_memory covers

Scope of `forget_memory`, by store. The receipt returned to the owner must match this list.

## Inside the owner Durable Object

- Claims: the selected rows are deleted, not status-flagged. The claim_recall triggers fire on delete.
- Episodes, derived cards, notes, goals, loops, background runs, memory blocks, memory inbox, topic index, patrol log: purged in the same commit. A purge that cannot verify clean leaves the pending row and the tool reports incomplete.
- Final outbox records that carry source-derived text: redacted by literal match.
- Verification: the SCAN test in `packages/runtime/test/memory-forget-do-provider.test.ts` checks every table and column of the DO SQLite and every KV entry for the forgotten text after forget and eviction.

## Outside the DO or known gaps

- Telegram chat history: Waldo cannot delete messages already in the Telegram chat. The receipt says so.
- trace_log.note and runtime_trace.detail_json: diagnostic logs, tracked as gaps in forget-store-table. They hold hop names and notes, not message bodies.
- Backups and archives (R2 objects, database backups): not rewritten. Retention not verified against code.
- Supabase rows (identity, connections): NOT VERIFIED. Believed to hold no memory text; not audited.
- R2 working-artifact bodies: NOT VERIFIED. They can carry owner text; forget does not touch them.
- Sent outbox rows that were already delivered: not recalled from Telegram.
