# Langfuse dashboards

A spec for the cost, latency and cache charts in the Langfuse project, which a person applies by hand in the Langfuse UI. Nothing in this repository creates or changes a Langfuse dashboard, and no runtime code or credential is involved.

Every chart reads only what `packages/runtime/src/observability/otlp-turns.ts` exports today. Line numbers are at `beta-mvp` `d026da0d` and drift as the file changes; the attribute names are the contract (see the trace schema in [OBSERVABILITY.md](OBSERVABILITY.md), which changes only with `TRACE_SCHEMA_VERSION`). The metrics come from the "Not measured yet" table in [M0_BASELINE_2026-10-20.md](../evals/M0_BASELINE_2026-10-20.md).

## How the export is shaped

- **One trace per owner turn.** The root span is named `<channel>.turn`, or `<channel>.machine` for scheduled work (`rootName`, line 75; `ROOT_NAMES`, line 34). Its observation type is `agent` (`HOPS.turn`, line 21).
- **Every hop is a child observation** named after the hop. `metadata.hop` carries the same name (line 226).
- **Model calls are `generation` observations** (line 82). Each carries:
  - `model.name` (line 84);
  - `usage_details` (line 85): `input` is the *uncached* input, plus `input_cached_tokens` and `output`;
  - `cost_details` (line 95): USD from `llm/pricing.ts`, set only when the model is in that table.
- **The root span's duration is the turn hop's own `ms`** (line 211): from receipt to the reply leaving.
- **Late hops join the same trace afterwards** (line 285), the background `memory` update for example. So the *trace's* latency runs past the reply, while the root *observation's* latency does not.
- **Ids on every span:**
  - `langfuse.environment` (line 213);
  - `langfuse.user.id` (line 214), the surface subject (`telegram:<id>` and similar);
  - canonical owner metadata from `ownerTraceFields` (lines 223-225): `owner_id`, and `owner_email` only when text capture is on;
  - `metadata.channel` (line 219).

Not verified from here: whether the Langfuse widget builder can filter or group by a metadata key, and whether it can aggregate a metadata value as a number. langfuse.com was unreachable from the environment this spec was written in. Each chart below says what to use when the builder cannot.

## Charts

Every chart filters `environment` to the one being watched (`staging` or `production`). Never mix the two on one chart.

### 1. Cost per turn

| Field | Value |
| --- | --- |
| Name | Cost per turn (USD) |
| Data source | Traces |
| Filter | trace name ends `.turn` (owner turns, not `.machine`); environment |
| Aggregation | total cost per trace: p50, p95 and mean, per day |
| Breakdown | `metadata.channel` (line 219); if the builder cannot group by metadata, trace name (which starts with the channel) |

The total cost is Langfuse's sum of `cost_details` (line 95) over the trace's generations, late memory calls included. Do not chart `metadata.estimated_cost_usd` (line 204) for this:
- it covers only hops finished before the reply (`metadata.cost_scope = pre_root_hops`, line 199);
- it is a string attribute.

Add a second filter, or a separate count chart, on `metadata.cost_coverage` (line 203): `partial` or `unpriced` means a model missing from the price table, so that turn's cost is a floor. `metadata.cost_kind` (line 198) is always `estimate`; it is not the turn/background/heartbeat cost kind and is not a breakdown.

### 2. Cost per owner per day

| Field | Value |
| --- | --- |
| Name | Cost per owner per day (USD) |
| Data source | Traces |
| Filter | environment (owner turns and machine turns both, so all of an owner's spend counts) |
| Aggregation | sum of total cost per day |
| Breakdown | `metadata.owner_id` (lines 223-225), the canonical owner; if the builder cannot group by metadata, `userId` (line 214) |

`userId` is a surface subject: one owner on two surfaces shows as two users. `metadata.owner_id` reads `unknown` for a turn whose owner was not resolved; count those as their own row.

The durable per-owner figure is the Supabase ledger, not this chart. The service-role query in OBSERVABILITY.md ("Durable cost ledger") and `scripts/cost-report.mjs` give spend per owner per day without the Langfuse retention window. The ledger runs only where `WALDO_COST_LEDGER_SYNC=on`.

### 3. Turn latency

| Field | Value |
| --- | --- |
| Name | Turn latency p50 / p95 (ms) |
| Data source | Observations |
| Filter | type `agent` and name ends `.turn` (the root span, lines 21, 210); environment |
| Aggregation | latency p50 and p95, per day |
| Breakdown | observation name (`<channel>.turn`, so one line per channel) |

Use the root observation, not trace latency: the trace stretches to the last late hop (line 285), and the root span ends when the turn hop does (line 211).

A second chart with name ending `.machine` gives scheduled work its own latency. Keep it off the owner-turn chart.

### 4. Time to first token

| Field | Value |
| --- | --- |
| Name | Time to first token p50 / p95 (ms) |
| Data source | Observations |
| Filter | type `generation` and `metadata.hop = llm_reply` (lines 82, 226); environment |
| Aggregation | p50 and p95 of `metadata.ttft_ms` (line 137), per day |
| Breakdown | `model.name` (line 84) |

**Empty until #1487 lands.** The exporter maps `ttft_ms` at both levels: on the generation (line 137) and on the trace, as the first generation's value (line 169). But no producer sets it on `beta-mvp`; #1487 adds it on the streamed reply hop. The value arrives as a string metadata attribute. If the builder cannot take a percentile of a metadata value, this chart cannot be built from metadata alone. [inference] Langfuse's own time-to-first-token reads a generation's completion start time, which the exporter does not send. Mapping `ttft_ms` onto it would be an exporter change, out of scope here.

### 5. Cache share on later rounds

| Field | Value |
| --- | --- |
| Name | Cached share of input, owner replies |
| Data source | Observations |
| Filter | type `generation` and `metadata.hop = llm_reply`; environment |
| Aggregation | sum of `usage_details.input_cached_tokens` ÷ (sum of `usage_details.input` + sum of `input_cached_tokens`), per day (line 85) |
| Breakdown | `model.name` (line 84) |

`usage_details.input` is the uncached part, so total input is `input + input_cached_tokens`.

**Rounds 2+ cannot be separated yet.** M0 asks for cache share on rounds 2+ of a turn, but no attribute names a model call's round within its turn, so this chart covers every round, round 1 included. Round 1 has the least cache to reuse, so this reads lower than the rounds 2+ figure. A round number on each generation would close the gap; that is an exporter change, not part of this spec.

`metadata.cached_share` exists per generation (line 83) and per trace (line 195). It is a ratio per row, so averaging it weights a small call like a large one. Use the token sums above.

## Applying it

1. In the Langfuse project for the environment, create one dashboard, "Cost and latency".
2. Add the five charts above with the named source, filter, aggregation and breakdown.
3. Where a chart needs a metadata breakdown the builder does not offer, use the fallback the chart names. Note the substitution in the chart's description so a later reader knows which one is live.
4. Record in the dashboard's description which `TRACE_SCHEMA_VERSION` it was built against (`metadata.schema_version` on every root, line 310). Re-check the charts whenever that version changes.

No part of this needs text capture. Every chart reads ids, durations, token counts and costs, never message text or health values.
