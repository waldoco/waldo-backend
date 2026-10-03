import type { ToolName } from '@waldo/contracts';

// What a crash between a tool's effect and the turn's persisted completion means for that tool.
// This is a reviewed table only. Nothing reads it at runtime yet, so no behavior or prompt changes.
//  safe_read              re-running is harmless.
//  provider_idempotent    the write carries a key the receiving store collapses (same key, one effect).
//  reconcilable_write     a re-run can duplicate, but a lookup (message id, dedupe key, revision) can tell
//                         whether the effect landed, so reconcile before retrying.
//  non_replayable_uncertain  never auto-retry; tell the owner the effect may or may not have happened.
// A local receipt key alone cannot make a REMOTE effect exactly-once across a crash before persistence,
// so a tool only gets provider_idempotent where the key reaches the store that dedupes.
// Anything not inspected is non_replayable_uncertain on purpose: the safe default, and `basis` says why.
export type ToolReplayClass = 'safe_read' | 'provider_idempotent' | 'reconcilable_write' | 'non_replayable_uncertain';
export type ToolReplayRow = { readonly replay: ToolReplayClass; readonly basis: string };

const read = (basis = 'no claimable effect; handler only reads'): ToolReplayRow => ({ replay: 'safe_read', basis });
const unknown = (basis: string): ToolReplayRow => ({ replay: 'non_replayable_uncertain', basis });
const NOT_INSPECTED = 'local owner-DO write; key and duplicate behavior not inspected';
const NO_HANDLER = 'no live handler in this tree (see TOOL_CLAIM_EFFECT)';

export const TOOL_REPLAY_CLASS: Readonly<Record<ToolName, ToolReplayRow>> = {
  get_crs: read(), get_health: read(), query_calendar: read(), get_communication: read(), search_communication: read(),
  read_thread: read(), get_tasks: read(), get_master_metrics: read(), get_context: read(), query_availability: read(),
  read_owner_context: read(), read_memory: read(), search_episodes: read(), propose_action: unknown('proposal handler not inspected'),
  web_search: read(), read_document: read(), list_artifacts: read(), read_artifact: read(), read_mcp_tool: read(),
  read_drive: read(), search_connector: read(), propose_schedule: unknown('proposal handler not inspected'), search_tools: read(),
  list_reminders: read(), read_tool_output: read(), connect_service: unknown('starts a connection flow; not inspected'),
  browse_page: read(), list_health_logs: read(), list_standing_orders: read(), workspace_list: read(), workspace_read: read(), skills_list: read(),
  skills_install: unknown(NOT_INSPECTED), skills_disable: unknown(NOT_INSPECTED), skills_load: unknown(NOT_INSPECTED),
  send_message: { replay: 'provider_idempotent', basis: 'proposal only on the owner channel; the approval desk collapses a second approval on idempotency_key (messaging.ts comment, ADR-0054). Key is required by the send_message schema (contracts writes.ts)' },
  send_email: { replay: 'reconcilable_write', basis: 'proposal only; the desk reconciles an ambiguous send through the Message-ID it sets (google.ts comment)' },
  propose_calendar_change: unknown('proposal desk dedupe not inspected'),
  draft_email: { replay: 'reconcilable_write', basis: 'local dedupe_key over user+turn+args (google.ts); remote draft lookup not verified' },
  create_artifact: unknown(NOT_INSPECTED), revise_artifact: unknown(NOT_INSPECTED), export_artifact: unknown(NO_HANDLER + '; export path is dormant'),
  browse_act: unknown('real browser actions on a public page; page effects cannot be reconciled'),
  workspace_write: { replay: 'provider_idempotent', basis: 'operation_id derived from user+turn+toolCall plus expected_revision (workspace.ts); same operation collapses' },
  workspace_render: unknown('not inspected'),
  set_reminder: unknown(NOT_INSPECTED), cancel_reminder: unknown(NOT_INSPECTED),
  open_loop: unknown(NOT_INSPECTED), close_loop: unknown(NOT_INSPECTED), set_proactivity: unknown(NOT_INSPECTED),
  log_meal: unknown(NOT_INSPECTED), log_workout: unknown(NOT_INSPECTED),
  set_standing_order: unknown(NOT_INSPECTED), cancel_standing_order: unknown(NOT_INSPECTED),
  call_mcp_tool: unknown('proposes a card on the owner channel, executes directly elsewhere; remote effect unknown'),
  delegate_task: read('runs a read-only subagent (TOOL_CLAIM_EFFECT comment)'),
  update_memory: unknown(NO_HANDLER), execute_action: unknown(NO_HANDLER), write_task: unknown(NO_HANDLER), update_task: unknown(NO_HANDLER),
  draft_document: unknown(NO_HANDLER), write_sheet_cell: unknown(NO_HANDLER), execute_code: unknown(NO_HANDLER),
  create_thread: unknown(NO_HANDLER), delete_message: unknown(NO_HANDLER), restore_message: unknown(NO_HANDLER),
  archive_thread: unknown(NO_HANDLER), update_thread_topics: unknown(NO_HANDLER),
};
