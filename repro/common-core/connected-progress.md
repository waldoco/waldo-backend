# Connected candidate, incomplete

Base: a91f9ceb5d8ef66a93f106d51b49b4454a064c3e. Existing Coordinator/root retained. Local source only, COMMON_OWNER_TASKS absent from deployment configuration. No staging/production migration applied, no CI/PR/deploy or activation.

Implemented internal dependencies:
- Signed exact common_owner_authority mapping to actual auth.users UUID. Missing binding rejected. Root uses existing owner auth-user hash. Digest-only message custody, owner-global epoch fences all prior issuer snapshots.
- Additive private message capture reuses existing capture writer, command replay integrity and projection. No fake presence_sessions. Public authenticated-session route preserved.
- Signed physical-host ingress is checked again at receiver and root routing verified. A text occurrence reaches common writer through real webhook/router/registered owner DO under synthetic authority/model/channel fixtures.
- Actual host presentation facts reach ordinary model request. Telegram native buttons/reactions versus WhatsApp text callback/no-op behavior. No new WhatsApp API feature implemented. Reviewed-skill safeguards no longer restore false renderer promises.

Not complete:
- Current capture is per occurrence, NOT retained canonical ongoing task. Another message would create a new Outcome. Need source classifier retain/new/restrict to drive common task selection and preserve narrowing/pending decisions.
- Model loop remains physical host/inbox-owned. No production common executor, retry ownership transfer, normal background/eviction continuation.
- No canonical frozen exact workspace intent, same-operation uncertain reconciliation, console common projection, second presence normal caller or artifact/export/owner delivery acceptance.
- Actual directory population/root compatibility and staging normal-path usefulness unverified.

Validation:
- Initial helper module-load failure and private-method-absence failure are not meaningful behavioral REDs. Earlier source/registered ingress absence RED and surface prompt assertions are real behavioral failures.
- Worker tsc passes with NODE_OPTIONS=--max-old-space-size=4096. Initial OOM followed by two fetch mock signature errors, fixed.
- 92 selected Coordinator/schema/execution/workspace/new admission/prompt tests pass. 47 old sealed ingress tests pass.
- Dedicated synthetic common caller 1 pass, 47 skipped; model request contains TG native presentation. Fixture outbound delivery egress-blocked, not delivered.
- Fresh local pgTAP shim: 466 pass with PGTZ=UTC, 12 new mapping/currentness tests. Initial fixture failed current verified-phone WA constraint, fixed; pre-existing health timestamp test requires UTC. Live DB not touched.

Constraints: console-signin.ts untouched; Telegram login/banner/buttons untouched; no probe --live; S0 off; browser activation/production/money/private-material scope unchanged; Dalda owns browser driver, Core shared caller wiring. finishRun overlaps serialized. Existing exact-head CI/review gates still apply. #892 Actions disabled blocker not bypassed.
