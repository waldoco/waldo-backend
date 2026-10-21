# Live baseline runbook

How to run the nightly eval suite in live mode for the first time and set its pass-rate floor.

Nothing here has been run live. A live run spends money on two providers, so the owner provides the keys and approves the spend before the first run.

## What a live run does

`WALDO_EVAL_MODE=live` runs every unblocked scenario `WALDO_EVAL_TRIALS` times (default 3) through the production responder on the app surface. The candidate is the OpenAI chat model.

Two Anthropic judges then grade each finished trial:

- the outcome judge grades every trial;
- the voice judge grades the scenarios that carry a voice rubric.

`WALDO_EVAL_JUDGE_MODE` picks how each judge asks. `split` (the default) makes one call per dimension, each answering met, not met, or unknown; the outcome judge asks outcome, avoided, persisted and, when the rubric names a question, asked_first, and the voice judge asks each of its six tests. `joint` asks every dimension of a judge in one call. A split verdict is not coloured by the other dimensions' answers, at about three and a half times the judge calls. A trial's split calls run together, so they add cost, not wall time. Any dimension not met fails the trial; otherwise any unknown leaves it ungraded (a judge error), and only all-met passes.

Every receipt is checked in code.

One call budget, `WALDO_EVAL_MAX_CALLS`, covers the candidate, the memory writer and both judges. The run refuses any call past it. The gate fails a scorecard whose budget ran out, so the cap has to cover a whole run.

The scorecard holds counts, class names and token totals. It never holds reply text, so it is safe to post. Every scenario is synthetic: no real owner, mail or health value.

## Secrets and settings

| Name | Kind | Value |
| --- | --- | --- |
| `WALDO_EVAL_OPENAI_KEY` | repository secret, set as `OPENAI_API_KEY` locally | An OpenAI key for an eval project, with a spend limit set in the OpenAI dashboard |
| `WALDO_EVAL_ANTHROPIC_KEY` | repository secret, set as `ANTHROPIC_API_KEY` locally | An Anthropic key for an eval workspace, with a spend limit set in the Console |
| `WALDO_EVAL_JUDGE_MODEL` | repository variable | `claude-opus-5-5` is recommended. `claude-sonnet-5-5` costs about half. It must differ from the candidate, and `assertIndependentJudge` refuses a match. |
| `WALDO_EVAL_MODEL` | optional | An OpenAI roster model. It defaults to `WALDO_CHAT_MODEL` (`gpt-6.1-sol`). |
| `WALDO_EVAL_MAX_CALLS` | required for live | `2400`: `pnpm eval:plan` suggests 2000 in split mode and 1500 in joint mode for 3 trials of today's catalogue, and the workflow sets 2400 so a scenario or two more does not exhaust the budget, which fails the gate |
| `WALDO_EVAL_JUDGE_MODE` | optional | `split` (default) or `joint` |
| `WALDO_EVAL_MEMORY` | optional | `claims` (default) or `raw_history`; see the raw-history baseline below |
| `WALDO_EVAL_TRIALS` | optional | `3`, which pass^k needs |

Keys never go into a command line that ends up in shell history, a log or a PR. Locally, read them with `read -s` into the environment of the one command.

The workflow checks for both secrets and the variable, and skips cleanly with a notice when any is missing.

The judges call the Messages API with adaptive thinking at effort `high`. The claude-api reference (cached 6 October 2026) says a fixed `budget_tokens` returns a 400 on Opus 5.5, Sonnet 5.5 and Fable 5.1. The wave-1 judge sent one, so [inference] every live verdict on those models would have been a judge error. It is fixed in `evals/nightly/anthropic.ts`; this was not observed live.

A refused or truncated grade counts as a judge error, never a pass.

## Where it can run

**Locally.** This works today from any checkout of the branch:

```bash
cd packages/runtime
read -s OPENAI_API_KEY; read -s ANTHROPIC_API_KEY; export OPENAI_API_KEY ANTHROPIC_API_KEY
WALDO_EVAL_MODE=live WALDO_EVAL_JUDGE_MODEL=claude-opus-5-5 WALDO_EVAL_MAX_CALLS=2400 WALDO_EVAL_TRIALS=3 \
  WALDO_EVAL_OUT="$PWD/live-scorecard.json" npx -y pnpm@10.34.4 eval:nightly > /dev/null
WALDO_EVAL_MODE=live npx -y pnpm@10.34.4 exec tsx evals/nightly/report.ts live-scorecard.json live-scorecard.md
```

Before the full run, do a one-scenario smoke test that costs cents. `WALDO_EVAL_ONLY` prints that scenario's synthetic transcript, both judges' reasons and any failed receipts:

```bash
WALDO_EVAL_MODE=live WALDO_EVAL_JUDGE_MODEL=claude-opus-5-5 WALDO_EVAL_MAX_CALLS=20 WALDO_EVAL_TRIALS=1 \
  WALDO_EVAL_ONLY=h03-notification-no-numbers npx -y pnpm@10.34.4 eval:nightly
```

**In CI (`evals-live.yml`).** GitHub runs `schedule` workflows, and lists `workflow_dispatch` workflows for manual runs, only from the repository's default branch. That branch is `main`, not `beta-mvp`, so the workflow does nothing while it lives only on `beta-mvp`. Ways forward, for the owner to choose:

1. **Land `evals-live.yml` on `main`, then dispatch it manually with `ref: beta-mvp`.** A dispatch runs the workflow file and code from the ref you pick. This suits the first baseline.
2. **Schedule it from `main`, with the job checking out `beta-mvp` explicitly.** A schedule always runs the default branch's latest commit, so without an explicit checkout it tests `main`'s code.
3. **Make `beta-mvp` the default branch.**

The job's timeout is 360 minutes, the most a hosted runner allows. Trials run one after another: up to about 1,200 candidate calls at several seconds each (the 10 October latency baseline measured about 6 s per call), plus the judge calls, which for one trial run together.

## Calls and cost per run

`pnpm eval:plan` computes the call plan from the catalogue; `WALDO_EVAL_JUDGE_MODE=joint pnpm eval:plan` plans the other mode. Today that is 61 scenarios, 58 of them runnable, at 3 trials:

| | Split (default) | Joint |
| --- | --- | --- |
| Owner turns and fired reminders | 243 | 243 |
| Candidate calls (2 to 5 per turn, memory writer included) | 486 to 1,215 | 486 to 1,215 |
| Judge calls | 780 | 216 |
| Suggested `WALDO_EVAL_MAX_CALLS` | 2000 | 1500 |

A test holds the cap in `evals-live.yml` at or above the plan's suggestion for the mode the workflow sets. The wave-1 cap of 300 would have run out on the 22-scenario catalogue alone.

**Cost estimate.** [inference] This is an estimate, not a measurement.

Prices come from `packages/runtime/src/llm/pricing.ts`: Sol $2 input, $0.10 cached input and $10 output per million tokens. Opus 5.5 is $4 and $20 per million, confirmed against the claude-api reference on 21 October 2026.

A chat request in the recorded dry run is about 51,000 characters, roughly 13,000 tokens, mostly the system prompt and tool schemas. Live requests grow with tool output.

| Part | Low | High |
| --- | --- | --- |
| Candidate (13K to 20K input tokens per call, 0.6K to 1.5K output, half the input cached at the high end) | about $8 | about $44 (about $65 with no cache hits) |
| Judges on Opus 5.5, joint (3K to 6K input, 1.5K to 4K output with thinking, 216 calls) | about $9 | about $22 |
| Judges on Opus 5.5, split (the same packet each call, shorter output, 780 calls) | about $25 | about $75 |
| Judges on Sonnet 5.5 | about half of Opus | about half of Opus |
| **A run, Opus 5.5 judging, joint** | **about $17** | **about $66 (up to about $87 with no cache hits)** |
| **A run, Opus 5.5 judging, split** | **about $33** | **about $120 (up to about $140 with no cache hits)** |

The judge-agreement check (`eval:voice-agreement` in live mode) makes 33 calls in joint mode and 198 in split mode, about $1 to $3 and $5 to $12.

Run nightly at the high end, live mode would cost on the order of $2,000 to $4,000 a month in split mode. Decide the cadence after the first run measures the real cost. For example, run the full suite weekly and one trial on behaviour PRs, or use joint mode for the regular runs and split mode for baselines.

The scorecard reports token totals per role, but not the cached split. The exact figure for a run comes from the provider dashboards, filtered to the eval project and workspace.

## The first run, in order

1. **Measure the judge first.** Run `eval:voice-agreement` live (about $2) on the labelled set, after Suyash has reviewed the labels (`reviewed_by` set). Read the false-pass rate. If the voice judge passes more than about 1 in 10 labelled fails, fix the rubric before trusting voice verdicts. [proposed] This 1-in-10 bar is a proposed threshold, not an agreed one.
2. **Smoke-test one scenario**, as above.
3. **Do the full run** at 3 trials with a cap of 2400, locally or by dispatch.
4. **Read the scorecard before any rate.** Check these things:
   - Blocked must be 3.
   - Harness errors must be 0.
   - Incomplete must be 0.
   - The budget must not have run out.
   - Judge errors should be few. A judge error is an ungraded trial, and many of them mean the judge request is wrong.

   Note the voice-judge and receipt failure lines.
5. **Set the floor.** Run `pnpm eval:plan live-scorecard.json`. It prints the graded trials, the observed pass rate, the 95% Wilson lower bound and `suggested_min_pass_rate`, which is the lower bound rounded down to a 0.05 step. Put that number in `NIGHTLY_THRESHOLDS.live.min_pass_rate` in `evals/nightly/gate.ts`.

   With about 140 graded trials, the point estimate moves by several points from run to run. A floor at the point estimate would fail the next honest run, so the lower bound is the defensible floor.
6. **Record the baseline.** Open the PR that sets the floor with the scorecard's Markdown (`live-scorecard.md`), the exact SHA, the models, the call and token counts, and the dashboard cost. The scorecard holds no reply text.
7. **Raise the floor only with evidence.** Raise it when a later run's lower bound clears it. Never lower it to make a run pass; a drop is a regression to classify.

`NIGHTLY_THRESHOLDS.live` holds the other limits too: `min_scenarios` (49), `max_blocked` (3), `max_harness_errors` (0) and `max_incomplete` (0). A PR that adds or unblocks a scenario moves them in the same diff.

## The raw-history baseline

Memory changes need something to be compared against. `WALDO_EVAL_MEMORY=raw_history` runs the memory cases with no claim store and no memory tools: the model sees the conversation and `search_episodes` over past turns, and nothing else. Run it live with the same keys and judge:

```bash
WALDO_EVAL_MODE=live WALDO_EVAL_MEMORY=raw_history WALDO_EVAL_JUDGE_MODEL=claude-opus-5-5 WALDO_EVAL_MAX_CALLS=400 WALDO_EVAL_TRIALS=3 \
  WALDO_EVAL_OUT="$PWD/raw-history-scorecard.json" npx -y pnpm@10.34.4 eval:nightly > /dev/null
```

It runs only the memory cases whose facts arrive in owner turns (`t19`, `r1`, `m02`, `h04`), since a seeded claim has no raw-history equivalent, and it skips their claim-store receipts, which have nothing to read. The same judge rubrics and the other receipts still apply, so the two scorecards compare like with like. Its scorecard is reported, never gated, and the label on the card says `(raw_history)`. If the claim store does not beat this baseline on those cases, the store is not earning its keep.
