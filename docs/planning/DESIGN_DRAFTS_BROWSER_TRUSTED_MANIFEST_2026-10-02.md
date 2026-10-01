# Design drafts: browser-task adapter, trusted-person coordination, manifest permissions

Status: DESIGN ONLY. No code, no DO edits, no deploy, nothing run. Layer is SOURCE reading unless stated. Facts come from the repo at beta-mvp and from PR #520's description; anything I did not read is marked unknown.

## 1. Browser-task adapter (prepare-only, staging)

What exists: `browse_page` (read-only, public pages) and `browse_act` in `tools/live/browser.ts`, Stagehand hosted API, keys server-side, provider diagnostics never relayed. `browse_act` submits go through `approvals.proposeBrowserSubmit`, so a submit becomes an owner approval card rather than executing. The skill `browser-task` is blocked in the audit because it "needs vault, test account".

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

I could not find a "manifest permissions" spec. What I read: skills are loaded by `skills/loader.ts` (imports `TOOL_PERMISSIONS`, `skillSchema`, a connector filter by `connectedConnectors`), and the audit says five skills are blocked because the tool they need does not exist. I did not trace the exact admission check.
Reading A (proposed unless corrected): a skill manifest declares the tools and connectors it requires; admission requires every declared tool to exist in the trigger's ACL and every connector to be connected, otherwise the skill is excluded with a reason. That would make "blocked because the tool does not exist" a recorded exclusion instead of a silent gap.
Reading B: manifest permissions mean what a skill may grant itself (tools beyond the ACL). Not proposed: a skill must never widen the ACL.
Question for the requester: which reading, or is this about something else (for example the native36 manifest `grants`)?

## Decisions needed
- Owner: test account and vault entry for browser-task; option (a) vs (b) confirmation for production; which reading of manifest permissions.
