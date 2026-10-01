# Communication read coverage repair

Live Q2 overclaimed a sampled ten-message page as today's inbox. Source inspection
found that get_communication ignored date_range.to and hid the Primary category,
one-account selection and lost pagination metadata. The first local fix applies
both instants to returned rows and reports the actual rolling24h/explicit window,
timezone, fetched/returned counts, Primary-only scope, one account and incomplete
pagination. An empty filtered page does not prove an older window has no messages.

This first step does not move the upper bound into Gmail's query, paginate, select
all accounts, or unmask sender/account addresses. It gives the model truthful
coverage before those larger connector/projection changes. No live proof yet.
Existing quarantine tests used future timestamps outside their fixed clock; those
were moved into the fixture clock's window, retaining full artifact assertions.

Official provider references inspected:
https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
Documents nextPageToken and resultSizeEstimate, which the existing adapter drops.
https://developers.google.com/workspace/gmail/api/guides/filtering
Documents query filtering and API/UI differences. Notification sender display
names remain untrusted and never establish a reply recipient or current CI state.

## Connector cursor/query follow-up

The concrete Google client now has read-only mailPage(q,limit,pageToken), preserves
nextPageToken/resultSizeEstimate and validates response metadata before returning.
The shared GOOGLE_METHODS roster exposes it on the Vault/proxy rail without a
separate hand-maintained allowlist. get_communication uses exact epoch after/before
query bounds, filters the final metadata timestamps to [from,to), and exposes the
provider cursor and estimate. Cursor continuation requires an explicit date
range. The caller is told to reuse the same range, but this source does not bind the
opaque provider token to a prior query. Returned coverage names that uncertainty; rolling default time must not silently change between pages. A first page
without a next cursor and without filtered rows can describe complete coverage of
that query, not all categories/accounts. Subsequent pages are never described as a
whole query. Provider estimates are not counts. No automatic paging/model loops.

Legacy synthetic/read adapters that lack mailPage retain explicitly marked unknown
pagination and the previous sampled-page limitation. The isolated native Google
adapter denies mailPage until it has a concrete fixture mapping. No fixture row
injection, sender unmasking, account metadata, proxy live deployment or hosted
query is claimed. The new method is read-only and requires no intent/send grant.
