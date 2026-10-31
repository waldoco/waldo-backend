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
| `WALDO_EVAL_MODEL` | optional | An OpenAI roster model. It defaults to `WALDO_CHAT_MODEL` (`gpt-6.1-terra`). |
| `WALDO_EVAL_MAX_CALLS` | required for live | `3300`: `pnpm eval:plan` suggests 3100 in split mode and 2200 in joint mode for 3 trials of today's catalogue, and the workflow sets 3300 so a few more scenarios do not exhaust the budget, which fails the gate |
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
WALDO_EVAL_MODE=live WALDO_EVAL_JUDGE_MODEL=claude-opus-5-5 WALDO_EVAL_MAX_CALLS=3300 WALDO_EVAL_TRIALS=3 \
  WALDO_EVAL_OUT="$PWD/live-scorecard.json" npx -y pnpm@10.34.4 eval:nightly > /dev/null
WALDO_EVAL_MODE=live npx -y pnpm@10.34.4 exec tsx evals/nightly/report.ts live-scorecard.json live-scorecard.md
```

Before the full run, do a one-scenario smoke test that costs cents. `WALDO_EVAL_ONLY` prints that scenario's synthetic transcript, both judges' reasons and any failed receipts:

```bash
WALDO_EVAL_MODE=live WALDO_EVAL_JUDGE_MODEL=claude-opus-5-5 WALDO_EVAL_MAX_CALLS=20 WALDO_EVAL_TRIALS=1 \
  WALDO_EVAL_ONLY=h03-notification-no-numbers npx -y pnpm@10.34.4 eval:nightly
```

**In CI (`evals-live.yml`).** GitHub runs `schedule` workflows, and lists `workflow_dispatch` workflows for manual runs, only from the repository's default branch, `main`, and `main` carries no eval code. So the workflow lives on both branches as the same file, and every run checks out the branch named by its `ref` input (default `beta-mvp`) before it runs anything. A dispatch takes two inputs: `subset` (`all`, `live`, or scenario ids separated by commas; default `live`) and `ref`.

| Trigger | Runs | Trials | Shards | Cap on calls |
| --- | --- | --- | --- | --- |
| Nightly schedule (02:00 IST) | the live-judged subset | 2 | 1 | 600 |
| Weekly schedule (Sunday 03:00 IST) | the whole catalogue | 3 | 4 | 4,400 in all, split across the shards |
| Dispatch, `subset` = `all` | the whole catalogue | 3 | 4 | as the weekly run |
| Dispatch, any other `subset` | what it names | 2 | 1 | 600 |

The workflow holds none of these numbers. Its plan job runs `evals/nightly/live-plan.ts` in the checked-out tree, which prints the trials, the shards and each shard's cap, so the default-branch copy of the workflow cannot drift from the plan a test holds them to. The total is shared out in proportion to each shard's own plan estimate, so no shard's cap is under its plan; a plan that needs more than the total is refused before any call.

The `subset` input reaches the workflow only through an environment variable. The plan step checks it against `[a-z0-9,-]` before writing it anywhere, and the runner checks it against the catalogue before it builds a model. A run that exhausts its cap fails the gate, so a long id list under the 600 cap fails loudly rather than spending more.

## The staging profile and the live-judged subset

`WALDO_EVAL_PROFILE=staging` runs the eval the way the staging Worker builds a turn. It reads `env.staging.vars` from `packages/runtime/wrangler.jsonc` at run time and sets the harness loader (`WALDO_TOOL_LOADER`), compaction, the forget barrier and the Anthropic fallback (the judge key, so the judge model may not be Sonnet 5.5 or Haiku 5.5). The candidate on the card reads `<model>+staging`. `evals/nightly/staging-profile.ts` classifies every staging variable as mapped, not turn-shaping, or a known gap with a reason; a test fails when a variable is in none of the three, so a new flag cannot reach staging unclassified. The known gaps are streaming, the proactive sweeps, the iMessage surface, the live tool registry and the nightly memory pass; the eval does not model them.

`WALDO_EVAL_SUBSET=live` runs the scenarios that carry `live_subset: true`. `pnpm eval:plan` takes the same variable, so `WALDO_EVAL_SUBSET=live WALDO_EVAL_TRIALS=2 pnpm eval:plan` prints the nightly plan. A subset card is gated against the size of its subset.

The scorecard now carries, for each scenario and as counts only: model rounds, `find_tools`, `use_tool`, groups loaded, peak tool-result characters, input, cached and cache-write tokens, output tokens, USD (priced by `src/llm/pricing.ts`, each fallback call at its own model's rate) and the number of calls the fallback model answered. The Markdown prints them per trial.

A hosted runner stops a job at 360 minutes, and a stopped job loses what it had not yet written. [inference] Run as one job, the full catalogue at 3 trials is about 380 minutes: up to 2,175 candidate calls at about 6 s each (the 10 October latency baseline) is about 218 minutes, and 327 scenario-trials whose judge waves take up to 30 s each add about 164. The earlier figure of 304 minutes was for a smaller catalogue. So the weekly run is cut into four shards, one job each, dealt out by expected cost so they take about the same time: about 95 minutes each at the same estimates, and a test holds each under 150. Jobs time out at 330 minutes. The runner writes the scorecard so far after every scenario, and each shard uploads `scorecard.json` and `scorecard.md` as an artifact even when it fails, so a cut-off job leaves what it measured. Each shard is gated on its own size; a pass-rate floor, once one exists, needs the shards' scorecards read together.

A dispatch runs the code of the `ref` it names with both provider keys in the environment, so dispatch is for people who can already push to the repository.

## Calls and cost per run

`pnpm eval:plan` computes the call plan from the catalogue; `WALDO_EVAL_JUDGE_MODE=joint pnpm eval:plan` plans the other mode. Today that is 86 scenarios, 83 of them runnable, at 3 trials:

| | Split (default) | Joint |
| --- | --- | --- |
| Owner turns and fired reminders | 351 | 351 |
| Candidate calls (2 to 5 per turn, memory writer included) | 702 to 1,755 | 702 to 1,755 |
| Judge calls | 1,329 | 348 |
| Suggested `WALDO_EVAL_MAX_CALLS` | 3100 | 2200 |

A test holds each shard's cap at or above the plan's suggestion for what it runs, and the planner accepts four more scenarios in the weekly run, since an exhausted budget fails the gate. The plan assumes 2 to 5 calls a turn; a turn may make up to 25 rounds, and the first live run's per-scenario round counts replace that assumption. For split at 85 runnable scenarios (88 in the catalogue) the plan suggests 3100, and room for four more scenarios takes it to 3300. The wave-1 cap of 300 would have run out on the 22-scenario catalogue alone.

**Cost estimate.** [inference] This is an estimate, not a measurement.

Prices come from `packages/runtime/src/llm/pricing.ts`. The candidate figures below were priced on Sol ($2 input, $0.10 cached input and $10 output per million tokens). The default candidate is now Terra at $1, $0.05 and $5, so [inference] the candidate rows are about half what they show. Opus 5.5 is $4 and $20 per million, confirmed against the claude-api reference on 21 October 2026.

A chat request in the recorded dry run is about 51,000 characters, roughly 13,000 tokens, mostly the system prompt and tool schemas. Live requests grow with tool output.

| Part | Low | High |
| --- | --- | --- |
| Candidate (13K to 20K input tokens per call, 0.6K to 1.5K output, half the input cached at the high end) | about $10 | about $55 (about $81 with no cache hits) |
| Judges on Opus 5.5, joint (3K to 6K input, 1.5K to 4K output with thinking, 336 calls) | about $14 | about $34 |
| Judges on Opus 5.5, split (the same packet each call, shorter output, 1,293 calls) | about $42 | about $125 |
| Judges on Sonnet 5.5 | about half of Opus | about half of Opus |
| **A run, Opus 5.5 judging, joint** | **about $24** | **about $89 (up to about $115 with no cache hits)** |
| **A run, Opus 5.5 judging, split** | **about $52** | **about $180 (up to about $206 with no cache hits)** |

The judge-agreement check (`eval:voice-agreement` in live mode) makes 33 calls in joint mode and 198 in split mode, about $1 to $3 and $5 to $12.

Run nightly at the high end, live mode would cost on the order of $2,500 to $5,500 a month in split mode. Decide the cadence after the first run measures the real cost. For example, run the full suite weekly and one trial on behaviour PRs, or use joint mode for the regular runs and split mode for baselines.

The scorecard reports token totals per role, but not the cached split. The exact figure for a run comes from the provider dashboards, filtered to the eval project and workspace.

## The first run, in order

1. **Measure the judge first.** Run `eval:voice-agreement` live (about $2) on the labelled set, after Suyash has reviewed the labels (`reviewed_by` set). Read the false-pass rate. If the voice judge passes more than about 1 in 10 labelled fails, fix the rubric before trusting voice verdicts. [proposed] This 1-in-10 bar is a proposed threshold, not an agreed one.
2. **Smoke-test one scenario**, as above.
3. **Do the full run** at 3 trials with a cap of 3300, locally or by dispatch.
4. **Read the scorecard before any rate.** Check these things:
   - Blocked must be 3.
   - Harness errors must be 0.
   - Incomplete must be 0.
   - The budget must not have run out.
   - Judge errors should be few. A judge error is an ungraded trial, and many of them mean the judge request is wrong.

   Note the voice-judge and receipt failure lines.
5. **Set the floor.** Run `pnpm eval:plan live-scorecard.json`. It prints the graded and ungraded trials (an ungraded trial counts as no pass, so a judge that abstains cannot raise the floor), the observed pass rate, the 95% Wilson lower bound and `suggested_min_pass_rate`, which is the lower bound rounded down to a 0.05 step. Put that number in `NIGHTLY_THRESHOLDS.live.min_pass_rate` in `evals/nightly/gate.ts`.

   With about 140 graded trials, the point estimate moves by several points from run to run. A floor at the point estimate would fail the next honest run, so the lower bound is the defensible floor.
6. **Record the baseline.** Open the PR that sets the floor with the scorecard's Markdown (`live-scorecard.md`), the exact SHA, the models, the call and token counts, and the dashboard cost. The scorecard holds no reply text.
7. **Raise the floor only with evidence.** Raise it when a later run's lower bound clears it. Never lower it to make a run pass; a drop is a regression to classify.

`NIGHTLY_THRESHOLDS.live` holds the other limits too: `min_scenarios` (83), `max_blocked` (3), `max_harness_errors` (0) and `max_incomplete` (0). A PR that adds or unblocks a scenario moves them in the same diff.

## The raw-history baseline

Memory changes need something to be compared against. `WALDO_EVAL_MEMORY=raw_history` runs the memory cases with no claim store and no memory tools: the model sees the conversation and `search_episodes` over past turns, and nothing else. Run it live with the same keys and judge:

```bash
WALDO_EVAL_MODE=live WALDO_EVAL_MEMORY=raw_history WALDO_EVAL_JUDGE_MODEL=claude-opus-5-5 WALDO_EVAL_MAX_CALLS=400 WALDO_EVAL_TRIALS=3 \
  WALDO_EVAL_OUT="$PWD/raw-history-scorecard.json" npx -y pnpm@10.34.4 eval:nightly > /dev/null
```

It runs only the memory cases whose facts arrive in owner turns (`t19`, `r1`, `m02`, `h04`), since a seeded claim has no raw-history equivalent, and it skips their claim-store receipts, which have nothing to read. The same judge rubrics and the other receipts still apply, so the two scorecards compare like with like. Its scorecard is reported, never gated, and the label on the card says `(raw_history)`. If the claim store does not beat this baseline on those cases, the store is not earning its keep.
