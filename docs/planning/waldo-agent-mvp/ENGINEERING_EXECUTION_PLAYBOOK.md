# Waldo Engineering Execution Playbook

Version 1.2 · 3 October 2026 · Maintainers: Dalda and Core (Instinct)

Build the smallest usable change, verify its real behavior, and improve the loop from observed failures. This playbook records the working direction for Waldo engineering. The process below is reusable; the dated checkpoint is historical evidence, not a permanent statement of readiness. Proposed CI improvements remain proposals until implemented and verified.

## Ownership and build direction

- **Dalda:** Edge, workspace host and Durable Object behavior, memory fixes, signup, migrations, and staging coordination
- **Core / Instinct:** Core runtime, Drive integration, and files dashboard
- **Integration:** Agree one owner per changed file and one owner per cross-component interface before parallel implementation. Record request, response, errors, authorization, currentness, and retry semantics. Resolve ordinary engineering decisions directly
- **Release execution:** Use the existing authorized credentialed executor and reviewed artifacts. A disconnected executor blocks its steps; independent implementation and acceptance preparation can continue

Start with the user outcome and observed problem. Inspect existing code, tests, and relevant mature implementations before adding a custom mechanism. Prefer an established library or typed contract when it fits Waldo's requirements. Explain any necessary difference.

### Product and engineering responsibilities

- **PM:** Define the user outcome, priority, scope, and acceptance threshold
- **SWE:** Own contracts, implementation, deterministic tests, operational recovery, and release evidence
- **AI engineering:** Own context assembly, prompts, tool selection, action budgets, and behavioral evaluations

These are responsibilities, not additional approval layers; the named component owners coordinate them.

## Why build this

Before every feature or new work item, record a short, risk-proportionate decision note. Start with existing evidence and research uncertainties that could change the decision:

- **User job and evidence:** Who needs this, what are they trying to accomplish, and what requests, observations, or failures support the need? Separate evidence from assumptions
- **Pain and timing:** What fails or creates friction today, how often, and why is this necessary now?
- **Value:** Identify the improvement to system or agent capability, reliability, UX, or trust. Treat personality and personalization as product behavior: explain their value for relevance, continuity, communication, or user control
- **Requirements and references:** Research the actual user requirements and verify relevant competitor or mature-harness patterns against current primary sources. Record limitations; do not copy blindly. Competitor adoption is neither proof of value nor a prerequisite for Waldo's distinctive capabilities
- **Smallest useful slice:** Define the smallest end-to-end change and observable acceptance evidence
- **Tradeoffs:** Consider cost, complexity, maintenance, dependencies, privacy, and latency against the expected value
- **Decision:** Build, reuse, defer, or remove. Keep the owner, evidence, reason, expected outcome, and revisit trigger in the lightweight decision ledger

This note adds no mandatory user approval or CI gate. Correctness, security, and bug fixes can proceed from demonstrated failure and risk without a market essay; capture their concrete value and acceptance test briefly.

## The execution loop

### 1 Define one observable outcome

Write the entry point, expected result, important failure case, and acceptance gate. Choose the smallest vertical slice that crosses the necessary boundaries. Do not turn a specific failure into an unbounded architecture project.

For bugs, inspect the actual task trace: input, tool arguments, serving version, boundary crossed, returned result, and user-visible response. Separate a demonstrated cause from a hypothesis. A provider error alone does not establish missing consent or scope.

### 2 Implement and prove the relevant behavior

Reproduce the failure, add a regression assertion, make the targeted fix, and rerun the failing case. Include an entry-point integration or UI check where relevant. A growing collection of keyword exceptions or ad hoc regular expressions is a stop signal: inspect the representation and reuse or establish a typed contract rather than adding another brittle special case.

Use impact-based verification:

- **Low:** Documentation or presentation changes without executable, permission, or schema effects. Check the diff and relevant rendering or links; self-review is sufficient
- **Normal:** Bounded behavior within an existing trust boundary. Run the regression and affected lint, types, build, and integration checks
- **High impact:** Auth, tenant isolation, grants, credentials, retention, migrations, irreversible writes, or deployment control. Add targeted boundary/failure tests, recovery evidence, and one independent review

Choose tests for the changed behavior. Expand scope when shared contracts, dependencies, or evidence justify it. Avoid repeating a whole-system review for an unchanged boundary or routine documentation.

### 3 Bind evidence to the candidate

Record source SHA, dependency/configuration identity, commands, results, environment, and artifact digest. For migrations, include exact SQL identifiers and hashes. Build once and promote the exact reviewed artifact; stop on a digest mismatch.

Reuse evidence while its assumptions remain valid. Changed code, dependencies, generated output, SQL, configuration, or relevant merge context invalidates the affected checks. Machine handoff alone does not invalidate them. Preserve platform-specific checks where the behavior requires that platform.

Required CI must run and report truthfully for the applicable candidate. Never manufacture a green result from skipped checks or relabel an older run. Existing required checks remain in force until an authorized configuration change replaces them. A baseline failure still needs an impact assessment and any required release exception.

### 4 Release through existing approval

Run a reasonable preflight: candidate identity, target, current authorization, required results, recovery plan, and relevant migration state. Then execute the already-approved staging release without repeatedly returning ordinary engineering decisions to the user.

Apply only the exact authorized SQL, in order. Verify ledger and schema postconditions, reconcile partial outcomes before retrying, and distinguish rollback from forward recovery. Serialize conflicting mutations; do not cancel an in-flight migration merely because a newer candidate exists.

Escalate genuine product decisions, new authority, changed consequential scope, unavailable credentialed execution, or unresolved high-impact risk. Credential creation, destructive operations, spending, and other owner-reserved actions retain their applicable approval or handoff requirements.

### 5 Accept each case and stabilize

Track **source prepared**, **tests**, **merged SHA**, **deployed version**, **migration outcome**, and **live behavior** separately. A merge or successful deployment command is not live acceptance.

Run the actual user path against the serving version. Mark each case PASS, FAIL, BLOCKED, or NOT RUN, with evidence and a narrow claim. One blocked provider must not erase an independently verified workspace result. A shared authorization failure can block every dependent case.

For each selected end-to-end case, follow the user request through the actual tool call, effect and authoritative readback, then the response. Add later-turn or recovery checks when the case demands them; every test need not run the full matrix.

Trace failures, repair the responsible boundary, redeploy when authorized, and retest. Record test-data cleanup separately. “Forget” is incomplete while retained topic content remains retrievable. Later-turn readback proves that case; it does not prove eviction/restart durability.

## AI engineering evaluation

Maintain a small representative task set, adding regressions from actual failures:

- Context relevance, missing evidence, conflicting facts, and truncation
- Prompt paraphrases and punctuation; correct tool selection, arguments, and avoiding unnecessary calls
- Memory save, correction, forget, and later-turn retrieval
- Provider errors, partial effects, bounded retries, and recovery

Record model/version, prompt/context configuration, and task inputs. Separate deterministic fixtures, actual-model runs with fake providers, and real-provider end-to-end runs; each proves different behavior. Diagnose model behavior, source/context quality, and provider/infrastructure failure separately; leave unlocalized causes unknown. Use observable requests, tool traces, outputs, and readbacks as evidence.

Set explicit latency, cost, and action budgets before comparison. Measure wall time, tokens, tool calls, retries, and cost or a labeled pricing estimate. Compare outcomes and budget adherence; report repeated-run variability where relevant. Do not invent performance improvements.

## Evaluate mature implementations before reuse

For each candidate pattern:

1. State the concrete problem and required behavior
2. Inspect official upstream documentation and the relevant version, commit, or source file
3. Check functional fit, maintenance, dependencies, and licensing obligations
4. Identify Waldo-specific differences, especially ownership, permissions, state, and recovery
5. Adapt narrowly and prove the behavior with Waldo regression and acceptance cases
6. Record adopt, adapt, defer, or reject, with evidence

Do not copy blindly. Upstream tests or reputation do not prove Waldo's adapted implementation.

## Boundaries that remain mandatory

Simplification removes duplicate process and unnecessary machinery. Auth, tenant ownership, connection currentness, revocation, scope, and signed grants still require enforcement at their actual boundaries.

For the three approved Drive metadata reads, the agreed direction is server-registry validation and signed, non-storing reads. Each call is an independently authorized observation. No exactly-once or stable-result replay guarantee is claimed. Do not silently switch accounts or execution paths. Redact provider errors before logging and test that redaction.

## Checkpoint on 2 October 2026

- **Migrations:** Six migrations applied; 39 migration-history entries and relevant schema conditions verified
- **Workspace:** Live write/list/read passed; a later independent turn read the same file, revision, and exact content without rewriting it. Traces: `tg-904957882` and `tg-904957883`. Eviction recovery remains unproved
- **Memory correction:** The original curly-quote parsing failure was fixed and live retested; the corrected workshop time, **09:10 UTC**, was visible. This is the saved value, not the retest timestamp
- **Forget and cleanup:** Retained-topic cleanup remains partial; do not claim complete deletion
- **Drive:** The signed path reached the provider, which returned `isError`. The v10 diagnostic work is closed, but the underlying provider failure remains unexplained. Successful Drive behavior is unverified
- **Console:** Actual UI acceptance is blocked by Dalda's current access; Core verification remains pending
- **Other open acceptance:** Hosted optional-phone onboarding, second-owner isolation, planning/draft comparisons, reminder delivery, and disposable-file cleanup require their own evidence. No complete parity certification or Meta Muse comparative run is claimed

Earlier records include the five-migration checkpoint and failed pre-fix memory tests. Preserve that chronology; do not reuse their obsolete “pending” states as current status.

## Reusable records

### Decision template

- ID, date, status: proposed / accepted / superseded
- Outcome or observed problem; evidence
- Owner, affected files, and interface owner
- Existing implementation and mature reference inspected
- Decision, alternatives, and reason for any custom behavior
- Authorization and safety boundaries; affected acceptance cases
- Candidate identity; supersedes; next action

### Release template

- Candidate owner, target, source SHA, artifact digest
- Dependency/configuration identity; exact migration IDs and hashes
- Existing authorization; material changes requiring a new decision
- Required CI and targeted test receipts; independent review if applicable
- Preflight, applied migration readback, deployed version
- Recovery plan; per-case live results; cleanup
- Stabilization criterion, remaining blockers, next owner

### Acceptance template

- Case ID and user-visible claim
- Serving version, time, entry point, safe test data
- Expected success and relevant denial/failure behavior
- Actual result, task trace, and readback/UI evidence
- PASS / FAIL / BLOCKED / NOT RUN; limits of the evidence
- Root cause or hypothesis; fix identity; retest result
- Cleanup state; dependency; next owner

## Stop criteria and improvement backlog

Close a case when its stated live gate and relevant failure gate pass, with cleanup verified or an explicit unresolved cleanup item. When deletion is the case outcome, incomplete cleanup keeps that case open. Close a release when its declared stabilization criterion is met and dependent failures are resolved or explicitly excluded from its claims. Stop a dependent action when authority or a critical invariant is missing; continue unaffected work.

**WED-012: Post-stabilization simplification, requested 2 October.** After the usable staging release and current live failures stabilize, compare Waldo's custom mechanisms with mature harnesses. Prioritize brittle parsing, duplicate state/check layers, redundant reviews, and reproducibility gaps. For each change record the reference, concrete fit, code removed, retained Waldo requirements, and before/after acceptance evidence. This is a bounded backlog, not a rewrite or a reason to delay the current release.

Update this playbook from repeated evidence and explicit decisions. A **reference** supplies an implementation pattern. A **benchmark** requires matched tasks, conditions, measurements, and recorded outputs. Studying a mature harness does not establish comparative performance or parity.

## Official reference material

Previously checked in the engineering decision record on 2 October 2026:

- [OpenHands design](https://docs.openhands.dev/sdk/arch/design) and [security](https://docs.openhands.dev/sdk/guides/security): boundaries, state, and risk-based confirmation
- [Hermes contributing guide](https://github.com/NousResearch/hermes-agent/blob/main/CONTRIBUTING.md): reproducible, relevant verification
- [GitHub artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data), [required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), and [concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency): candidate evidence and controlled execution
