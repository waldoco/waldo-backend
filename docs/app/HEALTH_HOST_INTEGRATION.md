# Owner-bound health host integration

`health/owner-production.ts` is an optional, currently uninstalled composition
of the existing signed health service, demand writer and current demand collector.
The existing owner-turn and direct authenticated app health routes still use the
unconfigured health factory; numeric activation remains unavailable. Installing
this adapter requires truthful actual supplier ports, the complete independently
accepted receipt and root-owned serving integration. It adds no owner identity,
provider authority, model destination or scheduler.

The factory API is:

```ts
const ownerHealth = createOwnerHealthProduction({
  call: signedRpc,
  doName: serverDerivedSignedOwnerHandle,
  assertCurrent: admittedOwnerSourceCurrent,
  accounts: actualSelectedGoogleAccounts,
  google: currentAccountGoogleClient,
  ownerEstimates: canonicalExplicitOwnerTaskEstimates,
  responses: canonicalResponseObligations,
}, trustedClock, trustedCalculationConfiguration);

// Existing app handler, after canonical authentication and rate limiting:
healthProductionRequest(request, ownerHealth.health);

// Existing owner scheduler, at an explicitly configured consistent cutoff:
ownerHealth.capture({ source, consent_epoch, day, timezone, as_of });
```

`trustedCalculationConfiguration` is optional and contains `review_receipt` plus
an optional actual owner-confirmed `sleep_need`. It accepts no arbitrary supplemental
or raw-health model callback. A strict receipt must match the current exact algorithm
and vector pins, all four versions, review timestamp and separate formula/privacy
review references. The release host supplies that receipt only after the actual
reviews pass. Test receipts are explicitly synthetic. Missing or mismatched receipts
leave `activation.state=inactive`; a admitted engineering candidate remains labeled
`candidate_unaccepted` and `clinical_validation=not_established` in numeric outputs.
The factory's `activation.state=reviewed_candidate` describes trusted engineering
configuration, never clinical acceptance or native/live evidence.

Both existing factories receive the same snapshotted signed `doName`, which is also
the calculator `owner_ref`. Do not substitute a Telegram subject, app field or
surface identifier. Every actual signed call verifies its owner binding, then
calls `assertCurrent` immediately before and after IO. Its optional metadata scope
contains only plane, operation, source, consent epoch and owner/model audience.
The host must check canonical owner/session lifecycle and current source/account
grants; it must honor model-processing purpose for model reads. SQL independently
checks source consent/epoch inside its transaction. The collector additionally
checks account revision and source consent around supplier reads and its signed
write. Failed current checks release no old health result and return fixed error
codes; provider exception bodies are suppressed by the existing adapters.

The host supplier ports must return actual selected accounts, current Calendar and
fully paged Tasks, explicit owner-confirmed task durations, and actual canonical
requires-owner-response obligations. They must report incomplete/unknown states
honestly. Missing estimates and unresolved obligations are null inputs; zero is
allowed only with complete source evidence. Numeric demand snapshots remain in
the signed protected Supabase health plane. The adapter adds no raw cache, ordinary
DO persistence, logging, transcript, outbound draft or browser payload.

Current `health.today` uses the trusted current clock as its calculation cutoff;
`health.history` uses each stored physiological day's `compiled_at`. Demand's
baseline regime includes the exact local cutoff minute, timezone and selected
account digest. An existing scheduled snapshot at a different minute cannot be
silently reused. Historical summaries read only already stored matching snapshots;
they never query today's providers and backdate their results. Absent matching
history leaves Weight unavailable. Complete historical Weight still needs the root
scheduler/ingest host to align capture and physiological cutoffs, or a separately
reviewed retained protected snapshot design. This adapter does not claim to close
that operational gap.

Local synthetic `health-owner-production.test.ts` exercises the actual adapter,
producer and collector. It demonstrates all four numeric candidates with admitted
physiological fixture provenance, actual current supplier-port responses and
explicitly synthetic matching-regime demand history. It also checks absent review
configuration, mismatched pins, missing estimates/obligations, canonical owner
binding, lifecycle/source revocation before and after IO, source/model read scope,
privacy-safe failures, unlinked ownership and historical cutoff isolation. These
fixtures do not prove real provider, physical-device, model, merged or deployed
behavior. Root call sites, exact-head review and release/runtime evidence remain
separate integration responsibilities.
