# Tool engineering pass: inventory and plan (4 Nov 2026)

Candidate plan. It authorizes no merge or deploy. The Mac orchestrator gates each slice on waldoco/waldo-backend#1449.

The owner asked on 4 Nov to "make our tools and the context used by those tools very, very rich, so the model itself has everything to work with". This doc does two things. It inventories what the model is offered today and where that falls short. Then it sends the fixes as slices, one tool family per PR.

Base: `beta-mvp` at `8455b0b9`. Labels follow `posture.md`: [verified] means measured or read at that SHA, [inference] means concluded but not observed, and [proposed] means not built.

## 1. Measured surface [verified]

These numbers come from `packages/runtime/test/brain-tool-surface.test.ts` on an app owner turn: every Google feature, Drive and MCP reads on, browsing added, tool search on.

- **64 tools offered**, out of 98 records in `TOOL_RECORDS`. The 34 that are not offered are listed in Appendix B.
- **Core (every round):** 13 tools, plus `browse_page` with browsing, plus `react_to_message` on a tapback-verified iMessage turn.
- **Visible definition tokens per round** (estimate: bytes / 4):
  - OpenAI 3,793, Anthropic 3,525;
  - with browsing: 4,097 / 3,756;
  - with browsing and tapback: **4,198 / 3,853**.
- **The budget is 4,200 on this base** (`test/helpers/tool-budget.ts`). That leaves 2 tokens of headroom.
  - #1843 (open, untested at the time of writing) moves `query_availability`, `list_reminders`, `cancel_reminder`, `send_email`, `send_message` and `raise_approval` to core. It sets the budget from a fresh measurement, about 6,100.
  - Re-measure once it lands.
  - Until then, every slice here keeps core and soon-core definitions byte-neutral or smaller. The richness goes into **results**, which cost nothing per round.
- **Without tool search the menu is 15,229 tokens.**
- **Task-worker rounds:** reader 5,444 / 5,297 and errand 6,806 / 6,651 (OpenAI / Anthropic). Both are under their pins.

**Usage frequency is UNAVAILABLE.**
- Langfuse needs credentials this lane must not load.
- `evals-live` skipped its 4 Nov run for lack of secrets.
- Appendix A's "eval mentions" column counts how often a tool's quoted name appears in `scenarios/` and `evals/nightly/`. That measures eval coverage, not production use.
- Of the 64 offered tools, 39 have zero mentions. Among them: `get_tasks`, `search_contacts`, `get_health`, `read_tool_output`, `search_history` and every workspace tool.

## 2. Gaps, ranked by leverage

### G1. Deterministic Google failures are told as passing, so the model retries them [verified]

`withGoogle` in `tools/live/google.ts` maps every thrown `Error` it does not recognise to `code: 'transient'`. `TOOL_ERRORS.transient` then attaches `retryable: true` and "Try the same call once more".

Most of those throws fail the same way on every retry:
- `Reply subject differs from its parent thread.`
- `A reply parent requires its Gmail thread.`
- `invalid body offset`
- `unknown message in thread`
- `Selected Google account is unavailable; no other account was used`
- `… adapter unavailable`
- `… exceeds requested limit`
- `Google collection account does not match the selected connection`

So the model spends a round on a retry that cannot succeed. The reply-subject case never tells it to fix the subject.

### G2. A handler cannot say how to recover [verified]

- The failure arm of `ToolResult` carries `error` and `code`, but no `fix`.
- `failDispatch` always takes `fix` from the per-code table (`TOOL_ERRORS`), so every `rejected` reads "Do not repeat the same call; change the approach or tell the owner".
- Only the handler knows the next step: use `body_next_offset`, use the thread's own subject, pass one of these accounts.

### G3. A spilled result shows a byte cut, not an index [verified]

- Above 16,384 characters, the dispatcher stores the result and inlines `head`, the first 4,000 characters of the raw JSON (`dispatcher.ts` `offloadResult`).
- `read_thread`'s first read allows 40,000 body characters (`READ_BODY_BUDGET`). So any long thread spills, and the model sees the first message or two plus a store id.
- To learn what the rest of the thread holds, it pages `read_tool_output` 4,000 characters at a time.

**Inline & Spill** [proposed]: when a result spills, a handler's optional `spill(data)` gives the inline view. That view is every item's id, sender, time and subject, plus a short opening, with the full content behind `read_tool_output`.

### G4. Thin results that force a second call [verified unless marked]

- **`get_tasks` across all lists.** It returns `task_list_id` with no list title, so naming the list means a `list_task_lists` call.
- **`get_health` unavailable.** It returns `{ state: 'unavailable', reason }` and nothing more. `consent_required`, `not_linked`, `no_readings` and `read_failed` each need a different next step, and the model has to guess it.
- **`list_reminders`.** It has no count and no time zone. [minor]
- **Mail list items.** They carry `id`, `thread_id`, `from`, `subject`, `snippet` and `at`, but no `to`/`cc`, unread or labels. So "what needs my reply" needs a `read_thread` per message.
  - That projection lives in `connectors/google.ts`, which is bundled into the connector-proxy Edge Function. The page schemas are strict.
  - So it needs the runtime to accept the field first, then a connector-proxy deploy, which needs separate authority.
  - It is a later slice. [proposed]

### G5. Fat results [inference; result sizes to be measured per slice]

- `get_communication` and `query_calendar` carry `coverage` blocks of about 12 fields each. They include enum strings (`cursor_query_binding`, `lower_bound_query`) and a 200 to 250 character `limitation`, repeated per account on a multi-account read.
- The honesty they carry ("empty is not absence", which account was read) is the "what is true now" half of the brief, and it stays.
- Trimming waits for an audit of every reader of those fields: the day plan, the brief, scenarios and the app projection. Each slice first adds a short `next` line, and it measures the result before and after.

### G6. Descriptions [verified]

- `read_thread`'s description is at the 1,024-character cap.
- `query_availability` is 786 definition tokens (an 884-character description), and it becomes core under #1843.
- `query_calendar` spends words on "Legacy adapters…" and "Event enumeration, not availability".
- Tightening these lowers every round's cost after #1843. Any rewording keeps the routing facts and adds no test that pins wording.

### G7. Merge candidates [proposed, not in this pass]

- `skills_install` and `skills_disable` share a schema and a 252-character description.
- The three MCP tools overlap.
- Tool names are contracts, so merging is a deprecation with downstream validation. This pass names the candidates and changes none.

### G8. Schema-only tools [verified]

- Eleven records have `NO_HANDLER`: `execute_action`, `write_task`, `update_task`, `draft_document`, `write_sheet_cell`, `execute_code`, `create_thread`, `delete_message`, `restore_message`, `archive_thread` and `update_thread_topics`. `search_connector` is a twelfth, schema only.
- None of them is offered. Removing them is `post-mvp-cleanup`, not this pass.

## 3. Slices

Each slice goes to `beta-mvp` with a full `pnpm verify` PASS, and is reported on #1449 as "ready at <sha>". No merge, no deploy, no `records.ts` edits (#1843 and the planning-brief lane both rewrite that file).

1. **Mail and Google recovery (G1, G2, G3).**
   - Contracts: an optional `fix` on the failure arm of `ToolResult` (additive).
   - Dispatcher: a handler's `fix` replaces the table text, and its `retryable` follows the code.
   - `google.ts`: typed errors. Each deterministic throw maps to `invalid_args`, `not_found` or `rejected`, with one recovery sentence.
   - Inline & Spill for `read_thread`, plus the `spill` seam on the handler.
   - Tests: each throw's code and fix; the spill index lists every message; a spill whose index fails the guard falls back to `head`.
2. **Calendar (G6, G5).**
   - Shorter `query_availability` and `query_calendar` descriptions, measured with `BRAIN_TOOL_SURFACE` before and after.
   - A `next` line on event and free-time pages.
3. **Tasks (G4).**
   - List titles on all-list `get_tasks` reads: the handler reads the account's task lists once, a runtime-only change.
   - Count and time zone on `list_reminders`.
4. **Health (G4).**
   - A recovery line per unavailable reason, in words.
   - No new field carries a number, and the existing turn-only numeric shape does not grow (ADR-0081).
5. **Memory and history.**
   - Coordinated with the chain-of-recall lane, which owns memory and history refs. This slice waits for that lane's scope.
6. **Mail list enrichment (G4).**
   - `to`, `cc` and unread on list items.
   - The runtime accepts each field as optional first. The fields stay inert until the connector-proxy is redeployed, which needs separate authority.

## 4. Evals: what before/after can and cannot show

The L1 scenario harness runs a scripted model, so a scripted round count proves nothing. Each slice adds the following.

- **Deterministic:**
  - The round-1 result carries the field that used to need a second call: list titles, a spill index, a health next step.
  - A deterministic error now carries a non-retryable code and its specific fix.
  - Per family, a result-size probe on a fixed fixture, logged before and after.
- **Live, NOT RUN:** a nightly scenario per family that counts model rounds to answer.
  - Mail: "what did Sam say in that long thread".
  - Tasks: "what's on my work list".
  - Health: "how did I sleep" without consent.
  - These run once `evals-live` has its secrets. Until a run is observed, they are reported as NOT RUN.

## 5. Constraints kept

- **Contracts are additive only.** Every tool keeps its valid and invalid schema pair (ADR-0029).
- **Judgment stays with the model.** Recovery lines say what is true and what can be done next; they route nothing.
- **Credentials never enter a result.** Health values stay within ADR-0081: model text carries zone words only.

## Appendix A. Offered tools (measured fixture, 64)

Def tokens is one definition's JSON bytes / 4. Eval mentions is eval coverage, not usage.

| Tool | Brain | Def tokens | Desc chars | Params | Eval mentions |
|---|---|---:|---:|---:|---:|
| `browse_act` | web | 1353 | 441 | 6 | 0 |
| `browse_page` | core | 231 | 167 | 5 | 8 |
| `call_mcp_tool` | web | 323 | 721 | 4 | 2 |
| `cancel_reminder` | reminders | 110 | 74 | 2 | 4 |
| `cancel_standing_order` | settings | 77 | 30 | 1 | 0 |
| `cancel_task` | reminders | 82 | 134 | 1 | 1 |
| `close_loop` | reminders | 115 | 73 | 2 | 5 |
| `connect_app` | settings | 174 | 437 | 2 | 0 |
| `connect_service` | core | 196 | 459 | 2 | 0 |
| `create_artifact` | artifacts | 194 | 417 | 3 | 0 |
| `delegate_task` | actions | 273 | 414 | 3 | 0 |
| `draft_email` | mail | 451 | 462 | 8 | 11 |
| `export_artifact` | artifacts | 229 | 552 | 3 | 0 |
| `forget_memory` | memory | 221 | 182 | 4 | 0 |
| `get_communication` | mail | 475 | 584 | 4 | 13 |
| `get_context` | core | 55 | 50 | 1 | 2 |
| `get_health` | core | 384 | 356 | 4 | 0 |
| `get_tasks` | calendar | 319 | 652 | 6 | 0 |
| `list_artifacts` | artifacts | 84 | 145 | 1 | 0 |
| `list_health_logs` | health | 102 | 121 | 2 | 0 |
| `list_owner_findings` | memory | 134 | 347 | 1 | 0 |
| `list_reminders` | reminders | 44 | 58 | 0 | 2 |
| `list_standing_orders` | settings | 40 | 35 | 0 | 0 |
| `log_meal` | health | 282 | 340 | 4 | 2 |
| `log_workout` | health | 175 | 105 | 4 | 0 |
| `open_loop` | core | 266 | 416 | 3 | 7 |
| `propose_action` | core | 198 | 438 | 3 | 0 |
| `propose_calendar_change` | calendar | 904 | 640 | 16 | 6 |
| `propose_google_task_change` | calendar | 390 | 413 | 7 | 0 |
| `query_availability` | calendar | 786 | 884 | 5 | 6 |
| `query_calendar` | core | 520 | 508 | 8 | 15 |
| `raise_approval` | actions | 336 | 660 | 3 | 0 |
| `read_artifact` | artifacts | 125 | 162 | 3 | 0 |
| `read_drive` | web | 399 | 519 | 8 | 0 |
| `read_mcp_tool` | web | 290 | 582 | 4 | 0 |
| `read_memory` | core | 173 | 144 | 5 | 3 |
| `read_thread` | core | 406 | 1024 | 6 | 15 |
| `read_tool_output` | memory | 131 | 210 | 3 | 0 |
| `record_owner_finding` | memory | 286 | 628 | 4 | 0 |
| `remember` | core | 427 | 1017 | 6 | 5 |
| `revise_artifact` | artifacts | 143 | 191 | 3 | 0 |
| `search_communication` | core | 467 | 475 | 5 | 19 |
| `search_contacts` | mail | 212 | 426 | 3 | 0 |
| `search_episodes` | memory | 454 | 596 | 4 | 2 |
| `search_history` | memory | 517 | 518 | 6 | 0 |
| `send_console_link` | settings | 207 | 707 | 0 | 0 |
| `send_email` | mail | 634 | 971 | 9 | 2 |
| `send_message` | actions | 129 | 125 | 3 | 0 |
| `set_proactivity` | settings | 309 | 334 | 4 | 3 |
| `set_reminder` | core | 207 | 153 | 4 | 17 |
| `set_schedule_preference` | settings | 343 | 327 | 3 | 0 |
| `set_standing_order` | settings | 348 | 292 | 6 | 0 |
| `skills_disable` | skills | 139 | 252 | 2 | 0 |
| `skills_install` | skills | 139 | 252 | 2 | 0 |
| `skills_list` | skills | 68 | 156 | 0 | 0 |
| `skills_load` | core | 105 | 119 | 2 | 0 |
| `start_task` | reminders | 236 | 240 | 6 | 1 |
| `use_mac` | actions | 374 | 340 | 8 | 0 |
| `web_search` | core | 93 | 119 | 2 | 21 |
| `workspace_list` | workspace | 102 | 124 | 3 | 0 |
| `workspace_read` | workspace | 138 | 141 | 4 | 0 |
| `workspace_render` | workspace | 248 | 458 | 5 | 0 |
| `workspace_search` | workspace | 138 | 243 | 3 | 0 |
| `workspace_write` | workspace | 304 | 597 | 5 | 1 |

## Appendix B. Records not offered in that fixture (34)

- **Surface or turn-kind only:**
  - `send_progress_note`, `owner_message_heard`, `attach_file`, `approve_shown` and `update_todo`;
  - `react_to_message` (a verified iMessage tapback turn; measured above).
- **Flag-gated or not wired for this owner:**
  - Health and medicines: `get_crs`, `get_screen_time`, `get_master_metrics`, `set_sleep_need`, `track_medication`, `log_medication`, `list_medications` and `stop_medication`.
  - Mail: `send_agent_mail`.
  - Web: `read_document` and `search_mcp_tools`.
  - Planning and skills: `propose_schedule` and `search_tools`.
  - Responsibilities: `track_responsibility`, `list_responsibilities` and `close_responsibility`.
- **No live handler:** `search_connector`, `execute_action`, `write_task`, `update_task`, `draft_document`, `write_sheet_cell`, `execute_code`, `create_thread`, `delete_message`, `restore_message`, `archive_thread` and `update_thread_topics`.

These are not measured here. A slice that touches one of them measures it in its own PR.
