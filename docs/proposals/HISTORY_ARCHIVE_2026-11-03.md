# History archive: retention moves rows, never deletes them (3 November 2026)

Status: **built behind `HISTORY_ARCHIVE`, default `"0"`.** The gate approved the design on waldoco/waldo-backend#1449 (comment 6599376134, item 5). By the gate's ruling no ADR is needed: the table lives in the same store, under the same owner and the same writer, with no new egress, and the forget paths cover it. The design it implements is the Ark lane's comment 6597556071 on the same issue.

Base: `beta-mvp` `d7ff3793`.

## The problem

On 3 Nov the owner ruled that DO retention and indexes must not reduce what the model or the harness can do: retention means archive, and the model must still be able to search old rows. Today `beta-mvp` deletes history in two places:

- `background_runs` deletes everything past the newest 500 rows on every `start()`.
- `task_jobs.trim()` deletes the owner's settled rows past the newest 200, and settled machine rows that are past the newest 50 and older than 48 hours.

No tool can search runs, tasks, scheduled runs or decided approval cards. The model sees only the last 8 decided cards in `desk.ledger()`.

## What this builds

### Storage: `history_archive`, DO migration v16 `history-archive`

The table lives in the owner object's own SQLite. It is not in R2: run summaries are owner text that the forget paths must redact, R2 may not hold raw health, and the DO keeps one writer and synchronous search.

| Column | What it holds |
|---|---|
| `seq` | the rowid key. A hot id is unique only among rows still hot (a run id has 32 bits), so the archive may hold one source id twice; a unique key there would make a later move fail on every `start()` |
| `source` | `background_runs`, `task_jobs` or `schedule_runs` |
| `source_id` | the hot row's id |
| `kind` | the hot row's kind |
| `status` | the hot row's status: a schedule run's `outcome` |
| `started_at` | the time the hot table sorts by: `started_at`, `created_at` or `fired_at` |
| `ended_at` | `ended_at` or `settled_at` |
| `summary` | a run's summary; a task's title, a replay's tool or a machine job's name; NULL for a schedule run |
| `row_json` | the whole hot row; a `*_json` column is kept as JSON, not as a string of it |
| `archived_at` | when the row moved |

Two indexes: `history_archive_by_source (source, started_at)` and `history_archive_by_ref (source, source_id)`, which is not unique. FTS5 is not added; add it only if a measurement shows it is needed.

The DDL is one exported constant, `HISTORY_ARCHIVE_TABLE_SCHEMA`. The v16 migration's `up` uses it, and so does the archive writer's first move, which runs it inside the move's transaction. The owner object never calls `provisionDoSchema`, which is why v15's index also ships through `ensureSchema`. The migration's down drops both indexes and the table.

### Moves: `src/history/archive.ts`

`retire(source, ids)` selects the ids first. It then runs `INSERT INTO history_archive … SELECT … WHERE id IN (ids)` followed by `DELETE … WHERE id IN (ids)`, inside one `transactionSync` with no I/O.

- Any failed insert throws and rolls the whole move back, so the delete can never remove a row the archive did not receive.
- The move compares the rows returned by both statements with `RETURNING`, not `rowsWritten`, which also counts index entries.

| Hot table | What moves | When |
|---|---|---|
| `background_runs` | settled rows past the newest 500; **never a `running` row**, which `finish()` still writes | each `start()` |
| `task_jobs`, owner rows | settled rows past the newest 200 | each `trim()` (the task lane) |
| `task_jobs`, machine rows | settled rows past the newest 50 and older than 48 hours | each `trim()` |
| `schedule_runs` | whole occurrences only, at most 200 per sweep | once a day, from the alarm |

A `schedule_runs` occurrence moves only when **all** of these hold:

- no row of the occurrence is `running` (`hasRunningRun`);
- its newest fire and its newest settle are more than 30 days old;
- it is neither its schedule's current occurrence nor its `quarantined_until` occurrence (`occurrenceDelivery`, `recordMissed` and `recordRunStart` read those).

The sweep's day stamp is written only after a sweep under `1` finishes, never under `dry`. A sweep that throws is logged with a content-free code and runs again on the next wake.

The **ledger** is never moved. It is the audit record; it stays hot and is indexed (#1847). **`health_trigger_runs`** is not in this PR.

### The ordinal fix, which lands first

`recordRunStart` took a run's ordinal from `count(*)+1`. Once a settled row of an occurrence leaves the hot table, the count lands back on a crashed row's ordinal, and the insert fails on the primary key. It now takes `MAX(attempt)+1`. A red test reproduced the collision first.

### The switch: `HISTORY_ARCHIVE`

It is `"0"` in both wrangler blocks and is declared in the `Env` type. A switch test pins both blocks.

| Value | Behaviour |
|---|---|
| `0`, or anything else | Today's deletes, unchanged. This is the rollback. |
| `dry` | Nothing moves and nothing is deleted. Each source logs `{hop: 'history_archive_dry', source, count}`. |
| `1` | Rows move. Each move logs `{hop: 'history_archive_moved', source, count}`. |

[decision, flagged to the gate] Under `dry` the existing deletes stop as well. "Writes nothing" is read as no archive insert and no hot delete, which deletes nothing, in line with the ruling. The hot tables then grow past their caps until the switch is set to `0` or `1`.

### Forget reaches the archive

- **`forgetStores`** (`owner-do.ts`): `historyArchiveForgetStore` gives each archived row the redaction its hot table gives:
  - a run's summary goes whole, both in the row and in `row_json`;
  - other text loses the forgotten words in every decoded JSON string;
  - a copy the literal redaction cannot rewrite (an escape that spells the topic, a JSON key) is dropped from the row: a brief becomes `{}`, any other column `null`;
  - it returns how many archived rows still carry the text.
- **`PROJECTION_STORES`** (`memory/claims.ts`) lists `history_archive (summary, row_json)`. An archived copy therefore holds the forget until the store has run, and `/heldrows` (`HELD_ROW_TABLES`) shows it.
- **`forget_memory`** counts an archived copy as memory it touched, as it does for a task. Without this, a topic that lived only in archived history got "No stored memory carries that topic".
- **Account erase** is already `deleteAll()`.

### Tool: `search_history`

- **Surface:**
  - read-only;
  - owner turns only (`ownerTurnOnly`, and `user_message` in `TOOL_PERMISSIONS`);
  - deferred in the `memory` namespace;
  - `scope: deny`.
- **Arguments:** `query` (all words must appear in the summary, type or status), `kinds` (`run`, `task`, `scheduled`, `approval`), `from`, `to`, `cursor`, and `limit`, which is at most 20 and defaults to 10.
- **Result:** `entries` newest first, `total` (every match) and `next_cursor`.
- **Entries:** each has a `ref`, its `kind`, its `type` (the row's own kind), `status`, `summary`, `started_at`, `ended_at` and `archived`. There are never payloads, bodies or health values.
- **Approval summaries:** these are the desk's own `summaryOf` projection. "Decided" uses the desk's own Recent list definition. Open cards stay the desk's to show.
- **Cursor:** it is `<time>:<ref>`, where a ref is `source:source_id` and stays the same when a row moves. A row that moves between two pages is therefore neither repeated nor skipped.
- **Matching:** it uses `instr`, never `LIKE`, because workerd caps LIKE pattern length.
- **Forget barrier:** `search_history` is an owner-store read (`OWNER_STORE_TOOLS`, plus the retained-read path in `owner-turn.ts`). An entry that carries a topic still being forgotten is dropped whole.
- **Contracts:** it has Zod valid and invalid pairs, a tool record, an activity kind and a hooks-registry schema. It needs no app.v1 or controls revision, because no app surface reads it.

## Falsifiers, each a test

| Falsifier | Test |
|---|---|
| A row past a cap is in the archive, not gone, even when its short id repeats an archived one. | `history-archive.test.ts`: runs (the repeated-id case observed red first) and both task trims |
| The ordinal collision | `schedule-runs.test.ts`: "numbers the next run past the highest ordinal" (observed red first) |
| A running run or a running or current occurrence is never moved. | `history-archive.test.ts` |
| Forget redacts archived rows, and the archive holds the forget until it does. | `forget-history-archive.test.ts`; the owner-DO `forget_memory` case and the full-store scan in `memory-forget-do-provider.test.ts` |
| `search_history` finds archived and decided rows, pages across a move, honours the barrier, and is refused on a non-owner turn. | `history-archive.test.ts` |
| A dry run writes nothing. | `history-archive.test.ts`: runs, tasks and schedule runs |
| Hot reads are byte-equal with the archive on and off. | `history-archive.test.ts`: `list`, `listPage`, `latestActivity`, `between` |

Observed red before their fix: the ordinal test and the repeated-id test. The rest were written with the code; a mutation that deletes without archiving turns 9 of them red.

## Rollback

- Set `HISTORY_ARCHIVE` to `"0"`. Archived rows stay searchable and forgettable, and nothing more moves.
- The v16 down drops the table, and with it the archived rows. Run it only on the owner's say-so, because those rows exist nowhere else.

## Follow-ups (not in this PR)

- `health_trigger_runs`: archive it in a separate PR, as the gate ruled.
- Other deletes of history-like rows remain: `mcp_sends` (keeps the newest N), `mcp_attempts`, `app_row_traces` and `health_trigger_wakes`. Each needs its own call on whether it is history the model should keep.
- The effect ledger (KV `owner:effect:*`) quota count still lists every record. Key it by day.
