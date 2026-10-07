# Common owner authority RED preparation

Base: a91f9ceb5d8ef66a93f106d51b49b4454a064c3e, October 7, 2026.
No production code changed. These are synthetic prerequisites, not shared-task closure, real authentication, CI, staging or live-model acceptance.

Owner direction: October 6 09:38:16 WhatsApp wamid.HBgMOTE3NTU4NjU5OTMxFQIAEhggQUNFREJFQTEyRDgyRDE1NUIxQkVGNUI0Mzg1RjBBN0QA directly calls for the common brain to win, rather than a surface-specific Durable Object. Pasted third-party RCA assertions are not approval evidence.

Observed REDs on unchanged source:
- common-owner-presence-red: Telegram synthetic binding admitted, same-owner WhatsApp binding rejected at owner-message-admission.ts:68/69. One expected failure, exit 1.
- common-owner-registration-red: first synthetic Coordinator registration admitted, second same-owner presence rejected at identity-presence-module.ts:108. One expected failure, exit 1. Independent revocation assertions are unreachable until registration is fixed; they are NOT claimed verified.

To reproduce without adding a failing test to default CI, copy each file into packages/runtime/test and replace ../../packages/runtime/src/ with ../src/ in its imports. Run pnpm --filter @waldo/runtime exec vitest run test/common-owner-presence-red.test.ts test/common-owner-registration-red.test.ts, then remove the copied files. Both tests are intentionally RED.

Engineering boundary:
The messaging presence lookup and Coordinator session-backed authority have different authenticated inputs. Do not synthesize session ID, session expiry, policy or registration evidence to bridge them. Map the verified authority/currentness contract first, including multiple independently revocable presences under one common owner root. Reuse OwnerTurnEnvelope/createOwnerResponder and WaldoCoordinator. Do not create a third brain, rename storage keys or mistake an admission helper for shared orchestration.

Closure evidence still required:
A same-owner task created through admitted chat, continued through another surface and background work, retaining task/revision/approval identity and one effect intent. Foreign-owner/stale/revoked inputs denied, crash-after-effect reconciled without resend, completion based on provider evidence. Exercise the deployed path, not the local-only WorkUnit bridge. Review, exact-head CI and staging acceptance remain separate gates. Dalda owns overlapping Telegram composition work; coordinate before changing it. Console sign-in is untouched.

Additional ingress RED (common-ingress-red.patch): overlays one test on the existing sealed owner-do-ingress-isolation test. Real webhook parsing/registered owner DO execute with synthetic authority/model/channel dependencies. Test request returns through existing chat processing, but the proposed auth-user-hash common root has zero owner_roots rows. This establishes that the current path makes no common-root handoff; the auth-user relation in this test is a proposed synthetic expectation, not a source-verified live mapping. 1 expected failure, 47 skipped. It is not full task/artifact/recovery acceptance. Apply patch to the test temporarily and run the named test under vitest.owner-ingress.config.ts; revert only that appended delta afterward.
