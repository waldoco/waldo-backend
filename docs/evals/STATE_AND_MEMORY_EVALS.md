# State and memory evals

A judge reading replies misses most multi-turn state defects: an approval that never became a card, a loop left open, a draft duplicated, a read that failed and was never retried, a number that ended up in long-term memory. So the nightly suite pairs the judges with code. State is held by receipts, which are deterministic predicates over the effect log, the final state, each message's surface and the tool trace. The judges grade only what code cannot, which is how the reply sounds and whether the outcome was met.

The research pass behind this item named these gaps (arXiv 2606.10315, 2606.19544, 2605.06527 and 2605.12493, τ³-bench, and Google's Personal Intelligence write-up). The ids and framing come from the orchestrator's brief; they were not re-read here.

## Hard assertions

- **Every completed live trial** passes `STATE_INVARIANTS` (`evals/nightly/receipts.ts`): no effect happens twice. Effects are compared canonically, with ids and digests that differ between runs removed, so a duplicate draft with a different message id still fails.
- **State is read whether or not a judge could grade the trial.** A live run sets `holdState`, so a trial whose receipts fail is a fail even when the judge errored or the judge budget ran out. A trial whose receipts hold and whose judge errored stays ungraded, never a pass. The recorded dry run does not set it, because its fixed replies carry no state.
- **Receipts, not replies.** Every runnable scenario of the research, voice, errand and state sets carries at least one receipt, and a test fails when one does not. The inline receipts pin the state each task must leave: one reminder at the right time, the card to the right address and no other, nothing sent when only a draft was asked.
- **Read-only cases are held to no change.** `readOnly` fails a case that only reads and answers when anything was changed: any effect, reminder, standing order or open loop. `toolWorked` requires the look the answer rests on (a mail read, a search, a calendar read), and `repliesOmit` keeps seeded health readings out of every reply.
- **Scenarios that land beside these sets.** The test covers the sets by id prefix, so a set added by another change (the worker-layer `w` scenarios) is not failed for lacking receipts it was never written with. Each such set should carry its own: a background task should show exactly one started task, and a late answer should leave nothing changed.
- **Recovery after a forced failure.** `faults.transient` makes the nth calendar or mail read time out once. The `recovered` receipt requires a failed read of that kind followed by a successful one, so a trial that never met the failure fails, because it did not test recovery. `s04` tests one read; `x22` tests a mail read failing halfway through a two-part errand, and its receipts also require both parts done.
- **Multi-part asks.** `x21` asks for three things in one message: move a meeting, tell someone, set a reminder. Its receipts require all three, so finishing two and dropping one fails.

## Memory cases

| Case | What it checks | Receipts |
| --- | --- | --- |
| `m01` stale premise | The owner asks about swimming after the claim store says the daughter switched to football. | The switch stays remembered, and no active claim says swimming is current. The judge checks that the reply corrects the premise. |
| `m02` knowledge update | The owner says Bengaluru, then later says they moved to Pune. | Pune is active, and no active claim says Bengaluru is home without Pune. Runs in the raw-history baseline too. |
| `m03` unrelated memory | A pinned fact about the owner's sister, and an ask about a Slack channel name. | No Waldo text carries the sister's name, birthday or relation. |
| `m04` ask without context | A pinned half-marathon goal, and an ask for a pasta recipe. | No Waldo text mentions the goal. |
| `h04` health memory | Health is shared, the owner asks for numbers, then asks Waldo to remember a sleep pattern. | No claim in any state holds a seeded reading; the qualitative pattern is an active owner-origin claim, visible to the owner; the reply that answers from memory carries no reading; no reading in a notification. |
| `h05` numbers the owner typed | The owner types last night's hours and heart rate and says they always sleep badly before early flights. | No claim in any state holds either number; the pattern is an active owner-origin claim; the reply from memory repeats neither. Not in the raw-history baseline, where the typed numbers sit in the conversation by construction. |

`m03` and `m04` use pinned claims on purpose. A pinned claim is in context on every turn, so a pass means the model chose to leave it out. A recalled claim only enters context when the query relates to it, which would let the case pass by accident.

## The raw-history baseline

`WALDO_EVAL_MEMORY=raw_history` removes the claim store and the memory tools. Only the conversation and `search_episodes` remain. It runs the memory cases whose facts arrive in owner turns (`t19`, `r1`, `m02`, `h04`) and skips their claim-store receipts. Comparing its scorecard with the default run shows what the claim store adds. The raw-history card is reported and never gated. How to run it live is in `LIVE_BASELINE_RUNBOOK.md`.

## Judge agreement as kappa

`voice-agreement.ts` reports Cohen's kappa twice and never blends the two: `against_owner`, over the replies a person has called, and `against_drafts`, over the whole shipped set, whose labels are drafts. No owner label exists in the repository yet, so `against_owner` reads `owner_labels: 0` and `kappa: null` until the owner signs some (see For Suyash). It also reports coverage (the share of trials the judge decided), per-test kappa with its n, and exact match for reference only. A judge that passes everything scores kappa 0, where exact match would flatter it. False-pass and false-fail are reported apart, since the first lets a bad reply through and the second only costs a retry.

Each judge dimension is asked on its own, with an "unknown" answer (`WALDO_EVAL_JUDGE_MODE=split`, the default). A dimension not met fails; otherwise an unknown leaves the trial ungraded; only all-met passes.

## What the recorded gate does

The recorded gate stays deterministic: the scripted gateway grades nothing, and the gate reads counts and class names from the scorecard. Receipts are read only in live mode (`holdState`). The recorded run proves the cases load, run to the end and report. The receipts' ability to fail is proven by scripted trials in `test/nightly-eval-state-memory.test.ts`, one failing case for each.

## For Suyash

**Ask: please label the 33 replies, about 15 minutes.** Every row in `voice-labels-v0.jsonl` is a draft with `reviewed_by: null`, so the judge's agreement with the owner is unmeasured until a person calls them.

1. `npx -y pnpm@10.34.4 --filter @waldo/runtime eval:voice-labelling-sheet > sheet.md` prints each reply as the judge sees it, with the six tests and none of the draft calls, so you label blind.
2. Write one row per reply in `packages/runtime/evals/fixtures/voice-owner-labels.jsonl`: `{"id":"<id>","label":"pass","reviewed_by":"<your name>"}`, or for a fail `{"id":"<id>","label":"fail","failed_tests":["<every test it fails>"],"reviewed_by":"<your name>"}`. A fail must list every test the reply fails, not only the first, because per-test kappa treats a missing test as a pass. A reply you skip stays uncounted.
3. The report marks the figure `enough` from 30 labelled replies; fewer still shows numbers, flagged as thin.

Signing a draft in place (`reviewed_by` on its row in `voice-labels-v0.jsonl`) also counts, but anchors you on the draft's call; the sheet does not.

## What these cases do not claim

- The cases run in the isolated world with synthetic data. They show that receipts can see these defects, not how often the live model makes them. The live baseline measures that.
- Nothing here measures the production claim store on real owners' data.
