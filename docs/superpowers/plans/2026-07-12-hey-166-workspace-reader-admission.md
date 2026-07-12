# HEY-166 — Workspace Reader Admission Plan

## Goal

Publish a reviewable, source-routed policy proposal that makes HEY-14's R2 reader testable without
pretending that a generic `Uint8Array` transport is resource-bounded or that a reader is a staged
writer.

## Exact Ownership

This branch changes only the HEY-166 contract, proposal, plan, and research documents listed in the
ISA run contract. It does not edit code, configuration, bindings, lockfiles, or the coordinator
ledger.

## Work Slices

1. Route authority: accepted ADR-0076/0024/0028, current contracts, current H14 acceptance, official
   Cloudflare R2 API and consistency documentation.
2. Separate observed source facts from proposed values. Do not derive a reader cap from the 5,120
   character Scribe surface or from the Workers memory ceiling.
3. Specify the pre-buffer private-mount flow: bounded list, metadata preflight, conditional ranged
   read, exact-copy/fatal-decode, strict parse, provenance/identity validation, one-seam Scribe
   admission, model-aware prompt counter, and cache generation guard.
4. Publish the fake-R2 test matrix as HEY-14's required TDD evidence. No test is claimed as executed
   in this docs-only branch.
5. Create the separate canonical ADR decision ticket if source wording prevents implementation from
   honestly calling the reader Scribe gate accepted.

## Future TDD Order For HEY-14

1. Red: a fake oversize `head` proves `get` and body allocation are never invoked.
2. Green: private mount uses metadata preflight plus conditional ranged read.
3. Red/green: list `truncated`, count, total-byte, all-head-before-get, and version-race failures
   cannot produce a partial cache snapshot.
4. Red/green: fatal decoding, constrained frontmatter, descriptor identity/provenance, and Scribe
   admission cannot reach cache or prompt on failure; exercise duplicate keys, lifecycle rows, and a
   cache hit under new canaries.
5. Red/green: after HEY-167 ratifies the counter seam, HEY-14 injects a model-aware counter that
   enforces the proposed 600 per body and `600 × K(trigger)` hard limits.
6. Refactor only after cache invalidation/generation, two-owner isolation, and content-free telemetry
   cases are non-vacuous.

## Verification For This Proposal

- `git diff --check`
- `npx -y pnpm@10.34.4 verify`
- independent source/sequence review
- independent security/reader-admission red-team review

`tools/eval/run-suite.ts` is absent in this repository. This branch records no eval-suite pass claim.
