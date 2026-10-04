# Owner source proactivity: provisional implementation checkpoint

This draft implements the original default-off slice. The subsequent product direction calls for proactive help after newly informed successful Google onboarding, preserving explicit opt-out and historical owners. That enrollment behavior is not implemented here. Merge is held pending agreement on that contract and store writer ownership.

## Serving behavior

`source_proactivity` is an additive boolean in the existing per-owner DO `proactivity.settings` JSON. Only literal `true` enables it; absence and nonboolean values read false. Authenticated owner settings persist the value; quiet/volume tool edits and timezone updates preserve it. The existing Supabase settings write precedes the local write but does not mirror this field. The DO JSON is authoritative for this slice.

The merged PR702 gate runs in the real ownerDO source consumers. Global flags and owner settings, current Google connection scope, quiet/volume and existing forget coverage gate creation, revisit, enqueue/retry and delivery. Existing source observations, decisions, calendar local-time counters/cohorts and receipt identities remain authoritative; no second identity store is introduced.

Disabling holds unsent queued output without consuming an attempt. Existing expiry remains enforced, and re-enabling may release a still-valid occurrence. Existing transport uncertainty policy remains unchanged. Initial admission is checked before durable attempting; existing owner action/alarm serialization protects that boundary, and plain transport fallback rechecks current eligibility.

The old calendar global-off branch previously sent legacy unsolicited prep. This draft removes that fallback, so global-off suppresses that serving path. Explicit reminders and owner-requested Calendar preparation retain their existing behavior and task-source confirmation, including under low volume and quiet hours.

## Verification

Source base: `694a936a4fe1731a269d6416fccca18acdf2751d`; PR702 merge: `68eadb5582fcbf14d5f3bc9d9281b59963a32a46`.

- Full Worker suite: 3,587 tests, 285 files, exit 0.
- Focused ownerDO/settings/loop regressions: 134 tests, 9 files, pass. These cover enabled A/disabled B, absent/nonboolean setting, queued/model disable races, global-off, quiet/low, retention/forget and local-time identity, explicit reminders and requested Calendar preparation.
- Workspace typecheck, verify:node (1,856 tests), scenarios (85) and owner ingress (82 plus 6) pass. `git diff --check` passes.
- Full verify is incomplete: its Supabase reset was withheld to preserve the existing running local database. Session-revocation unit tests pass (4); its integration needs unavailable local Auth/REST. Guard verification stops at the Linux-only pgTAP bootstrap on this Mac; earlier guards pass.

These are local hermetic results, not live acceptance. No flags, owner opt-ins, OAuth access, grants, deployment, remote migrations or processing were activated.

## Remaining coordination and rollout prerequisites

Parent owns merge and deployment. Resolve overlapping store ownership and the informed-onboarding default contract before merge. Preserve the distinction between absent enrollment and explicit opt-out: the current default-off setter materializes an absent setting as false. Historical Google connections and the legacy `google.keep` migration path are not evidence of informed enrollment. A fresh successful callback needs a versioned disclosure witness before any future initialization of an unset setting.

No remote migration is required for the DO JSON field. If a future Supabase mirror is chosen, separately review an additive column, signed authenticated RPC coverage and read/restore tests; do not apply a remote migration as part of this draft. Its defaults must follow the final enrollment contract.

Complete the remaining database/pgTAP gates in a suitable isolated environment, review the final immutable source head, then obtain coordinated rollout and live acceptance. Global `MAIL_SOURCE_FOLLOWUPS` and `CALENDAR_GROUNDED_PREP` remain 0. Reverting this draft restores the old calendar fallback; a complete shutdown must preserve its removal or stop that scheduler path.
