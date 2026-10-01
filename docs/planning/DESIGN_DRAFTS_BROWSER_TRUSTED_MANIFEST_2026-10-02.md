# Design drafts: browser-task adapter, trusted-person coordination, manifest permissions

Status: DESIGN ONLY. No code, no DO edits, no deploy, nothing run. Layer is SOURCE reading unless stated. Facts come from the repo at beta-mvp and from PR #520's description; anything I did not read is marked unknown.

## 1. Browser-task adapter (prepare-only, staging)

What exists: `browse_page` (read-only, public pages) and `browse_act` in `tools/live/browser.ts`, Stagehand hosted API, keys server-side, provider diagnostics never relayed. `browse_act` submits go through `approvals.proposeBrowserSubmit`, so a submit becomes an owner approval card rather than executing. The wiring audit (`waldo-wiring-audit-2026-10-02.md`, section 4, "The five blocked skills" line) lists `browser-task` as blocked with "needs vault, test account" (section 8 repeats "vault for browser-task").

Proposal, prepare-only:
1. Scope: the adapter drives a page up to, never through, the final submit. Output is a typed prepared-action record (target origin, field values entered, the exact submit control identified, a screenshot reference). The record is shown on the existing approval card. Executing the submit stays the owner's Do it on that card, as today.
2. Credentials: any login uses a vault entry requested through a vault link; no secret in chat, tool args or model text. A test account is created by the owner, not by Waldo.
3. Origin allowlist: the adapter refuses origins not on a staging allowlist. Money, signing and account-changing flows are out of scope for this adapter.
4. Taint: page content is external; results are stamped external like other read tools.
Unknown: whether `browse_act` already exposes a "stop before submit" mode or only act-and-propose; how screenshots would be stored (the new binary store from #539 could hold them, not decided). Needs the owner's decision on a test account and vault entry before any live run.

## 2. Trusted-person coordination (identity mapping option (b))

What exists: PR #520 (design checkpoint) says the owner directory returns doName, subject and timezone without a canonical principal_ref or tenant_ref. Option (a) extends the signed route lookup to return owners.id. Option (b) uses do_name as the principal key behind a fail-closed staging allowlist with no migration. Option (b) was chosen by the main agent under the standing decide-and-log rule, not by the owner; it is staging only.

Proposal for the implementation slice, still design:
1. The principal comes only from the authenticated directory row, never from a message, request parameter or model output.
2. The allowlist names exact do_names and fails closed outside staging. Production stays blocked until option (a) plus a reviewed tenant_ref policy.
3. Coordination with another person is disclosure-gated: nothing about the owner leaves without a recorded scope for that person and purpose. This design adds no sending path.
4. The skill stays blocked until the mapping is implemented and a read-only trial passes on staging.
Unknown: the exact code seam in the owner-turn path (Codex-owned files); not traced here.

## 3. Manifest permissions

Reading A is already current behavior, not a proposal: `skills/loader.ts` `exclusionReason` (around lines 312-330) excludes a skill with `acl_violation` when any `required_tools` entry is not in `TOOL_PERMISSIONS[trigger]`, and with `missing_connector` when a `required_connectors` entry is not connected. So a skill can never widen the ACL. What remains open is intent: whether "manifest permissions" means only this existing check or something more (for example a manifest field that declares effects a skill may prepare, or the native36 manifest `grants`). The main agent decided, under decide-and-log (not owner-approved), to treat it as Reading A; Reading B (a skill grants itself tools beyond the ACL) stays rejected.

## Decisions needed
- Owner: test account and vault entry for browser-task; option (a) vs (b) confirmation for production; whether manifest permissions means anything beyond the existing loader check.
