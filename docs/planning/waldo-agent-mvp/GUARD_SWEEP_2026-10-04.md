# Guard sweep: guards that cost answer quality (2026-10-04)

Rule (AGENTS.md, Full Context and Capability by Default): keep only real-harm guards, each with a plain-words why. SOURCE-read of beta-mvp; items marked CHECK are unverified until the slice that changes them.

| Guard | Where | Costs quality because | Proposal |
|---|---|---|---|
| PII redaction of external-tainted payloads headed to the model (email, phone, address) | src/scribe/sanitiser.ts:711-731 (owner seam only skips when source_taint is null) | Mail, calendar and file text is external-tainted, so the model sees [REDACTED_EMAIL] instead of the address in a message it must read and act on | Drop email/phone/address redaction for model and owner destinations when the payload is the owner's own connected data. Keep credit_card, credentials, and every persistence/egress destination. Why kept: card numbers and secrets must not reach logs or other owners |
| Oversize payload denied, not truncated | src/scribe/sanitiser.ts:929-941 (truncates only for sandbox_stdout) | A long thread or document fails the whole read instead of returning the first part | Truncate with a marker and offload the rest to read_tool_output for every model-bound destination. CHECK dispatcher offload covers it |
| Mail projection keeps sender, subject, snippet only | src/channels/update-cards.ts:84 mailPromptProjection | "Assets due tomorrow" often sits in the body, not the snippet | Fetch the body when the snippet is not enough (S5). Full context to the model; storage rules unchanged |
| Task-source cards for Google families | src/channels/task-source-scope.ts | Owner gets asked before the agent reads his own mail | Drop (S1). browse_page/web_search already moved to the no-card family (#707) |
| browse_act list-bound egress | src/hooks/egress-policy.ts, WALDO_EGRESS_ALLOWLIST | The agent cannot act on a page outside a short host list | Open it like browse_page; keep the private/loopback/metadata blocks (why: a fetch must not reach internal infrastructure) and approval-bound submits (why: irreversible actions need approval) |
| pasted_only SourceScopeStore / guardExternalReads | src/tools/source-scope.ts | Not enforced live (no production callers), so no cost today | Delete or leave unwired; do not wire it |
| Env flags MAIL_SOURCE_FOLLOWUPS, CALENDAR_GROUNDED_PREP default off | wrangler vars, telegram-owner-do.ts | DONE in #714 for staging (flags are kill switches; production wrangler unchanged) | Proactive help is off for everyone | On by default, per-owner opt-out (#709, S2a). Production config is the owner's call |
| Tool-round cap 25 | src/channels/owner-turn.ts:81 MAX_TOOL_ROUNDS | A research task (search then several pages) can run out | CHECK against the eval before changing |
| Tool-arg taint tightening when a reply is quoted | owner-turn.ts toolArgSourceTaint 'external' | Quoting a message may restrict tool use | CHECK what it blocks before deciding |

Kept on purpose, with why: canary leak check (secrets must not leave), medical gate (hard clinical safety line), approval for privileged/irreversible actions (no irreversible act without owner approval), cross-owner isolation tests (one owner must never see another's data), receipts (the agent must not claim an effect that did not happen).
