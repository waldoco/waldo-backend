# Live baseline runbook

How to run the nightly eval suite in live mode for the first time and set its pass-rate floor.

Nothing here has been run live. A live run spends money on two providers, so the owner provides the keys and approves the spend before the first run.

## What a live run does

`WALDO_EVAL_MODE=live` runs every unblocked scenario `WALDO_EVAL_TRIALS` times (default 3) through the production responder on the app surface. The candidate is the OpenAI chat model.

Two Anthropic judges then grade each finished trial:

- the outcome judge grades every trial;
- the voice judge grades the scenarios that carry a voice rubric.

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
| `WALDO_EVAL_MAX_CALLS` | required for live | `1200` for 3 trials of today's catalogue (from `pnpm eval:plan`) |
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
WALDO_EVAL_MODE=live WALDO_EVAL_JUDGE_MODEL=claude-opus-5-5 WALDO_EVAL_MAX_CALLS=1200 WALDO_EVAL_TRIALS=3 \
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

The job's timeout is 240 minutes. Trials run one after another: about 950 model calls at several seconds each (the 10 October latency baseline measured about 6 s per call), plus 180 judge calls.

## Calls and cost per run

`pnpm eval:plan` computes the call plan from the catalogue. Today that is 49 scenarios, 46 of them runnable, at 3 trials:

| | Calls |
| --- | --- |
| Owner turns and fired reminders | 189 |
| Candidate calls (2 to 5 per turn, memory writer included) | 378 to 945 |
| Judge calls (46 outcome + 14 voice, times 3) | 180 |
| Suggested `WALDO_EVAL_MAX_CALLS` | 1200 |

A test holds the cap in `evals-live.yml` at or above the plan's suggestion. The wave-1 cap of 300 would have run out on the 22-scenario catalogue alone.

**Cost estimate.** [inference] This is an estimate, not a measurement.

Prices come from `packages/runtime/src/llm/pricing.ts`: Sol $2 input, $0.10 cached input and $10 output per million tokens. Opus 5.5 is $4 and $20 per million, confirmed against the claude-api reference on 21 October 2026.

A chat request in the recorded dry run is about 51,000 characters, roughly 13,000 tokens, mostly the system prompt and tool schemas. Live requests grow with tool output.

| Part | Low | High |
| --- | --- | --- |
| Candidate (13K to 20K input tokens per call, 0.6K to 1.5K output, half the input cached at the high end) | about $6 | about $35 (about $52 with no cache hits) |
| Judges on Opus 5.5 (3K to 6K input, 1.5K to 4K output with thinking) | about $8 | about $19 |
| Judges on Sonnet 5.5 | about $4 | about $10 |
| **A run, with Opus 5.5 judging** | **about $14** | **about $55 (up to about $70 with no cache hits)** |

The judge-agreement check (`eval:voice-agreement` in live mode) makes 33 calls, about $1 to $3.

Run nightly at the high end, live mode would cost on the order of $1,000 to $2,000 a month. Decide the cadence after the first run measures the real cost. For example, run the full suite weekly and one trial on behaviour PRs.

The scorecard reports token totals per role, but not the cached split. The exact figure for a run comes from the provider dashboards, filtered to the eval project and workspace.

## The first run, in order

1. **Measure the judge first.** Run `eval:voice-agreement` live (about $2) on the labelled set, after Suyash has reviewed the labels (`reviewed_by` set). Read the false-pass rate. If the voice judge passes more than about 1 in 10 labelled fails, fix the rubric before trusting voice verdicts. [proposed] This 1-in-10 bar is a proposed threshold, not an agreed one.
2. **Smoke-test one scenario**, as above.
3. **Do the full run** at 3 trials with a cap of 1200, locally or by dispatch.
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

`NIGHTLY_THRESHOLDS.live` holds the other limits too: `min_scenarios` (51), `max_blocked` (3), `max_harness_errors` (0) and `max_incomplete` (0). A PR that adds or unblocks a scenario moves them in the same diff.
