# What forget_memory covers

Scope of `forget_memory`, by store. The receipt returned to the owner must match this list.

## Inside the owner Durable Object

- Claims: the selected rows are deleted, not status-flagged. The claim_recall triggers fire on delete.
- Episodes, derived cards, notes, goals, loops, background runs, memory blocks, memory inbox, topic index, patrol log: purged in the same commit. A purge that cannot verify clean leaves the pending row and the tool reports incomplete.
- Final outbox records that carry source-derived text: redacted by literal match.
- The Google profile (`google:profiles`: the name and phone Google gives at connect). A forget whose text matches a field exactly bars that value. A forget that names the field (`provider_fields`) records it in `google:forgotten`, field names only, which no disconnect clears; it is not a memory barrier, so the owner can still give their name in their own words. A forgotten phone is deleted in the same commit, and a later connect does not store it again. A forgotten name stays stored as Google's record and is left out of every prompt, after a reconnect too. Disconnect removes the whole profile entry. A named field's values are not swept from chat history. See the owner-profile ADR draft, §3.3.
- Verification: the SCAN test in `packages/runtime/test/memory-forget-do-provider.test.ts` checks every table and column of the DO SQLite and every KV entry for the forgotten text after forget and eviction.

## Outside the DO or known gaps

- Telegram chat history: Waldo cannot delete messages already in the Telegram chat. The receipt says so.
- trace_log.note and runtime_trace.detail_json: diagnostic logs, tracked as gaps in forget-store-table. They hold hop names and notes, not message bodies.
- Backups and archives (R2 objects, database backups): not rewritten. Retention not verified against code.
- Supabase rows (identity, connections): NOT VERIFIED. Believed to hold no memory text; not audited.
- R2 working-artifact bodies: NOT VERIFIED. They can carry owner text; forget does not touch them.
- Sent outbox rows that were already delivered: not recalled from Telegram.
