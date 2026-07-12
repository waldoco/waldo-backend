# HEY-166 — Workspace Reader Admission Proposal Handoff

**Phase status:** research and policy-design package merged in PR #58. It remains a proposal, not
an accepted canonical decision, and does not authorize HEY-14 implementation.

## Delivered

- Source-routed research confirming that no accepted ADR supplies a generic `WorkspaceBlob` read cap.
- A user-skill-only proposal for bounded list, metadata preflight, conditional ranged read, strict
  decode/frontmatter/lifecycle admission, cache handling, content-free failures, and future fake-R2
  tests.
- A separate Linear architecture ticket, HEY-167, for the unresolved canonical authority: an
  in-memory use of the existing Scribe seam at reader/prompt admission and the owner/interface for a
  model-aware token counter.

## Deliberate Non-Deliveries

- No `WorkspaceMount` contract change, R2 binding, bucket access, writer/commit path, Cloudflare
  mutation, deployment, sanitiser vocabulary change, or runtime code.
- No assertion that the proposed 16/20 KiB/320 KiB or 600-token hard limits are accepted ADR facts.
- No claim that the absent `tools/eval/run-suite.ts` passed.

## Verification

`npx -y pnpm@10.34.4 verify` passed on the proposal branch:

- contracts: 48 files / 1,186 tests
- runtime: 20 files / 514 tests
- all typechecks and repository guards passed

Independent source/standards and reader-security red-team reviews were run. Their findings were
incorporated before this handoff: source labels distinguish ADR facts from proposed limits, cache
hits rerun current-session Scribe admission, lifecycle fields come from trusted owner-bound rows,
and R2 list/get configuration is bounded and metadata-minimising.

## Next Owner And Gate

1. PR #58 records the HEY-166 policy as a proposal, not a deployment or implementation decision.
2. HEY-167 must ratify the canonical reader-Scribe/token-counter owner/interface/fail-closed behavior.
3. After HEY-167 is human-approved and merged, create a fresh HEY-14 worktree and implement the
   private R2 mount/SkillLoader through vertical TDD using the proposal's fake-R2 matrix.

The completed prerequisite lineage is `HEY-163 -> HEY-166`; the remaining merge sequence is
`HEY-167 -> HEY-14 -> HEY-15 -> HEY-16`.
