# Thread routing: a follow-up goes to the task that owns the thread (design, 5 November 2026)

Status: **proposed**. This is the fifth slice of the proactive layer (#1884–#1887). Nothing here is built, because the change it needs is to a persisted shape and to the frozen-intent rule. Those are the gate's and the owner's to decide, so a shim in code would be the wrong move.

Claims are tagged [verified] (read at `beta-mvp` `9e0284b8`), [inference] or [proposed]. Paths are under `packages/runtime/src/`.

## 1. The ask

The DeepSeek super-agent note (§3.2) routes a follow-up event on a thread straight to the worker that owns the thread. It reports about 37% fewer cache-read tokens, a figure from its own preliminary evals. Waldo's version:

> A follow-up on a thread that a task already owns goes to that task, not to a fresh, disconnected turn.

Two examples:
- Maya replies to the mail an errand is chasing.
- The owner adds "and make it Thursday" in the app thread where they started a task.

## 2. What exists

- **Briefs are frozen intent.** A worker is started on its brief and the brief's digest. If the brief has changed by the time a worker claims the job, the job is parked with `brief_changed` and never run (`tasks/brain.ts:395-400`). This is the CLAUDE.md rule: "frozen intent/digests". [verified]
- **Tasks don't own threads.**
  - An app task records only `conversation_ref`, the app thread chain its report answers in (`tasks/jobs.ts:44-49`, written by `tasks/tools.ts:51`).
  - Machine jobs record `refs`, which are the items they were *given* (`tasks/jobs.ts:30-38`), not threads they own.
  - Mail threads are owned by open loops (`loop_mail_sources`, `channels/loops.ts`), not by tasks.

  [verified]
- **A job takes input only through its checkpoint.** Since #1854, a worker that asks the owner checkpoints into `awaiting_owner`. The owner's decision is written into the checkpoint (`AskedStep.decision`), and the next attempt resumes with it (`tasks/jobs.ts:56-60`, `tasks/lane.ts` ask-closed resume). This is the only way new input reaches a job. [verified]
- **Follow-ups today:**
  - An owner message in an app thread is an ordinary owner turn in that thread. The brain can see the task with `get_tasks` but cannot add to it.
  - A reply on a mail thread goes through the update sweep and triage like any mail.

  [verified]

## 3. Proposed shape

1. **Ownership, derived with no new table.**
   - An app thread is owned by the open tasks whose `conversation_ref` is that thread's chain.
   - A mail thread is owned by a task only if the task names it. This needs one additive brief field, `source_thread` (`mail:<thread id>`), written by the brain when `start_task` runs from a turn that read that thread. The field is part of the brief, so it is part of the frozen digest.

   [proposed]
2. **An additive follow-up channel in the checkpoint, not the brief.**
   - The brief stays frozen.
   - A follow-up is appended, by the brain only, to a new checkpoint list, `followups: [{ ref, at, taint, text_digest }]`. The text is stored the way checkpoint turns are.
   - The worker reads new follow-ups at its next round as fenced data, and the job keeps its `external` taint.
   - A running job gets the follow-up at its next claim or round. An `awaiting_owner` job gets it with its resume.
   - The worker must not run an effect on a follow-up alone. Effects still go through the card the job raises.

   [proposed]
3. **The routing decision.** Whether a follow-up belongs to the task is judgment, so it follows CLAUDE.md:
   - **App thread:** the owner turn gets a new owner-turn-only tool, `add_to_task(job_id, note)`. The model decides whether the owner's words belong to the task or are a new ask, and it answers the owner in the same turn.
   - **Mail thread:** triage sees "a task owns this thread", and the model chooses `route` (append it to the task, nothing sent now) alongside `act`, `tell`, `brief` and `silent`.
   - **Code checks only authority:**
     - same owner;
     - the job is open (`queued`, `running` or `awaiting_owner`);
     - the thread matches the ownership above;
     - follow-ups are bounded (for example, at most 10 per job, each capped in size).

   [proposed]

## 4. Impact
- **Persisted shape:** `task_jobs.checkpoint_json` gains `followups`, which is additive. A worker build without the field has to ignore it, so check the deploy order: brain first, then worker. [inference]
- **Contract:** a new tool schema (`add_to_task`) with valid and invalid pairs, plus the triage `route` decision. The app task surface (§4.5 of the runtime proposal) can show "Got your follow-up" for the task. That surface is additive, so it needs the app lane.
- **Rule:** frozen intent is kept, because the brief never changes. The CLAUDE.md wording "frozen intent/digests" should say plainly that a checkpoint follow-up is new data, not a changed intent. That needs the gate's agreement and, if the owner wants it, an ADR line.

## 5. Tests and falsifiers
- An owner note added to a running task reaches the worker's next round, the brief digest is unchanged, and the job is not parked.
- A mail reply on a task-owned thread is routed and not triaged twice. A reply on a thread no task owns is triaged as before.
- A follow-up whose text claims approval approves nothing. The worker's effects still card.
- A job that is cancelled, parked or applied refuses a follow-up.
- The owner's own message keeps priority over machine work (#1868 order).
- **Falsifier for the design:** if workers routinely finish before a follow-up arrives (a short task life), routing saves nothing. Then the owner turn plus `get_tasks` is enough, and this slice should be dropped. Measure task life in staging traces first.

## 6. Decisions needed
1. Gate: is an additive checkpoint `followups` list acceptable under frozen intent?
2. Owner: should a mail reply on a task-owned thread go silently to the task, or still surface?
3. App lane: the "Got your follow-up" row on the task surface.
