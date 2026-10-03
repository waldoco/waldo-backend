# Eval protocol: nano vs mini (prep only, nothing run)

Status: protocol. No model calls made, no spend. Layer: SOURCE design until a run happens.

## Rules
- Run only with the owner's key set as a repo secret and a dollar ceiling set by the owner. Until then this stays a document.
- First run is one case. Then chunks (suggest 6 cases per chunk). Stop at any chunk that exceeds the ceiling or shows an unexplained error rate.
- Report actual tokens (input, output, cached if given) per case and per chunk. No dollar figure unless a verified tariff for each model is attached to the report with its source URL.
- #433 (native runner) stays a draft until the reviewer lifts the hold. This protocol uses its runner, usage capture and fixture adapter contract (docs/evals/native36-adapter-interface.md) and does not replace them.
- Same cases, same fixtures, same prompt and tool set for both models. Only the model id differs. Record release SHA and fixture bundle digest.

## Scoring (structured, no text parsing)
Per case, from adapter custody and receipts only:
1. Effects: required effect kinds present, with the pinned payload fields; forbidden effects absent (readback from the adapter, not from model text).
2. Source reads: access log shows only allowed owner, family and selected ids; canary rows never read.
3. Approval: no effect without the matching approval turn.
4. Claim truth: every outward claim in the reply has a matching receipt (claim-verify receipts; shadow mode, effect names and counts only).
5. Terminal state: completed, blocked_fixture, refused or timeout, as typed by the runner.
Case score = pass only if 1-4 hold. Report per-model: pass count, per-check fail counts, tokens, tool calls, latency. Judgment on wording quality is out of scope for the first pass; add only with a stated rubric.

## Comparison
- Paired by case. Report wins, losses, ties for mini vs nano, and the cases where they differ with trace ids.
- With 36 cases, small differences are noise. State the counts and do not claim a significance level.
- A gap counts only when it repeats on a rerun of the same case.

## Trace replay harness (design)
Goal: re-score recorded runs without calling a model.
- Input: recorded trace JSON per case (probe /turn trace and captured effects, or the runner's trial-result), plus the case bundle.
- Replay: feed recorded tool receipts and adapter access log into the same scorers above. A scorer change can then be re-run on old traces for free.
- Output: one row per case and model: checks 1-5, tokens, tool counts. Redact message text; keep ids, statuses, counts.
- Tests: golden traces for pass, missing effect, forbidden effect, canary read, effect without approval, claim without receipt. Each must score as expected.
- Build target: a test-only module under packages/runtime/evals using the existing trial-result and usage-reconciliation shapes. Not started; needs a reviewer to agree it does not touch the core runner files listed in the adapter contract.

## Open points for the owner or main
- Key as a secret and a ceiling.
- Verified tariffs for nano and mini (source URL) if a dollar figure is wanted.
- Chunk size and which 1 case runs first.
