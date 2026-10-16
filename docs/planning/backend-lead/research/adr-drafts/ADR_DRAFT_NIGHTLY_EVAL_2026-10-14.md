> **DRAFT for owner decision.** Written 14 Oct 2026 by the backend lead's decision workflow `wf_d8922d1d-861` at `beta-mvp` `e5c022ef`. Each draft went through research, two adversarial verifiers (source and risk) and a reviser. Status: Proposed. Not accepted until the owner says so.

# ADR draft: the nightly model-graded eval (hosting, judge, spend, scorecards)

Status: Proposed, 14 Oct 2026. It becomes authoritative only after three things:
1. the owner approves it;
2. it is published in Brain under the next free number (0085 at the Brain checkout read, unless another draft takes it);
3. `docs/foundation/accepted-adrs.json` is regenerated.

It applies ADR-0069's harness rules to a second, nightly harness. It extends ADR-0069 in two named places (sections 2.2 and 2.3). It changes no roster pin, product route or runtime path.

Author: the decision-packet session. Source read at `beta-mvp` `04bb8c89`. PR #1185 merged as `90ed0786`; nothing under `packages/runtime/evals` or `.github/workflows` changed between the two.

## 1. Context

- **Before #1185.** The only model-graded eval was `packages/runtime/evals/run.ts`. It runs by hand, runs one trial, and is graded by the model it tests (`run.ts:31`). A change that keeps the tool trajectory but makes replies worse goes unseen (harness comparison, section 9.2).
- **#1185 (merged)** adds `packages/runtime/evals/nightly/`:
  - 22 synthetic scenarios: 19 runnable, 3 reported blocked;
  - three trials each, reported as pass^3;
  - an Anthropic Messages API judge with a fixed thinking budget;
  - one call budget shared by the candidate and the judge.

  It has no workflow, key, schedule, storage, dollar figure or release tie. Those are owner decisions, recorded here.
- **ADR-0069 sets most of the rules:**
  - the harness judge is cross-family `claude-haiku-4-5`, scoped to comparative judging;
  - no judge is trusted until TPR and TNR are both at least 0.85 against the founder's blind labels, with honeypots so the fail class has at least 25 cases, and with binomial CIs;
  - any judge or rubric change, or any deprecation notice on a pinned ID, re-runs the labels;
  - synthetic-only harness traffic needs no Anthropic DPA;
  - harness runs are off-peak;
  - the product Anthropic key lives in gateway BYOK, never in Worker env.
- **Facts that shape the design:**
  - The repository is public.
  - GitHub fires a scheduled workflow only from the default branch, `main`, which has diverged from `beta-mvp` by thousands of commits. Neither branch is protected.
  - The judge's fixed thinking budget is rejected with a 400 by current-generation Anthropic models; Haiku 4.5 accepts it.
  - Tokens are summed per role today, so cost cannot be computed.
  - A scenario counts as graded if any one trial was graded, so a mostly ungraded night still prints a pass rate.
- **Waiting on this:** the compaction switch (its draft, section 6), the semantic-recall switch, persona rubrics and release suites.

## 2. Decision

### 2.1 Hosting
- **The workflow.** `nightly-eval.yml` runs on `schedule` and on `workflow_dispatch` with an optional `source_sha` input.
  - The same file lives on `main` (for the schedule) and on `beta-mvp`.
  - It always checks out `beta-mvp`, or `source_sha` when given; never the dispatched ref.
  - `source_sha` goes through env, must match 40 lowercase hex characters, and must be an ancestor of `origin/beta-mvp`.
- **Hardening.**
  - `permissions: contents: read`;
  - every action pinned to a full SHA;
  - no `pull_request_target`;
  - one `concurrency` group, so runs never overlap;
  - `timeout-minutes: 120`.
- **Keys.**
  - The two CI keys live only as environment secrets of the GitHub environment `nightly-eval`, limited to `main` and `beta-mvp`.
  - They are mapped into the eval step's env only, never job env, so install lifecycle scripts never see them.
  - They never go into Worker env, wrangler or repository-level secrets.
- **Schedule:** `17 21 * * *` (21:17 UTC, 02:47 IST). That is off-peak for the owner's zone [inference: IST], off the top of the hour, and done before morning.
- **No transcripts in CI.** `WALDO_EVAL_ONLY` and `WALDO_EVAL_EXPORT_DIR` are never set there.
- **Branch protection.** Either a ruleset requires a reviewed pull request on `beta-mvp` and `main`, or the owner's written acceptance of unreviewed push access is recorded here: `<owner ruling>`.

### 2.2 Judge
- **The model.** The judge is `claude-haiku-4-5`, called directly on the Anthropic Messages API with thinking on.
  - The code defaults to `ROSTER.harness_judge`.
  - An override must be an Anthropic roster model that accepts `budget_tokens`.
- **Extension of ADR-0069.** This ADR widens the `harness_judge` role from comparative judging to absolute pass/fail grading on the nightly rubric.
  - ADR-0069's comparative calibration does not carry over.
  - The nightly rubric gets its own founder-label calibration.
  - The rubric version is pinned by `catalogue_digest`. Any digest change re-runs the labels before any switch may flip on a scorecard.
- **Preflight.** One judge call on a fixed synthetic packet runs before any candidate call. A 4xx aborts the night with zero candidate spend.
- **Honeypots.** About 15 synthetic records that must fail are judged every night. A honeypot graded pass, or returning a judge error, counts as not caught.
- **Calibration.**
  - The owner labels a locally run, blind export (transcripts and verdicts in separate files).
  - The set has at least 25 fail cases (organic plus honeypots).
  - TPR and TNR are reported with 95% CIs. The judge is trusted at 0.85 or above on both, with every honeypot caught.
  - Calibration week also runs three dispatches at one pinned `source_sha` to measure noise.
- **Migration target.** `claude-haiku-5-5` with adaptive thinking is the named target when Haiku 4.5 gets a deprecation notice or fails calibration. It needs a code change, a roster amendment and its own calibration.

### 2.3 Keys and spend
- **A second Anthropic key home.** ADR-0069 keeps the product Anthropic key in gateway BYOK. This ADR adds eval-only Anthropic keys in GitHub (CI) and with the backend lead (local calibration). They are scoped to a `waldo-evals` workspace. This keeps eval spend out of the product gateway's route budgets and keeps the product gateway token out of CI.
- **Three limits; the tightest wins.**
  1. **Per run.** `WALDO_EVAL_MAX_CALLS` is 600 for the first run. After that it is 1.25 x the measured calls, rounded up to tens.
  2. **Per month, at the provider.** Anthropic: a `waldo-evals` workspace spend limit of $100, with a notification at $50. OpenAI: the control actually verified in force, recorded here as `<owner ruling: project hard limit, or a prepaid-credit eval-only organization>`, at $50. Until it is verified, the per-run cap is the binding OpenAI limit.
  3. **Time.** The job timeout.
- **Visible cost.** The scorecard reports estimated dollars per role from separate input, output and cached token counts.
- **Rotation.** All eval keys are revoked and reissued on removal of any collaborator with write access, on suspected workflow tampering, and every 90 days.

### 2.4 Scorecards and the release tie
- **Fields.** Each card carries:
  - `source_sha`: the checked-out commit, never `github.sha`;
  - `catalogue_digest`;
  - the candidate and judge model ids;
  - `started_at` and `finished_at`;
  - counts and rates;
  - ungraded and judge-error totals by class (status family or parse; never body text);
  - tokens split into input, output and cached;
  - estimated dollars;
  - honeypots caught.

  It never carries text.
- **Storage.** Each run uploads the artifact `nightly-eval-<source_sha>-<run_id>`, kept 90 days, and writes a job-summary table.
- **Release tie.**
  - The deploy hand-off dispatches `nightly-eval` with `source_sha` set to the reviewed release SHA.
  - The lead commits that card under `docs/evals/nightly/<sha>.json`, kept indefinitely; it holds counts only.
  - If no card's `source_sha` equals the deployed `WALDO_RELEASE`, the hand-off states 'no scorecard for this release'.
- **Exit status.** The run exits non-zero when:
  - ungraded trials exceed 10% of runnable trials;
  - nothing was graded;
  - the budget ran out;
  - the preflight failed; or
  - a honeypot was not caught.

  A low pass rate is not a failure. The trajectory tests stay the merge gate.

### 2.5 Data
- **Synthetic only, enforced.** Every scenario, honeypot and compaction script is authored synthetic. A case derived from a real conversation is rewritten and reviewed, never pasted.
  - A guard test fails if any fixture address or domain is not `.example` or `example.com`, or if a phone-number pattern appears.
  - This is the deterministic boundary that the no-DPA exemption rests on.
- **Providers.** Anthropic receives synthetic transcripts, tool names, effects and final state. OpenAI receives synthetic turns with `store: false`. Both fall under ADR-0069's synthetic-only exemption. This grants no DPA standing to any other traffic.
- **Public by default.** Logs, summaries and artifacts are public in this repository. The card holds no text. The owner accepts that pass rates are public.

## 3. Considered options

1. **GitHub Actions, direct Haiku 4.5 judge, eval-only keys, provider spend controls** (above). Chosen: no roster pin change, the merged code works as written, and spend and keys stay out of product paths.
2. **A current-generation judge with adaptive thinking.**
   - Haiku 5.5 costs about a tenth of Haiku 4.5's judge cost [inference]. Sonnet 5.5 or Opus 5.5 is probably stronger [inference] and costs more.
   - All of them reject the fixed thinking budget, so this needs a code change, a roster amendment and its own calibration.
   - Kept as the migration and fallback path.
3. **Judge through the existing AI Gateway with the product BYOK key.**
   - Pro: one key home, with payload logging off.
   - Cons: eval spend would draw on product route budgets that the Haiku fallback relies on; CI would hold the product gateway token; the chat-completions path may not pass Anthropic thinking [inference].
   - Rejected.
4. **A second OpenAI model as judge.** Same-family judging is what ADR-0069 avoids, and the roster has no second OpenAI model. Rejected.
5. **A staging cron inside the Worker** (the harness comparison's original 'on staging' proposal). It needs provider keys in Worker env, which ADR-0069 forbids, plus wrangler and deploy changes and synthetic owners in staging storage. Rejected for the nightly run. Revisit for release suites against a deployed build.
6. **Manual runs only.** Regressions surface only when someone remembers. Used for the first run and for calibration.

## 4. Consequences

- **Benefits:**
  - a nightly, cross-family pass^3 measurement tied to exact source, including every released SHA;
  - the compaction and recall switches get a real-model bar;
  - cost is visible on every card and capped at more than one layer.
- **Costs:**
  - about $60-95 a month [inference];
  - one vendor workspace and four eval keys (two in a public repository's environment, two with the lead);
  - about 2 hours of owner labelling once, and again after any catalogue, judge or deprecation change.
- **Risks:**
  - Without the ruleset, anyone with write access can run code with the eval keys. The eval-only spend controls bound the damage.
  - GitHub can delay, drop or auto-disable scheduled runs. A missed night shows as a missing artifact.
  - A card describes source run in process, not the running deploy.
  - Haiku 4.5 is previous-generation, so a second calibration is likely when it is deprecated.
- **Impact surface:**
  - `packages/runtime/evals/nightly/*` and its tests;
  - `.github/workflows/nightly-eval.yml` on two branches;
  - the deploy hand-off comment and runbook;
  - `docs/evals/nightly/`.

  No runtime, contract, migration, wrangler or app change.

## 5. Decisions the owner makes

1. Anthropic as the eval judge vendor, under the synthetic-only exemption.
2. The second, direct Anthropic key home for evals.
3. Widening `harness_judge` to absolute nightly grading.
4. Hosting on GitHub Actions in this public repository, with public, text-free scorecards.
5. Branch protection, or written acceptance of the risk.
6. The caps, and which OpenAI control is in force.
7. The schedule.
8. Retention.
9. The calibration labels.

## 6. Verification and tests

- **Config:**
  - a judge override outside the allowed Anthropic roster set throws;
  - live mode without `WALDO_EVAL_SOURCE_SHA` throws.
- **Preflight:** a stubbed 400 aborts with zero candidate calls and a non-zero exit.
- **Honeypots:**
  - a stub judge that passes everything fails the run;
  - a honeypot returning judge_error counts as not caught;
  - a correct judge catches all of them.
- **Card:**
  - all new fields are present;
  - no scenario text, mail field or address appears;
  - a rubric edit changes the digest;
  - dollars match modelCost on a fixed token split.
- **Exit status:**
  - 50 judge errors in 57 trials exits non-zero;
  - a budget-exhausted night exits non-zero;
  - a graded night with failures exits zero.
- **Synthetic guard:** a fixture with a non-`.example` address fails the test.
- **Workflow review:**
  - every `uses:` is pinned to a full SHA;
  - `permissions` is `contents: read`;
  - the secrets appear only in the eval step's env;
  - `source_sha` is never interpolated into `run:`;
  - a non-hex or non-ancestor `source_sha` fails before install;
  - a dispatch from `main` still checks out `beta-mvp`.
- **First live run:** about 19 graded and 3 blocked, every honeypot caught, and the card's dollars within about 20% of both provider usage pages.
- **Calibration:**
  - at least 25 fail labels;
  - TPR and TNR at 0.85 or above with CIs reported;
  - no more than 3 of 19 pass^3 flips across three runs at one pinned SHA.
- **Falsifiers that reopen this decision:**
  - calibration below the bar (move to option 2);
  - the noise check above;
  - more than $150 a month across both accounts;
  - more than 2 of 7 nights with no artifact;
  - a ruling that synthetic traffic still needs a DPA (the eval stays manual until signed).

## 7. Rollback

1. Disable the workflow: Actions > nightly-eval > Disable workflow. Or delete the file on both branches.
2. Revoke all four eval keys at the providers.
3. Delete the `nightly-eval` environment.

Nothing in the runtime depends on the eval. Committed release cards stay as history.
