import type { LLMRequest, LLMTool, ToolName } from '@waldo/contracts';

// Where a tool sits on the brain's surface. Core tools are loaded every round. Every other tool sits in a namespace the
// model loads through the provider's tool search when a task needs it, so a round carries the core definitions and one
// line per namespace instead of every schema. OpenAI's tool search guide asks for namespaces with clear, high-level
// descriptions and fewer than 10 functions each; Anthropic's asks to keep the most used tools non-deferred.
export const BRAIN_NAMESPACES = {
  calendar: 'Calendar changes and Google Tasks: free and busy time across all calendars, propose_calendar_change to add, move or cancel an event, and reading or changing Google Tasks.',
  mail: 'Mail beyond search: read a whole message, send_email to propose an email the owner approves on a card, draft_email for a Gmail draft they edit themselves, and contacts.',
  web: 'Acting on web pages and connected sources: browse_act to set dates, guests or filters on an open page or watch a transcript, Drive files, documents, connected MCP tools, and get_weather for the forecast and daylight hours.',
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

// What a crash between a tool's effect and the turn's persisted completion means for that tool.
//  safe_read              re-running is harmless.
//  provider_idempotent    the write carries a key the receiving store collapses (same key, one effect).
//  reconcilable_write     a re-run can duplicate, but a lookup (message id, dedupe key, revision) can tell
//                         whether the effect landed, so reconcile before retrying.
//  non_replayable_uncertain  never auto-retry; tell the owner the effect may or may not have happened.
// A local receipt key alone cannot make a REMOTE effect exactly-once across a crash before persistence,
// so a tool only gets provider_idempotent where the key reaches the store that dedupes.
// Anything not inspected is non_replayable_uncertain on purpose: the safe default, and `basis` says why.
export type ToolReplayClass = 'safe_read' | 'provider_idempotent' | 'reconcilable_write' | 'non_replayable_uncertain';
// evidence: a source file under src/ and a string it must contain, so a class that claims a key or a lookup is checked against the code.
export type ToolReplayRow = { readonly replay: ToolReplayClass; readonly basis: string; readonly evidence?: { readonly file: string; readonly needle: string } };

// One record per tool, so adding a tool fails the build until someone decides each of these:
//  brain   where it sits on the brain's surface: loaded every round, or in a namespace loaded through tool search.
//  scope   the owner's "use only the text I pasted" limit. deny = brings in material from outside the pasted text
//          (mail, calendar, files, web, stored memory/context/notes/tasks/health, earlier tool output, browsing, MCP);
//          allow = reads no owner or outside content: the clock, the owner's own reminder and standing-order lists
//          (needed to act on what the owner asks), tool and skill catalog metadata, and writers and proposals that read
//          nothing back.
//  claim   which effect the tool's receipt can back in a "done" claim; null = no claimable effect (a read, a lookup,
//          or a proposal that changes nothing).
//  replay  what a crash between its effect and the turn's persisted completion means, and why (`basis`).
export type ToolRecord = Readonly<{ brain: BrainPlacement; scope: 'deny' | 'allow'; claim: string | null; replay: ToolReplayRow }>;

const read = (basis = 'no claimable effect; handler only reads'): ToolReplayRow => ({ replay: 'safe_read', basis });
const unknown = (basis: string): ToolReplayRow => ({ replay: 'non_replayable_uncertain', basis });
const NOT_INSPECTED = 'local owner-DO write; key and duplicate behavior not inspected';
const NO_HANDLER = 'no live handler in this tree (see TOOL_CLAIM_EFFECT)';

export const TOOL_RECORDS: Readonly<Record<ToolName, ToolRecord>> = {
  // claim null: a note says what the turn is doing, never that something is done; the effect claims stay with the tools that act.
  send_progress_note: { brain: 'actions', scope: 'allow', claim: null, replay: unknown('sends a note straight to the owner chat with no send key; a re-run sends it again') },
  // claim null: queued is not sent; the file leaves after the reply is written, so no done-claim can rest on this receipt.
  attach_file: { brain: 'actions', scope: 'allow', claim: null, replay: unknown('queues the file; the send after the reply is keyed only in the local effect ledger, WhatsApp cannot be asked whether an upload landed, so an unknown send is never retried') },
  // claim null: its not-sent outcomes are ok results too, so a done label would claim a send that never happened.
  send_console_link: { brain: 'settings', scope: 'allow', claim: null, replay: unknown('mints the one console grant and sends it; a re-run voids the link already sent, so it never auto-retries') },
  use_mac: { brain: 'actions', scope: 'deny', claim: 'mac_action_requested', replay: { replay: 'provider_idempotent', basis: 'The stable request_id reaches DeviceCommandStore and never reissues a started Mac effect.', evidence: { file: 'tools/live/use-mac.ts', needle: 'request_id' } } },
  get_crs: { brain: 'health', scope: 'deny', claim: null, replay: read() },
  get_health: { brain: 'core', scope: 'deny', claim: null, replay: read() },
  query_calendar: { brain: 'core', scope: 'deny', claim: null, replay: read() },
  get_communication: { brain: 'mail', scope: 'deny', claim: null, replay: read() },
  search_communication: { brain: 'core', scope: 'deny', claim: null, replay: read() },
  search_contacts: { brain: 'mail', scope: 'deny', claim: null, replay: read() },
  read_thread: { brain: 'core', scope: 'deny', claim: null, replay: read() },
  get_tasks: { brain: 'calendar', scope: 'deny', claim: null, replay: read() },
  get_master_metrics: { brain: 'health', scope: 'deny', claim: null, replay: read() },
  get_context: { brain: 'core', scope: 'allow', claim: null, replay: read('pure clock read (tools/live/get-context.ts)') },
  query_availability: { brain: 'calendar', scope: 'deny', claim: null, replay: read() },
  read_owner_context: { brain: 'memory', scope: 'deny', claim: null, replay: read() },
  read_memory: { brain: 'core', scope: 'deny', claim: null, replay: read() },
  search_episodes: { brain: 'memory', scope: 'deny', claim: null, replay: read() },
  // core: the route for a privileged call whose arguments came from outside; the refusal that names it must find it loaded.
  propose_action: { brain: 'core', scope: 'allow', claim: null, replay: unknown('proposal only: each call inserts a fresh tainted_action card; approval replays the frozen call once under the approval effect key, and a re-run raises a second card') },
  web_search: { brain: 'core', scope: 'deny', claim: null, replay: read() },
  get_weather: { brain: 'web', scope: 'deny', claim: null, replay: read() },
  read_document: { brain: 'web', scope: 'deny', claim: null, replay: read() },
  list_artifacts: { brain: 'artifacts', scope: 'deny', claim: null, replay: read() },
  read_artifact: { brain: 'artifacts', scope: 'deny', claim: null, replay: read() },
  read_mcp_tool: { brain: 'web', scope: 'deny', claim: null, replay: read('deploy-configured Google MCP reads carry a host-derived read intent through the connector-proxy; reads on owner-connected servers run only for tools the owner allowed at their current definition digest and have no intent ledger, so a replay runs the read again (tools/live/mcp.ts); either way the remote server is trusted to be read-only') },
  search_mcp_tools: { brain: 'web', scope: 'deny', claim: null, replay: read('searches stored tool definitions, refreshing a stale list with tools/list; runs no server tool') },
  read_drive: { brain: 'web', scope: 'deny', claim: null, replay: read() },
  search_connector: { brain: 'web', scope: 'deny', claim: null, replay: unknown(NO_HANDLER + ' (schema only)') },
  propose_schedule: { brain: 'calendar', scope: 'allow', claim: null, replay: unknown('proposal handler not inspected') },
  search_tools: { brain: 'skills', scope: 'allow', claim: null, replay: read() },
  list_reminders: { brain: 'reminders', scope: 'allow', claim: null, replay: read() },
  read_tool_output: { brain: 'memory', scope: 'deny', claim: null, replay: read() },
  connect_service: { brain: 'core', scope: 'allow', claim: null, replay: unknown('starts a connection flow; not inspected') },
  browse_page: { brain: 'core', scope: 'deny', claim: null, replay: read('starts and ends a vendor browser session and reads a public page; page-load side effects not verifiable') },
  list_health_logs: { brain: 'health', scope: 'deny', claim: null, replay: read() },
  list_standing_orders: { brain: 'settings', scope: 'allow', claim: null, replay: read() },
  workspace_list: { brain: 'workspace', scope: 'deny', claim: null, replay: read() },
  workspace_read: { brain: 'workspace', scope: 'deny', claim: null, replay: read() },
  workspace_search: { brain: 'workspace', scope: 'deny', claim: null, replay: read() },
  skills_list: { brain: 'skills', scope: 'allow', claim: null, replay: read() },
  // claim: loading selects ephemeral catalog metadata; it does not certify instruction admission.
  skills_install: { brain: 'skills', scope: 'allow', claim: 'skill_enabled', replay: unknown(NOT_INSPECTED) },
  skills_disable: { brain: 'skills', scope: 'allow', claim: 'skill_disabled', replay: unknown(NOT_INSPECTED) },
  skills_load: { brain: 'skills', scope: 'allow', claim: 'skill_selected', replay: unknown(NOT_INSPECTED) },
  // claim: verified against each handler (mutates_state, and the result says what happened). Proposals are labelled as
  // proposals: the owner-channel handlers only request an approval card.
  send_message: { brain: 'actions', scope: 'allow', claim: 'message_send_proposed', replay: unknown('proposal only, but each call inserts a fresh ledger row and card; the model-supplied idempotency_key collapses only at approval after status done (approvals.ts). A crash after the send and before done can resend. No lookup reconciles it') },
  send_email: { brain: 'mail', scope: 'allow', claim: 'email_send_proposed', replay: { replay: 'reconcilable_write', basis: 'proposal only; a replay of the same turn+args reuses the proposal through dedupe_key, and the desk reconciles an ambiguous send through the Message-ID it sets', evidence: { file: 'tools/live/google.ts', needle: 'dedupe_key' } } },
  propose_calendar_change: { brain: 'calendar', scope: 'allow', claim: 'calendar_change_proposed', replay: unknown('proposal desk dedupe not inspected') },
  propose_google_task_change: { brain: 'calendar', scope: 'deny', claim: 'google_task_change_proposed', replay: unknown('exact provider proposal and shared approval receipt required') },
  draft_email: { brain: 'mail', scope: 'allow', claim: 'email_drafted', replay: { replay: 'non_replayable_uncertain', basis: 'proxy intent id from user+turn+toolCall: a replay returns the stored result or intent_pending; an uncertain dispatch stays pending and there is no remote draft lookup', evidence: { file: 'connectors/proxy-intent.ts', needle: 'intent_pending' } } },
  create_artifact: { brain: 'artifacts', scope: 'allow', claim: 'artifact_created', replay: unknown(NOT_INSPECTED) },
  revise_artifact: { brain: 'artifacts', scope: 'allow', claim: 'artifact_revised', replay: unknown(NOT_INSPECTED) },
  export_artifact: { brain: 'artifacts', scope: 'allow', claim: 'artifact_exported', replay: unknown(NOT_INSPECTED) },
  browse_act: { brain: 'web', scope: 'deny', claim: 'browser_acted', replay: unknown('real browser actions on a public page; page effects cannot be reconciled') },
  workspace_write: { brain: 'workspace', scope: 'allow', claim: 'workspace_file_written', replay: { replay: 'provider_idempotent', basis: 'operation_id derived from user+turn+toolCall plus expected_revision; collapse is at the workspace store, not a remote provider', evidence: { file: 'tools/live/workspace.ts', needle: 'operation_id' } } },
  workspace_render: { brain: 'workspace', scope: 'allow', claim: 'workspace_document_rendered', replay: unknown('not inspected') },
  set_reminder: { brain: 'core', scope: 'allow', claim: 'reminder_set', replay: unknown(NOT_INSPECTED) },
  cancel_reminder: { brain: 'reminders', scope: 'allow', claim: 'reminder_cancelled', replay: unknown(NOT_INSPECTED) },
  open_loop: { brain: 'core', scope: 'allow', claim: 'loop_opened', replay: unknown(NOT_INSPECTED) },
  close_loop: { brain: 'reminders', scope: 'allow', claim: 'loop_closed', replay: unknown(NOT_INSPECTED) },
  raise_approval: { brain: 'actions', scope: 'allow', claim: null, replay: unknown(NOT_INSPECTED) },
  track_responsibility: { brain: 'reminders', scope: 'allow', claim: 'responsibility_tracked', replay: unknown(NOT_INSPECTED) },
  update_todo: { brain: 'actions', scope: 'allow', claim: 'todo_updated', replay: unknown(NOT_INSPECTED) },
  list_responsibilities: { brain: 'reminders', scope: 'allow', claim: null, replay: read() },
  close_responsibility: { brain: 'reminders', scope: 'allow', claim: 'responsibility_closed', replay: unknown(NOT_INSPECTED) },
  set_proactivity: { brain: 'settings', scope: 'allow', claim: 'proactivity_set', replay: unknown(NOT_INSPECTED) },
  set_schedule_preference: { brain: 'settings', scope: 'allow', claim: 'schedule_preference_set', replay: unknown(NOT_INSPECTED) },
  log_meal: { brain: 'health', scope: 'allow', claim: 'meal_logged', replay: unknown(NOT_INSPECTED) },
  log_workout: { brain: 'health', scope: 'allow', claim: 'workout_logged', replay: unknown(NOT_INSPECTED) },
  set_standing_order: { brain: 'settings', scope: 'allow', claim: 'standing_order_set', replay: unknown(NOT_INSPECTED) },
  cancel_standing_order: { brain: 'settings', scope: 'allow', claim: 'standing_order_cancelled', replay: unknown(NOT_INSPECTED) },
  // claim null: proposes a card on the owner channel and executes directly elsewhere, so no single effect holds.
  call_mcp_tool: { brain: 'web', scope: 'deny', claim: null, replay: unknown('proposes a card on the owner channel, executes directly elsewhere; remote effect unknown') },
  // scope allow: the source guard is applied to the child's handlers too. claim null: it runs a read-only subagent.
  delegate_task: { brain: 'actions', scope: 'allow', claim: null, replay: read('runs a read-only subagent (TOOL_CLAIM_EFFECT comment)') },
  remember: { brain: 'core', scope: 'allow', claim: 'memory_stored', replay: { replay: 'reconcilable_write', basis: 'owner-local active claims dedupe by kind/text and corrections record supersedes_id', evidence: { file: 'tools/live/memory.ts', needle: 'supersedes_id' } } },
  forget_memory: { brain: 'memory', scope: 'allow', claim: 'memory_forgotten', replay: unknown('local forget plus retained history cleanup; reconcile scope before retrying') },
  // No live handler in this tree, so the effect is unverified: give each a claim label when its handler ships.
  execute_action: { brain: 'actions', scope: 'allow', claim: null, replay: unknown(NO_HANDLER) },
  write_task: { brain: 'calendar', scope: 'allow', claim: null, replay: unknown(NO_HANDLER) },
  update_task: { brain: 'calendar', scope: 'allow', claim: null, replay: unknown(NO_HANDLER) },
  draft_document: { brain: 'artifacts', scope: 'allow', claim: null, replay: unknown(NO_HANDLER) },
  write_sheet_cell: { brain: 'artifacts', scope: 'allow', claim: null, replay: unknown(NO_HANDLER) },
  execute_code: { brain: 'actions', scope: 'allow', claim: null, replay: unknown(NO_HANDLER) },
  create_thread: { brain: 'memory', scope: 'allow', claim: null, replay: unknown(NO_HANDLER) },
  delete_message: { brain: 'mail', scope: 'allow', claim: null, replay: unknown(NO_HANDLER) },
  restore_message: { brain: 'mail', scope: 'allow', claim: null, replay: unknown(NO_HANDLER) },
  archive_thread: { brain: 'mail', scope: 'allow', claim: null, replay: unknown(NO_HANDLER) },
  update_thread_topics: { brain: 'memory', scope: 'allow', claim: null, replay: unknown(NO_HANDLER) },
};

// A column of the records as its own table, for the callers that read one decision.
export const toolRecordColumn = <K extends keyof ToolRecord>(column: K): Readonly<Record<ToolName, ToolRecord[K]>> =>
  Object.fromEntries(Object.entries(TOOL_RECORDS).map(([name, record]) => [name, record[column]])) as Record<ToolName, ToolRecord[K]>;

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
