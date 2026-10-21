import type { LLMRequest, LLMTool, ToolName } from '@waldo/contracts';

// Where a tool sits on the brain's surface. Core tools are loaded every round. Every other tool sits in a namespace the
// model loads through the provider's tool search when a task needs it, so a round carries the core definitions and one
// line per namespace instead of every schema. OpenAI's tool search guide asks for namespaces with clear, high-level
// descriptions and fewer than 10 functions each; Anthropic's asks to keep the most used tools non-deferred.
export const BRAIN_NAMESPACES = {
  calendar: 'Calendar changes and Google Tasks: free and busy time across all calendars, propose_calendar_change to add, move or cancel an event, and reading or changing Google Tasks.',
  mail: 'Mail beyond search: read a whole message, send_email to propose an email the owner approves on a card, draft_email for a Gmail draft they edit themselves, and contacts.',
  web: 'Acting on web pages and connected sources: browse_act to set dates, guests or filters on an open page or watch a transcript, Drive files, documents and connected MCP tools.',
  memory: 'Memory upkeep and history: forget_memory when the owner asks to forget something, memory about one topic with its evidence, past conversations, stored tool output and chat threads.',
  health: "Health logs and scores: log a meal or workout, list what was logged, and the owner's derived scores.",
  reminders: 'Follow-ups: list or cancel reminders, close an open loop when it is done, and tracked responsibilities.',
  settings: 'How Waldo works for the owner: set_proactivity for quiet hours and how often to reach out, set_schedule_preference for scheduled behaviours, standing orders, and send_console_link for the console.',
  skills: 'Reviewed skills: list, load, install or disable a skill, and search the tool catalog.',
  workspace: "The owner's workspace files: list, read, search, write and render them.",
  artifacts: 'Documents Waldo makes: create, revise, export, list or read an artifact, a drafted document or a sheet cell.',
  actions: "Actions that reach beyond this chat: send_message for a message to someone else, a progress note, a file attachment, an approval card, the owner's Mac, a delegated research task, todos and code.",
} as const;
export type BrainNamespace = keyof typeof BRAIN_NAMESPACES;
export type BrainPlacement = 'core' | BrainNamespace;

export type ToolRecord = Readonly<{ brain: BrainPlacement }>;

// One record per tool: every tool name is placed, so adding a tool fails the build until someone decides.
export const TOOL_RECORDS: Readonly<Record<ToolName, ToolRecord>> = {
  get_context: { brain: 'core' }, read_memory: { brain: 'core' }, remember: { brain: 'core' }, web_search: { brain: 'core' },
  browse_page: { brain: 'core' }, query_calendar: { brain: 'core' }, search_communication: { brain: 'core' }, read_thread: { brain: 'core' },
  get_health: { brain: 'core' }, set_reminder: { brain: 'core' }, open_loop: { brain: 'core' }, connect_service: { brain: 'core' },
  // The route for a privileged call whose arguments came from outside; the refusal that names it must find it loaded.
  propose_action: { brain: 'core' },

  query_availability: { brain: 'calendar' }, propose_calendar_change: { brain: 'calendar' }, get_tasks: { brain: 'calendar' },
  propose_google_task_change: { brain: 'calendar' }, propose_schedule: { brain: 'calendar' }, write_task: { brain: 'calendar' }, update_task: { brain: 'calendar' },

  get_communication: { brain: 'mail' }, send_email: { brain: 'mail' }, draft_email: { brain: 'mail' }, search_contacts: { brain: 'mail' },
  archive_thread: { brain: 'mail' }, delete_message: { brain: 'mail' }, restore_message: { brain: 'mail' },

  browse_act: { brain: 'web' }, read_drive: { brain: 'web' }, read_document: { brain: 'web' }, search_connector: { brain: 'web' },
  call_mcp_tool: { brain: 'web' }, read_mcp_tool: { brain: 'web' },

  forget_memory: { brain: 'memory' }, read_owner_context: { brain: 'memory' }, search_episodes: { brain: 'memory' }, read_tool_output: { brain: 'memory' },
  create_thread: { brain: 'memory' }, update_thread_topics: { brain: 'memory' },

  log_meal: { brain: 'health' }, log_workout: { brain: 'health' }, list_health_logs: { brain: 'health' }, get_crs: { brain: 'health' }, get_master_metrics: { brain: 'health' },

  list_reminders: { brain: 'reminders' }, cancel_reminder: { brain: 'reminders' }, close_loop: { brain: 'reminders' },
  track_responsibility: { brain: 'reminders' }, close_responsibility: { brain: 'reminders' }, list_responsibilities: { brain: 'reminders' },

  set_proactivity: { brain: 'settings' }, set_schedule_preference: { brain: 'settings' }, send_console_link: { brain: 'settings' },
  set_standing_order: { brain: 'settings' }, list_standing_orders: { brain: 'settings' }, cancel_standing_order: { brain: 'settings' },

  skills_list: { brain: 'skills' }, skills_install: { brain: 'skills' }, skills_disable: { brain: 'skills' }, skills_load: { brain: 'skills' }, search_tools: { brain: 'skills' },

  workspace_list: { brain: 'workspace' }, workspace_read: { brain: 'workspace' }, workspace_search: { brain: 'workspace' },
  workspace_write: { brain: 'workspace' }, workspace_render: { brain: 'workspace' },

  create_artifact: { brain: 'artifacts' }, revise_artifact: { brain: 'artifacts' }, export_artifact: { brain: 'artifacts' }, list_artifacts: { brain: 'artifacts' },
  read_artifact: { brain: 'artifacts' }, draft_document: { brain: 'artifacts' }, write_sheet_cell: { brain: 'artifacts' },

  send_message: { brain: 'actions' }, send_progress_note: { brain: 'actions' }, attach_file: { brain: 'actions' }, raise_approval: { brain: 'actions' },
  use_mac: { brain: 'actions' }, delegate_task: { brain: 'actions' }, execute_action: { brain: 'actions' }, execute_code: { brain: 'actions' }, update_todo: { brain: 'actions' },
};

// The brain's tool list with each tool's place on the surface: core tools as they are, the rest named into their
// namespace and deferred, and the routing line of each namespace in use. A name outside the record (a test double) stays
// core. Off, the list goes as it is, every tool up front.
export const brainTools = (tools: readonly LLMTool[], toolSearch: boolean): Pick<LLMRequest, 'tools' | 'tool_search'> => {
  if (!toolSearch) return { tools: [...tools] };
  const placed = tools.map((tool) => {
    const placement = (TOOL_RECORDS as Partial<Record<string, ToolRecord>>)[tool.name]?.brain ?? 'core';
    return placement === 'core' ? tool : { ...tool, namespace: placement, defer_loading: true };
  });
  const used = [...new Set(placed.flatMap((tool) => tool.namespace ? [tool.namespace as BrainNamespace] : []))];
  return { tools: placed, tool_search: { namespaces: Object.fromEntries(used.map((name) => [name, BRAIN_NAMESPACES[name]])) } };
};
