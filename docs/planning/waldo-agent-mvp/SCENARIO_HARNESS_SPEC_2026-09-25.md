# Scenario harness spec (2026-09-25)

Owner mandate (2026-09-25, ~2:33 AM): the scenario harness is the top build priority after the
scribe RCA fix. Every tool gets scenarios, runs assert on logging/tracing, cover as many
scenarios as possible, keep it generalizable, and give us a standard way to test the real
Telegram UX without the owner's phone.

Motivating failure: the 2026-09-25 overnight outage. Every reply turn on staging died pre-flight
with `forbidden (scribe_sanitise: invalid_payload)` for hours. Contract tests were green the whole
time; only live traffic caught it. The harness exists so the next one is caught by a scenario
before an owner message ever hits the worker.

## What exists today

- `packages/runtime/evals/cases.ts` + `run.ts` (W7): 43 held-out cases across voice, tools,
  memory, day_planning, clinical, fetch and injection. Drives the real `createTelegramResponder`
  against fixture tools over in-memory sqlite, with a live model and a model judge. Tool checks
  are exact (mustCall / mustNotCall). Needs `OPENAI_API_KEY`; run by hand.
- `packages/runtime/src/channels/harness.ts`: the live owner-DO debug channel. `/fire`, `/trace`,
  `/e2e`, `/usage`, `/langfuse`, plus `traceBook` persisting every turn's hops to `trace_log`
  (hop, ok, ms, note, model, tokens, usd, request shape).
- `LLMProvider` seam (ADR-0004): every model, and every in-memory fake, is one adapter interface.
- Vitest + `cloudflare:test` runs real DO code with real sqlite (`harness.test.ts` pattern).

The gap: no deterministic middle layer. Cases need a live model and a judge, so they are slow,
cost money, and flake; contract tests never touch the responder pipeline; and nothing drives the
real worker ingress except the owner's own Telegram account.

## Design: four layers

**L0 Contract/unit (existing).** Vitest over contracts and runtime. Unchanged. Fast, hermetic,
gates every commit.

**L1 Deterministic scenarios (new, the core of this build).** Drive the real responder and turn
pipeline with a *scripted* fake `LLMProvider`: each scenario declares the exact tool-call rounds
the model will make and its final text. Everything downstream of the model is the production code
path: dispatcher, tools, memory admission, loops, scribe, hop logging. No API key, no judge, no
flake; runs inside the existing vitest gate. This layer owns the tool, state and trace
assertions. If L1 says the turn called `set_reminder` and the `reminder` hop is ok, that is a
fact, not a grade.

**L2 Model-graded evals (existing runner, upgraded).** Keep `evals/run.ts` with live models and
rubric judges for voice, tone and judgment calls, but move its cases onto the shared scenario
format (below) so one catalog serves both layers: a scenario's `llm` script drives L1; its rubric
drives L2. L2 runs on demand and before milestones, not per commit.

**L3 Staging ingress smoke (new).** A test-only path that sends a synthetic Telegram webhook
update through the real worker: real signature check, real listener, real DO, real turn. Outbound
sends are captured by a recording seam and returned to the caller instead of hitting Telegram.
This is the standard "test the real Telegram UX" path: buttons, cards and reply text are asserted
from the captured sends. Gated by an env flag plus a shared secret header, present only on
staging; production never enables it. Needs `TELEGRAM_WEBHOOK_SECRET` on the worker and a deploy,
so it lands via a Mac packet, not from the sandbox.

**L4 Dogfood (existing practice).** One real-phone pass per milestone. The harness makes L4 a
confirmation, never the first place a class of bug appears.

## Scenario format

One declarative module per area under `packages/runtime/scenarios/`, exporting
`readonly Scenario[]`. A scenario:

```ts
type Scenario = {
  id: string;                       // stable, referenced from the bug log and checklist
  category: 'tools' | 'memory' | 'scheduler' | 'degradation' | 'injection' | 'approvals' | 'voice' | 'clinical' | 'fetch';
  fixtures?: {                      // seeded into the in-memory DO before turn one
    memoryFiles?: Record<string, string>;
    reminders?: readonly ReminderSeed[];
    loops?: readonly LoopSeed[];
    events?: readonly CalendarEvent[];   // fixture google client, as evals/run.ts already does
    mail?: readonly MailItem[];
    web?: readonly WebResult[];
  };
  turns: readonly ScenarioTurn[];   // text, '@plan ...', '@prompt ...', or a fired card target
  llm?: ScriptedModel;              // L1: ordered tool-call rounds + final text per turn
  rubric?: string;                  // L2: judge instructions (existing style)
  assert: {
    mustCall?: readonly string[];   // exact tool names, any turn
    mustNotCall?: readonly string[];
    hops?: readonly HopAssert[];    // see trace assertions below
    state?: readonly StateAssert[]; // sql/store assertions after the last turn
    replies?: readonly (RegExp | string)[]; // per-turn reply matchers (L1 exact, L2 soft)
    outbound?: readonly OutboundAssert[];   // L3: captured telegram sends (text, buttons)
  };
};
```

Generalization rules (engineering law, same weight as the bug-log rule):

1. Every new tool ships with at least two scenarios in the same commit: one happy path, one
   adversarial or failure path.
2. Every bug-log row names the scenario that now covers it. The 2026-09-25 scribe outage gets
   scenario `degradation-scribe-structural-deny` in H2: history seeded with a payload the
   structural policy denies, asserting the reply still lands and the `llm_reply` hop is ok.
3. Every new hop in the trace vocabulary lands in the harness checklist in the same commit.

## Trace assertions

The assertion substrate is the hop stream (`TurnLogEntry`), the same feed `traceBook` persists:

```ts
type HopAssert = {
  hop: string;                      // 'llm_reply', 'memory', 'tool_query_calendar', 'connect_offer', ...
  ok?: boolean;                     // required outcome
  note?: RegExp;                    // error/detail text, e.g. /scribe_sanitise: invalid_payload/
  maxMs?: number;                   // wall-clock bound
  after?: string;                   // ordering: this hop must follow the named one
  usage?: { maxTokens?: number; maxUsd?: number };
};
```

Every L1 scenario run captures the full hop stream per trace id and evaluates its `hops` block:
hop presence, outcome, note regex, ordering and cost bounds. This is the "logging/tracing
assertions" requirement: a scenario can fail because a hop is missing, failed, out of order, slow
or expensive, even when the reply text looks right. Scribe denies must always surface as a hop
with the destination in the note, so a silent drop like tonight's is structurally impossible to
miss in the harness.

## Coverage catalog (first pass)

- **Tools:** one happy + one adversarial scenario per live tool: `get_context`,
  `search_episodes`, `set_reminder`, `list_reminders`, `cancel_reminder`, `query_calendar`,
  `propose_calendar_change`, `draft_email`, `web_search`, `browser`, plus the connect flow
  (offer → button-only delivery → resolve, and the rate-limit and dedup paths shipped in S4).
- **Scheduler:** each `/fire` target as a scenario turn: brief, midday, close, fetch, briefs,
  nightly; reminder due; missed-alarm reporting once that lands.
- **Degradation:** scribe structural deny (tonight's regression), scribe hard deny still failing
  closed, tool oversize result, model timeout vs the 150s wall clock, provider failover.
- **Injection:** port the existing email/web/fetch injection cases to the shared format unchanged
  in intent; each must keep its `mustNotCall`.
- **Memory:** correction, forget-stays-forgotten (nightly pass cannot relearn a forgotten fact),
  temporal, stated-vs-guess.
- **Approvals:** expiry (12h), stale etag on move, skip path.
- **Serialization:** two messages in flight queue rather than race; post-turn memory writers
  complete before the next turn starts (96c7683's fixes, pinned).

## Build order

- **H1:** scenario types + L1 runner (scripted fake provider over the real responder, hop
  capture, hop/tool/state/reply assertions). Port the 12 deterministic cases from
  `evals/cases.ts` (the ones whose rubric is checkable without a judge) as the seed catalog.
- **H2:** degradation + serialization scenarios, including the scribe outage regression. Bug-log
  rows gain scenario references.
- **H3:** full per-tool catalog and scheduler fires.
- **H4:** L3 staging ingress smoke (test route + send recording + secret gating) via Mac packet;
  verify one synthetic update end to end on staging.
- **H5:** L2 unification: `evals/run.ts` reads the shared catalog; rubric cases keep their judge.

Gates per slice as usual: typecheck, contracts, runtime shards green; commit; push; ls-remote
verify; honest live-vs-tests labeling in the status doc.

## Non-goals

- No model-quality grading in L1; that is what L2 is for.
- No production test hooks: L3 gating is staging-only by construction.
- No replacement for L4 dogfooding; the harness narrows what the phone pass has to catch.
