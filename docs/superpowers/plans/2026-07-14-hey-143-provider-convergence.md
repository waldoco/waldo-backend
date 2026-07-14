# HEY-143 — Provider Contract Convergence

Status: [proposed] bounded local implementation plan. It is not a claim that HEY-143 is
complete or that a real provider path is ready.

Date: 2026-07-14 IST.

## Current → ideal → gap

| State | Contract |
| --- | --- |
| [observed] Current | The merged adapter has a fixed Cloudflare REST origin, asynchronous credential seam, metadata-only logging, and hermetic tests. Its Anthropic request mapper derives a non-documented wire ID from Waldo's internal roster alias. `RuntimeLLMProvider` sends a template immediately when the spend threshold is reached. |
| [ideal] | Every Anthropic request uses the provider's documented wire ID while the internal roster stays stable; only an explicitly enumerated equivalent response ID is accepted. A reached spend threshold transforms the route to the configured cheap primary before normal L1, then reaches the template only for availability failure. |
| [gap] | The canonical model roster needs an explicit Cloudflare chat-completions ID table consumed by the adapter. The provider needs an effective clamped route and an attempt metadata type that represents `spend_cap_clamp`. Neither change proves a credential, daily-meter reservation, real context, safety callback, sink, staging deployment, or Alpha run. |

## Source reconciliation

- [observed] The accepted ADR-0051 amendment requires all remaining calls after the tier spend
  threshold to route to the configured degrade target, not immediately to a template; the
  spend path is distinct from the abuse breaker.
- [observed] ADR-0069 requires the spend clamp before L1 and names a primary-only floor as the
  final clamp. Its L3 template is an availability floor, not the budget action itself.
- [observed] Cloudflare's current primary model pages document Anthropic request IDs
  `anthropic/claude-sonnet-4.6` and `anthropic/claude-haiku-4.5`. Their raw response examples
  identify Sonnet as `claude-sonnet-4-6` and Haiku as `claude-haiku-4-5-20251001`.
  Sources: <https://developers.cloudflare.com/ai/models/anthropic/claude-sonnet-4.6/> and
  <https://developers.cloudflare.com/ai/models/anthropic/claude-haiku-4.5/>.
- [observed] Those raw examples use Cloudflare's `/ai/v1/messages` model-page surface; the
  adapter uses `/ai/v1/chat/completions`. [inference] The Haiku physical response ID is therefore
  an exact, source-backed compatibility alias at the chat-completions seam, not proof that every
  future chat response has that shape and never a family/version prefix rule.
- [observed] The current Cloudflare REST adapter uses the documented fixed account API origin
  and metadata-only logging header. Source: <https://developers.cloudflare.com/ai-gateway/usage/rest-api/>.
- [inference] A roster-owned, exhaustive mapping is safer than deriving an external ID with a
  string transformation: a future roster addition fails review/typechecking rather than silently
  generating a plausible but undocumented provider ID.

## Bounded decision

### 1. Adapter model identity

[proposed] Keep the three internal roster aliases unchanged. Add an exhaustive roster-owned table
for each `ModelName` containing its Cloudflare request ID and exact response-identity allowlist.
For the two Anthropic entries, the request value carries the documented dotted ID; the Workers AI
ID is unchanged. The adapter consumes that table, and its response normalizer accepts only a
listed identity for the requested model. It must not use family-prefix or version-prefix matching.

This is a transport compatibility correction, not a roster, model-selection, cache, credential,
or endpoint decision. [proposed] The provider-specific wire table belongs beside the canonical
roster rather than in the adapter because ADR-0069's single-owner roster guard forbids a second
model-identifier authority; the adapter remains the sole transport implementation that consumes
it. The current OpenAI-compatible chat-completions payload does not implement Anthropic native
prompt caching; that behavior remains [blocked] pending a separately sourced adapter decision
and test plan.

### 2. Spend-cap route transform

[proposed] When a supplied spend state is at or above its cap, `RuntimeLLMProvider` will create
an internal effective route whose sole model is the canonical `ROSTER.primary` Workers AI step
with `cache: 'none'` and no cross-provider fallback. It retains the existing full-context then
reduced-context L1 attempts because both are calls to the configured cheap target. Each attempt
is marked `fallback_step: 'spend_cap_clamp'` and the result retains
ordered `routing_logs: ['spend_cap_degrade']`.

If those primary-only attempts are unavailable, the existing L3/L4 route floor applies. Thus a
template remains possible for availability, while it is no longer the direct consequence of a
budget threshold. The normal pre-LLM Scribe path, core hooks, output hooks, and medical gate
remain on every attempted call and on a terminal template.

[proposed] Structural P6 is not an ordinary immediate clamp: when the selected dreaming route
is the structural Sonnet route, this seam requires the durable number of prior P6 deferrals.
Absent or invalid state returns a fail-closed result tagged `fallback_step: 'defer'` without
provider egress; it does not schedule a retry. The eighth attempt (seven prior deferrals) clamps
to primary via the accepted `p6ClampAction` contract. The current RunLoopDO does not persist or
supply that state, so [blocked] P6 scheduling/retry ownership remains a later integration gate
rather than a silently incorrect primary call.

[proposed] Route selection fails closed when a policy contains more than one row for a trigger.
A later P6 scheduler/selector must explicitly supply the single selected row; it cannot rely on
route-array order to choose between ordinary dreaming and P6.

[observed] `RuntimeLLMProvider` resolves the opaque model-aware skill budget immediately before
each attempt from that attempt's model. [inference] Once a future H16 caller is injected at this
seam, a clamped attempt will receive a fresh primary-model budget without making the provider the
owner of prompt composition.

## Test-first acceptance for this slice

1. A fake fetch observes the exact documented outbound ID for both Anthropic roster models and
   a corresponding enumerated response ID normalizes back to the internal model.
2. A different Anthropic family/version response remains invalid; no prefix matching is added.
3. A custom route whose ordinary primary is reasoning becomes a primary-only route at cap:
   the fake gateway receives only `ROSTER.primary`, `workers_ai`, `cache: 'none'`, and
   `fallback_step: 'spend_cap_clamp'`; the successful result carries `spend_cap_degrade` and
   mints a primary-model skill budget.
4. A failed capped primary attempt reaches the existing template only after the primary-only
   availability attempts, and terminal output controls still run.
5. Structural P6 with missing/invalid durable deferral state performs no provider egress and
   returns a fail-closed `fallback_step: 'defer'` result without scheduling a retry; exactly
   seven prior deferrals permit the primary-only clamp.
6. The durable `llm_called`, `llm_observed`, and capped early LLM-failure trace records retain
   only bounded typed `routing_logs`; a capped early failure also retains its typed
   `fallback_step` rung. Malformed spend-reader state, malformed reader envelopes, and
   accessor-backed reader state fail before egress. The eighth P6 escape retains both ordered facts:
   `spend_cap_degrade`, then `p6_degraded`.
7. Focused adapter/provider tests, runtime typecheck, the applicable verification wall, and
   whitespace check pass without network, provider, credential, Cloudflare, Supabase, or sink
   side effects.

## Explicit non-goals and remaining HEY-143 gates

- [blocked] Atomic daily spend reservation/reconciliation and token-to-cost run-journal proof.
  This slice records typed routing metadata only; it does not claim metering completeness.
- [blocked] Real source/identity context, H14/H15/H16 composition ownership, and accepted source
  admission provenance.
- [blocked] Durable P6 deferral storage, next-night scheduling, and retry ownership for the
  explicit P6 state seam.
- [blocked] Real safety callbacks, `ESCALATION_RULES` consumption, asynchronous idempotent sink,
  provider Secrets Store binding, staging deployment, and Alpha end-to-end evidence.
- [proposed] Those gates stay separate from this correction; HEY-143 remains In Progress after
  this slice and requires a human-reviewed plan before any live action.

## Learning captured in the plan

[observed] A repository search found no existing durable note for this exact adapter-ID and
budget-versus-availability reconciliation. This plan is the smallest durable record; a separate
learning artifact is unnecessary unless a later live-path investigation produces a reusable new
lesson.
