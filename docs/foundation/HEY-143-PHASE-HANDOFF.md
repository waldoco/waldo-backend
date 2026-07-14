# HEY-143 Provider-Readiness Handoff

Status: provider adapter/configuration hardening merged in PR #44 at `b311d54`; HEY-143 remains
In Progress because real-path and Alpha acceptance are unproved.
Date: 2026-07-10 IST.
Historical implementation branch: `codex/hey-143-provider-readiness`.

## [observed] Implemented

- RunLoopDO resolves fake or gateway adapters through explicit environment selection; fake mode is
  restricted to `test|local`.
- The Cloudflare AI Gateway adapter uses a fixed REST origin, metadata-only logging, timeout signal,
  cache bypass for `cache: none`, strict response-model validation, and sanitised error results.
- Gateway credential access is an asynchronous Secrets Store-style binding, not a token string.
- Prompt system/messages cross the sanitiser before provider egress; denial and thrown sanitiser
  failures stop before fetch.
- Gateway-mode RunLoop execution fails before egress without an auditable spend reader.
- Local run ingress is restricted to `test|local`.
- The fake callback guard has fixture-backed self-test coverage.

## [historical verified] Merge Evidence

- `npx -y pnpm@10.34.4 verify`: contracts typecheck and 1,168 tests passed; runtime typecheck
  and 182 tests passed; all guards and their self-tests passed.
- `git diff --check` passed.
- The eval-suite probe found no `tools/eval/run-suite.ts`; the verification wall is the recorded
  fallback.
- No live provider call, credential, channel delivery, or Cloudflare/Supabase side effect occurred.

## Historical / Superseded Before-Alpha Record (pre-PR #47)

This preserved block predates HEY-13's merge. HEY-13 is now a completed prerequisite rather than a
live blocker; use the 2026-07-11 convergence update below for current gates.

- HEY-13 supplied the structured sanitizer/Scribe/taint foundation before real content.
- Provider spend needs atomic/auditable reservation and reconciliation before each attempt.
- A Cloudflare Secrets Store binding must be provisioned outside this repository.
- Real context/recall, one accepted source seam, and a bounded provider staging smoke remain.
- HEY-153 must prove verified subject to one owner-bound DO before public projection access.
- HEY-110 must prove the separate asynchronous idempotent in-app adapter.
- HEY-156 must prove two-user staging parity and whole-path rollback.
- Shadow Fetch delivery must remain off; real Spots and persistent text Chat remain unbuilt.

## Historical / Superseded Next Owner Handoff (pre-PR #47)

This retained record predates the HEY-13 merge. Use the 2026-07-11 convergence update below for
current sequencing; do not treat this section as an active assignment.

HEY-13 is the next backend harness execution slice. Keep sanitizer/hooks/provider/run-loop files
single-writer where that slice crosses them. A later provider session consumes the real safety,
context, spend, secret, and source seams and preserves the no-payload logging invariant.

The first public morning-Brief GET is a side-effect-free committed-projection read. It is not a
provider call, async delivery, HEY-143 completion, or Alpha proof. Do not mark HEY-143 complete
until the promoted Alpha criteria are separately observed.

## Convergence Update — 2026-07-11

[observed] HEY-13 merged and is Done at `82f582b5a28530c1fb7800b7fad889590b35e57d`; it is no
longer a live convergence blocker for HEY-143.

Before HEY-143 closure planning, the required merged convergence gates are HEY-15, HEY-16, HEY-75,
HEY-100's static guard slice, and HEY-141. HEY-14 and HEY-144 remain transitive through HEY-16.
HEY-153 owner-bound identity/routing, HEY-110 asynchronous idempotent in-app delivery, and HEY-156
two-user staging parity/rollback remain separate Alpha dependencies.

The clean-main convergence wall authorizes planning only. It does not authorize a live provider,
Secrets Store use, staging write, sink effect, or deployment.

## Provider Contract Convergence — 2026-07-14

[observed] This local, fake-first slice starts from `origin/main`
`845cbf441fbf5e075d8ca70dbf98a17d6565e770` (merged HEY-16).

[observed] The slice pins documented Cloudflare chat-completions identities in the canonical
model roster, emits every selected `fallback_step` to the gateway, applies the ADR-0051/0069
spend clamp to the primary before normal availability fallback, and preserves bounded typed
routing metadata in durable trace evidence. It accepts neither malformed spend-reader envelopes
nor accessor-backed spend records before provider admission.

[observed] Structural P6 is explicitly recognized by its full route shape, fails closed without
a valid durable deferral count, and retains both `spend_cap_degrade` and `p6_degraded` on its
eighth primary-only escape. Ambiguous multi-row trigger policies fail closed rather than choosing
by array order.

[observed] Final local verification passed: contracts tests (1,207), runtime tests (718),
Scribe property tests (258), contracts/runtime typechecks, the full guard wall, and
`git diff --check`. The repository-wide `verify` command reaches the expected environmental stop
at `verify:supabase` because local Supabase is not running; its independent worker/property/guard
checks are run separately. No network provider call, credential read, cloud write, or deployment
occurred.

[blocked] This does not add atomic daily reservation/reconciliation, durable P6 retry state or
scheduling, real source/identity composition, safety callback wiring, a real sink, credential
provisioning, staging deployment, or Alpha evidence. HEY-143 remains In Progress.

[proposed] Next owner action: merge the reviewed local correctness PR, then prepare a separately
authorized plan for atomic metering and durable P6 ownership before any live-provider or
cloud-side action.
