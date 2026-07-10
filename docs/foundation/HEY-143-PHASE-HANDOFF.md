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

## [blocked] Before Alpha

- HEY-13 must supply structured sanitizer/Scribe/taint wiring before real content.
- Provider spend needs atomic/auditable reservation and reconciliation before each attempt.
- A Cloudflare Secrets Store binding must be provisioned outside this repository.
- Real context/recall, one accepted source seam, and a bounded provider staging smoke remain.
- HEY-153 must prove verified subject to one owner-bound DO before public projection access.
- HEY-110 must prove the separate asynchronous idempotent in-app adapter.
- HEY-156 must prove two-user staging parity and whole-path rollback.
- Shadow Fetch delivery must remain off; real Spots and persistent text Chat remain unbuilt.

## Next Owner Handoff

HEY-13 is the next backend harness execution slice. Keep sanitizer/hooks/provider/run-loop files
single-writer where that slice crosses them. A later provider session consumes the real safety,
context, spend, secret, and source seams and preserves the no-payload logging invariant.

The first public morning-Brief GET is a side-effect-free committed-projection read. It is not a
provider call, async delivery, HEY-143 completion, or Alpha proof. Do not mark HEY-143 complete
until the promoted Alpha criteria are separately observed.
