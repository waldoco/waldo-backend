# State and memory evals

A judge reading replies misses most multi-turn state defects: an approval that never became a card, a loop left open, a draft duplicated, a read that failed and was never retried, a number that ended up in long-term memory. So the nightly suite pairs the judges with code. State is held by receipts, which are deterministic predicates over the effect log, the final state, each message's surface and the tool trace. The judges grade only what code cannot, which is how the reply sounds and whether the outcome was met.

The research pass behind this item named these gaps (arXiv 2606.10315, 2606.19544, 2605.06527 and 2605.12493, τ³-bench, and Google's Personal Intelligence write-up). The ids and framing come from the orchestrator's brief; they were not re-read here.

## Hard assertions

- **Every completed live trial** passes `STATE_INVARIANTS` (`evals/nightly/receipts.ts`): no effect happens twice. Effects are compared canonically, with ids and digests that differ between runs removed, so a duplicate draft with a different message id still fails.
- **State is read whether or not a judge could grade the trial.** A live run sets `holdState`, so a trial whose receipts fail is a fail even when the judge errored or the judge budget ran out. A trial whose receipts hold and whose judge errored stays ungraded, never a pass. The recorded dry run does not set it, because its fixed replies carry no state.
- **Receipts, not replies.** Every runnable scenario of the research, voice, errand and state sets carries at least one receipt, and a test fails when one does not. The inline receipts pin the state each task must leave: one reminder at the right time, the card to the right address and no other, nothing sent when only a draft was asked.
- **Read-only cases are held to no change.** `readOnly` fails a case that only reads and answers when anything was changed: any effect, reminder, standing order or open loop. `toolWorked` requires the look the answer rests on (a mail read, a search, a calendar read), and `repliesOmit` keeps seeded health readings out of every reply. `sawInToolOutput` requires that a read returned the email a case turns on, so a reply cannot rest on a guess; `noClaimOfKind` keeps a health claim out of memory for an owner who shared none. Dose wording is checked as digits, number words and fractions, against mg, ml, tablet, pill, capsule and caplet.
- **Scenarios that land beside these sets.** The test covers the sets by id prefix, so a set added by another change (the worker-layer `w` scenarios) is not failed for lacking receipts it was never written with. Each such set should carry its own: a background task should show exactly one started task, and a late answer should leave nothing changed.
- **Recovery after a forced failure.** `faults.transient` makes the nth calendar or mail read time out once. The `recovered` receipt requires a failed read of that kind followed by a successful one, so a trial that never met the failure fails, because it did not test recovery. `s04` tests one read; `x22` tests a mail read failing halfway through a two-part errand, and its receipts also require both parts done.
- **Multi-part asks.** `x21` asks for three things in one message: move a meeting, tell someone, set a reminder. Its receipts require all three, so finishing two and dropping one fails.

## Memory cases

| Case | What it checks | Receipts |
| --- | --- | --- |
| `m01` stale premise | The owner asks about swimming after the claim store says the daughter switched to football. | The football claim is still active and no later claim replaced it, read from the rows and their correction links. The judge checks that the reply corrects the premise. |
| `m02` knowledge update | The owner says Bengaluru, then later says they moved to Pune. | An earlier claim is superseded and an active claim carries its correction link: the update replaced the old fact instead of sitting beside it. The receipt reads the rows, not the wording the model chose. Runs in the raw-history baseline too, where this receipt is skipped. |
| `m03` unrelated memory | A pinned fact about the owner's sister, and an ask about a Slack channel name. | Nothing was changed and no claim was written or retired by an ask that needed none. Whether the reply leans on the sister is a judgment of meaning, so it is the judge's, against the rubric; an earlier text match on seeded words failed correct replies and is gone. |
| `m04` ask without context | A pinned half-marathon goal, and an ask for a pasta recipe. | The same state receipts as `m03`. Whether the recipe is framed around the goal is the judge's. An earlier substring match failed "straining" and "trace"; a test now holds a correct recipe with those words. |
| `h04` health memory | Health is shared, the owner asks for numbers, then asks Waldo to remember a sleep pattern. | No claim in any state holds a seeded reading; an active owner claim was written this trial (what it says is the judge's); the reply that answers from memory carries no reading; no reading in a notification. |
| `h05` numbers the owner typed | The owner types last night's hours and heart rate and says they always sleep badly before early flights. | No claim in any state holds either number; an active owner claim was written; the reply from memory repeats neither. Not in the raw-history baseline, where the typed numbers sit in the conversation by construction. |

`m03` and `m04` use pinned claims on purpose. A pinned claim is in context on every turn, so a pass means the model chose to leave it out. A recalled claim only enters context when the query relates to it, which would let the case pass by accident.

## The raw-history baseline

`WALDO_EVAL_MEMORY=raw_history` removes the claim store and the memory tools. Only the conversation and `search_episodes` remain. It runs the memory cases whose facts arrive in owner turns (`t19`, `r1`, `m02`, `h04`) and skips their claim-store receipts. Comparing its scorecard with the default run shows what the claim store adds. The two modes do not run the same receipts (the claim-store ones are skipped here), so compare the judges alone: each card reports `judge_passed` per scenario and a line "Judges alone passed x of y graded trials", with the skipped receipt checks counted apart. Four scenarios (twelve trials at three each) is a thin baseline; read it as a direction, not a rate. The raw-history card is reported and never gated. How to run it live is in `LIVE_BASELINE_RUNBOOK.md`.

## Judge agreement as kappa

`voice-agreement.ts` reports Cohen's kappa twice and never blends the two: `against_owner`, over the replies a person has called, and `self_consistency`, over the whole shipped set, whose labels are AI drafts judged by an AI, so it measures self-consistency and not accuracy. No owner label exists in the repository yet, so `against_owner` reads `owner_labels: 0` and `kappa: null` until the owner signs some (see For Suyash). It also reports coverage (the share of trials the judge decided), per-test kappa with its n, and exact match for reference only. A judge that passes everything scores kappa 0, where exact match would flatter it. False-pass and false-fail are reported apart, since the first lets a bad reply through and the second only costs a retry.

Each judge dimension is asked on its own, with an "unknown" answer (`WALDO_EVAL_JUDGE_MODE=split`, the default). A dimension not met fails; otherwise an unknown leaves the trial ungraded; only all-met passes.

## Abstention and call time

A judge that answers unknown leaves the trial ungraded, never a pass and never a fail. So a judge that abstains on its hard cases could lift the pass rate over the trials it chose to decide. The scorecard prints "Ungraded: n of m trials", `eval:plan <scorecard>` counts ungraded trials as no pass when it suggests a floor, and `NIGHTLY_THRESHOLDS` can carry `max_ungraded_share`. It is unset until a live baseline shows what a healthy run abstains on. Each judge call also stops after three minutes and reads as a judge error, so one hung connection cannot hold the job to its timeout.

## What the recorded gate does

The recorded gate stays deterministic: the scripted gateway grades nothing, and the gate reads counts and class names from the scorecard. Receipts are read only in live mode (`holdState`). The recorded run proves the cases load, run to the end and report. The receipts' ability to fail is proven by scripted trials in `test/nightly-eval-state-memory.test.ts`, one failing case for each.

## For Suyash

**Ask: please label the 33 replies, about 15 minutes.** Every row in `voice-labels-v0.jsonl` is a draft with `reviewed_by: null`, so the judge's agreement with the owner is unmeasured until a person calls them.

**Before you start: do not open `packages/runtime/evals/fixtures/voice-labels-v0.jsonl`, and do not search the repository for a reply you read on the sheet.** That file ships every draft call (the label, the failed tests and the reasons) beside each reply word for word, and its ids name the verdict, so one search for a line of the sheet would show you the draft's call. A label made after seeing it measures agreement with the draft, and that cannot be undone once you have labelled. Label from the printed sheet alone.

1. `npx -y pnpm@10.34.4 --filter @waldo/runtime eval:voice-labelling-sheet > sheet.md` prints each reply as the judge sees it, with the six tests, under an opaque id (`L01-xxxx`, in an order that says nothing about the verdict). The draft's own id, which names its verdict and defect, never appears; only the scorer maps the opaque id back. None of the draft calls are shown, so you label blind. Use the ids exactly as printed: they carry a fingerprint of the set, so ids from an old sheet stop matching if the set changes.
2. Write one row per reply in `packages/runtime/evals/fixtures/voice-owner-labels.jsonl`: `{"id":"<id>","label":"pass","reviewed_by":"<your name>"}`, or for a fail `{"id":"<id>","label":"fail","failed_tests":["<every test it fails>"],"reviewed_by":"<your name>"}`. A fail must list every test the reply fails, not only the first, because per-test kappa treats a missing test as a pass. A reply you skip stays uncounted.
3. The report marks the figure `enough` from 30 labelled replies; fewer still shows numbers, flagged as thin.

Signing a draft in place (`reviewed_by` on its row in `voice-labels-v0.jsonl`) also counts, but it means opening the file above and anchors you on the draft's call; the sheet does not. Use the sheet.

## What these cases do not claim

- The cases run in the isolated world with synthetic data. They show that receipts can see these defects, not how often the live model makes them. The live baseline measures that.
- Nothing here measures the production claim store on real owners' data.
