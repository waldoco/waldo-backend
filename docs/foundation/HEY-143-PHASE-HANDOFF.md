# HEY-143 Provider-Readiness Handoff

Status: provider adapter/configuration hardening implemented locally and awaiting PR review.
Date: 2026-07-10 IST.
Branch: `codex/hey-143-provider-readiness`.

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

## [verified] Evidence

- `npx -y pnpm@10.34.4 verify`: contracts typecheck and 1,168 tests passed; runtime typecheck
  and 182 tests passed; all guards and their self-tests passed.
- `git diff --check` passed.
- The eval-suite probe found no `tools/eval/run-suite.ts`; the verification wall is the recorded
  fallback.
- No live provider call, credential, channel delivery, or Cloudflare/Supabase side effect occurred.

## [blocked] Before Alpha

- HEY-13 must supply real sanitiser, rate-limit, approval, and medical callback wiring.
- HEY-99 needs an auditable daily-spend reader available before each provider call.
- A Cloudflare Secrets Store binding must be provisioned outside this repository.
- An explicitly approved bounded staging smoke, real context/recall, and a real/staging sink are
  required for the ticket's alpha acceptance run.

## Next Owner Handoff

Keep the runtime/provider files single-writer. The next provider session should consume the real
safety and spend seams, add a bounded staging smoke only after approval, and preserve the no-payload
logging invariant. Do not mark HEY-143 complete until the alpha acceptance criteria are separately
observed.
