import type { ToolName } from '@waldo/contracts';

// Which effect a tool's receipt can back in a "done" claim. null = the tool has no claimable
// effect (a read, a lookup, or a proposal that changes nothing). Typed over every tool name, so
// adding a tool without deciding its effect fails the build, and the test checks the same list.
export const TOOL_CLAIM_EFFECT: Readonly<Record<ToolName, string | null>> = {
  get_crs: null, get_health: null, query_calendar: null, get_communication: null, search_communication: null,
  read_thread: null, get_tasks: null, get_master_metrics: null, get_context: null, query_availability: null,
  read_owner_context: null, read_memory: null, search_episodes: null, propose_action: null, web_search: null,
  read_document: null, list_artifacts: null, read_artifact: null, read_mcp_tool: null, read_drive: null,
  search_connector: null, propose_schedule: null, search_tools: null, list_reminders: null,
  read_tool_output: null, connect_service: null, browse_page: null, list_health_logs: null, list_standing_orders: null,
  workspace_list: null, workspace_read: null, workspace_search: null, skills_list: null,
  // Loading selects ephemeral catalog metadata; it does not certify instruction admission.
  skills_install: 'skill_enabled', skills_disable: 'skill_disabled', skills_load: 'skill_selected',
  // Verified against the handler in this tree (mutates_state: true, and the result says what happened).
  // Proposals are labelled as proposals: the owner-channel handlers only request an approval card.
  send_message: 'message_send_proposed', send_email: 'email_send_proposed', propose_calendar_change: 'calendar_change_proposed',
  draft_email: 'email_drafted', create_artifact: 'artifact_created', revise_artifact: 'artifact_revised', export_artifact: 'artifact_exported',
  browse_act: 'browser_acted', workspace_write: 'workspace_file_written', workspace_render: 'workspace_document_rendered', set_reminder: 'reminder_set', cancel_reminder: 'reminder_cancelled',
  open_loop: 'loop_opened', close_loop: 'loop_closed', track_responsibility: 'responsibility_tracked', update_todo: 'todo_updated', list_responsibilities: null, close_responsibility: 'responsibility_closed', set_proactivity: 'proactivity_set', set_schedule_preference: 'schedule_preference_set', log_meal: 'meal_logged', log_workout: 'workout_logged',
  set_standing_order: 'standing_order_set', cancel_standing_order: 'standing_order_cancelled',
  // null on purpose. call_mcp_tool proposes a card on the owner channel and executes directly elsewhere, so no single
  // effect holds. delegate_task runs a read-only subagent. The rest have no live handler in this tree
  // (memory writes go through the memory path), so their effect is unverified: give each a label when its handler ships.
  remember: 'memory_stored', forget_memory: 'memory_forgotten',
  call_mcp_tool: null, delegate_task: null, update_memory: null, execute_action: null, write_task: null, update_task: null,
  draft_document: null, write_sheet_cell: null, execute_code: null, create_thread: null, delete_message: null, restore_message: null,
  archive_thread: null, update_thread_topics: null,
};
