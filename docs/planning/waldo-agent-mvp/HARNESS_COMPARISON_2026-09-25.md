# Harness comparison and parity inventory (2026-09-25)

How the Waldo scenario harness (SCENARIO_HARNESS_SPEC_2026-09-25.md, H1-H3 shipped this morning)
compares with the peer and open-source state of the art, and the exact numbers of what we cover.
Peer claims are dated and sourced; repo-internal peer notes are marked secondhand.

## Peer landscape (checked 2026-09-25)

- **LangChain agentevals + LangSmith** (docs.langchain.com): trajectory evaluation against a
  reference trajectory (deterministic step-by-step tool-call comparison) or an LLM judge with a
  rubric. Strong dataset management, experiment tracking, annotation queues. Requires a live
  model for the run itself; the judge adds a second model pass.
- **Langfuse evaluation** (langfuse.com): the unit of evaluation is the trace, not the
  completion. Four dimensions: trajectory, tool use, task completion, multi-turn quality.
  Deterministic code checks for anything decidable, LLM-as-judge for semantic judgments, online
  evals on sampled production traffic. We already ship OTLP traces to Langfuse, so the online
  path is open to us without new plumbing.
- **promptfoo** (promptfoo.dev): declarative YAML evals, an OpenAI Agents SDK provider with
  toolMocks and OTLP span export; assertion library over outputs. Model-graded and
  deterministic assertions, but the agent under test is a black box across the wire.

## Where Waldo stands against them

| Capability | LangChain/LangSmith | Langfuse | promptfoo | Waldo L1 (today) |
| --- | --- | --- | --- | --- |
| Deterministic tool-call assertions | trajectory match | code checks | assertions | exact mustCall / mustNotCall |
| Scripted model (no API cost per run) | no (live model) | no | toolMocks only | yes - scripted gateway drives the real pipeline |
| Trace/observability assertions | via LangSmith spans | native (trace is the unit) | OTLP export | hop-stream assertions: outcome, note regex, ordering, ms, per-turn trace scoping |
| Post-turn state assertions | no | no | no | yes (reminders, loops, connect offers) |
| Injection suite | community datasets | docs patterns | redteam plugins | 7 cases ported from W7, pinned mustNotCall |
| Runs the production code path in CI | partially | no | no | yes - real responder, dispatcher, hooks, scribe, memory |
| Model-graded rubric layer | LLM judge | LLM judge | LLM judge | L2 evals/run.ts (43 cases) |
| Live ingress smoke (synthetic webhook) | n/a | online evals on prod traffic | no | L3 spec'd, staging-only, Mac packet pending |
| Dataset UI / annotation / trends | yes | yes | partial | no (deliberately - we are not building eval SaaS) |

The one structural thing none of the peers do, because they sit outside the agent: our L1 runs
the production responder, dispatcher, hook registry and scribe in-process, so a scenario fails on
the same hop the live `/trace` command and Langfuse would show. The first run caught seven chat
tools silently dead at the args-schema hook - a failure class invisible to mustCall-style checks
and rubric judges, and invisible to any harness that mocks the pipeline it is testing.

## Parity inventory numbers (2026-09-25, beta-mvp 5357a4d)

- L1 scenarios: **20** across tools (11), degradation/security (3), memory (2), voice (1),
  and the serialization ordering pin. All assert on the hop stream; 9 assert tool calls exactly;
  4 assert post-turn state; 1 asserts the connect-offer seam.
- Live chat tools covered: **9 of 9** dispatchable chat tools (get_context, query_calendar,
  set/list/cancel_reminder, propose_calendar_change, draft_email, open_loop, close_loop,
  set_proactivity, search_episodes, web_search; connect_service covered via the offer seam).
  draft_email pins its current autonomy-gate halt pending the approval-wiring decision.
- L2 rubric cases: **43** (voice 6, tools 7, memory 7, day planning 5, clinical 7, fetch 4,
  injection 7), run on demand with a live model and judge.
- Unit/contract suites: contracts 1657 tests, runtime 1433 tests (4 shards), all green at push.
- Known uncovered: scheduler fires (brief/midday/close/fetch/nightly as scenario turns), L3
  staging webhook, L2/L1 catalog unification, online evals on sampled production traces via
  Langfuse.

## What we deliberately skip

Building dataset UIs, annotation queues and experiment dashboards ourselves. If we want online
evals, Langfuse already has our traces; the move is a scheduled task that samples production
traces and scores them, not new infrastructure.
