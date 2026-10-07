# Account-bound Calendar action journey

## Concrete gap and candidate

SOURCE baseline beta-mvp 18f6589 already protected Undo using the applied etag, a fresh event read and If-Match. This candidate retains that behavior. The remaining defects were unregistered common calendar proposals, an approval left open across provider awaits, acknowledgement treated as completion, and no restart/readback/channel recovery.

The serving path is the existing Google handler → owner approval desk → authenticated callback or console decision → primary-calendar adapter → provider readback → channel receipt. Common admission includes the proposal, and task source mapping plus the existing pasted-only guard cover its event reads. No new action permission or per-step approval was added.

A card and console review identify the connection, account email and primary calendar. The stored proposal freezes those fields, action, event/version, interval, title, reason and generated provider ID with a binding digest. A selected missing or scope-revoked connection never falls through to another account. Multiple connected calendar accounts require selection for a proposal. Calendar queries accept the same connection ID; nonprimary mutations are outside this candidate.

Approval consumes open state synchronously before any await. The existing ledger's undo_json retains operation phase, target ID, before interval, applied version and confirmation/delivery markers. There is no hosted migration or new store. Create supplies a stable base32hex event ID; create/move writes a private operation marker. Readback requires the ID-specific resource, marker and requested interval (and create title). Cancellation and create Undo require a cancelled/absent resource. Mutation acknowledgement alone never produces Done.

Response loss, proxy pending, malformed acknowledgement and readback outage leave visible uncertainty. The existing owner /ledger path reconciles at most eight bound unfinished or undelivered rows, rotates them durably, and only reads the provider; callbacks, restarts and reconciliation never resubmit mutations. Lost channel receipts can be redelivered without another Calendar write. Readback establishes the observed calendar state, not causal attribution to our delete if another actor also deleted the event.

Undo uses the exact applied etag and the existing 10-minute window, checks the fresh version and supplies If-Match. Owner edits and read/write races preserve the edited event. A lost mutation acknowledgement cannot establish an applied version and therefore cannot offer Undo. Lost Undo response reconciles its desired state without another reversal. Legacy unbound approvals need fresh review; uncertain legacy outcomes remain visible for manual Calendar checking.

## Verification and falsifier

- Synthetic REST journey exercises the actual connector, registered Google handler, common admission, owner desk, provider readback and channel receipt.
- Workers owner-DO tests exercise its actual registered handler, selected connection resolution, authenticated/non-owner callbacks, restart /ledger, revoked scope and disconnected-account negatives.
- Existing Undo tests retain later-edit, If-Match race, missing-version, concurrent and restart cases with provider-shaped account/readback fixtures.
- Falsifier: wrong account/calendar, altered approved content, duplicate mutation/reversal, overwritten later edit, false Done without readback, or lost uncertainty hidden by recent history.

No live Calendar changes, invites, grants, model calls, hosted database writes or deployment were performed. Deployed connector-proxy support for the extended arguments/private-property projection and parent-coordinated staging acceptance remain unverified. Core owns final integration with PR905; overlapping hunks are account selection and approval forwarding, common policy/source mapping, Calendar connector methods and the existing ledger hook. The isolated branch does not include PR905's mail changes.

## Current official semantics

- [Conditional versions](https://developers.google.com/workspace/calendar/api/guides/version-resources): update/delete support If-Match and return 412 on conflict; insert uses unique supplied IDs rather than conditional modification.
- [Events insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert): primary targets the authenticated account; supplied IDs use base32hex and are unique per calendar.
- [Events patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch) and [private extended properties](https://developers.google.com/workspace/calendar/api/guides/extended-properties): patch changes only supplied properties; private operation metadata belongs to the event copy on this calendar.
