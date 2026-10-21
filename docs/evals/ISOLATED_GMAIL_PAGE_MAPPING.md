# Isolated Gmail page mapping

PR472 verification failed at the real owner-DO source isolation test because
get_communication correctly preferred the present mailPage method, but the
isolated adapter implemented that method only as rejection. This is a fixture
mapping gap, not evidence of a production Gmail failure.

The test-only adapter maps only the exact Primary inbox/date query form emitted by
the real handler. Unsupported Gmail search syntax fails before collection. It
validates epoch window and Gmail page limit, collects only through the supplied
owner/selection boundary, filters time and optional fixture category/inbox flags,
sorts deterministically, and returns only normal message-list metadata, not body
or arbitrary source fields. Absent category/inbox flags retain the existing fixture
convention that authored mail rows belong to its Primary inbox.

Synthetic cursor checks owner, exact query, limit and current filtered rows digest;
stale or mismatched cursor fails. This unkeyed hash is not authentication: offsets
can be edited and a caller knowing the rows can recompute the digest. It contains no source body/subject. It is a deterministic
fixture cursor, not an authenticated Google cursor or real provider provenance.
The Google-only integration keeps real owner A/B isolation and cursor/revision tests,
but does not include the separate nativeSelectedSource wrapper test.
No source writes, network, effect admission or scripted successful model answer.
The full real-DO owner A/B source isolation test passes with the mapped path.
