# DeepSeek Harness and Drover cross-repository research handoff

**Date:** 2026-08-16
**Issue:** [#132](https://github.com/Pin4sf/waldo-backend/issues/132)
**Owner:** `/root`
**Read-only researcher:** `/root/deepseek_source_map`
**Status:** documentation/research complete locally; no push, pull request, merge, runtime mutation, deployment, or production acceptance

## Upstream evidence pins

- DeepSeek Harness: `47f943859bef60e4160492346772ded9b24f765a`
- Cordis: `8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4`
- Cordis paper: `948a07b369c62adb3b12e102458be5c18dfb69b9`
- Drover: `4b9ac5211d520953b7b05519e8b243f5768167cc`

The official product name is DeepSeek Harness (`dsh`); “DeepSea Harness” was treated as a naming correction, not a separate source.

## Repository ownership and worktrees

| Repository | Worktree | Base | Branch | Scope |
| --- | --- | --- | --- | --- |
| `Pin4sf/waldo-brain` | `/Users/shivanshfulper/.codex/worktrees/deepseek-drover-brain/waldo-brain` | `81917023d55dc22cf55c5ff628fc54852cdc6a29` | `codex/deepseek-drover-harness-research-20260816` | repo references, combined research, Waldo/Kennel adoption contract, benchmark, master learning, dashboard |
| `Pin4sf/waldo-backend` | `/Users/shivanshfulper/.codex/worktrees/deepseek-drover-backend/waldo-backend` | `105e4b5137ed6281a5d731e0cc1ff1d5a5827800` | `codex/deepseek-drover-harness-research-20260816` | backend adoption research, benchmark/convergence/docs indexes, this handoff |
| `Pin4sf/kennel` | `/Users/shivanshfulper/.codex/worktrees/deepseek-drover-kennel/kennel` | `367c484dac87d0c64aac2247e57ceb367f50c196` | `codex/deepseek-drover-harness-research-20260816` | proposed provider/lifecycle/evidence/conformance boundary and README pointer |

The original dirty checkouts were not edited. The active backend #84 worktree, contracts, runtime, migrations, generated artifacts, and production frontier were not touched.

## Decision carried forward

Adopt DeepSeek's reversible lifecycle, causal model-visible log, one effect-policy pipeline, bounded concurrency with ordered commit, and interrupted-turn repair. Adopt Drover's host-local process authority, command/context plane separation, fact/projection provenance, provider raw fallback, degraded optional workers, and quiescent updates.

Keep these below Waldo's locked domain kernel. Provider/session/generated-context completion remains observation only. Waldo remains the sole owner of identity, authority, Outcome, Verification, Acceptance, OpenLoop, and governed durable memory.

## Anti-criterion

No provider `completed`, successful tool, generated decision/open-loop label, PR merge, or message delivery may write Outcome Acceptance directly.

## Verification completed

- `git diff --check` passed in all three worktrees.
- Every new untracked Markdown page passed `git diff --no-index --check /dev/null <file>`.
- New Waldo Brain wikilink targets were resolved by basename and each new page had valid opening/closing frontmatter delimiters; the four new pages contain 55 wikilinks in total.
- `pnpm install --frozen-lockfile` completed in the isolated backend worktree using the pinned lockfile.
- `pnpm verify:guards` passed all backend guards and their self-tests.
- Drover `uv lock --check` failed read-only under the locally available `uv`/CPython 3.14.6 because the checked lock needs an update, reproducing the `0.3.2` project versus `0.3.1` lock-root drift.
- Kennel runtime checks were not rerun because the isolated worktree had no `node_modules` and the change is Markdown-only; no source/package/generated/runtime file changed.
- No upstream build/runtime claims were made: DeepSeek Harness and Drover were statically source-inspected only.

## Follow-up boundary

Do not implement the proposed contracts from this research inside #84. The next authorized implementation step would require its own issue/worktree and should begin with a bounded provider-capability-manifest or effect-pipeline conformance spike. A spike must prove that direct tools, dynamic/generated calls, MCP, terminals, subagents, approval resume, and recovery can traverse one policy seam before any provider-neutral refactor is accepted.

The research should be simplified or rejected if capability manifests cannot represent provider differences honestly, one effect seam cannot cover the transports without bypass, or lifecycle/provenance machinery adds friction without measurable recovery, Evidence, or authority benefit.
