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
