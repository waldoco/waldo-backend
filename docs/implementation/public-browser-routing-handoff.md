# Public browser diagnostics and explicit alternate-provider routing

Base: `beta-mvp` at `9a3f0847b7d51f563ba48399b835159520b8979b`. Prepared on isolated branch `dot/browser-routing-20261006`. This is local source, fake-provider Workers/DO and bundle-startup evidence. No deployment or live-provider acceptance is asserted.

## Outcome

The existing `browse_page` tool retains its two provider choices. Its description reports the trusted default and only configured alternatives. Browserbase requires host allowance, API key and project ID; configuration is not proof of quota or provider availability. No failure makes an automatic alternate-provider call.

The additive, strict `browser_read` result diagnostic carries a finite provider, observed phase/reason, cleanup state, optional HTTP status, and configured alternative. Handler, dispatcher, post-hook, model JSON and trace projections preserve the diagnostic. Input schemas still reject model-supplied owner/session identifiers, configuration or fallback provenance.

The host tool loop may add `fallback_from: cloudflare_playwright` only to a fresh, explicit Browserbase call for the exact URL following an eligible Cloudflare failure from an earlier model round in that invocation. First-choice Browserbase, same-round prebatching, cached replay, different URLs, new turns and other owner loops cannot inherit that provenance. Existing authority, source, egress, shared-round budget and action-replay checks remain in place.

## Failure and cleanup custody

Cloudflare failures are classified where they are observed; page text is not scanned for login/challenge judgments. Whitespace-only content is empty. Nonempty short content and HTTP200 challenge text remain evidence for the model to interpret.

An observed page HTTP failure is retained if cleanup later fails. Known sessions still receive physical close plus exact-session absence verification. A lost allocation acknowledgement, malformed identity, 408, 5xx or unexpected successful acquire status remains `unknown_allocation`. The pinned SDK accepts acquire status200 only. Exact acquire POST402/429 responses are reported as `allocation_refused`, not as physical absence, a billing diagnosis or authorization to spend. Status survives a stalled diagnostic body; expired runs do not advertise an alternative.

Browserbase reads carry the same typed outcome and their actual selected provider. Empty output no longer guesses login or blocking. A successful end response acknowledges cleanup under the documented hosted Stagehand contract. Failure to confirm cleanup suppresses completed-read claims and retains the original failure. This does not establish Cloudflare-equivalent redirect prevention or final-page URL proof for the existing Browserbase path.

Unknown allocation or unconfirmed cleanup stops later `browse_page` starts in that tool-loop invocation while ordinary non-browser work may continue. This is not an account-wide session registry, durable crash recovery or dollar cap. Validated uncertainty is snapshotted before post-tool hooks so sanitizer rejection, hook failure, malformed result, metadata removal/replacement or in-place mutation cannot erase that custody.

Capture-off browser trace codes contain only validated enum/status fields. Dispatcher rejection code/reason remain alongside provider facts, so a completed provider read rejected for oversize or sanitization cannot look like an unexplained successful read. No URL, instruction, request ID, session ID, provider response body or credential is encoded in these traces. Unrelated legacy trace behavior is unchanged.

## Verification

- Full `verify:node` gate: 105 files, 2,005 tests passed (contracts 1,779; workspace 50; browser fixtures 30; browser continuity 120; iMessage relay 26)
- Ordinary registered two-argument owner DO: default Cloudflare read and Cloudflare empty result → model observes configured alternative → separate explicit Browserbase call → host fallback provenance passed, with all model/provider calls faked and live fetch denied
- Focused Workers tests: 17 files, 338 tests passed, covering strict dispatcher/reconciliation, post-hook uncertainty custody, tool-loop replay/budgets, exact-URL provenance, capture-off DO/console/OTLP traces, egress and existing browser regressions
- All workspace typechecks, including runtime Worker and integration configurations, passed
- Staging activated-SDK and ordinary production-SDK-free bundles both passed local Wrangler dry-run and Miniflare startup checks
- `git diff --check` passed

The local commit and artifact checksums are supplied with the patch handoff. Red-before-green receipts include provider configuration/empty-output/cleanup classification, unknown allocation, refusal-body deadline, source withdrawal, strict contract transport, post-hook custody and dispatcher rejection trace preservation. The full Node gate exposed a race between refusal-body timeout and the enclosing work deadline; the catch path now checks the actual deadline while preserving observed status. The corrected regression passed five consecutive stability checks before finalization.

The broad default Workers aggregate was started but stopped when unrelated tests attempted external DNS for OpenAI/Meta and failed resolution. It is not a full Workers pass. No network restriction was bypassed. The root Supabase/CI wall, external providers and staging/live owner journey remain unverified; no database reset or migration was run. Focused local checks do not replace CI on the eventual published head.

## Scope and review

Only two existing owner-turn tool-log callbacks and their import changed; the pending separate owner-request marker is outside this slice. Hooks registry/native AbortSignal cloning is unchanged; the adapter continues using canonical admission/deadline capabilities rather than reading a cloned native signal. Provider calls already in flight are not claimed to abort instantly.

Independent review reproduced two defects, both repaired with adversarial regressions: sanitizer rejection erasing cleanup custody, and browser trace projection erasing the dispatcher rejection reason. No unresolved blocking source finding remained after those repairs, subject to the final frozen-head checks.

## Source evidence

- [Pinned Cloudflare Playwright source](https://github.com/cloudflare/playwright): installed `@cloudflare/playwright`1.3.6 acquire implementation issues one POST and accepts status200 only
- [Cloudflare session management](https://developers.cloudflare.com/browser-run/cdp/session-management/#step-1-acquire-a-browser-session): successful acquisition returns a session identity
- [Cloudflare rate-limit refusal](https://developers.cloudflare.com/browser-run/limits/#error-429-too-many-requests) and [browser-time refusal](https://developers.cloudflare.com/browser-run/limits/#error-429-browser-time-limit-exceeded-for-today): observed admission rejection does not imply a working alternative
- [Cloudflare session reuse](https://developers.cloudflare.com/browser-run/playwright/#session-reuse): connected browser close is a disconnect, requiring distinct termination evidence
- [Stagehand end-session contract](https://docs.stagehand.dev/v3/api-reference/python/end-a-browser-session): ending terminates the session and releases resources, acknowledged by HTTP200/success:true

Rollback is a source revert of this bounded change. No persistence migration, dependency, provider credential, paid plan, deployment configuration or access grant changed.
