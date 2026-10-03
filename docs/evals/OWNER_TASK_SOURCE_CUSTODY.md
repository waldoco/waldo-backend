# Owner task source custody

## Problem and bounded repair
N03 at74f1e763 attempted five mail searches and two thread reads during a fictional pasted-only task. Structural trace inspection found the original source limit in all eight reply inputs. The scripted RED checkpoint at9573199e demonstrated that prompt presence alone did not fence physical reads. A later unrelated forgetting hold removed historical task input; it did not explain the original N03.

The owner-local SQL row stores only task UUID, owner key, revision, enum source families, readiness, current task input reference and a bounded pending confirmation. It contains no task text, owner facts, summaries or forgotten spans. Current owner identity, grants, connector consent and effect approval remain independently enforced.

A mandatory structured classification uses the existing serving model. It can retain or intersect source families. Malformed/unavailable classification leaves reads unresolved. New/change/close only creates a machine-enum confirmation card; the model cannot authorize widening. The existing authenticated Telegram owner callback must match the stored owner/task/revision/single-use nonce and unexpired card. SQL CAS rejects stale/replayed decisions. Card expiry never drops an active restriction. Console confirmation is not implemented.

Each normal owner turn incurs one additional model call; new steering is classified once and debits the shared turn/child budget. There is no model change, new grant, new feature flag or free-cost claim. Classification may miss a natural-language restriction; RETAIN does not prove that no restriction was intended. Prompt precedence supports recognition but is not a proof of model intent.

## Source confinement
The responder checks host custody before dispatch and before/after results. Accepted steering invalidates pending physical reads immediately. Google clients recheck transport dispatch after authentication and on internal follow-up HTTP calls. Drive, MCP read, web search and legacy browser reads carry host-only currentness checks. Opened browser sessions still close independently after denial. Already admitted remote operations cannot be rolled back; stale results are withheld. Dispatch is bound to the last classified steering revision, including steering received before handler entry or between batch calls. Children abort completion and publication when their captured scope or steering revision changes, so earlier read results cannot silently survive a narrowed task.

Automatic legacy memory, standing orders and workspace metadata are gated before suppliers run. Canonical limited turns require an explicit task-safe mandatory-material supplier, with forbidden optional fragments rejected and retained recall skipped; absent safe material fails closed. The host-owned task input reference limits conversation ancestry without deleting stored history. Existing forgetting holds still withhold older input bytes; the policy survives without recovering forgotten facts.

## Verification and release limits
Scripted regressions cover the drifting five-search/two-read attempt, ordinary correction and recreation, privacy-preserving recall hold, forbidden-source sentinels, malformed classification, foreign/stale/expired/replayed cards, new/change/close controls, owner currentness, steering during authentication, Gmail internal fetches and browser cleanup. A real authenticated webhook/DO fixture tests owner callbacks and replay protection. These are local structural proofs, not live model answer/referent acceptance.

No production deployment, provider grant or browser activation is included. Release requires independent Spec/QA and Standards/security review at an immutable head, required CI, and a staging receipt preserving existing flags and Durable Object namespaces. Live N03 acceptance remains a separate owner-run check after deployment.
