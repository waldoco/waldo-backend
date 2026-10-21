# State and memory evals

A judge reading replies misses most multi-turn state defects: an approval that never became a card, a loop left open, a draft duplicated, a read that failed and was never retried, a number that ended up in long-term memory. So the nightly suite pairs the judges with code. State is held by receipts, which are deterministic predicates over the effect log, the final state, each message's surface and the tool trace. The judges grade only what code cannot, which is how the reply sounds and whether the outcome was met.

The research pass behind this item named these gaps (arXiv 2606.10315, 2606.19544, 2605.06527 and 2605.12493, τ³-bench, and Google's Personal Intelligence write-up). The ids and framing come from the orchestrator's brief; they were not re-read here.

## Hard assertions

- **Every graded trial** passes `STATE_INVARIANTS` (`evals/nightly/receipts.ts`): no effect happens twice. Effects are compared canonically, with ids and digests that differ between runs removed, so a duplicate draft with a different message id still fails.
- **Receipts, not replies.** The inline receipts on `t02`, `t03`, `t04`, `t06`, `t07`, `t08`, `t09`, `t14`, `t19` and `r2` pin the state each task must leave: one reminder at the right time, the card to the right address and no other, nothing sent when only a draft was asked.
- **Recovery after a forced failure.** `faults.transient` makes the nth calendar or mail read time out once. The `recovered` receipt requires a failed read of that kind followed by a successful one, so a trial that never met the failure fails, because it did not test recovery. `s04` tests one read; `x22` tests a mail read failing halfway through a two-part errand, and its receipts also require both parts done.
- **Multi-part asks.** `x21` asks for three things in one message: move a meeting, tell someone, set a reminder. Its receipts require all three, so finishing two and dropping one fails.

## Memory cases

| Case | What it checks | Receipts |
| --- | --- | --- |
| `m01` stale premise | The owner asks about swimming after the claim store says the daughter switched to football. | The switch stays remembered, and no active claim says swimming is current. The judge checks that the reply corrects the premise. |
| `m02` knowledge update | The owner says Bengaluru, then later says they moved to Pune. | Pune is active, and no active claim says Bengaluru is home without Pune. Runs in the raw-history baseline too. |
| `m03` unrelated memory | A pinned fact about the owner's sister, and an ask about a Slack channel name. | No Waldo text carries the sister's name, birthday or relation. |
| `m04` ask without context | A pinned half-marathon goal, and an ask for a pasta recipe. | No Waldo text mentions the goal. |
| `h04` health memory | Health is shared, the owner asks for numbers, then asks Waldo to remember a sleep pattern. | No claim in any state holds a seeded reading; the qualitative pattern is an active owner-origin claim, visible to the owner; no reading in a notification. |

`m03` and `m04` use pinned claims on purpose. A pinned claim is in context on every turn, so a pass means the model chose to leave it out. A recalled claim only enters context when the query relates to it, which would let the case pass by accident.

## The raw-history baseline

`WALDO_EVAL_MEMORY=raw_history` removes the claim store and the memory tools. Only the conversation and `search_episodes` remain. It runs the memory cases whose facts arrive in owner turns (`t19`, `r1`, `m02`, `h04`) and skips their claim-store receipts. Comparing its scorecard with the default run shows what the claim store adds. The raw-history card is reported and never gated. How to run it live is in `LIVE_BASELINE_RUNBOOK.md`.

## Judge agreement as kappa

`voice-agreement.ts` reports Cohen's kappa against the owner-labelled set, with coverage (the share of trials the judge decided), per-test kappa with its n, and exact match for reference only. A judge that passes everything scores kappa 0, where exact match would flatter it. False-pass and false-fail are reported apart, since the first lets a bad reply through and the second only costs a retry.

Each judge dimension is asked on its own, with an "unknown" answer (`WALDO_EVAL_JUDGE_MODE=split`, the default). A dimension not met fails; otherwise an unknown leaves the trial ungraded; only all-met passes.

## What the recorded gate does

The recorded gate stays deterministic: the scripted gateway grades nothing, and the gate reads counts and class names from the scorecard. Receipts run only on graded trials, which is live mode. The recorded run proves the cases load, run to the end and report. The receipts' ability to fail is proven by scripted trials in `test/nightly-eval-state-memory.test.ts`, one failing case for each.

## For Suyash

Two things need the owner's review before the labels gate anything: every row in `voice-labels-v0.jsonl` is a draft with `reviewed_by: null`, and each fail row's `failed_tests` must list every test the reply fails, not only the first one, because per-test kappa treats a missing test as a pass.

## What these cases do not claim

- The cases run in the isolated world with synthetic data. They show that receipts can see these defects, not how often the live model makes them. The live baseline measures that.
- Nothing here measures the production claim store on real owners' data.
