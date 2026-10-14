> **UNVERIFIED DRAFT (research stage only).** Produced 14 Oct 2026 by the lead's decision workflow `wf_d8922d1d-861` at `beta-mvp` `e5c022ef`. The two adversarial verifiers and the reviser did not run because the session limit was reached. Verify against source before relying on it. Not accepted: the owner decides.

# ADR draft: the nightly model-graded eval (hosting, judge, spend, scorecards)

Status: Proposed, 14 Oct 2026. It becomes authoritative only after three things:
1. the owner approves it;
2. it is published in Brain under the next free number (0085 at the Brain checkout read, unless another draft takes it);
3. `docs/foundation/accepted-adrs.json` is regenerated.

It applies ADR-0069's harness rules to a second harness that runs nightly. It changes no product route or roster pin.

Author: the decision-packet session. Source read at `beta-mvp` `e5c022ef`; PR #1185 read at `a5138126`.

## 1. Context

- **Today.** The only model-graded eval is `packages/runtime/evals/run.ts`. It is run by hand, runs one trial, and is judged by the model it grades (`run.ts:31`). A prompt or model change that keeps the tool trajectory but makes the reply worse goes unseen until someone runs it (harness comparison, section 9.2).
- **PR #1185** adds a nightly suite:
  - 22 synthetic scenarios: 19 runnable, 3 reported blocked;
  - three trials each, reported as pass^3;
  - an Anthropic judge with thinking on;
  - one call budget shared by the model under test and the judge.

  It adds no workflow, key, schedule or storage. Those are owner decisions, recorded here.
- **ADR-0069 already sets the rules that matter:**
  - the harness judge is cross-family `claude-haiku-4-5`;
  - no judge is trusted until it agrees with the founder's blind labels (TPR and TNR at least 0.85, honeypots included);
  - a judge or rubric change re-runs that check;
  - synthetic-only harness traffic needs no Anthropic DPA;
  - harness traffic stays out of the morning wake cluster;
  - provider keys never go in Worker env.
- **Three facts shape the hosting:**
  - The repository is public.
  - GitHub fires a scheduled workflow only from the default branch, `main`. `beta-mvp` has diverged from it by thousands of commits, so `github.sha` on a schedule is `main`'s commit.
  - The judge request sends a fixed thinking budget, which current-generation Anthropic models reject with a 400.
- **Waiting on this:** the compaction switch (its draft, section 6, needs a real-model on/off run), the semantic-recall switch, persona checks and release suites.

## 2. Decision

### 2.1 Hosting
- **The workflow.** A GitHub Actions workflow, `nightly-eval.yml`, runs on `schedule` and `workflow_dispatch`.
  - The same file lives on `main` (for the schedule) and on `beta-mvp` (dispatched with `--ref beta-mvp`).
  - It checks out `beta-mvp` explicitly.
- **Hardening.**
  - `permissions: contents: read`;
  - every action pinned to a full SHA;
  - no `pull_request_target`;
  - one `concurrency` group, so two runs never overlap;
  - `timeout-minutes: 120`.
- **Keys.** The two eval keys live only as environment secrets of a GitHub environment `nightly-eval`, limited to `main` and `beta-mvp`. They never go into Worker env, wrangler or repository-level secrets.
- **Schedule:** `17 21 * * *` (21:17 UTC, 02:47 IST). That is:
  - outside 06:00 to 08:00 in the owner's zone [inference: IST];
  - off the top of the hour, when GitHub delays scheduled runs;
  - ready before the owner's morning.
- **No transcripts in CI.** `WALDO_EVAL_ONLY` is never set there. Transcripts are printed only on a developer's machine.

### 2.2 Judge
- **The model.** The judge is `claude-haiku-4-5`, ADR-0069's `harness_judge`. It is called on the Anthropic Messages API with thinking on.
  - The code defaults to `ROSTER.harness_judge`.
  - An override must be an Anthropic roster model.
- **Preflight.** One judge call on a fixed synthetic packet runs before any candidate call. A 4xx aborts the night with no candidate spend.
- **Honeypots.** About 15 synthetic trial records that must fail are judged every night, with no candidate call. Examples: a claimed send with no effect, the wrong recipient, a readiness claim after sharing was withdrawn, an invented event. Any honeypot graded pass fails the run.
- **Trust.** The scorecard is a measurement. No switch flips on it until the judge meets ADR-0069's alignment bar on the owner's blind labels, from one live night's trials plus the honeypots. A judge or rubric change re-runs that calibration.

### 2.3 Spend
Three limits apply; the tightest wins.
1. **Per run.** `WALDO_EVAL_MAX_CALLS` is 600 for the first run. After that it is 1.25 x the first run's measured calls, rounded up to tens. At the repository's price table and Haiku 4.5 list prices, that bounds a night at about $10 at worst, about $2-3 expected [inference].
2. **Per month, at the provider.** An eval-only OpenAI project with a hard monthly limit of $50, and an eval-only Anthropic workspace with a spend limit of $100. Product keys are never used.
3. **Time.** The job timeout.

The scorecard reports estimated dollars per role, so each night's cost is visible.

### 2.4 Scorecards and the release tie
- **Fields.** Each card carries:
  - `source_sha`: the checked-out commit, never `github.sha`;
  - `catalogue_digest`: scenarios, rubrics and judge instructions;
  - the candidate and judge model ids;
  - `started_at` and `finished_at`;
  - counts, rates, tokens, estimated dollars and honeypots caught.

  It never carries text.
- **Storage.** Each run uploads the artifact `nightly-eval-<source_sha>-<run_id>`, kept 90 days, and writes a job-summary table.
- **Release tie.** For each released SHA, the deploy hand-off names the card whose `source_sha` equals the deployed `WALDO_RELEASE`. The lead commits that card under `docs/evals/nightly/`. Released cards hold counts only and are kept indefinitely.
- **Exit status.** The run exits non-zero when:
  - nothing was graded;
  - the budget ran out;
  - the preflight failed; or
  - a honeypot passed.

  A low pass rate is not a failure. The trajectory tests stay the merge gate.

### 2.5 Data
- **Synthetic only.** The scenarios, mail, calendar, web results and the zone-level health context are all synthetic. No owner, tester or staging data enters the harness.
- **Providers.** Anthropic receives synthetic transcripts, tool names, effects and final state. OpenAI receives synthetic turns with `store: false`. Both fall under ADR-0069's synthetic-only exemption. This grants no DPA standing to any other traffic.
- **Public by default.** Logs, summaries and artifacts are public in this repository. The card holds no text. The owner accepts that pass rates are public.

## 3. Considered options

1. **GitHub Actions, Haiku 4.5 judge, eval-only keys with provider hard caps** (above). Chosen: it fits ADR-0069 without amendment, and the reviewed code works as written.
2. **A current-generation judge (Sonnet 5.5 or Opus 5.5) with adaptive thinking.**
   - Pro: probably a stronger grader [inference].
   - Con: the fixed thinking budget is rejected, so it needs a code change, plus an ADR-0069 roster amendment and the re-run ritual.
   - Con: about 1.5-3x the judge cost [inference].
   - Kept as the fallback if Haiku 4.5 fails calibration.
3. **A second OpenAI model as judge.** No new vendor, but same-family judging is what ADR-0069 says to avoid, and the roster has no second OpenAI model. Rejected.
4. **A staging cron inside the Worker.** It measures the deployed build, but:
   - provider keys would sit in Worker env, which ADR-0069 forbids;
   - it needs wrangler and deploy changes;
   - synthetic owners would land in staging storage.

   Rejected for the nightly run. Revisit for release suites against a deployed build.
5. **Manual runs only.** Cheapest, but regressions surface only when someone remembers. Used once, for the first run.

## 4. Consequences

- **Benefits:**
  - a nightly, cross-family, pass^3 measurement tied to the exact source it ran;
  - the compaction and recall switches get a real-model bar;
  - cost is visible on the card and capped twice.
- **Costs:**
  - about $60-90 a month [inference];
  - one vendor workspace and two keys in a public repository's environment;
  - about an hour of the owner's labelling once, and again after any judge or rubric change.
- **Risks:**
  - Anyone who can merge to `beta-mvp` can run code with the eval keys. This is the same trust as `deploy-staging`; the eval-only keys and hard limits bound it.
  - GitHub can delay or drop a scheduled run. A missed night shows as a missing artifact.
  - The harness runs the responder in process, so a card describes source code, not the running deploy.
- **Impact surface:**
  - `packages/runtime/evals/nightly/*` and its tests;
  - `.github/workflows/nightly-eval.yml` on two branches;
  - `docs/evals/nightly/`.

  No runtime, contract, migration, wrangler or app change.

## 5. Decisions the owner makes

1. Anthropic as the eval judge vendor, under ADR-0069's synthetic-only exemption.
2. Hosting on GitHub Actions in this public repository, with public, text-free scorecards.
3. The caps: 600 calls per run to start; $50 OpenAI and $100 Anthropic per month, eval-only accounts.
4. The schedule: 21:17 UTC daily, after one manual run.
5. Retention: artifacts 90 days; released-SHA cards kept in the repository.
6. The calibration labels, once.

## 6. Verification and tests

- **Config:**
  - a judge override outside the Anthropic roster throws at start;
  - live mode without `WALDO_EVAL_SOURCE_SHA` throws.
- **Preflight:** a stubbed 400 from the judge aborts with zero candidate calls and a non-zero exit.
- **Honeypots:** a stub judge that passes everything fails the run; a correct judge catches every honeypot.
- **Card:**
  - `source_sha`, `catalogue_digest`, timestamps and dollars are present;
  - no scenario text, mail field or address appears (the existing dry-run assertion, extended);
  - editing a rubric changes the digest.
- **Exit status:** an all-ungraded night and a budget-exhausted night exit non-zero; a graded night with failures exits zero.
- **Workflow review:**
  - every `uses:` is pinned to a full SHA;
  - `permissions` is `contents: read`;
  - no `WALDO_EVAL_ONLY` is set;
  - a dispatch on `beta-mvp` produces one artifact named with the checked-out SHA.
- **First live run:** about 19 graded and 3 blocked, with the card's dollars matching both provider dashboards within about 20%.
- **Calibration:** TPR and TNR at least 0.85 on the owner's labels, with every honeypot caught.
- **Falsifiers that reopen this decision:**
  - calibration below the bar, which moves to option 2;
  - more than 3 of 19 pass^3 flips across three nights at one `source_sha`;
  - more than $150 a month across both accounts;
  - more than 2 of 7 nights with no artifact.

## 7. Rollback

1. Disable the workflow: Actions > nightly-eval > Disable workflow. Or delete the file on both branches.
2. Revoke the two eval keys at the providers.
3. Delete the `nightly-eval` environment.

Nothing in the runtime depends on the eval. Released cards in the repository stay as history.
