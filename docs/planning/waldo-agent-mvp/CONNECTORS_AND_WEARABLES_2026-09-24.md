# Connectors and wearables: WHOOP terms and pre-beta requirements

Recorded 24 September 2026 from owner rulings relayed that night. Planning input for the connector ADR, memory architecture and model routing.

## WHOOP

**Status: last on the wearables roadmap, blocked on terms review of the AI/ML clause.**

WHOOP's new terms take effect on 6 October 2026. They ban using the API or WHOOP data to create, develop, test, train, fine-tune or improve AI models. We don't know yet whether putting one user's WHOOP data into an LLM prompt for that user counts. WHOOP needs to confirm in writing before anything beyond the prototype.

### Connector rules (for the ADR)

- v2 API only. v1 is dead.
- Webhook-first, and verify every webhook's HMAC signature.
- One token refresh per user at a time, under a lock.
- Request the offline scope.
- Revoke the token when the user disconnects.
- Purge WHOOP data when the user's account ends.
- Dev credentials never go in the open-source repo.

### Memory rule

WHOOP's terms ban permanent copies, databases, and caching longer than the cache header allows. Until WHOOP approves otherwise in writing:

- Store only short-lived WHOOP values that can be fetched again.
- Tag every stored WHOOP-derived record with its source so it can be purged on its own.

### Model routing rule

- A prompt that contains WHOOP data goes only to a provider with no training on inputs and low retention.
- Each user opts in first, and the opt-in is recorded.

### Prototype limits

- Fine within WHOOP's 10-member developer limit.
- No training, evals or test fixtures built from real WHOOP data.

## Pre-invited-beta requirement: network guardrails

Owner ruling, 24 September 2026: infra-level network guardrails for the Waldo runtime are required before the invited beta, not now. That means egress allowlists and network security hardening. Code-level trust boundaries stay covered by [ENGINEERING_FUNDAMENTALS.md](ENGINEERING_FUNDAMENTALS.md).
