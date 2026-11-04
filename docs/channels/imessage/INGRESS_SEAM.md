# Admitted iMessage seam (S1)

`admittedIMessageTurn` accepts an explicitly trusted verified presence binding; it does not discover or verify a sender. It parses the versioned event and requires matching bridge, account, chat and exact subject. No alias/display-name inference occurs. SMS/RCS, shared/group messages, outgoing echoes and non-message events reject before a turn is returned. Mutation updates are retained at the protocol/relay layer and never silently rerun text turns.

The envelope carries opaque message/thread references and ordered attachment references. S3 must resolve them through owner-scoped media tickets and verified content handlers; S1 does not fetch files or convert paths. Loaded plural `attachments` use the existing model attachment schema (currently four maximum); ambiguous singleton-plus-array and oversized arrays reject, never truncate. Existing singleton callers remain compatible. Reply context is external, with no invented author or quote text.

`PresenceLookupProvider` adds imessage to lookup only. Existing redemption providers remain Telegram/WhatsApp. No iMessage lookup is invoked by a live route, and no binding/setup or invite authority is created.

Candidate SQL is `migration-proposal/presence-provider.sql`, deliberately outside `supabase/migrations`, transaction-wrapped with rollback. It preserves existing presence literals and adds an inactive-only iMessage constraint. It leaves link codes, grants, RLS and functions unchanged. Offline planned-statement tests validate its shape against committed WhatsApp DDL; PostgreSQL execution, catalog effects and hosted schema semantics are **not tested**. Do not apply or move this proposal into canonical migrations under S0–S2. A later reviewed identity/setup design must replace the inactive-only constraint before linking.

S1 is cumulative over S0; Instinct must review/land predecessors first. Production remains disabled. No inbox, outbox, stop, steer, scheduler, connector-secret, deployment or auth implementation is changed.
