# Next Session — Waldo Personal Agent

Updated 21 October 2026 · backend execution entrypoint

Read [the build direction](../planning/BUILD_DIRECTION_2026-10-21.md) first. It holds the owner's decisions of 21 October 2026 and the five waves; this page says where the build is and how a session starts.

## Where the build is

- Wave 1 lands Ashish's integration: the second brain is deleted, Anthropic becomes the fallback provider, memory corrections apply, and every tool refusal has one shape. After it, the shape in source is one `OwnerDO` per owner with no competing brain.
- Every other open PR is resolved in the same pass: landed, rebased onto wave 1, or closed with a reason.
- Wave 2 (harness and voice) starts when wave 1 is on `beta-mvp`.

Re-fetch `beta-mvp` and read the current head before acting on any of this. A plan line is not evidence that something works.

## How a session starts

1. Take one bounded item from the current wave, with its own PR. Record branch, base SHA and scope on [#116](https://github.com/Pin4sf/waldo-backend/issues/116).
2. Read the source and tests for the seam you touch, then the accepted ADRs for that seam only.
3. Write the failing test or eval case first. Behaviour changes add or update a case in the nightly eval suite, not only unit tests.
4. Land the change with its proof, named by layer: SOURCE, CI, STAGING or LIVE.

## Verification and handoff

Documentation/instruction changes:

```bash
git diff --check
npx -y pnpm@10.34.4 verify:guards
```

Runtime/contract/integration changes:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

App/native claims require their repository gates and appropriate simulator/physical-device proof. Record exact base/head, scope, commands, passed/failed/not-run results, rollback and next owner. Documentation publication is not merge, deployment, runtime proof or permission for hosted mutations.
