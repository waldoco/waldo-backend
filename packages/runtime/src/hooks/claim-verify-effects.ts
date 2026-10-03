import type { ToolName } from '@waldo/contracts';

// Which effect a tool's receipt can back in a "done" claim. null = the tool has no claimable
// effect (a read, a lookup, or a proposal that changes nothing). Typed over every tool name, so
// adding a tool without deciding its effect fails the build, and the test checks the same list.
export const TOOL_CLAIM_EFFECT: Readonly<Record<ToolName, string | null>> = {
  get_crs: null, get_health: null, query_calendar: null, get_communication: null, search_communication: null,
  read_thread: null, get_tasks: null, get_master_metrics: null, get_context: null, query_availability: null,
  read_owner_context: null, read_memory: null, search_episodes: null, propose_action: null, web_search: null,
  read_document: null, list_artifacts: null, read_artifact: null, read_mcp_tool: null, read_drive: null,
  search_connector: null, propose_schedule: null, search_tools: null, list_reminders: null, propose_calendar_change: null,
  read_tool_output: null, connect_service: null, browse_page: null, list_health_logs: null, list_standing_orders: null,
  workspace_list: null, workspace_read: null,
  update_memory: 'memory_updated', execute_action: 'action_executed', send_message: 'message_sent',
  call_mcp_tool: 'mcp_tool_called', write_task: 'task_written', update_task: 'task_updated',
  draft_document: 'document_drafted', create_artifact: 'artifact_created', revise_artifact: 'artifact_revised',
  export_artifact: 'artifact_exported', draft_email: 'email_drafted', send_email: 'email_sent',
  write_sheet_cell: 'sheet_cell_written', execute_code: 'code_executed', create_thread: 'thread_created',
  delete_message: 'message_deleted', restore_message: 'message_restored', archive_thread: 'thread_archived',
  update_thread_topics: 'thread_topics_updated', set_reminder: 'reminder_set', cancel_reminder: 'reminder_cancelled',
  open_loop: 'loop_opened', close_loop: 'loop_closed', set_proactivity: 'proactivity_set', browse_act: 'browser_acted',
  delegate_task: 'task_delegated', log_meal: 'meal_logged', log_workout: 'workout_logged',
  set_standing_order: 'standing_order_set', cancel_standing_order: 'standing_order_cancelled', workspace_write: 'workspace_file_written',
};
