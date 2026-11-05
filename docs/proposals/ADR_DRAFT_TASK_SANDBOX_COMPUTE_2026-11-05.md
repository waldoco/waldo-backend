# ADR draft: a per-task Cloudflare Sandbox for the `code` profile's `execute_code`

- **Status:** proposed (draft for review). The ADR number is assigned in waldo-brain at acceptance.
- **Date:** 2026-11-05
- **Reopens:**
  - ADR-0023, "`execute_code` primitive backed by Cloudflare Sandbox SDK". It is accepted, but its design predates the task-worker shape.
  - ADR-0050, "`execute_code` deferred to Phase 3". This draft supersedes ADR-0050's deferral, for the `code` task profile only, once it is accepted.
- **Builds on:**
  - F1 file tools, behind `WALDO_FILE_TOOLS`: every owner upload is kept in the workspace, and `extract_archive` exists.
  - The task workers, `tasks/profiles.ts`.
  - The progress watchdog, behind `WALDO_WATCHDOG`.
  - `execution-environment/port.ts`.
- **Switch:** `WALDO_SANDBOX`. It is "0" in production. Staging turns it on only after the review gate passes. Turning it off is the rollback.

Facts marked **[verified]** were read on developers.cloudflare.com on 2026-11-05; the URL follows each one. Facts marked **[unverified]** were not found on a fetched page and must be checked before acceptance.

## Context

On 5 November the owner asked for Claude- and Codex-style capability: Waldo should do ordinary file and compute jobs instead of refusing them. F1 covers the jobs a Worker can do on its own (keeping files, unpacking zips, reading text). It cannot run code.

- `TASK_PROFILE_SPECS.code` lists only `execute_code`. No handler exists for it on any deploy, so every code task is refused at start with "Code tasks need a sandbox, which this Waldo does not have yet."
- ADR-0023 chose the Cloudflare Sandbox SDK with these settings:
  - Python and JS;
  - a 30 s hard timeout;
  - an empty egress allowlist by default;
  - stdout and stderr sanitised by the Scribe before the model sees them.
- ADR-0050 deferred that work and removed `execute_code` from the V1 permissions.
- Since then, B-1 settled the shape of the system. There is one brain (the per-owner `OwnerDO`). Long or untrusted work runs on short-lived task workers that hold no credentials and call tools through the brain.

What the owner should get: a task like "turn this CSV into a chart" or "run this script on the spreadsheet I sent" runs in an isolated environment. It reads only the files the task names, and writes its results back as workspace files the owner can open. It cannot reach the network, a credential, or the owner's health data.

## Decision (proposed)

### 1. One sandbox per task attempt

The sandbox is created when a `code` task attempt starts and destroyed when the attempt ends. That covers finishing, cancellation, the watchdog parking it, a timeout, and its deadline passing.

- A Sandbox SDK 1.0 sandbox is "a Durable Object that starts and stops a container", and "the same name always reaches the same Durable Object". **[verified]** https://developers.cloudflare.com/sandbox/concepts/lifetime/
- The name is `task:<job_id>:<attempt>`. A retried attempt therefore gets a fresh sandbox and never inherits the state of the attempt that failed.
- The brain is the only caller. Every `execute_code` the worker sends goes through the brain's dispatch, as every worker call does today: "the worker never holds a handler or a credential" (`tasks/profiles.ts`).
- The sandbox binding lives only in the brain's environment.

### 2. Lifecycle, with cleanup that can be tested

Each step below follows intent-before-I/O and has one retry owner, the jobs lane.

1. **Lease.** Before any container I/O, the brain writes a row to an owner-local `sandbox_leases` table in DO SQLite: name, job, attempt, created time and deadline. The row is written in the same transaction as the attempt claim.
2. **Start.** The brain starts the sandbox with internet disabled (§4) and an empty `env` (§5).
3. **Stage.** It writes the input files (§6).
4. **Run.** The brain runs each `execute_code`, bounded by a per-call timeout.
   - `exec()` "has no built-in timeout. Use `kill()` to request termination." **[verified]** https://developers.cloudflare.com/containers/api/durable-object-container/#exec
   - The adapter therefore enforces the timeout itself. The default is ADR-0023's 30 s. A task brief may raise it up to a ceiling that the review sets.
5. **Collect.** It copies the output files back (§6).
6. **Destroy.** `destroy()` "stops the instance at once". **[verified]** https://developers.cloudflare.com/containers/api/durable-object-container/#destroy
   - Destroy runs from the attempt's `finally`.
   - The lease row is deleted only after destroy returns.
7. **Backstop for a lost brain.**
   - The sandbox sets an inactivity timeout. `setInactivityTimeout()` takes up to 6 hours. "Without a timeout, Cloudflare stops the instance shortly after the Durable Object becomes inactive." **[verified]** https://developers.cloudflare.com/containers/api/durable-object-container/#setinactivitytimeout
   - The brain's alarm pass also destroys every leased sandbox whose deadline has passed, or whose job is no longer running.
   - A destroy that fails stays in `sandbox_leases` and is retried on the next pass. It is never forgotten.

Tests that must exist before staging turns the switch on:
- start fails;
- the brain crashes after start (the alarm sweep destroys the orphan);
- the attempt is cancelled during an `exec`;
- an `exec` times out and is killed;
- destroy fails and is retried later;
- a retried attempt gets a fresh name;
- the switch is off: the code profile is refused as it is today, and the sweep still destroys anything leased.

What survives a stop:
- "The disk of an instance holds the repository … All of it ends when the instance stops." **[verified]** https://developers.cloudflare.com/sandbox/concepts/lifetime/
- Container snapshots (public beta) keep the root filesystem for 30 days. **[verified]** https://developers.cloudflare.com/containers/platform/limits/#snapshot-limits
- This design does not use snapshots. Nothing should outlive the attempt.

### 3. Size, cold start, cost and limits

- **Instance size.** The draft proposes `basic`: 1/4 vCPU, 1 GiB memory, 4 GB disk. `standard-1` (1/2 vCPU, 4 GiB, 8 GB) is held for data-heavy briefs, chosen by profile, never by the model. **[verified]** https://developers.cloudflare.com/containers/platform/limits/
- **Account defaults:**
  - 6 TiB of concurrent memory;
  - 1,500 concurrent vCPU;
  - 30 TB of concurrent disk;
  - 50 GB of image storage.
  - All of these "can be increased". **[verified]** same URL.
- **Waldo's own limit.** At most one live sandbox per owner, and a wall-clock and exec-count budget per task. These are hard bounds, not judgment.
- **Cold start.** "Container cold starts can often be in the 1-3 second range." **[verified]** https://developers.cloudflare.com/containers/concepts/architecture/ The task's progress note should say that work has started, not that it is done.
- **Pricing on Workers Paid.** **[verified]** https://developers.cloudflare.com/containers/platform/pricing/

  | Resource | Included per month | Beyond that |
  |---|---|---|
  | Memory | 25 GiB-hours | $0.0000025 per GiB-second |
  | CPU | 375 vCPU-minutes | $0.000020 per vCPU-second |
  | Disk | 200 GB-hours | $0.00000007 per GB-second |

  - Memory and disk are billed on provisioned size; CPU is billed on active use.
  - Egress costs $0.025/GB after 1 TB in North America and Europe. With internet off, egress should be close to zero.
- **Worked cost example** [inference, from the prices above]. A `basic` instance alive for 60 s with full CPU use costs about:
  - memory: 1 GiB × 60 s × $0.0000025 ≈ $0.00015
  - CPU: 0.25 vCPU × 60 s × $0.00002 ≈ $0.0003
  - disk: 4 GB × 60 s × $0.00000007 ≈ $0.000017

  That is about $0.0005 per task-minute, before the included amounts. Every attempt records its seconds in the existing spend ledger.
- **GA status.** Whether the Sandbox SDK and Containers are GA is **[unverified]**. The `durable_object` scheduling policy is "in public beta". **[verified]** https://developers.cloudflare.com/sandbox/

### 4. Egress is off, and only an allowlist can open it

- "By default, a Container will allow internet access." **[verified]** https://developers.cloudflare.com/containers/configuration/outbound-traffic/
- The adapter therefore always passes `enableInternet: false` to `start()`. That option is required whenever options are passed. **[verified]** https://developers.cloudflare.com/containers/api/durable-object-container/#start
- A later, separately reviewed grant may open named hosts through `allowedHosts`. Once set, it is deny-by-default; only ports 80 and 443 apply. **[verified]** outbound-traffic URL above.
  - The grant would be owner-scoped, time-bounded and named in the task brief, as other grants are.
  - A package registry is the likely first case.
- The draft does not use the outbound interception hooks (`interceptOutboundHttp…`) to inject credentials. A code task holds no credentials.

### 5. No secrets in the container

- Values reach a container through `start({ env })`. Processes started with `exec()` "do not receive these variables, except `PATH`". **[verified]** https://developers.cloudflare.com/containers/api/durable-object-container/#start
- The adapter passes no `env` at all.
- The image is built with no secrets. A guard test checks that the start call carries no `env`, and that the image definition names no secret.
- Cloudflare's recommended credential pattern, "The secret lives in the Worker's environment and is never passed into the sandbox" **[verified]** (outbound-traffic URL), is the default here anyway, because a code task needs no secret.
- Synced health readings never enter a sandbox:
  - The brain stages workspace files only, never a health-plane read.
  - The worker profile holds no health tool (`tasks/profiles.ts`).
  - This keeps ADR-0081's destination rules: health-plane values reach only the destinations that ADR names, and a sandbox is not one of them.
- After F1, the workspace can hold health documents the owner sent, such as a lab report. Those are covered by the staging rule in §6.

### 6. Inputs and outputs are only workspace files

- **Inputs.** The task brief names workspace `file_id`s and revisions. The brain exports those exact revisions and writes them under `/workspace/in/` before the first `exec`.
  - Workspace limits apply: 10 MB per file and the owner quota.
  - A file the brief does not name never enters the sandbox.
- **Staging rule.** These are hard checks in the brain, not the model's judgment.
  - **By default the model may stage any owner file** the task needs, including one it found through `workspace_list`. On the owner's own turn the model's choice of files is the owner's agent working within their authorization, and a check there would only make Waldo ask more often (the owner's no-over-restriction ruling).
  - **The check applies when outside content is in play.** Two cases:
    - the task was started from a turn that read outside text (an email, a web page, or a workspace file's contents);
    - the task holds an egress grant (§4).

    In either case, only files the owner chose for this task may be staged: files they named or sent in the owner turn that started it, or confirmed on the task's card. A file the model found through `workspace_list` needs that confirmation.
  - **Internet is off whenever an owner file is staged.** A task with an egress grant can therefore stage owner files only with the owner's confirmation and with the grant's hosts unreachable while those files are present. In practice a task either stages owner files or holds a grant, never both. No grant can become a way to send the owner's files out.
  - **Synced readings never enter a sandbox** (§5): only workspace files are staged, never a health-plane read.
  - **Health documents the owner sent** (a lab report, for example) are workspace files under the same rule:
    - What the task produces from them goes back only to the owner's workspace, as `sandbox_output`.
    - That output is never written to memory, logs or traces.
    - It leaves the workspace only when the owner asks for that specific item.
  - Waldo does not try to decide which files "contain health information", so no classifier or keyword rule is needed. Outside content and egress decide when the owner must choose.
- **Outputs.** When the attempt ends, the brain reads `/workspace/out/` and writes each file to the owner's workspace with provenance `sandbox_output`, which `@waldo/workspace` already defines. Each write has an operation id derived from (job, attempt, path).
  - This is the one writer: the brain applies the result once.
  - The quota, the per-file cap and the per-call write cap that `extract_archive` uses all apply.
  - Output larger than those is reported as not saved.
- **Text.** stdout and stderr are truncated and pass the Scribe's external policy before the model sees them, as ADR-0023 requires. They are tainted `external`.
- **Proposals.** A task result that wants anything outside the workspace raises the owner's card through the existing `propose_action` path. Sending mail and changing the calendar are examples.

### 7. Where it fits: the port, the task worker and the watchdog

- **`execution-environment/port.ts`.** This adds the first real adapter: `cloudflare-sandbox`, `environmentKind: 'cloud'`.
  - `start`, `cancel` and `reconcile` are `native`.
  - `pause` and `resume` are `unsupported` at first. A paused task parks, and resuming starts a fresh attempt with a fresh sandbox.
  - `steer` is `unsupported`.
  - The port's `fencingGeneration` and `cancellationGeneration` map to the job attempt.
  - `execute` rejects a lower generation before it does any container I/O.
  - `recover` reads `sandbox_leases` and the container state, and never starts anything.
- **Task worker.**
  - `TASK_PROFILE_SPECS.code` gains `execute_code` with a handler in the brain.
  - The worker keeps `finish_task`.
  - It holds no memory, send, approve or health tool.
  - The `unavailable` text is removed only while `WALDO_SANDBOX` is on.
  - `execute_code` stays `non_replayable_uncertain` in `TOOL_REPLAY_CLASS`. A crash after an exec started parks the job with that effect named, as `unreplayable` already does.
- **Progress watchdog.**
  - Each exec records its start and end as job facts the watchdog already reads.
  - A worker stuck in a loop of execs is judged by the watchdog's model as looping or drifting. It is never judged by a fixed rule.
  - The watchdog's park goes through the job book. Parking ends the attempt, so destroy runs.

## Rollback

- Turning `WALDO_SANDBOX` off returns the `code` profile to the current refusal.
- The alarm sweep keeps destroying any leased sandbox, so nothing is left running.
- `sandbox_leases` is a new, additive owner-local table. There is no Supabase migration.
- Removing the binding from `wrangler.jsonc` is the last step, after the leases are empty.

## Considered options

| Option | For | Against | Verdict |
|---|---|---|---|
| **Worker-only** (F1 extended) | No new service. Zip, text and archive jobs already work. | No Python or native libraries. 128 MB of memory per isolate. Default CPU 30 s, configurable up to 5 min. **[verified]** https://developers.cloudflare.com/workers/platform/limits/ Running untrusted code needs `eval`, which the security checklist forbids. | Keep for file jobs (F1). Not enough for code. |
| **`use_mac`** (owner's own Mac) | Exists today. Full machine. | Only owners with a Mac that is paired and online. The code runs on the owner's own machine. It is not available to everyone. | Keep as an owner-chosen option, not the default. |
| **External sandbox vendor** (E2B, Modal, Daytona) | Mature products with warm pools. | Another subprocessor and DPA. Owner files leave Cloudflare. Another long-lived credential. Separate egress controls to review. | Reject for now. Revisit if Cloudflare limits or cost fail the trial. |
| **Cloudflare Sandbox SDK / Containers** (this draft) | Same provider and DPA as the Workers. DO addressing fits one brain. Internet off and allowlists are documented. Cost is per second. | GA status unverified. Cold start of 1–3 s. A new binding and image to maintain. | **Proposed.** |

## Open questions for the owner

1. Who gets it in staging: every staging owner, or a named tester allowlist first?
2. What should the per-task wall-clock ceiling and per-exec ceiling be? This draft proposes 10 min and 30 s by default.
3. What goes in the image? This draft proposes Python with pandas, openpyxl, python-docx, pdfplumber and matplotlib, and Node.
4. Should a package-registry egress grant exist at all in beta, or stay out until the review?

## Unverified (must be checked before acceptance)

- Whether the Sandbox SDK 1.0 and Containers are GA, and their SLA.
- The Sandbox 1.0 file API signatures (`/sandbox/reference/files/`) and any `keepAlive` equivalent in 1.0.
- The current limit on concurrent instances per account, beyond the memory, vCPU and disk defaults.
- Whether a Durable Object request has its own subrequest budget. The Workers limit page says 10,000 per request on Paid **[verified]**, and the DO page does not say.
- Any documented guidance against baking secrets into images. Only the CA-certificate warning was found.
