# Six owner decisions: verified packets (14 Oct 2026)
Tip `e5c022ef`. Each packet went through research, a source verifier, a risk verifier and a reviser. Full packets are in `decision-packets-2026-10-14.json`; the ADR drafts are in `adr-drafts/`.

## G37: Health values typed in chat: the transcript, the recall index, embeddings, compaction and claims

**Question.** When a conversation row carries a health value (typed by the owner, or said back by Waldo in an owner-channel reply), which stores may keep the value, which get only a value-free form, who decides that a row carries one, and where does that answer live?

**Recommended.** Light split: verbatim transcript and index, model class gates new stores and claims

**Why.** Switch. Verifier 1's lighter option is better, and I confirmed its premises in source.

Why the light split:
- Every reader of the episode index puts text into model context: search_episodes, B3 recall (within recallReach), and the nightly model call (owner-do.ts:3031-3039). Ruling 2 allows that. The nightly pass's only persistent output is claims, so the guard belongs at the claim write.
- The index lives in the owner object beside the transcript, with the same forget, thread-erase and deleteAll reach (owner-do.ts:990-997, :2761-2778, :919). It adds no store and no lifetime the transcript does not already have.
- Compaction's input is the model view every turn already sends to the same provider with store:false (compaction.ts:82-85; llm/openai.ts:70). Its persisted output already meets policy (a) through the numeric floor (owner-turn.ts:741-746). So compaction needs only the owner's word, not a classifier.
- The new stores are where values would multiply: embeddings, which are invertible and deleted asynchronously, and claims, which ride every turn's system prompt (claims.ts:1056-1075, owner-turn.ts:546). The class is spent there.
- A failed or missing class fails closed (not embedded). Nothing waits on it. That removes the full split's stall, its global backlog gate and its post-delivery dependency.

The one reading this rests on: the owner treats the episode index as part of the transcript record, not as 'long-term memory' under amendment:23. If the owner reads it the other way, the full split (option 4) is the right choice. That is sub-decision A and falsifier 1.

Verifier findings, checked against source:
- Accepted: the every-turn prompt is turnMemoryPrompt, not the About-you block in memoryPrompt (claims.ts:1146, :1161, :1358 use memoryPrompt only for nightly, promotion and migration). The value in the prompt is observed in tests, so the [inference] tag is dropped.
- Accepted: the numeric floor misses lab values and doses, including the pinned fixture. Claims therefore rest on model instruction, with the floor as backstop. remember stays at internal_context. Switching to memory_block would redact contact facts and run the qualitative regexes, a fixed rule making a judgment call (sanitiser.ts:82-85, :585-590).
- Accepted: resolveSource is not wired (memory.ts:20, :101; owner-do.ts:2759-2780). S6 adds a resolver, checked against recallReach.
- Accepted: compactIfDue has no caller. The light split avoids needing a post-delivery slot: each owner turn's classify call also takes the previous reply row, and the nightly pass drains the rest.
- Accepted: iMessage history is not indexed (owner-do.ts:2820). In the light split the class writer wraps all three chain stores, independent of the index.
- Accepted: #1248 windows load(). Pending rows are found by SQL on row_class and fetched by entry id. S8 is sequenced after #1248.
- Accepted: a classify result must be fenced. settle() is a compare-and-set on row existence, source digest, pending state and consent epoch.
- Accepted: bounded retries. One retry owner (the nightly drain), an attempt count, and a terminal fail-closed state, unclassified.
- Accepted: 'never' in ADR-0081 means deterministic. The matrix row states 'model class plus numeric floor' and names the residual. The floor runs as a hard gate on every text entering embeddings.
- Accepted: retention and withdrawal amend ADR-0081 §3 and §5 for conversation rows. Withdrawal handling is mandatory before outside users, not optional. Model-use withdrawal is handled too (amendment:27).
- Accepted: scope widened to any person's health values and medication doses.
- Accepted: the class never widens a destination; class labels never go to logs, metrics, traces or audit.
- Accepted: the Brain steps. The matrix row travels inside the new ADR as an amendment of 0081, and the security-checklist exception goes through a canonical Brain edit and a remirror.
- Accepted: the falsifier sample. At least 150 values rows, reported as a confidence bound, with subsets.
- Accepted: the consent copy was over-promising; replaced.
- Accepted: account deletion already wipes the new table through deleteAll; no slice for it. ADR-0081 'never' sentence is line 80. Row 90 is cited as precedent.
- Moot under the switch: the index speaker label, the quoted/own split, the index backlog and mark stall, and the S5 resize. These applied only to the full split.
- Rejected: none outright. One partial correction: compaction still needs the B2 post-delivery call and the G43 eval before it flips. Those are B2's own dependencies, not G37's.

Sub-decisions the owner rules on with this:
- A: the episode index is part of the transcript record (recommended yes).
- B: claims hold a qualitative statement plus a pointer, decided by the model, with the floor as backstop (recommended yes, because a value in a claim rides every turn's prompt).
- C: before outside users, storage withdrawal rewrites values rows to their value-free form, and model-use withdrawal projects them value-free into model context (required by ADR-0081 §5 and amendment:27; the owner confirms).
- D: retention before outside users. Owner-typed values rows stay until deleted, following the row 90 precedent of quoted user intent. Waldo's reply rows that quote values are rewritten value-free after 90 days, matching the raw window (recommended).
- E: classify historical rows once, so B4 can embed old none rows. This re-sends past chat to the provider for a new purpose (recommended yes, owner-only beta).

Main trade-off: the index keeps verbatim values, for full search recall, in exchange for one owner reading. Everything new is gated by the model's class.

**Falsifier.** Any of these makes the light split the wrong choice.

1. Index reading. The owner, or a DPDP or App Store review, reads the episode index as long-term memory under HEALTH_PLANE_AMENDMENT.md:23. Then use the full split (option 4) for the index.

2. Classifier recall. Use synthetic sets of at least 150 values rows, 150 qualitative and 150 none. Subsets: third-party values, medication doses, Hindi, Marathi and mixed-language text, quoted content, Telegram-style and app-style. Run three times. Report the 95% upper bound, not only the point rate. The split fails for embeddings if the upper bound of values rows labelled none exceeds 3%, or any subset shows a values row labelled none in more than one run. Then B4 embeds no owner or quoted rows until a better classifier passes.

3. False positives. If more than 5% of none rows are labelled values, embedding recall suffers. Tune the instruction; this does not reopen the policy.

4. Claims. A scenario eval where the owner states lab values and doses. The split fails if remember or the nightly pass stores an exact value in more than 2 of 50 runs. Then the claim write needs a stronger guard, or exact values move to the health plane.

5. Legal. A review says owner-typed health values must not persist in Waldo's storage outside the RLS health plane. Then use option 1.

6. Cost. The classify call costs more than the turn's cheapest model call on a median turn. Then classify only in the nightly drain and record that 'classified at ingress' means 'pending at ingress'.

**Owner steps.**
- **Ansh (owner):** Rule in one comment on the #1103 board, or as a review reply on the S1 ADR draft PR. Suggested text: 'G37: light split. A yes (the index is part of the transcript record). B yes. C yes before outside users. D: owner rows kept until deleted, Waldo reply rows value-free after 90 days, before outside users. E yes. I accept the residual misclassification at the bound the eval posts.' Change any part you disagree with. A no means the full split.
- **Ansh (owner):** In Pin4sf/waldo-brain, merge the PR that adds this ADR under the next free number in '01-Waldo/Architecture Decision Records (ADR)/'. The ADR itself carries the new ADR-0081 matrix row as an amendment; the 0081 file is not edited. After the merge, the agent regenerates docs/foundation/accepted-adrs.json in a backend PR.
- **Ansh (owner):** In Pin4sf/waldo-brain, merge a canonical edit to .claude/rules/security-checklist.md. In the health-data overlay, add the exception: the owner's own transcript rows and their episode index in the owner object may hold values the owner typed or Waldo said back. Then merge the remirror PRs in waldo-backend, waldo-app and waldo-types.
- **Ansh (owner):** Confirm the classify call may use the chat model provider already approved for conversation, with store:false. This adds no third-party service. A different provider is a new egress decision.
- **Ansh (owner):** Turn on classification. ROW_CLASS.enabled is a source constant. After S2-S5 merge and the agent posts the falsifier numbers on #1103, merge the one-line flip PR and deploy the Worker from that exact merged SHA. No hosted Supabase migration, no wrangler.jsonc change, no edge deploy.
- **Ansh (owner):** Compaction is separate. Its flip needs the B2 post-delivery call and a passing compaction eval, which needs the #1185 nightly eval keys and schedule (G43). Merge the compaction flip PR and deploy after that eval passes.
- **Ansh (owner):** For B4, do the owner steps already in its spec: confirm Workers AI and Vectorize under the consent policy, and add both bindings to production wrangler.jsonc.
- **Ansh (owner):** Before any outside user, approve consent copy the app lane drafts. It should say: chat keeps your messages as you wrote them; Waldo aims to keep health numbers out of its memory and semantic search and checks numbers before saving; messages sent through Telegram, iMessage or WhatsApp also stay with those services; deleting a message, thread or account, or withdrawing health storage, removes Waldo's copies only.

**Backend work.**
- S1 Publish the decision. ADR draft; addendum to HEALTH_PLANE_AMENDMENT; a pointer in IMPLEMENTATION_CONTRACTS saying :16, :17 and :39 are superseded for owner-channel rows while :37 and :41 stand; a resolution line in CONSULT_VERDICTS for :39. After the Brain merge, regenerate accepted-adrs.json. Docs only. Recording the ruling also clears compaction's G37 dependency. (S; files: docs/proposals/ADR_DRAFT_HEALTH_IN_CONVERSATION_ROWS_2026-10-14.md (new); docs/app/HEALTH_PLANE_AMENDMENT.md; docs/planning/waldo-agent-mvp/IMPLEMENTATION_CONTRACTS.md; docs/app/CONSULT_VERDICTS.md; docs/foundation/accepted-adrs.json (after Brain); starts when: The owner rules on G37 and sub-decisions A-E.)
- S2 The class store.
- New module conversation/row-class.ts owns table row_class(entry_id PK, chain_ref, persisted_at, class pending|none|qualitative|values|unclassified, value_free_text NULL, source_digest, consent_epoch, attempts, classified_at).
- A wrapper applied to all three chain stores (Telegram conv:*, app canonical, iMessage canonical) writes pending when a row persists.
- settle(entryId, digest, epoch, answer) commits only if the row exists, its digest matches, the class is still pending and the consent epoch is unchanged. Otherwise it drops the answer.
- A row with no class row counts as not classified for every reader.
- Thread erase removes class rows.
- Switch ROW_CLASS.enabled, off by default. (M; files: packages/runtime/src/conversation/row-class.ts (new); packages/runtime/src/channels/owner-do.ts (store wiring at :2554/:2750/:2814/:2820 and the erase hunk at :990-997); packages/runtime/test/row-class.test.ts (new, red first); starts when: Owner yes. Built behind the switch, off. owner-do.ts hunks in the Mac lane's slot.)
- S3 Classify at ingress.
- Instruction and strict JSON schema {class, value_free_text?}. Scope: any person's health measurement, reading, score, lab result or medication dose.
- One call per owner turn, started after persistOwnerInput, beside the turn, never awaited by the reply. It classifies the new owner row plus up to N pending rows of the chain (the previous reply included), found by SQL on row_class and fetched by entry id.
- admit() before the call and before settle. Purpose row_class is metadata-only in complete(). Chat provider with store:false.
- Class labels never reach logs, metrics, traces or audit.
- Synthetic eval sets for the falsifier. (M; files: packages/runtime/src/conversation/row-class.ts; packages/runtime/src/channels/owner-turn.ts; packages/runtime/src/channels/owner-do.ts (classifier host hunk); packages/runtime/test/row-class-turn.test.ts (new); packages/runtime/evals fixtures (synthetic only); starts when: After S2.)
- S4 One retry owner. The nightly pass drains pending rows in bounded batches. Each attempt is counted. After 3 failed attempts the row becomes unclassified: never embedded, and treated as values on withdrawal. A content-free count of pending and unclassified rows is logged. If E is yes, the same drain classifies historical rows once. (M; files: packages/runtime/src/conversation/row-class.ts; packages/runtime/src/channels/owner-do.ts (nightly hunk); test for terminal state and exactly-once settle; starts when: After S3.)
- S5 Forget reach. A forget hit on a row's text literally redacts its value_free_text, then clears it and resets the row to pending so it is re-derived from the redacted row. Covers both forget paths (hideHistory and the claims purge). (S; files: packages/runtime/src/channels/owner-do.ts (hideHistory hunk at :2761-2778); packages/runtime/src/memory/claims.ts (purge near :626-632); packages/runtime/src/conversation/row-class.ts; packages/runtime/test/forget-derived-stores.test.ts, forget-topic-redaction.test.ts (extend); starts when: With S2; before the switch turns on.)
- S6 Claims as a qualitative statement plus pointer (sub-decision B).
- The remember description and NIGHTLY_MEMORY_INSTRUCTION ask for a qualitative statement plus source_ref, never the exact value.
- remember stays at internal_context. numericHealthIn runs explicitly in the remember handler and in applyClaimOps as the Art-9 backstop.
- A new resolver lets read_memory return the exact value from the source row as model context, only when recalls(entryId) allows it; otherwise the qualitative claim only.
- A one-time model pass rewrites existing numeric health claims to qualitative plus pointer and purges their memory_backups payloads.
- The two pinned tests are rewritten red first. A scenario eval checks the model's behaviour. (M; files: packages/runtime/src/tools/live/memory.ts; packages/runtime/src/memory/claims.ts; packages/runtime/src/channels/owner-do.ts (resolver wiring hunk); packages/runtime/test/memory-health-contact-route.test.ts; packages/runtime/test/memory-health-owner-turn.test.ts; scenario eval; starts when: Owner yes on B. Independent of S2-S5.)
- S7 Embedding gate, inside the B4 build. The vector outbox embeds a row only if its class is none and its text passes numericHealthIn. No class row means no embedding. A forget settles only after the vector delete is read back. Source conformance test: a qualitative, values, pending, unclassified or unclassed row never reaches the embedding call. (S; files: B4 vector outbox module (new in B4); packages/runtime/src/memory/turn-recall.ts; B4 tests. Coordinate episodes.ts edits with the B4 lane.; starts when: Inside B4, after S2-S5 and a passing classifier eval.)
- S8 Before outside users (sub-decisions C and D).
- A consent signal from the withdrawal route into the owner object that advances a consent generation before any purge.
- Storage withdrawal: each values row in the transcript (canonical and legacy conv:*) and its index rows are rewritten to value_free_text, with the witness, in one unit. Unclassified and unclassed rows get a fixed marker.
- Model-use withdrawal: values rows are projected value-free into the model window, recall and search at read time, and the S6 resolver is off.
- Retention: Waldo reply rows that carry values are rewritten value-free after 90 days. (L; files: packages/runtime/src/channels/app-health.ts; packages/runtime/src/channels/owner-do.ts; packages/runtime/src/conversation/canonical-owner-store.ts; packages/runtime/src/channels/conversation-store.ts; packages/runtime/src/channels/episodes.ts; packages/runtime/src/conversation/row-class.ts; tests; starts when: Before any outside user, after S2-S5 and after #1248 merges.)

**Unblocks.** - Compaction (G7, the B2 flip): this ruling (S1) removes its G37 dependency under its approved policy (a). It still needs the B2 post-delivery call and a passing compaction eval, which needs the #1185 keys (G43).
- Semantic recall (G8, B4): embedding limited to rows the model classed none that also pass the numeric floor, after S2-S5 and a passing classifier eval. The B4 owner steps for Workers AI and Vectorize still apply.
- Takes exact owner-stated values out of claims and the every-turn system prompt (S6).
- Gives A3 visibility a per-row health signal that may only narrow.
- Closes the transcript part of CONSULT_VERDICTS.md:39 and the conflict between IMPLEMENTATION_CONTRACTS.md:16-17, :39 and ruling 2.
- Defines the withdrawal and retention work required before any outside user (S8).

**Verifiers before revision.** PASS_WITH_FIXES (13 findings); FAIL (19 findings)

**ADR draft.** `adr-drafts/ADR_DRAFT_HEALTH_IN_CONVERSATION_ROWS_2026-10-14.md`

## EVAL: Nightly model-graded eval (#1185): keys, judge, schedule, spend cap, scorecard storage

**Question.** How should the nightly eval merged by PR #1185 go live: where it runs, which judge it uses, which keys and caps it gets, when it runs, and where its scorecards are kept and tied to a release SHA?

**Recommended.** A. GitHub Actions nightly, direct Haiku 4.5 judge, eval-only keys with provider spend controls, scorecards tied to the source SHA

**Why.** ADR-0069 already decides the important parts: a cross-family Haiku 4.5 judge, no DPA needed for synthetic-only traffic, off-peak runs, and no trusted judge before calibration. Option A applies those rules without changing a roster pin, and the merged judge code works with Haiku 4.5 as it stands.

What A is not:
- It is not 'no amendment needed'. It widens harness_judge from comparative to absolute grading on a new rubric. The ADR draft records that, and the nightly rubric gets its own founder-label calibration, pinned by catalogue_digest.
- It also adds a direct Anthropic key next to the gateway BYOK key. Direct beats C because eval spend stays out of the product gateway's route budgets, CI never holds the product gateway token, and the Messages API thinking parameter is known to work. The owner must approve this second key home explicitly.

Why not the others:
- B is a code change plus a roster amendment, not a setting. Haiku 5.5 is its low-cost variant and the named migration target when Haiku 4.5 gets a deprecation notice. Calibration is needed either way, so starting on A costs nothing extra now.
- D1 weakens judge independence. D2 breaks the no-keys-in-Worker rule.
- A departs from HARNESS_COMPARISON section 9.2's 'on staging' on purpose: running on staging would need keys in Worker env or staging storage writes, and the harness runs the responder in process anyway.

Verifier findings I confirmed in source and applied:
- PR #1185 has merged (90ed0786). The old S1 is gone.
- Tokens are summed per role (trial.ts:36, judge.ts:80, budget.ts:16), so pricing needs the split. Those files are now in S1.
- A tip-only schedule cannot match a deployed WALDO_RELEASE. workflow_dispatch now takes a validated source_sha, and the deploy hand-off dispatches at the release SHA. If no card matches, the hand-off says so.
- A dispatch from main would check out main, which has no evals. The checkout now ignores the dispatched ref.
- The noise falsifier is now a deliberate three-run measurement at one pinned SHA.
- Calibration now requires at least 25 fail labels and binomial CIs (ADR-0069 l.164, 217).
- Labels must be blind. main.ts:16 prints verdicts next to transcripts, so S4 adds a split export. The lead gets a separate developer key, because the CI keys are copied only into GitHub.
- Branch protection is off on both branches (verified). The owner adds a ruleset or accepts the risk in writing. Secrets are scoped to the eval step only.
- Nothing enforced 'synthetic only', which is the only basis for the no-DPA exemption. S4 adds a deterministic fixture guard at that privacy boundary.
- A mostly ungraded night exited 0. S1 adds judge_error classes and an ungraded-fraction exit rule.
- The OpenAI hard limit was unverified. The owner step now has a fallback (prepaid credits in a separate eval-only org), and the ADR names whatever control is actually in force.
- Falsifier 5 fell back to the rejected option C. It now keeps the eval manual instead.
- Key rotation triggers were added.
- I qualified 'no runtime path calls Anthropic' to 'capable but uncalled'.

Finding I rejected:
- The verifier said ENGINEERING_QUALITY.md:46 is the scenario-record paragraph and the rubric line is :48. grep shows the opposite: :44 is the scenario record and :46 is the 'calibrated model/human rubrics for usefulness, personality' line. The :46 cite stays.

Expected cost [inference]. Assumptions:
- 57 trials (19 runnable scenarios x 3), about 99 responder turns, and 2-4 candidate calls per turn;
- 57 judge calls, plus about 16 for the preflight and honeypots;
- gpt-6-luna at $0.10/M input and $0.50/M output (pricing.ts:8);
- Haiku 4.5 at $1/M input and $5/M output.

That gives about $1 for the candidate and $2 for the judge per night, about $60-95 a month. A 600-call cap bounds a night at about $10.

Schedule: 21:17 UTC (02:47 IST). That is off-peak for the owner's zone [inference: IST from the scenarios' Asia/Kolkata], off the top of the hour, and done before morning.

**Falsifier.** Any one of these makes A the wrong choice:
1. Calibration fails. The set is a locally re-run, blind-labelled set: at least 25 fail cases (organic fails plus honeypots) and comparable passes. If Haiku 4.5's TPR or TNR is below 0.85, or it passes any honeypot, move to option B (Haiku 5.5 first, then Sonnet 5.5).
2. The scorecard is too noisy. During calibration week, dispatch three runs at one pinned source_sha. If more than 3 of the 19 runnable scenarios flip pass^3 across those runs, k=3 with this judge is too noisy.
3. The provider usage pages show more than $5 per run, or more than $150 a month across both eval accounts.
4. More than 2 of any 7 scheduled nights produce no artifact. Then GitHub's schedule is unreliable here (this includes the auto-disable of inactive scheduled workflows [inference]); move to an external trigger of workflow_dispatch.
5. The owner rules that synthetic-only traffic to Anthropic still needs a signed DPA. Then the eval stays manual and synthetic-only until the DPA is signed. Do not fall back to a same-family judge.

**Owner steps.**
- **Ansh (owner):** Rule on this packet with one reply on the follow-up PR, or as a comment on merged PR #1185. Seven rulings:
1. Anthropic as the eval judge vendor, under ADR-0069's synthetic-only exemption.
2. A second, direct Anthropic key home in GitHub for evals, next to the gateway BYOK key.
3. Widening harness_judge to absolute nightly grading, with its own calibration.
4. GitHub Actions in this public repo, with public, text-free scorecards.
5. Caps: 600 calls per run to start; $50 a month on the OpenAI eval project and $100 a month on the Anthropic eval workspace.
6. Schedule 21:17 UTC daily.
7. Artifacts kept 90 days; released-SHA cards committed to the repo.
- **Ansh (owner):** Branch protection. Today both beta-mvp and main are unprotected, so code pushed without review would run with the eval keys. Choose one:
(a) Settings > Rules > Rulesets > New branch ruleset. Target beta-mvp and main. Require a pull request before merging with 1 approval. Block force pushes.
(b) Record in your reply that you accept unreviewed push access to code that runs with the eval keys, bounded by the eval-only spend controls.
- **Ansh (owner):** OpenAI platform:
1. Create a project named waldo-evals.
2. In that project: Settings > Limits. Set a monthly spend limit of 50 USD and turn on hard enforcement if the UI offers it. The menu wording is from OpenAI's spend-limits guide and was not checked live.
3. If the project offers no enforced limit, create a separate eval-only organization funded by prepaid credits of about 50 USD, and do steps 4-5 there.
4. Tell the lead which control is actually in force, so the ADR names it.
5. Create two project-owned secret keys, restricted to the Responses endpoint if offered: one for CI (GitHub only) and one for the backend lead's local calibration runs.
6. Never reuse the product or smoke key.
- **Ansh (owner):** Claude Console (Anthropic):
1. Use the existing org if one exists from the ADR-0069 BYOK route.
2. Settings > Workspaces > Create workspace, named waldo-evals.
3. Limits tab: spend limit 100 USD per month, with a notification at 50 USD.
4. Settings > API keys: create two keys scoped to waldo-evals, one for CI and one for the lead's local runs.
5. Copy each key once into its destination only.
- **Ansh (owner):** GitHub, repository waldoco/waldo-backend:
1. Settings > Environments > New environment, named nightly-eval.
2. Deployment branches and tags: Selected branches. Add main and beta-mvp.
3. Leave Required reviewers off; it would hold every scheduled run.
4. Environment secrets: WALDO_EVAL_OPENAI_KEY and WALDO_EVAL_ANTHROPIC_KEY (the CI keys).
5. Environment variables: WALDO_EVAL_MAX_CALLS = 600 and WALDO_EVAL_TRIALS = 3. Add WALDO_EVAL_JUDGE_MODEL only to override claude-haiku-4-5.
6. Do not add these as repository-level Actions secrets.
- **Ansh (owner):** Hand the two developer keys to the backend lead through a password manager share, never chat or email.
- **Ansh (owner):** Review and approve the two workflow PRs from slice S5 (the same file on beta-mvp and on main). This is a CI/CD change, which is your call.
- **Ansh (owner):** First run, manual:
1. Actions > nightly-eval > Run workflow > Use workflow from: beta-mvp > Run workflow.
2. Open the run Summary and the artifact.
3. On both providers' usage pages, check that the spend roughly matches the card's dollars. Expect about 19 graded scenarios, 3 blocked, and every honeypot caught.
4. Then set WALDO_EVAL_MAX_CALLS to the value the lead posts: 1.25 x the measured calls, rounded up to tens.
- **Ansh (owner):** Calibration, once, about 2 hours [inference; ADR-0069 budgeted about 4 hours for 115 longer items]:
1. The lead runs the suite locally with the developer keys and WALDO_EVAL_EXPORT_DIR, adding trials until the set holds at least 25 fail cases (organic plus honeypots).
2. You label transcripts.jsonl pass or fail without seeing any verdict.
3. The lead reports TPR and TNR with 95% CIs. The judge is trusted at 0.85 or above on both, with every honeypot caught.
4. The same week, the lead dispatches three runs at one pinned source_sha for the noise check.
5. Repeat calibration after any catalogue_digest change, judge change, or deprecation notice on the judge ID.
- **Ansh (owner):** Key rotation:
- Revoke and reissue all four eval keys at once if a collaborator with write access is removed, or if workflow tampering is suspected.
- Otherwise rotate every 90 days; first rotation on 14 Jan 2027.
- **Backend lead:** After the owner approves:
1. Publish the ADR draft in Brain under the next free number (0085 at the Brain checkout read here).
2. Regenerate docs/foundation/accepted-adrs.json.
3. Add the eval dispatch step to the deploy hand-off (S6).

**Backend work.**
- S1. Priceable, releasable scorecard and honest exit status.
- Budget records input, output and cached tokens separately per role. The candidate uses cache_read_input_tokens from the adapter result; the judge uses Anthropic usage.
- The card adds:
  - source_sha, required in live mode, read from WALDO_EVAL_SOURCE_SHA;
  - catalogue_digest: sha256 over scenarios, rubrics and judge instructions;
  - started_at and finished_at;
  - estimated USD per role: the candidate through pricing.ts modelCost, the judge through one eval-local price row for claude-haiku-4-5;
  - ungraded and judge_error totals, with judge_error classed as 4xx, 429, 5xx, parse or network. The class is a status family only, never body text.
- main.ts exits non-zero when ungraded trials exceed 10% of runnable trials, when nothing is graded, or when the budget runs out. A graded night with failures exits 0.
- Tests:
  - the dry-run no-text assertion is extended to the new fields;
  - a rubric edit changes the digest;
  - a stub that returns 50 judge_errors in 57 exits non-zero. (M; files: packages/runtime/evals/nightly/budget.ts, trial.ts, judge.ts, scorecard.ts, suite.ts, main.ts, config.ts; packages/runtime/test/nightly-eval-scorecard.test.ts, nightly-eval-suite.test.ts; starts when: Now, on the beta-mvp tip. No owner input needed.)
- S2. Judge guard and preflight.
- WALDO_EVAL_JUDGE_MODEL defaults to ROSTER.harness_judge.
- An override must be an Anthropic roster model that accepts budget_tokens (today claude-haiku-4-5 and claude-sonnet-4-6).
- One preflight judge call on a fixed synthetic packet runs before any candidate call. A 4xx aborts the run with zero candidate calls and a non-zero exit.
- Tests: a non-roster override throws; a stubbed 400 gives candidate_calls 0 and a non-zero exit. (S; files: packages/runtime/evals/nightly/config.ts, judge.ts, main.ts; packages/runtime/test/nightly-eval-judge.test.ts; starts when: Now, in parallel with S1. No owner input needed.)
- S3. Honeypots.
- About 15 synthetic trial records that must fail. Examples: a send claimed with no effect, the wrong recipient, a time not in the source, a readiness claim after health sharing was withdrawn, a reminder on the wrong day, an invented event.
- They are judged every night with no candidate call.
- The card reports honeypots {total, caught}. A honeypot that comes back judge_error counts as not caught. Any honeypot not caught makes the run exit non-zero.
- Test: a stub judge that passes everything fails the run. (M; files: packages/runtime/evals/nightly/honeypots.ts (new), suite.ts, scorecard.ts, main.ts; packages/runtime/test/nightly-eval-suite.test.ts; starts when: After S1. The owner skims the honeypot list in review.)
- S4. Synthetic-data guard and blind calibration export.
- Guard test. Every email address and domain in scenarios.ts, world.ts, honeypots.ts and any compaction script must use .example or example.com, and no phone-number pattern may appear. This is a deterministic privacy guard at the no-DPA boundary, not a judgment rule.
- Export mode, WALDO_EVAL_EXPORT_DIR, for local runs only:
  - it writes transcripts.jsonl (shuffled label ids, no verdicts) and verdicts.jsonl (label id, judge verdict) as separate files;
  - a small script compares the owner's labels file with verdicts.jsonl and prints TPR and TNR with Wilson 95% CIs and the fail-class count.
- The workflow never sets it. (S; files: packages/runtime/test/nightly-eval-fixtures-synthetic.test.ts (new); packages/runtime/evals/nightly/main.ts, calibrate.ts (new); starts when: After S3.)
- S5. Workflow nightly-eval.yml.
- Triggers: schedule '17 21 * * *', and workflow_dispatch with an optional input source_sha.
- Settings: permissions contents: read; environment nightly-eval; concurrency group nightly-eval with cancel-in-progress false; timeout-minutes 120.
- Steps:
  1. Check out beta-mvp with fetch-depth 0, whatever ref was dispatched.
  2. If source_sha is set, pass it through env (never interpolated into run:). Check it matches ^[0-9a-f]{40}$ and that git merge-base --is-ancestor says it is in origin/beta-mvp. Then check it out.
  3. Set up node and pnpm at the SHAs verify.yml already pins.
  4. Install with the frozen lockfile. No secrets in job env.
  5. Run the eval step with step-level env only: WALDO_EVAL_MODE=live, OPENAI_API_KEY and ANTHROPIC_API_KEY from the environment secrets, the environment variables, WALDO_EVAL_SOURCE_SHA from git rev-parse HEAD, and WALDO_EVAL_OUT under runner.temp.
  6. Upload the artifact nightly-eval-<source_sha>-<run_id> with retention-days 90, using upload-artifact pinned to a reviewed full SHA at least two weeks old.
  7. Write the rates, ungraded and honeypot table to the job summary.
- Use environment deployment: false if GitHub supports it [inference: check the docs]. Otherwise accept one deployment record per run.
- WALDO_EVAL_ONLY and WALDO_EVAL_EXPORT_DIR are never set.
- The same file lands on main and on beta-mvp. (S; files: .github/workflows/nightly-eval.yml (two PRs: beta-mvp and main); starts when: After S1 and S2, and after the owner approves the CI change. Merge only after the owner creates the environment and settles branch protection.)
- S6. Release tie in the hand-off.
- Add one step to the deploy hand-off recipe in deploy-staging.yml's header comment and the deploy runbook: dispatch nightly-eval at the reviewed 40-character SHA, then commit that run's card under docs/evals/nightly/<sha>.json.
- If no card has source_sha equal to the deployed WALDO_RELEASE, the hand-off says 'no scorecard for this release'. It must not name the nearest night's card. (S; files: .github/workflows/deploy-staging.yml (comment block only), the deploy runbook doc, docs/evals/nightly/ (new directory); starts when: After S5 has had one green manual run.)
- S7. Compaction switch suite (the G7 bar).
- The compaction ADR draft's section 6 long scripted conversation, run with the switch on and off through injected CompactionSettings, selected by WALDO_EVAL_SUITE=compaction.
- Five recall probes and two safety probes. The card reports both counts and the numeric-floor reject rate.
- Its script is covered by the S4 guard.
- The semantic-recall switch (G8) gets the same pattern once its spec names its probes [inference]. (M; files: packages/runtime/evals/nightly/compaction-scenarios.ts (new), trial.ts, config.ts, suite.ts; a new test file; starts when: After S1-S4 and a calibrated judge. The flip also waits on the G37 health ruling.)

**Unblocks.** I could not find the G-numbered register in the repo. The meanings below come from the task and the owner's message [inference].

- **G7, the compaction switch.** COMPACTION.enabled=false (src/conversation/compaction.ts:8). This decision supplies the keys, hosting and calibrated judge, and S7 adds the on/off suite. The flip also needs the G37 health ruling.
- **G8, the semantic-recall switch.** It gets the same on/off bar.
- **G47, persona.** It gives model-graded usefulness and personality rubrics (ENGINEERING_QUALITY.md:46) a calibrated, cross-family judge and a nightly home.
- **G44, release suites.** Every released SHA gets a card dispatched at that exact SHA, or the hand-off says plainly that it has none.

It also closes HARNESS_COMPARISON section 9.2's gap. The model-graded eval is no longer manual or self-judged, and it reports pass^3.

**Verifiers before revision.** PASS_WITH_FIXES (9 findings); PASS_WITH_FIXES (10 findings)

**ADR draft.** `adr-drafts/ADR_DRAFT_NIGHTLY_EVAL_2026-10-14.md`

## G3: Standing grants: acting without asking, within owner-set limits

**Question.** Should Waldo get owner-created standing grants that let one exact kind of effect run without a card? If so, what scope, store, rechecks, run-origin rule and never-list apply, and which class ships first?

**Recommended.** B. Narrow closed-class grants on the owner object, desk-owned, gated by run origin; first class calendar.move_own_block

**Why.** Hypotheses considered:
- (1) A broad grant model pays off fastest (C).
- (2) A global slider is enough (D).
- (3) A narrow first class on the existing desk and ledger seams gives real autonomy with a bounded blast radius (B).
- (4) Grants are not needed yet (A).

Evidence against C and D:
- Both cover sends to other people, which are irreversible. Email "can't be undone" (approvals.ts:598). Moving events with guests emails them.
- The release brief forbids sends, spending, deletes, sharing and health destinations.
- CLAUDE.md:20 requires per-resource, parameter, time and budget scope. A slider has none.

Evidence against A: the Window job (ADR-0019) and Patrol only matter if Waldo can act unattended somewhere. A gives no path there.

Why B:
1. The seams exist. The desk freezes and digests payloads and already reads the event before a move. The ledger already reserves intent and quota in one synchronous transaction (owner-effect-ledger.ts:43-70), so the grant recheck is a sync SQL read inside it, with no external I/O.
2. "Waldo's own block" is provable from the ledger, using an exact create record and the derived id (approvals.ts:771), not a marker other apps could write.
3. The effect sends nothing and can be undone: no attendees, times only, etag-guarded undo. The move schema already refuses description, location and attendees (calendar.ts:23-25).
4. One writer per aggregate holds. The grant module writes grants, the desk writes rows, and the ledger writes intents and counts uses. v0.5 authority_grants stays untouched; it runs only in local run-loop environments anyway (run-loop/do.ts:376-378).
5. It gives ADR-0074 what it asks for before any L3 activation: a contract update (this ADR) and conformance proof (S5).

Verifier findings: accepted.
- Taint (blocking, verifier 1). Confirmed at conversation/tool-loop.ts:208-215: an external-stamped result taints the rest of the turn. query_calendar is external-origin. So the old check 3 ("argument taint is null") would card almost every move, and the claim that "a timer pass is untainted" was wrong. Fix: eligibility now depends on an immutable run-origin field set at turn start, separate from the accumulated toolArgSourceTaint. The ADR now says plainly, in §2.3 and §2.8, that external text read in an eligible run can steer moves inside the bounds, and that ADR-0049's taint is not the control for this class.
- I rejected the "null-taint own-block read" alternative. To decide where a block should move, the model must still read other events (the conflicting meeting), and those are third-party text. Removing taint from one read would hide the steering risk, not remove it.
- ADR-0074 graduation gate. Accepted and named.
- Connectors lane co-ownership. Accepted.
- Tool description and status text. Accepted.
- Stale results consume the cap. Confirmed: they are recorded as done. I chose to count them, which fails closed and needs no ledger change. This is documented and tested.
- Missing desk columns, the undo sites and the LIMIT 5. Confirmed and added to S3.
- Coordinator built only in local environments. Confirmed; this strengthens the case against option 4.
- PR #932 test count corrected.
- No code creates Window blocks. Confirmed; a pre-count step added.
- Production hard-off (blocking, verifier 2). Accepted. Modeled on trace-privacy.ts:62-66.
- authorize applies only to a reserved-to-attempting transition. Accepted. Reconciliation of attempting or unknown records is never blocked.
- Host-built summaries so the model's reason never reaches activity, hops or the grant row. Accepted.
- Free/busy visibility is shown on the card and named as an ADR-0018 amendment. Accepted.
- Exact ownership proof. Accepted. Card-approved moves also write calendar_change records (approvals.ts:775-777).
- Quota keyed by class and connection, so a superseding grant cannot reset the day. Accepted.
- Console revoke behind the console session. Accepted.
- Disclosure copy owner step. Accepted.

Verifier findings: rejected in part.
- Verifier 2 said taint is a per-run stamp that in-run reads never raise. That is wrong (tool-loop.ts:208-215). Its conclusion still holds under the new origin rule: unattended timer runs can be steered. That is now owner decision §5.6.
- Verifier 2 said deletion does not reach the grant store. That is wrong. Owner deletion runs storage.deleteAll() on the owner object (owner-do.ts:919, 1483, 1611), which removes the new table. A regression test is added. No owner data export exists to extend [inference from grep]. The ADR says any future export must include grants.

Main trade-off: B gives the least immediate relief, and it openly accepts bounded steering by external text in place of a card. That is deliberate. The first standing permission should be one whose worst case is a capped, undoable change to the owner's own focus time.

Threshold to proceed: the owner accepts the never-list, the defaults and the §5.6 run-origin choice. S3 tests must show authorize runs inside reserve with no awaited I/O. Confidence: about 70%. The main uncertainty is reach: today no code creates Window blocks, so the class is only worth building alongside a Window-block create path, or if owner-approved attendee-free creates are common.

**Falsifier.** Any one of these makes B the wrong choice.

1. In 20 runs each of the hostile scenarios (an invite whose description tells Waldo to move focus blocks, read in an owner turn, a standing-order fire and a timer pass), any grant-run move lands outside the owner window, inside the minimum lead, or above the daily cap. The bounds are then not enforced at the host.
2. The grant recheck cannot run inside the ledger reserve transactionSync without awaited I/O. Recheck-at-dispatch then fails CLAUDE.md:18, and A should stand until it can.
3. The pre-count of existing attendee-free, non-recurring create records on beta owner objects is near zero, and no Window-block create path is planned. Or, after 30 days of beta, testers trigger fewer than one grant-eligible move a week. The class then reaches too little, and another first class should be chosen (the mechanism may still stand).
4. The app cannot pin the additive contract (the standing_grant kind and the grants routes) before the backend needs to emit. The first release must then stay switch-off.
5. A multi-use grant already exists under another name (harness doc §13). This ADR then becomes a review of that path.
6. The owner rules that external text steering unattended moves is unacceptable even within bounds (§5.6), and owner-authored turns alone carry too little value. B then reduces to A for unattended work.

**Owner steps.**
- **Ansh (owner):** Rule on the ADR. Where: the ADR draft PR (docs/proposals/ADR_DRAFT_STANDING_GRANTS_2026-10-14.md) or a reply on #1103. What: accept option B as drafted, or name changes to §5 items 1-6. These cover:
- the first class, including that moves change free/busy others can see;
- the never-list, including RSVP declines;
- that externally woken runs and replies to others always card;
- the defaults: 30-day expiry (90 max); cap 3 a day (10 max), with stale attempts counting; 30-minute minimum lead; undo until the earlier of the original start and 24 h;
- where grant cards can be approved;
- whether owner timer jobs (standing-order fires, later Patrol) may use the grant even though external text they read can steer moves inside the bounds, or only owner-authored turns.
- **Ansh (owner):** Before building S3, decide whether the class has enough reach. Either authorize a one-off count, on the staging owner objects, of effect-ledger calendar_change create records that are done and have no attendees (counts only, no titles or times), or approve a Window-block create path (S6) as its companion. If the count is near zero and no create path is planned, pick another first class.
- **Ansh (owner):** Publish the accepted ADR in waldo-brain under the next free ADR number. 0084 is the highest in Brain main at 23c4f992; other drafts may claim 0085 first. Mark it as amending ADR-0018/0019 for how L3 is granted, and as the ADR-0074 policy update for per-effect L3 with S5 as its graduation evidence. Then have the backend repin its entrypoints and regenerate docs/foundation/accepted-adrs.json. Until then the ADR is non-authoritative (CLAUDE.md:3).
- **Ansh (owner), with the app lane:** Review the user-facing copy before the staging flip: the grant card (what Waldo may do without asking, that others who see free/busy will see the new time, the limits, the expiry, how to revoke) and the settings grants view. Then approve the app build that pins the S1 contract (the standing_grant approval kind, the optional grant and undo_until fields, the grants list and revoke routes) before any backend deploy that emits them. Where: the app PR that bumps the generated client.
- **Ansh (owner):** Deploy the Worker carrying S3/S4 to staging with the switch off. No migration, wrangler.jsonc, secret or edge change is expected; confirm the deploy diff says so. Then, on the S5 flip PR, read its hostile-scenario, cap and production-hard-off results and approve turning the switch on. The code keeps it off wherever WALDO_ENVIRONMENT is production.
- **Ansh (owner) as tester:** On staging, from the app:
1. Ask Waldo to make focus-block moves standing, read the grant card in full, approve it, and check the grant list.
2. Let a chat-triggered move happen (and a scheduled one, if §5.6 allows), then check the receipt and undo.
3. Revoke in plain words and confirm the next move shows a card.
4. Revoke once from the console page as well.
Record PASS or FAIL per step on #1103.
- **Ansh (owner):** Production stays off. Lifting the production hard-off needs its own owner-approved PR after the guardrail review that also revisits the staging trace exception.

**Backend work.**
- S1 Contracts (additive). New runtime/standing-grant.ts: StandingGrantV1 with a one-value closed class enum, resource, bounds, limits, required expiry, state and created_from. app.v1: approval kind standing_grant with exact.grant; an optional host-built grant summary on appApprovalV1 and an undo_until on done rows; GET /app/v1/grants and POST /app/v1/grants/revoke. Optional grant_ref on the activity input. Tool schemas and ACL rows for propose_standing_grant, list_standing_grants and revoke_standing_grant. A never-list conformance test. Valid and invalid pairs for every field. Regenerate OpenAPI. (M; files: packages/contracts/src/runtime/standing-grant.ts (+test), src/app/parts.ts, src/app/approvals.ts, src/app/grants.ts (new), src/runtime/activity.ts, src/tools/schemas/standing-grants.ts (new), src/tools/permissions.ts, src/index.ts, generated OpenAPI; starts when: When the owner accepts the ADR. Independent of A2 and C7. The app must pin it before S3/S4 emit.)
- S2 Grant module and store. Owner-object table standing_grants, created inline like the desk ledger and standing_orders. Single writer for create (from a desk commit), supersede, revoke, connection-removed and the expiry sweep. A pure evaluate(proposal, liveEvent, ledgerProof, runOrigin, now, ownerZone) returning eligible, or card with a closed reason enum. A sync assertCurrent(grantId, revision, now) for the ledger. The effective switch is resolveStandingGrants(env) = STANDING_GRANTS.enabled && (env.WALDO_ENVIRONMENT ?? 'development') !== 'production', with a test that production stays off when the constant is true. Port #932's invariants and its 19+2 tests by hand (no rebase). Close #932 as superseded when S2 merges. Add a deletion-suite test that storage.deleteAll removes grants. (M; files: packages/runtime/src/channels/standing-grants.ts (new), packages/runtime/test/standing-grants.test.ts (new), the existing owner-deletion test; starts when: After S1 merges. No owner-do.ts, approvals.ts or google.ts hunk, so it can run beside A2 and C7.)
- S3 Desk, ledger and run-origin integration.
- Ledger: an optional authorize callback that runs inside reserve's transactionSync, only when moving from no record or 'reserved' to 'attempting'. A 'reserved' record that fails is updated to 'rejected'. 'attempting' and 'unknown' always go to readback, whatever the grant state.
- Run origin: an immutable runOrigin ctx field ('owner' | 'external'), set in owner-turn.ts from the same inputs as the initial taint (:437, :464). tool-loop.ts must not write it; a test asserts that.
- Desk: the standing_grant kind (approve creates the grant in the same commit). Inline ALTERs for grant_ref, grant_revision and undo_until on the desk ledger. Undo checks at :396, :803 and :1066 use undo_until when present. The pending list at :1033 includes in-window grant rows beyond the newest 5.
- Grant path for calendar_change moves: evaluate; write the row; claim; then effect() with quota (grant_ref = 'calendar.move_own_block:' + connection_ref, local_day = the dispatch instant in the grant zone) and authorize. On failure the proposal falls back to an open card. A stale result counts against the cap.
- Tools: propose_calendar_change gets a grant-aware description and a grant-run status string (applied under the standing permission, its end date, how to undo, no buttons). query_calendar marks own blocks from the ledger.
- Also: activity and grant summaries are built from host fields only. claim-verify treats an applied move as applied. grant_eval and grant_use hops. Adds no channel compares. (L; files: packages/runtime/src/channels/owner-effect-ledger.ts, channels/approvals.ts, channels/owner-turn.ts, tools/live/google.ts, hooks/claim-verify-effects.ts, tool dispatcher ctx type; tests: owner-effect-ledger, approvals, google tools, tool-loop (runOrigin untouched); starts when: After S2. Co-owned with the Connectors lane (approvals.ts and tools/live/google.ts belong to it per PR #1148). Claim the slot on #1103, and order it against that lane's queue and against A6 (one desk), or have the Connectors lane carry it.)
- S4 Owner surfaces. App routes for the grants list and revoke, served by app-api. Revoke and list in the console, behind the existing console owner session and CSRF. Any chat message only links to that authenticated page and carries no capability. Natural-language revoke through revoke_standing_grant on owner-origin turns. One owner-do.ts hunk registering the grant module and its tools. Grants are revoked when the Google connection is removed or re-linked. (M; files: packages/runtime/src/channels/app-api.ts, channels/owner-do.ts (one hunk), channels/console-workspace.ts or console.ts (grants view), Google connection removal path, tests; starts when: After S3, and after the app build pins S1's contract.)
- S5 Scenario and eval wall (ADR-0074 graduation evidence) and the flip PR. Scenario cases:
- golden path with the switch on and off; production hard-off;
- each eligibility check failing on its own, including a card-approved move of an owner event (not own) and a legacy create;
- cap at the edge with two concurrent jobs; supersede then move on the same day; stale attempts counting;
- revoke races: before reserve, after reserve, a 'reserved' record re-entered, an 'unknown' record still settling by readback;
- DST days of 23 h and 25 h; zone change; provider failure;
- hostile invite text read in an owner turn, a standing-order fire and a timer pass (20 runs each); an externally woken run (cards);
- a reason containing synthetic health text, absent from activity, grant summary and hops;
- a C7 interrupted step.
The flip PR sets the constant to true for non-production only, citing the counts. (M; files: packages/runtime/test/scenarios/standing-grants.*.test.ts, src/channels/standing-grants.ts (switch constant); starts when: Tests ride with S3/S4. The flip PR comes after S4 is deployed to staging with the switch off and the owner approves the flip.)
- S6 (out of scope, noted) Patrol executor using the grant: an owner-job executor for the patrol schedule kind, with propose_calendar_change added to the patrol ACL. A Window-block create path (Waldo creating focus blocks) is the companion that gives the class reach. That path is still card-approved creates and needs no grant. (M; files: channels/owner-do.ts executors, contracts/src/tools/permissions.ts, C7 step runner; starts when: After C7 PR 1 and the S5 flip, and only if the owner allows timer-origin runs (§5.6). It needs its own small spec, not an ADR, because it adds no authority.)

**Unblocks.** If accepted:
- G3 gets its first bounded class: acting without asking. Waldo keeps its own blocks clear of new meetings without a tap. This is ADR-0019's Window at real L3. Its reach depends on a Window-block create path (S6 companion).
- Unattended adjustment by standing-order fires, Patrol timer passes and C7 steps, inside the same limits, if the owner allows timer runs (§5.6), and once S6 and C7 land.
- Grant management the owner can see: an app list, revoke in plain words, and a console view behind the console session.
- Offers to make a repeated approval standing, presented as cards.
- The receipt, undo and production hard-off pattern that later classes reuse, plus ADR-0074 graduation evidence for per-effect L3.

Later classes each need their own ADR amendment and ruling: creating own blocks without a card, reminders to named people (the slice-I acceptance case), and invite declines.

It does not unblock the reply watch (G1 email-body ADR), spend caps (G41) or outside users (G38).

**Verifiers before revision.** FAIL (9 findings); PASS_WITH_FIXES (10 findings)

**ADR draft.** `adr-drafts/ADR_DRAFT_STANDING_GRANTS_2026-10-14.md`

## G1: Reply watch on sent threads: bounded email-body processing for approved sends

**Question.** May Waldo read new messages on a thread the owner sent through Waldo and asked it to watch, have the model judge whether each is an answer, an auto-reply or a bounce, keep only the verdict, and tell the owner, and if so, under which bounds?

**Recommended.** Option 2: Bounded body read on approved, watched threads; verdict and owner-facing text only

**Why.** The gap is closure and honesty. After a verified send the follow-up cannot learn the outcome. A reply never reaches it and a bounce goes unnoticed (approvals.ts:694, :698; loops.ts:22-27).

Hypotheses. (H1) Thread-scoped, approval-bound body reads give the model what it needs at the smallest privacy cost. (H2) Headers and snippet are enough (Option 1). (H3) The inbox lane can absorb it (Option 3). H3 fails a requirement: the update lane stores and traces mail detail, and the watch tables must store none. H2 is plausible but unproven, so the eval runs it on the same fixtures and wins if it meets the bar. Option 4 cannot keep ruling 7.

Verifier findings, checked in source:

Accepted (verifier 1):
- Double deadline notice. Confirmed: the heartbeat notifies past-due open loops without a mail source (heartbeat.ts:95-101). The watch loop has none, so a separate notice at `until` would duplicate it. Fix: the heartbeat's past-due notice is the deadline nudge; the watch sends no deadline notice of its own.
- Responsibilities exists. Confirmed (responsibilities.ts:8-13, 93-107; test-only callers). The loop is the interim anchor. adoptLoops keeps ids, so the watch's anchor id carries over unchanged.
- Two done paths. Confirmed at :694 and :697-699. The email branch ends at :709. One helper opens the watch on both.
- Cap timing. Accepted: open await_reply proposals count at proposal time; the open at done always succeeds (soft cap).
- Artifact relay. Confirmed that read_thread relays when wired (tools/live/google.ts:141-147). The background path passes no relay: codes are dropped and the input notes one was present.
- waiting_for in the ledger. Confirmed that the ledger is outside forget (claims.ts:104-110). The ledger already holds the full outgoing email to the same correspondent, so the added exposure is small. It is still named in section 8 for the owner to accept.
- Lane overlap. pr/1113 touches owner-do.ts (observed, 4 lines). The A2 and A6 lane assignments are from the coordination thread and not in repo docs at this SHA [inference]. S2 goes first; S1 and S3 wait or coordinate.
- Nits accepted: the edge allowlist is derived from GOOGLE_METHODS, and the mail-scope check is new ground. threadPage cannot be reused because it reads every body and returns no labelIds. The flag runs everywhere except production ('0'). #1185 merged at 17:34Z on 14 Oct, after e5c022ef; its keys and schedule still wait on the owner.

Accepted (verifier 2):
- `proposal` undefined (blocking). Fixed: there is no free-text proposal. The output carries a `next_step` enum. The runner never writes the ledger. Any draft or resend happens in a later owner turn under the normal taint gate and approval.
- Notice storage (blocking). Fixed: the ADR now says the notice is stored, in the final outbox and the transcript. That is the same practice as mail follow-up notices (update-cards.ts:109-110). The notice is schema-bounded: at most 300 characters, and no URLs, email addresses or phone numbers. A real-model canary check joins the eval, and the owner decides on this storage in section 8. The verifier's 'tag transcript rows with source_taint' is not possible as stated, because the transcript has no per-row taint field (grep). That fix needs its own contract and is left out.
- Auto-close. Switched to propose-close. This keeps 'mail-derived completion is unknown' (contracts loops.ts:5) and the Evidence/Acceptance split.
- Silence contradiction. Fixed. The handler gates await_reply deterministically. The `answered`, `bounce` and watch-ended notices count as owner-requested, because the owner approved the watch. Quiet hours defer them; low volume does not hold them. If follow-ups are turned off mid-watch, the watch ends and the owner is told once.
- Forget by correspondent. Confirmed that forget writes loops directly (claims.ts:697-704). Fixed with a book method, endForForget, that matches the watch's ledger recipients, subject and waiting_for. The runner also ends any watch whose anchor is no longer open.
- Health in the tainted path. The subject is dropped from the input. The waiting_for description tells the model to write it neutrally, and a test checks this.
- Phishing. The schema ban plus hostile fixtures cover it.
- Egress. Named: the OpenAI Responses path sends store:false (llm/openai.ts:70). The owner confirms that the DPA and the tester disclosure cover background processing. A Scribe halt counts as an attempt.
- Eval size. Per-class minimums, 3 runs, worst run reported.
- failed_recipients is now a field, validated as a subset of the ledger's to/cc. A C7 resume rechecks the grant, the account and the switches, and it is never authority to send.
- Nit accepted: setStatus is a bare exec (cited at 313-314, not 314-315). Each wake re-resolves the mail client and checks the account, as approvals.ts:600-601 does. Pruning runs in the sweep.

Rejected: none outright. One partial: the transcript taint tag (see above).

Why Option 2 stays: verifier 2's better option is a refinement of Option 2, not a different option, and it is adopted in full.

Main trade-off: a background reader of third-party text, against a promise Option 4 cannot keep. Retention in the watch tables is ids and enums only. The one stored text is Waldo's bounded notice.

**Falsifier.** Any one of these makes Option 2 the wrong choice:
(a) On the same fixtures and the same three runs, the headers-and-snippet variant also meets the eval bar in its worst run. Then full-body reads are unjustified; switch to Option 1.
(b) In staging, testers report that more than about 1 in 10 replies to watched sends arrived on a different Gmail thread and were missed. Then the thread is the wrong unit, and a sender-scoped search needs its own review.
(c) Any eval run gives 'answered' on an auto-reply, delivery report or injection probe. Then the 'answered' notice must drop its close prompt and report only that a reply came.
(d) After a judged reply carrying a canary in body, subject and sender, a storage scan finds the canary in any watch table, KV key other than an outbox notice, or trace sink. Then the build does not meet this ADR and must not flip.
(e) In the real-model eval, any notice repeats the body canary, a URL, an address or the injected request as a Waldo instruction. Then notices become fixed templates rendered from enums and ledger fields only.
(f) Google's Limited Use review rejects this use of gmail.readonly when the app is published.

**Owner steps.**
- **Ansh/owner:** Decide G1. Approve Option 2 and the section 8 choices in the ADR draft, or amend them. The choices are: the 30-day window and the 8,000-character body cap; metadata-only traces for this purpose in staging too; propose-close on 'answered'; the bounded notice text stored in the outbox and transcript; watch notices counted as owner-requested (not held by low volume); and waiting_for kept in the approval ledger, which forget does not cover. Reply on #1103 or on the ADR draft PR. Nothing in S1-S3 starts before this.
- **Ansh/owner:** Before the flip, confirm that the model provider DPA on file and the beta-tester disclosure cover background processing of correspondents' replies to watched sends. Record the answer on the flip PR. No secret or config change.
- **Owner:** After the S2 PR merges, deploy the connector-proxy Edge Function to the staging Supabase project from the merged SHA (Supabase CLI `functions deploy connector-proxy`, or the dashboard). Do this before any Worker deploy that calls threadHeads or messageText.
- **Owner:** After S3 merges, hand-deploy the Worker to staging from the merged tip. The switch is still off, so testers see no change. Post the staging deploy's version id in the hand-off thread.
- **Owner:** Make the nightly eval keys and schedule from #1185 available (merged 14 Oct 17:34Z, after e5c022ef). S4's real-model eval needs them. Then approve or reject the flip PR on its reported worst-run counts and canary results, and hand-deploy staging.
- **Owner:** Optional check: in the Google Cloud console of the OAuth app's project, under Pub/Sub, confirm that the Gmail push topic and push subscription from #1215 are active. If they are not, the watch still works on the 10-minute sweep.
- **Owner (later: production and outside users):** Only after beta evidence: set MAIL_SOURCE_FOLLOWUPS to "1" in the production vars of packages/runtime/wrangler.jsonc and deploy. Before Google verification for outside users, add one line to the privacy policy (publish checklist in GOOGLE_WORKSPACE_PLAN.md on pr/1148): Waldo reads replies only on threads the user sent through Waldo and asked it to watch, and keeps only a verdict and its own short note to the user.

**Backend work.**
- S2 Gmail reads (first, no lane conflict): add threadHeads(threadId) using threads.get format=metadata with a fixed header list, returning ids, labelIds, internalDate and those headers only, and messageText(messageId) using messages.get format=full, capped at 8,000 characters with a truncated flag, with no attachments. Add both to GOOGLE_METHODS (the edge allowlist follows by import) and keep the parity test. Add mail-scope checks at the edge for the two new reads. threadPage is not reused because it reads every body and returns no labelIds. (S; files: packages/runtime/src/connectors/google.ts; supabase/functions/connector-proxy/index.ts (scope checks beside :201-206); connector and edge parity tests; starts when: Owner approves G1. The edge deploy (owner) must precede any Worker that calls the methods.)
- S1 Contract and desk. In contracts: send_email gains optional await_reply { until (1-30 days), waiting_for (max 200 chars, described as neutral with no health values) }, with sendEmailArgsSchema split from draftEmailArgsSchema. Add the verdict schema (verdict enum; failed_recipients only with bounce; notice max 300 chars, no URL/email/phone, required on answered and bounce; next_step enum). In the send_email handler: drop await_reply with a typed note to the model unless REPLY_WATCH.enabled, MAIL_SOURCE_FOLLOWUPS is not '0', the owner's followups are on, the mail grant is present, and active watches plus open await_reply proposals are under 25. In the desk: EmailSendProposal carries await_reply, emailContent includes it, reviewEmail adds the watch line, and one helper opens the watch and the loop (due = until) in the same synchronous write block as setStatus(id,'done') on both done paths (:694 and :697-699). Add the reply-watch book (tables, open, supersede). Valid and invalid schema tests. (M; files: packages/contracts/src/tools/schemas/writes.ts; packages/contracts/src/runtime/reply-watch.ts (new) and contract tests; packages/runtime/src/tools/live/google.ts (handler gate, description); packages/runtime/src/channels/approvals.ts; packages/runtime/src/channels/reply-watch.ts (new book); starts when: After G1 approval. Register files on #116. The approvals.ts change waits for the one-desk (A6) lane or is coordinated with it [inference: lane ownership from the coordination thread].)
- S3 Runner. In updateCheck after collectChanges: prune ended rows; pick up to 10 due watches; per watch, re-resolve the mail client and check the account (fail closed); end the watch if its anchor is not open; read heads; record owner SENT messages without reads; fetch up to 3 new non-owner bodies, quarantine artifacts with no relay; run one call (purpose 'reply_watch', metadata-only, response_format verdict schema, no tools, no memory or health, no subject); CAS-write verdicts by fingerprint. Render notices with failed recipients from the ledger and send them through the final outbox with a replyWatch receipt (owner-requested for answered, bounce and ended; held under retainedRecallAvailable; quiet hours defer). collectChanges skips messages in actively watched threads. Hooks: disconnect ends watches; forget calls endForForget; follow-ups off ends the watch with one notice. Code switch REPLY_WATCH.enabled=false. A 'reply_watch' hop with counts and enums only. (L; files: packages/runtime/src/channels/reply-watch.ts; packages/runtime/src/prompt/reply-watch.ts (new); packages/runtime/src/channels/owner-do.ts (updateCheck ~3239-3297, disconnect ~2388-2397, outbox route ~1780-1794); packages/runtime/src/channels/update-cards.ts; packages/runtime/src/memory/claims.ts (forget hook near 697-704); packages/runtime/src/channels/telegram-final-outbox.ts (replyWatch receipt, redaction near 273); packages/runtime/src/channels/owner-turn.ts:255 (metadataOnly purpose); workers-pool tests; starts when: After S1 and S2 merge. owner-do.ts wiring waits for the runtime-factory (A2) lane and pr/1113, or is coordinated with them.)
- S4 Eval and flip. At least 50 synthetic messages, with these minimums per class: 10 delivery reports (hard and delayed), 10 auto-replies (with and without Auto-Submitted), 10 true answers, 6 'will get back to you', and 8 injection or phishing probes (including a fake bank or security notice and a click-to-confirm message). Also a CC'd person's reply and a reply in another language. Every body carries a unique canary token. Run the full-body and headers-plus-snippet variants 3 times each on a real model and report each variant's worst run. The flip PR reports both variants' counts and the canary results. (M; files: packages/runtime/evals/ (new reply-watch fixtures and scorer); packages/runtime/src/channels/reply-watch.ts (switch flip); starts when: After S3 merges and the owner makes the #1185 nightly eval keys available.)
- S5 Responsibilities and C7 link. When responsibilities becomes the live aggregate, the reply-watch book reads its anchor status there (adoptLoops keeps ids). Status is 'waiting' while watching, and the owner's close uses closed_by_evidence 'reply_watch:<id>:<fingerprint>'. A C7 step that proposes a send with await_reply blocks with waiting_on 'reply_watch:<id>'. A terminal watch state calls unblock with the verdict enum only. Before any dispatch, the resume rechecks the grant, the account and the switches. (S; files: packages/runtime/src/channels/responsibilities.ts; packages/runtime/src/channels/tasks/step-runner.ts (C7, not yet built); packages/runtime/src/channels/reply-watch.ts; starts when: After C7's wait-on-event PR lands.)

**Unblocks.** The reply-watch parts of owner ruling 7:
- a reply to an approved send reaches its follow-up as evidence, and the owner closes it with one answer;
- bounces and auto-replies are told apart and reported, naming the failed recipients from the owner's own ledger;
- a missed deadline gives exactly one nudge, through the existing heartbeat.

It also gives the responsibilities book and C7 durable tasks a wait-on-reply event (waiting_on 'reply_watch:<id>', closed_by_evidence 'reply_watch:<id>:<fingerprint>'), and gives the Google publish checklist a concrete Limited Use statement.

S2 can start as soon as the owner approves. S1 and S3 then wait for, or coordinate with, the lanes holding approvals.ts and owner-do.ts. The flip in S4 also needs the #1185 eval keys and the owner's DPA and disclosure confirmation.

**Verifiers before revision.** PASS_WITH_FIXES (10 findings); PASS_WITH_FIXES (11 findings)

**ADR draft.** `adr-drafts/ADR_DRAFT_REPLY_WATCH_EMAIL_BODY_2026-10-14.md`

## G41: Model spend: a per-owner monthly ledger and a $25 ceiling (split from #1113)

**Question.** Should per-owner model spend go into a durable owner-DO ledger with a per-environment monthly ceiling, enforced at the one owner-DO model-call chokepoint, and should that land separately from #1113's guard changes? Near the cap, background prompts would carry a budget note. At the cap, background model calls would be skipped (fail closed), with exact exceptions and one notice. Chats would never be refused or downgraded.

**Recommended.** B. Split: ledger now, monthly ceiling at the one model-call chokepoint under an ADR, guards decided separately

**Why.** **Merge #1113 in halves.**
- The ledger half is small and the right shape: one writer, a DO table created at start, no text, already EXEMPT.
- The guard half changes what blocks every future merge. On today's tip it weakens the A0 ratchet and removes the only OpenAPI freshness check. That is a separate decision.

**Ledger in owner-DO SQLite, not Supabase.** Spend is per owner, and the enforcement point is in the owner DO. ADR-0051 already keeps per-user enforcement DO-only. Langfuse gives the fleet view without text.

**Classify at the call, not from the log.** The cost kind is decided inside owner-turn.ts `complete` from the responder's own owner-turn state, not from the pruned trace log and not from a DO-wide field. A DO can run an owner turn while a job is awaiting [inference: interleaving not tested here], so `OwnerDO.ownerJob` alone could tag a chat as background. The `trigger` column becomes a closed value: the OwnerJob kind, or `owner_turn`. That closes the free-text hop hole and lets the console show spend by job.

**Enforce at one chokepoint (switched from a per-job list, after verifier 2).**
- Every owner-DO model call passes `complete` (owner-turn.ts:198). At 100%, a non-turn call throws a typed `SpendCeilingReached` before the gateway call, unless its job is an exception. Unknown or missing job kind fails closed.
- `OwnerDO.asOwnerJob` (owner-do.ts:689) catches that type, logs one `spend_ceiling_skip` hop holding only the job kind, and returns normally. The scheduler then counts the occurrence as done. No attempts, no quarantine, no paused-job notice, and a recurring entry advances instead of bursting at rollover.
- Exceptions are exact: `device_followup` runs (owner-requested result). `reminder` delivers the owner's note without the model (fire() catches the typed error and uses the note). `standing_order` is an owner question; the default proposed is that it runs, because it is owner-set under a standing grant (standing-orders.ts:11-14).
- The boot memory migration is a deferral: `pendingCoreFiles` stays pending (owner-do.ts:2826) and it runs after rollover. migrateCoreFiles' catch must rethrow the typed error so it is not logged as a failure.

**Below 80%:** nothing changes. **From 80%:** background job prompts get one line on the budget state; the model decides what still matters. No model switch; effort is already 'low'. This is a prompt change, so the run-eval gate applies.

**Owner turns are never refused, degraded or switched.** Interactive spend therefore has no hard stop. The guards left are the abuse circuit-breaker (owner-turn.ts:230) and per-turn tool-loop step limits (for example subagent.ts:110). So a provider-side project limit becomes a required owner step before outside users, not optional.

**One notice per owner per UTC month, with no silent loss.** When a skip happens and no marker exists for the month, the notice is enqueued with `enqueueFenced`. The marker is written in the same local transaction as the outbox row (pattern at owner-do.ts:1908). Intent-before-I/O holds, because the external send happens later from the outbox. A crash before that transaction leaves neither, and the next skip or scheduled pass tries again. During quiet hours the enqueue waits for a later pass. It does not reuse `scheduleNotice`, which drops a notice when no failure pause holds (owner-do.ts:1786). The resume date is the UTC month boundary rendered in the owner's timezone.

**The ceiling value** is one env var per deployment, `WALDO_MODEL_SPEND_CEILING_USD`. Unset means no ceiling (dev, previews). Because it fails open (cost-ledger.ts:74-78), the console and /healthz warn when WALDO_ENVIRONMENT is staging or production and the value is missing or invalid. The owner checks the production console after deploy.

**Why an ADR.** It departs from accepted ADR-0051 on five points: (1) the window, user-local day to UTC month; (2) the action at the cap, degrade every call to skip background only; (3) UX, silent to one notice; (4) the metering store, run journal (ADR-0054) to owner-DO cost_ledger; (5) scope, model+voice to model only, pending the owner. It keeps 0051's check-before-each-call, its DO-only enforcement and its separate abuse breaker.

**Verifier findings I rejected or narrowed (re-checked in source):**
- 'Four of ten schedule kinds are uncovered' is wrong for the owner DO. Only six kinds have executors (owner-do.ts:1827), and OwnerJob is a closed enum of seven (invocation.ts:68-69). journal, handoff, pre_brief_sweep and patrol have no owner-DO executor. The Gmail push only pulls forward the scheduled sweep (owner-do.ts:1281-1289), which runs under `pre_activity_spot`. The chokepoint design is still better, because it is complete by construction.
- 'Volume low or computeAdmission can drop the notice' is wrong for a plain outbox record. Those gates apply to mail follow-ups and calendar prep (owner-do.ts:1794, :3200-3206). The real risks were quiet hours and the `scheduleNotice` coupling; both are handled above.
- The wrangler rate limiter is `RESPONSIBILITY_RATE_LIMITER` (wrangler.jsonc:40-44). It is not shown to gate owner turns, so it is not listed as an interactive guard.

**Lane overlap.** Slice 3 edits owner-do.ts job and delivery code that Workstream A (A2 runtime factory, A4 deliver seam) is reshaping [inference on current ownership; #116 not read]. Register files on #116 first, and send the notice through whatever deliver seam has landed by then.

**Expected spend [inference].** At the current price table, a 12k-in/800-out call costs about $0.0016, so $25 is roughly 15,000 calls a month. In alpha the ceiling is mainly a runaway backstop.

**Process.** This revision made no repository writes and no fetches; unmerged PR files were read with `git show pr/NNNN:` or gh api. The earlier draft's fetch of refs/remotes/pr/915 was already reverted. Vendor docs (OpenAI, Cloudflare) were blocked by the egress proxy, so vendor limits are left for the owner to check.

**Falsifier.** Option B is the wrong choice if any of these turn out true:
1. **The ledger disagrees with the bill.** Over the first two alpha weeks, summed owner-DO ledgers differ from the OpenAI project's billed usage for the same UTC days by more than 10%. The DO ledger is then not a sound basis; reconcile against provider usage (option D or a provider budget).
2. **The owner wants a hard stop.** The owner rules that $25 stops chats too. 'Interactive never refused' is then wrong.
3. **The cap loses owner-requested work.** An end-to-end test shows a reminder, a device result, or (if the owner rules they run) a standing-order run lost at the cap. The exception list is then wrong.
4. **The chokepoint misclassifies.** A test shows an owner turn's call tagged background (and so skipped at the cap), or a background call tagged turn. Classifying per call is then not sound.
5. **The 80% note has no effect.** Across alpha owners, background spend in the 80-100% band does not fall versus the 50-80% band. A mechanical cut is then needed instead.

**Owner steps.**
- **Ansh (owner):** On GitHub PR #1113, rule 'split'. The ledger half lands as its own PR (slice 1). The guard half (five blocking guards, freshness deletions) becomes a separate decision, rebased on the tip. It must say what happens to guard-surface-neutral-core (A0) and guard-openapi-fresh. Tell the lead session, or comment on #1113.
- **Ansh (owner):** Approve or amend the ADR draft's policy. Points to rule on: (a) the window is the UTC calendar month; (b) at 80%, background prompts get a budget note and the model decides, with no model switch; (c) at 100%, every background model call stops unless it is an exception; device results run; reminders still arrive with your own words; one notice per month; (d) standing orders at 100%: run (proposed, since you set them) or pause and say so in the notice; (e) the boot memory migration waits until next month at the cap (proposed) or is exempt; (f) chats are never refused or downgraded by this ceiling. Scope: accepted ADR-0051 counted model and voice spend. Does $25 cover model calls only (proposed), or browser and voice too? Do team and admin accounts get the same ceiling?
- **Ansh (owner):** Merge the slice 1 PR when it is green and reviewed. It adds a table in owner-DO SQLite only, so there is no hosted migration to apply.
- **Ansh (owner):** After the slice 3 PR merges, edit packages/runtime/wrangler.jsonc. Add "WALDO_MODEL_SPEND_CEILING_USD": "25" inside env.staging.vars and inside the top-level vars (production). Leave the previews block without it. Vars are not inherited between environments, so each block needs its own entry.
- **Ansh (owner):** Deploy staging from the Mac by the usual path, then check /healthz shows no ceiling warning. Open the staging console Usage page and confirm it shows this month by kind and the $25.00 limit. Under normal use, no spend_ceiling_skip hop should appear. When production next deploys, open the production console Usage page and confirm the $25.00 limit appears and /healthz shows no ceiling warning. A missing or mistyped value means no ceiling at all.
- **Ansh (owner):** Required before outside users: on the OpenAI project that holds the production key, set a monthly budget limit (a hard stop if the dashboard offers one; otherwise an alert) at about cohort size × $25 plus headroom. Check what the dashboard offers today; it was not verified here. This is the only cap on chat spend, which this ceiling never stops.
- **Ansh (owner), or a session he names:** Publish the ADR in Waldo Brain under the next free number after 0084 and any reserved drafts. Then regenerate docs/foundation/accepted-adrs.json in waldo-backend. Until then the draft is not authoritative and slice 3 does not merge.

**Backend work.**
- 1. Ledger-only PR split out of #1113, rebased on the tip. No guard files, no '/usage' change. Kind and trigger decided at the model call. (S; files: packages/runtime/src/llm/cost-ledger.ts (CREATE ... IF NOT EXISTS, ensureCostLedger, prune rows older than 13 months once per UTC day); packages/runtime/src/channels/owner-do.ts:2138 (ensureCostLedger, then traceBook(sql, undefined, costLedger(sql))); packages/runtime/src/channels/owner-turn.ts `complete` :198-262 (set cost_kind from the responder's own owner-turn state; set trigger to the OwnerJob kind or 'owner_turn'; the job kind reaches the job responder through the job host at asOwnerJob ~:658-674); packages/runtime/src/channels/harness.ts:86-90 (use the call's kind and trigger, drop the log lookup); tests: rewrite #1113's owner-cost-ledger.test.ts to log a real turn and a job and assert one 'turn' and one 'background' row; turn tagged correctly after the 500-row prune; background tagged correctly with and without a job host (owner-turn.ts:798-811 fallback); a thread-title call after a turn (owner-turn.ts:849, ownerTurnActive resets at :694) is 'turn'; trigger values come only from the closed set; failed calls are not ledgered; starts when: Ansh rules 'split' on #1113 (owner step 1). Merge is Ansh's (new owner-DO table).)
- 2. Month view without commands: console Usage shows this month by kind and by job, plus the ceiling or 'no ceiling set'; a read-only spend tool lets the model answer 'what have you cost me this month'. (M; files: packages/runtime/src/channels/console.ts:172, :317-321, :538; packages/runtime/src/channels/owner-do.ts:3374 (view data from ledger.monthByKind/monthTotal); packages/contracts tool schema + TOOL_PERMISSIONS entry (packages/contracts/src/tools/permissions.ts:112) + valid/invalid schema tests; new packages/runtime/src/channels/spend-tool.ts registered at owner-do.ts:2751 and resolved per turn as read-only. Does not extend parseHarnessCommand (harness.ts:29).; starts when: After slice 1 merges. Announce the contract tool on the board first.)
- 3. Ceiling enforcement per the ADR: env ceiling; posture from the ledger; typed SpendCeilingReached thrown in owner-turn.ts `complete` for non-turn calls at 100% unless the job is an exception (fail closed on unknown kind); OwnerDO.asOwnerJob converts it to a spend_ceiling_skip hop and a normal return; reminder delivers the note; boot migration defers; 80% budget note in background job prompts; one notice per UTC month via enqueueFenced with the marker in the same transaction, held through quiet hours; staging/production warning when the ceiling is missing or invalid. (M; files: packages/runtime/src/channels/telegram-webhook.ts:6 (optional WALDO_MODEL_SPEND_CEILING_USD); packages/runtime/src/channels/owner-turn.ts :198-230 (check before the gateway call), ~:803-811 (budget note); packages/runtime/src/channels/owner-do.ts :689-693 (catch, skip hop, notice), :2877-2922 (reminder at cap), :2825-2835 (migrateCoreFiles rethrows the typed error), the notice through the deliver seam current at the time; /healthz and console warning; packages/runtime/src/llm/cost-ledger.ts (exception set, notice text replacing costNotice wording); deploy-var docs. Tests: 79.9/80/100%; every OwnerJob kind at 100% (skip vs run vs note); an owner turn at 150% on each surface; the boot migration at the cap stays pending and runs after rollover; a recurring entry after a skipped occurrence has attempts 0, no quarantine, no paused-job notice, no burst at rollover; notice exactly once across two alarm passes, a crash between skip and enqueue, and a restart; a notice during quiet hours arrives after they end; resume date in a non-UTC owner timezone; month rollover; unset and invalid ceiling; ledger and skip hop carry no owner text; the run-eval gate for the prompt change (or its absence recorded).; starts when: After Ansh approves the ADR policy points (owner step 2), slice 1 is merged, and the files and writer are registered on #116 against Workstream A.)
- 4. Additive app contract: an optional spend block (month total, ceiling, posture) on the app account view, for APP_CHAT_PLAN A16. (S; files: packages/contracts (app account schema, regenerated OpenAPI, sha256 sentinel); packages/runtime/src/channels/app-api.ts; contract tests; starts when: After slice 3, when the app lane asks; announced on the board before the PR, per the additive-contract protocol.)

**Unblocks.** - **Monthly spend per owner.** The ledger becomes a durable source, by kind and by job.
- **Outside users.** Ruling 18's $25 ceiling is the precondition: "build it before outside users" (GAP_ANALYSIS_HANDOFF_2026-10-11.md:16). The provider-project limit (owner step 6) covers chat spend.
- **App usage view.** APP_CHAT_PLAN A16 (docs/planning/lanes-2026-10-11/APP_CHAT_PLAN.md:286) and the "spend field on the account view" in #1103's protocol.
- **#915 slice L.** This closes it.
- **#1113.** It leaves the hold list: its ledger half lands, and its guard half becomes its own decision.
- **Telegram commands.** The Mac lane's slice (vi) can drop `/usage` without losing the month view.

**Verifiers before revision.** PASS_WITH_FIXES (8 findings); PASS_WITH_FIXES (10 findings)

**ADR draft.** `adr-drafts/ADR_DRAFT_MODEL_SPEND_CEILING_2026-10-14.md`

## G38: Google OAuth verification so users outside the test list can connect

**Question.** How should Waldo get its Google OAuth app verified so people outside the 100-person test list can connect Google: which scopes go to Google, in what order (sensitive first, restricted plus CASA later, or everything at once), and under which Cloud project and client?

**Recommended.** B. Two steps, per-feature consent, production restricted-scope gate

**Why.** Why B:

- **Two feature classes cost very different amounts to verify.** Calendar, availability, calendar lists, tasks and contacts are sensitive or non-sensitive. Every mail feature needs a restricted scope, including sending, because the desk confirms a send by reading Sent and replies read the thread. gmail.metadata is restricted too. Only D avoids CASA, and it removes core value.

- **Separating the classes needs per-feature consent.** With one dialog, every new user meets restricted scopes and spends the lifetime cap. The plumbing is half built: the feature reaches connectUrl and is dropped (owner-do.ts:2415).

- **Per-feature consent alone is not enough.** Accepted from verifier 2. connectUrl mints a link for any feature, and the model decides when a feature is needed. Without a gate, production would offer mail to outside users before CASA. Each grant spends the cap for good and starts Gmail-body processing before the email-body review CLAUDE.md requires. A deterministic, owner-set gate on the production client is a hard boundary, not a judgment rule. It also removes the earlier main risk: production never requests restricted scopes before step 2, so the step-1 submission matches the client's real requests.

- **Trim now, under any option.** Accepted from verifier 1. The phone scope and the Docs, Sheets and Slides scopes serve no live feature. Dropping them helps every option. Removing the phone scope from the dialog is not enough: include_granted_scopes returns old grants' scopes, so exchangeGoogleCode would keep calling People for legacy grants (google.ts:174). The People call goes. Stored phones are purged once, because a grant without a profile leaves the old one (owner-do.ts:2337-2341). Accepted from verifier 2.

- **Mail must be split before any mail scope changes.** Accepted from both verifiers. googleHas('mail') needs all three Gmail scopes by name (google.ts:13, :35). Dropping compose or using modify without a split breaks mail on every new grant, across tools, push and the edge. G38-3 is M, not S.

- **Reconnect keeps what the account had.** Accepted. The reauth notice mints connectUrl('calendar') (owner-do.ts:2300). With bundles, that would silently drop mail. Reconnect asks for the bundles the account held, filtered by the gate.

- **Limited Use covers staging too.** Accepted from verifier 2, with one part rejected. Staging capture is environment-wide (trace-privacy.ts:63-66; wrangler.jsonc:87). So every staging Google tester's content can reach the trace store, where humans read it. Fix: an explicit written tester agreement before anyone joins the staging test list, separate from the health line. [inference] Limited Use speaks of agreement to view specific messages; legal review must confirm that a blanket tester agreement is enough. If not, G38-9 redacts Google-sourced text from staging traces. Rejected: a test that capture is off "whenever the production client ID is configured". The Worker cannot tell which client is production. The existing gate already forces capture off for WALDO_ENVIRONMENT production, and the production client is installed only there.

- **Step 2 waits for an email-body ADR.** Accepted from verifier 2. This ADR does not bound where Gmail-derived content lives, for how long, or what disconnect purges. disconnect() removes only the account and profile (owner-do.ts:2388-2396). A separate bounded ADR plus G38-6 (inventory and purge) must land first. Mail reaches LLMs in background triage, push and follow-ups too, not only in replies. The privacy text says so.

- **Separate production project and client.** The production client carries the Limited Use commitments. [inference] Today's OAuth app sits in the dev-named project (google-push.ts:94-96). The owner confirms which project and client each environment uses. A grant minted on another client fails refresh as 'configuration', not 'auth' (google.ts:107), so it would fail silently. G38-7 handles that if production already holds such grants.

- **Gmail push.** Accepted from verifier 1. The real callers are event-ingress.ts:141 and owner-do.ts:3162. Step 2 also needs the waldo-gmail-push service account (google-push.ts:103) in the production project.

- **Timing.** Accepted from verifier 1. G38-1 and the owner's long-lead work (domain, pages, project, client) are useful under every option and can start now. G38-2 brings no user value until the owner lifts the publishing ruling, so it waits for that word.

Rejected or corrected from my earlier packet: prompt is 'consent select_account', not 'consent'; profile write is owner-do.ts:2331-2342, not :2340; the 7-day source is the OAuth2 page, not a Health API page.

Unverified: Google pages were not fetchable from this session; Google facts come from search extracts. The class of calendar.events.freebusy, calendar.calendarlist.readonly, tasks and the contacts scopes is [inference: sensitive or non-sensitive]; the owner confirms on the Data Access page. No tests were run; this is source inspection only.

**Falsifier.** Switch to Option A (one submission after the working agent) if any of these turns out true:

- Google refuses or stalls a step-1 submission for the base set, for example because it wants the whole product's scopes reviewed together.
- Beta data shows outside users do not connect Google without mail, for example more than about 80% of first connects add mail at once [inference threshold]. Then step 1 brings in almost no one.
- Google's restricted review including CASA finishes within a couple of weeks of the sensitive review, so the split costs more than it saves.

Re-examine Option D if the CASA tier, cost or annual effort is out of proportion to beta scale, for example Tier 3.

Re-examine the staging plan if legal review says a blanket tester agreement does not meet Limited Use's human-reading exception. Then G38-9 (redact Google-sourced text from staging traces) becomes required before more testers join.

**Owner steps.**
- **Owner (Ansh):** Decide the sub-questions in the ADR section 'Owner decisions' and post the answers on the G38 issue:
(1) Amend the 24 Sep ruling to per-feature consent.
(2) Drop the phone and Docs/Sheets/Slides scopes (G38-1 can start on this alone).
(3) Keep or drop gmail.compose.
(4) gmail.readonly or gmail.modify for step 2.
(5) New company-owned production project, or verify the existing one.
(6) Accept the production restricted-scope gate.
(7) Commission the separate email-body processing ADR.
- **Owner (Ansh):** Confirm the current setup in the consoles, without pasting any value into chat: which Google Cloud project holds the OAuth client(s); whether staging and production use the same client; whether staging and production connector-proxy edges are separate Supabase projects, each with its own GOOGLE_CLIENT_ID and secret; and whether production DOs already hold Google grants (decides G38-7).
- **Owner (Ansh):** Staging tester agreement, now. Before adding anyone to the staging Google test list (Google Auth Platform > Audience > Test users in the staging project), get their explicit written agreement that team members may read their Google content (mail, calendar, contacts) in staging traces. Keep it separate from the beta health-logging line. Have legal confirm it satisfies Limited Use; if not, ask for G38-9. Keep the list opted-in and at most 100.
- **Owner (Ansh):** Create the production Cloud project. console.cloud.google.com > project picker > New project, under the company organization, with company billing. In APIs & Services > Library enable Google Calendar API, Google Tasks API and People API. Enable Gmail API, Google Drive API and Cloud Pub/Sub API only near step 2. Give at least two company accounts Owner or Editor so verification and recertification mail reaches a monitored inbox.
- **Owner (Ansh):** Verify the company domain (heywaldo.in, as PR #1148 names it). Google Search Console > Add property > Domain; add the TXT record at the DNS provider, using an account that is Owner or Editor on the production project.
- **Owner (Ansh):** Give the production Worker a custom domain under heywaldo.in (Cloudflare dashboard or wrangler.jsonc, owner-only), so the redirect URI (origin + /oauth/google/callback) sits on the verified domain. Staging keeps its origin and Testing client.
- **Owner (Ansh):** Publish three public pages on the domain, no login: home, privacy policy, terms. The privacy policy states:
- which Google data Waldo uses (calendar, availability, calendar lists, tasks, contacts; later Gmail and Drive) and the user-facing purpose of each;
- that content goes to named LLM providers to produce replies and to run background triage, follow-ups and push handling for the owner, without asking them to retain it;
- retention, deletion and what disconnect removes, and how to revoke (Waldo disconnect and the Google Account permissions page);
- that no human reads it except under Limited Use exceptions;
- that Workspace data never trains generalized AI/ML models and is never used for ads;
- the Limited Use sentence: "Waldo's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements."
Have it legally reviewed.
- **Owner (Ansh):** Branding and client. Google Auth Platform > Branding (production project): app name Waldo; a company group address as support email; the three page links; authorized domain heywaldo.in. A logo is optional and triggers brand verification. Google Auth Platform > Clients: create a Web client whose only redirect URI is the production origin + /oauth/google/callback. Put its ID and secret only in the production Worker secrets and the production connector-proxy edge secrets. Never in chat, issues or files.
- **Owner (Ansh):** Data Access for step 1 (Google Auth Platform > Data Access): add only openid, email, profile, calendar.events, calendar.events.freebusy, calendar.calendarlist.readonly, tasks, contacts.readonly, contacts.other.readonly. Check the class shown beside each; none should be restricted. Write one justification per scope naming the feature and why a narrower scope will not do.
- **Owner (Ansh):** Gate and deploys. Set the restricted-scope gate var to "1" in the staging env in wrangler.jsonc before G38-2 deploys; leave it absent in production until step 2 passes. Redeploy the connector-proxy edge after G38-1 and after G38-3, since it bundles google.ts.
- **Owner (Ansh):** Record the step-1 video on the production build after G38-1 and G38-2 deploy, with a demo Google account and fictional data. English consent screen, client ID visible in the address bar. Show: read calendar; propose an event change and approve the card; find free time; list calendars; read tasks and approve a task change; search contacts. Upload to YouTube as Unlisted.
- **Owner (Ansh):** When you lift the PR #1148 publishing ruling: Google Auth Platform > Audience, confirm User type External, choose Publish app. Then Verification Center: submit brand plus sensitive-scope verification with the video link and answer reviewer emails. The gate keeps mail off production, so the user cap is not spent on restricted scopes.
- **Owner (Ansh):** Keep staging on its own project in Testing with only agreed testers. Testers still reconnect every 7 days. Do not move staging to Production while staging trace capture is on.
- **Owner (Ansh):** Step 2, only after the email-body ADR is accepted and G38-3 and G38-6 have landed:
- Data Access: add the final restricted set: gmail.readonly or gmail.modify, gmail.send, gmail.compose only if kept, and drive.readonly or drive.file.
- Record a second video covering each mail and Drive feature; submit in Verification Center.
- When Google sends CASA instructions, contract an authorized lab (a new third-party service) and finish the tier Google assigns. Scope: the production Worker, the owner Durable Object, the production connector-proxy edge and the LLM gateway. Staging is out of scope on its own Testing client; note its egress allowlist is "*".
- Keep the Letter of Validation; put the 12-month recertification date in the company calendar.
- For Gmail push in production: create the waldo-gmail-push service account in the production project, create the waldo-gmail-push topic and a push subscription that authenticates as that service account, and grant Gmail's push service account publish rights on the topic. Then set the per-environment project value from G38-5.
- Only then set the restricted-scope gate to "1" in production.
- **Owner (Ansh) or the lead session:** Accept the ADR draft, publish it in Brain under the next free number, and regenerate docs/foundation/accepted-adrs.json. Save the draft at docs/proposals/ADR_DRAFT_GOOGLE_OAUTH_VERIFICATION_2026-10-14.md in a docs PR; this packet did not write it.

**Backend work.**
- G38-1 Trim and purge. Remove user.phonenumbers.read, documents.readonly, spreadsheets.readonly and presentations.readonly from GOOGLE_CONSENT_SCOPES. Remove the People phone call from exchangeGoogleCode outright, because include_granted_scopes returns old grants' scopes. Add a one-time purge in google.migrate() that strips 'phone' from every 'google:profiles' entry. Feature-map entries for docs/sheets/slides stay for legacy grants and the unused MCP entries. Google lane; owner-do.ts edit registered on #116. Owner redeploys the connector-proxy edge, which bundles exchangeGoogleCode. (S; files: packages/runtime/src/connectors/google.ts:89-92, :153-178; packages/runtime/src/channels/owner-do.ts:2331-2361 (migrate, keep); tests: google.test.ts, google-profile.test.ts, owner-do-google-profile.test.ts, connector-proxy-entry.test.ts, mcp-drive-read.test.ts, google-collection-coverage.test.ts, google-contacts.test.ts, plus a purge test (no stored profile has a phone afterwards; a legacy grant holding the phone scope makes no People call); starts when: Now, on the owner's approval of the trim. Needed under every option; no Console action.)
- G38-2 Per-feature consent with a production restricted-scope gate. consentScopes(bundles) builds the scope list: base always; mail and drive bundles on request. googleConsentUrl takes the list; startConsent passes it through. connectUrl stores the feature server-side next to connect_channel:<hash>; beginSession reads it. A ticket with no stored feature or an unknown one is refused and mints nothing; nothing is read from the callback. Gate: a new owner-set var (absent means off) must be "1" before any restricted bundle is requested. While off, connectUrl refuses restricted features and the typed connect intent returns a 'not available yet' reason the model can relay. Reconnect (owner-do.ts:2300) asks for the bundles the failing account held, filtered by the gate, and tells the owner which were left out. Declined incremental consent leaves the existing grant unchanged. legacy begin() uses base. Google lane; owner-do.ts registered on #116. (M; files: packages/runtime/src/connectors/google.ts:92-102; packages/runtime/src/connectors/google-consent.ts:44-53; packages/runtime/src/channels/owner-do.ts:2291-2300, :2409-2436; packages/runtime/src/tools/live/google.ts:475-491; tests: google.test.ts, google-consent.test.ts, google-reconnect.test.ts, app-google-connect.test.ts, s5-default-on-journey.test.ts, plus new consent-bundle and gate tests (gate off: mail connect refused, base connect works; gate on: base plus mail; reconnect of a mail account requests base plus mail; tampered or unknown ticket refused); starts when: The owner accepts the ADR (reversing the 24 Sep ruling) and lifts the PR #1148 publishing ruling. Owner sets the gate var to "1" on staging before this deploys, or staging loses mail connects.)
- G38-3 Split the mail feature, then fix the mail scope set. Redefine 'mail' as read plus send: read is gmail.readonly or gmail.modify (modify accepted as a superset), send is gmail.send. Add a separate draft capability (gmail.compose) that gates only draft_email. Keep state()'s 'mail' flag meaning read and send, so the app contract does not drift. Then, per the owner's decisions, drop gmail.compose from the mail bundle (draft_email offered only when the grant holds compose) and swap gmail.readonly for gmail.modify if archive, label and trash ship. The edge's literal checks at index.ts:205 stay; index.ts:128 follows googleHas. Owner redeploys the connector-proxy edge. (M; files: packages/runtime/src/connectors/google.ts:6, :8-35; packages/runtime/src/tools/live/google.ts:63, :85-91, :217, :257, :312, :373-418, :485; packages/runtime/src/channels/owner-do.ts:1677, :2374, :2386, :3162; packages/runtime/src/connectors/google-reconnect.ts:19-20; supabase/functions/connector-proxy/index.ts:128, :205; skills/bundled-text.ts:8-15 and prompt/messaging-behavior.ts:57, :109 if draft_email changes; tests: a grant without compose passes read and send; a modify-only grant passes read; a legacy readonly+send+compose grant still passes; draft_email absent without compose; edge refuses 'draft' without compose; starts when: Owner decisions 3 and 4. Must land before the step-2 submission.)
- G38-4 Pinned verified-scope list. One exported constant per step listing the scopes submitted to Google, and a test that fails when the production consent set (with the gate at its production default) asks for a scope not on the list. A hard policy check, not a judgment rule. (S; files: packages/runtime/src/connectors/google.ts (one constant); new packages/runtime/test/google-verified-scopes.test.ts; starts when: With G38-2. Updated in the same PR as each submission.)
- G38-5 Gmail push project per environment. Replace the dev-named constant with a config value; event-ingress and the owner DO pass it to gmailPush(). The edge's topic regex (index.ts:125) needs no change. Code is the Google lane's; the var value is the owner's. (S; files: packages/runtime/src/connectors/google-push.ts:94-103; packages/runtime/src/channels/event-ingress.ts:141; packages/runtime/src/channels/owner-do.ts:3162; test: google-push.test.ts; starts when: Before Gmail push runs on production, which is step 2.)
- G38-6 Mail and Drive data inventory and disconnect purge. Inventory every store that can hold Gmail- or Drive-derived content (DO SQLite and KV, memory, follow-up loop book, push state, approvals, traces). On disconnect and on a confirmed revocation (invalid_grant), purge that account's derived content. Test: after disconnect, no mail-derived content for that account is reachable. Feeds the email-body ADR. (M; files: packages/runtime/src/channels/owner-do.ts:2388-2396, :3162, :3251; packages/runtime/src/channels/gmail-push.ts; [inference] further stores found by the inventory; new test; starts when: With the separate email-body ADR. Blocks step 2.)
- G38-7 Client cut-over, conditional. Only if production DOs already hold grants minted on the old client. Record the non-secret client ID on each account in google:accounts at connect. A grant minted on a different client than the current one reports as needs-reconnect ('auth'), not 'configuration' (google.ts:104-109). Test that an old-client grant produces an honest reconnect state, not a silent failure. (M; files: packages/runtime/src/channels/owner-do.ts:2331-2342, :2366-2381; packages/runtime/src/connectors/google.ts:104-109; test: google-token-refresh.test.ts or a new cut-over test; starts when: The owner confirms production currently holds Google grants on the old client. Skip otherwise.)
- G38-8 Docs. Update PR #1148's scope table and 'Publish later' checklist to the two-step order, the gate, the trimmed set and the mail split; link the ADR. (S; files: docs/connectors/GOOGLE_WORKSPACE_PLAN.md:17-28, :154-160, :176-194 (PR #1148 branch); starts when: Now; follows the ADR text.)
- G38-9 Staging trace redaction for Google content, conditional. Keep Google tool results and Google-sourced text out of staging trace text while still capturing other text for opted-in testers. (M; files: packages/runtime/src/observability/trace-privacy.ts; the Google tool result path in packages/runtime/src/tools/live/google.ts; new test; starts when: Only if legal review finds a blanket tester agreement insufficient, or if any staging Google tester is outside the team.)

**Unblocks.** Step 1 lets users outside the test list connect Google for calendar reads, calendar changes through the desk, free-time finding, calendar lists, tasks with task approvals, and contact search, with no unverified warning and no weekly reconnect. The production gate keeps the lifetime 100-user cap and Gmail-body processing safe until step 2. Step 2 (email-body ADR, mail split, data purge, restricted review and CASA) unblocks mail (triage, search, threads, reviewed send with Sent readback, follow-ups, Gmail push) and Drive reads for outside users. The trim and phone purge can land now under any option. The packet also settles PR #1148's 'Publish later' checklist and its scope plan (gmail.modify, drive.file) before any CASA run, and it makes staging's Google testers' trace exposure explicit and agreed.

**Verifiers before revision.** PASS_WITH_FIXES (5 findings); FAIL (9 findings)

**ADR draft.** `adr-drafts/ADR_DRAFT_GOOGLE_OAUTH_VERIFICATION_2026-10-14.md`
