import type { LLMRequest, LLMTool, ToolName } from '@waldo/contracts';
import type { AppChatActivityKind } from '../../../contracts/src/app/core';

// Where a tool sits on the brain's surface. Core tools are loaded every round. Every other tool sits in a namespace the
// model loads through the provider's tool search when a task needs it, so a round carries the core definitions and one
// line per namespace instead of every schema. OpenAI's tool search guide asks for namespaces with clear, high-level
// descriptions and fewer than 10 functions each; Anthropic's asks to keep the most used tools non-deferred.
export const BRAIN_NAMESPACES = {
  calendar: 'Calendar changes and Google Tasks: free and busy time across all calendars, propose_calendar_change to add, move or cancel an event, and reading or changing Google Tasks.',
  mail: 'Mail beyond search: read a whole message, send_email to propose an email the owner approves on a card, draft_email for a Gmail draft they edit themselves, and contacts.',
  web: 'Acting on web pages and connected sources: browse_act to set dates, guests or filters on an open page or watch a transcript, Drive files, documents and connected MCP tools.',
  memory: 'Memory upkeep and history: forget_memory when the owner asks to forget something, list_owner_findings and record_owner_finding for what Waldo found about the owner on the public web, memory about one topic with its evidence, search_episodes for past conversations, read_tool_output for stored tool output, and chat threads.',
  health: "Health logs and scores: log a meal or workout, list what was logged, and the owner's derived scores.",
  reminders: 'Follow-ups and background work: start_task for long work that reports back later, list or cancel reminders, close_loop when an open loop is done, tracked responsibilities, and cancel_task to stop a background task.',
  settings: 'How Waldo works for the owner: set_proactivity for quiet hours and how often to reach out, set_schedule_preference for scheduled behaviours, standing orders, send_console_link for the console, and connect_app to connect one of the owner\'s apps.',
  skills: 'Reviewed skills: list, install or disable a skill, and search the tool catalog.',
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
//  concurrent  one model response may run it beside other concurrent reads: it changes nothing a later call can
//          observe (no store write that spans an await, no send, no session, no tool-menu change). The Google reads and
//          read_drive are: grant health, the circuit's probe stamp and the reconnect notice run one at a time on the owner
//          object's Google chain, a client's token refresh is shared by the calls waiting on it, and the legacy-grant
//          migration is shared by the reads that start it. read_thread's code relay goes to the owner alone and changes
//          nothing a call reads. The MCP reads are not: a call stamps its connection's token version and status after it
//          returns, a stale tool list is rewritten while sibling reads check its digests, and a server's question is stored.
//          read_tool_output reads a store sibling calls evict from.
//  probe   strip = a synthetic capture probe never reaches it: Google reads and writes (private data), the browser,
//          the MCP bridge, the connect flow and the console link (a capture probe hands its sends to the probe caller).
//  paid    held past the owner's monthly spend ceiling: it bills browser or sandbox time on top of the model call.
//  ownerTurnOnly  held only while the owner's own turn runs, never by a machine turn.
//  claim   which effect the tool's receipt can back in a "done" claim; null = no claimable effect (a read, a lookup,
//          or a proposal that changes nothing).
//  replay  what a crash between its effect and the turn's persisted completion means, and why (`basis`).
//  tainted why a tool with a claim needs no owner card in a turn that has read outside text. Absent, it needs one: the
//          owner ruled that such a turn sends every change to their card (hooks/registry.ts taintedCallNeedsOwnerApproval),
//          so a new write tool is carded until its record names a reason here. A record may instead name a refusal: such a
//          turn never runs or cards the call, because a card keeps its arguments in the owner's ledger.
export type ToolRecord = Readonly<{
  brain: BrainPlacement; scope: 'deny' | 'allow'; concurrent: boolean; probe: 'strip' | 'keep'; paid: boolean; ownerTurnOnly: boolean;
  claim: string | null; replay: ToolReplayRow; tainted?: TaintedWriteExemption | TaintedWriteRefusal;
}>;
// The kinds of reason, each with the record's own words for it:
//  draft          it sends and commits nothing; the owner reviews the result before anything leaves.
//  honest_origin  its handler keeps what a tainted turn writes as Waldo's read, with its source, never as the owner's word.
//  source_bound   a write bound to an observed mail source runs without a card; any other call to it is carded.
//  own_card       its handler only raises the owner's own approval card. The gate admits it through the handler's
//                 proposal_only declaration, read per call, so a host wiring an executing handler under the name is carded.
//  commits_on_card  a typed browser step that commits nothing (hooks/registry.ts NON_COMMITTING_BROWSER_OPERATIONS): the
//                 owner's browser host sends no request but GET and holds every submit for the owner's own browser card.
//                 Any other operation, or a call with no typed command, is carded.
// owner_statement  the tool takes only what the owner says to Waldo directly, and its arguments are a figure no card may hold
//                 (the owner's stated sleep need, a health value): a turn that has read outside text is refused the call.
export type TaintedWriteRefusal = Readonly<{ refused: 'owner_statement'; reason: string }>;
export type TaintedWriteExemption = Readonly<{ exempt: 'draft' | 'honest_origin' | 'source_bound' | 'own_card' | 'commits_on_card' | 'instructions_only'; reason: string }>;

const read = (basis = 'no claimable effect; handler only reads'): ToolReplayRow => ({ replay: 'safe_read', basis });
const unknown = (basis: string): ToolReplayRow => ({ replay: 'non_replayable_uncertain', basis });
const NOT_INSPECTED = 'local owner-DO write; key and duplicate behavior not inspected';
const NO_HANDLER = 'no live handler in this tree (see TOOL_CLAIM_EFFECT)';

export const TOOL_RECORDS: Readonly<Record<ToolName, ToolRecord>> = {
  // claim null: a note says what the turn is doing, never that something is done; the effect claims stay with the tools that act.
  send_progress_note: { brain: 'actions', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: true, claim: null, replay: unknown('sends a note straight to the owner chat with no send key; a re-run sends it again') },
  // claim null: queued is not sent; the file leaves after the reply is written, so no done-claim can rest on this receipt.
  // core: offered only on an iMessage owner turn whose host verified tapbacks, where a tapback is a reply the model makes in
  // passing, so it is never behind a search. claim null: queued is not sent; it leaves with the reply.
  react_to_message: { brain: 'core', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: true, claim: null, replay: { replay: 'provider_idempotent', basis: 'the commandId is fixed by the turn and the reaction, and the bridge mailbox and the host journal keep one command per commandId', evidence: { file: 'channels/imessage/final-outbox.ts', needle: 'wrx_' } } },
  attach_file: { brain: 'actions', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: true, claim: null, replay: unknown('queues the file; the send after the reply is keyed only in the local effect ledger, WhatsApp cannot be asked whether an upload landed, so an unknown send is never retried') },
  // claim null: its not-sent outcomes are ok results too, so a done label would claim a send that never happened.
  send_console_link: { brain: 'settings', scope: 'allow', concurrent: false, probe: 'strip', paid: false, ownerTurnOnly: false, claim: null, replay: unknown('mints the one console grant and sends it; a re-run voids the link already sent, so it never auto-retries') },
  connect_app: { brain: 'settings', scope: 'allow', concurrent: false, probe: 'strip', paid: false, ownerTurnOnly: true, claim: null, replay: unknown('starts one sign-in attempt and sends its link or code; a re-run starts another and the directory revokes the earlier link, so it never auto-retries') },
  use_mac: { brain: 'actions', scope: 'deny', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'mac_action_requested', replay: { replay: 'provider_idempotent', basis: 'The stable request_id reaches DeviceCommandStore and never reissues a started Mac effect.', evidence: { file: 'tools/live/use-mac.ts', needle: 'request_id' } } },
  get_crs: { brain: 'health', scope: 'deny', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  get_health: { brain: 'core', scope: 'deny', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  query_calendar: { brain: 'core', scope: 'deny', concurrent: true, probe: 'strip', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  get_communication: { brain: 'mail', scope: 'deny', concurrent: true, probe: 'strip', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  search_communication: { brain: 'core', scope: 'deny', concurrent: true, probe: 'strip', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  search_contacts: { brain: 'mail', scope: 'deny', concurrent: true, probe: 'strip', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  read_thread: { brain: 'core', scope: 'deny', concurrent: true, probe: 'strip', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  get_tasks: { brain: 'calendar', scope: 'deny', concurrent: true, probe: 'strip', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  get_master_metrics: { brain: 'health', scope: 'deny', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  get_context: { brain: 'core', scope: 'allow', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read('pure clock read (tools/live/get-context.ts)') },
  query_availability: { brain: 'calendar', scope: 'deny', concurrent: true, probe: 'strip', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  read_memory: { brain: 'core', scope: 'deny', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  search_episodes: { brain: 'memory', scope: 'deny', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  // core: the route for a privileged call whose arguments came from outside; the refusal that names it must find it loaded.
  propose_action: { brain: 'core', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: unknown('proposal only: each call inserts a fresh tainted_action card; approval replays the frozen call once under the approval effect key, and a re-run raises a second card') },
  web_search: { brain: 'core', scope: 'deny', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  read_document: { brain: 'web', scope: 'deny', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  list_artifacts: { brain: 'artifacts', scope: 'deny', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  read_artifact: { brain: 'artifacts', scope: 'deny', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  read_mcp_tool: { brain: 'web', scope: 'deny', concurrent: false, probe: 'strip', paid: false, ownerTurnOnly: false, claim: null, replay: read('deploy-configured Google MCP reads carry a host-derived read intent through the connector-proxy; reads on owner-connected servers run only for tools the owner allowed at their current definition digest (a read allowed by connecting from an official tile only in an untainted turn the owner started) and have no intent ledger, so a replay runs the read again (tools/live/mcp.ts); a tool that sends as the owner (mcp-catalogue sends_as_owner) is refused here and goes through call_mcp_tool; either way the remote server is trusted to be read-only') },
  search_mcp_tools: { brain: 'web', scope: 'deny', concurrent: false, probe: 'strip', paid: false, ownerTurnOnly: false, claim: null, replay: read('searches stored tool definitions, refreshing a stale list with tools/list; runs no server tool') },
  read_drive: { brain: 'web', scope: 'deny', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  search_connector: { brain: 'web', scope: 'deny', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: unknown(NO_HANDLER + ' (schema only)') },
  propose_schedule: { brain: 'calendar', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: unknown('proposal handler not inspected') },
  search_tools: { brain: 'skills', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  list_reminders: { brain: 'reminders', scope: 'allow', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  read_tool_output: { brain: 'memory', scope: 'deny', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  connect_service: { brain: 'core', scope: 'allow', concurrent: false, probe: 'strip', paid: false, ownerTurnOnly: false, claim: null, replay: unknown('starts a connection flow; not inspected') },
  browse_page: { brain: 'core', scope: 'deny', concurrent: false, probe: 'strip', paid: true, ownerTurnOnly: false, claim: null, replay: read('starts and ends a vendor browser session and reads a public page; page-load side effects not verifiable') },
  list_health_logs: { brain: 'health', scope: 'deny', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  list_standing_orders: { brain: 'settings', scope: 'allow', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  workspace_list: { brain: 'workspace', scope: 'deny', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  workspace_read: { brain: 'workspace', scope: 'deny', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  workspace_search: { brain: 'workspace', scope: 'deny', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  skills_list: { brain: 'skills', scope: 'allow', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  // claim: loading selects ephemeral catalog metadata; it does not certify instruction admission.
  skills_install: { brain: 'skills', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'skill_enabled', replay: unknown(NOT_INSPECTED) },
  skills_disable: { brain: 'skills', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'skill_disabled', replay: unknown(NOT_INSPECTED) },
  // core: a skill fits a turn the owner never shaped for it, so the model must be able to load one without a search first.
  skills_load: { brain: 'core', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'skill_selected', tainted: { exempt: 'instructions_only', reason: 'it selects reviewed instructions for this turn and grants no tool; each effect those instructions describe still meets its own gate' }, replay: unknown(NOT_INSPECTED) },
  // claim: verified against each handler (mutates_state, and the result says what happened). Proposals are labelled as
  // proposals: the owner-channel handlers only request an approval card.
  send_message: { brain: 'actions', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'message_send_proposed', tainted: { exempt: 'own_card', reason: 'its handler only proposes; the owner approves the exact change on its own card' }, replay: unknown('proposal only, but each call inserts a fresh ledger row and card; the model-supplied idempotency_key collapses only at approval after status done (approvals.ts). A crash after the send and before done can resend. No lookup reconciles it') },
  send_email: { brain: 'mail', scope: 'allow', concurrent: false, probe: 'strip', paid: false, ownerTurnOnly: false, claim: 'email_send_proposed', tainted: { exempt: 'own_card', reason: 'its handler only proposes; the owner approves the exact change on its own card' }, replay: { replay: 'reconcilable_write', basis: 'proposal only; a replay of the same turn+args reuses the proposal through dedupe_key, and the desk reconciles an ambiguous send through the Message-ID it sets', evidence: { file: 'tools/live/google.ts', needle: 'dedupe_key' } } },
  propose_calendar_change: { brain: 'calendar', scope: 'allow', concurrent: false, probe: 'strip', paid: false, ownerTurnOnly: false, claim: 'calendar_change_proposed', tainted: { exempt: 'own_card', reason: 'its handler only proposes; the owner approves the exact change on its own card' }, replay: unknown('proposal desk dedupe not inspected') },
  propose_google_task_change: { brain: 'calendar', scope: 'deny', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'google_task_change_proposed', tainted: { exempt: 'own_card', reason: 'its handler only proposes; the owner approves the exact change on its own card' }, replay: unknown('exact provider proposal and shared approval receipt required') },
  draft_email: { brain: 'mail', scope: 'allow', concurrent: false, probe: 'strip', paid: false, ownerTurnOnly: false, claim: 'email_drafted', tainted: { exempt: 'draft', reason: 'a Gmail draft sends nothing; the owner reviews and sends it themselves' }, replay: { replay: 'non_replayable_uncertain', basis: 'proxy intent id from user+turn+toolCall: a replay returns the stored result or intent_pending; an uncertain dispatch stays pending and there is no remote draft lookup', evidence: { file: 'connectors/proxy-intent.ts', needle: 'intent_pending' } } },
  create_artifact: { brain: 'artifacts', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'artifact_created', replay: unknown(NOT_INSPECTED) },
  revise_artifact: { brain: 'artifacts', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'artifact_revised', replay: unknown(NOT_INSPECTED) },
  export_artifact: { brain: 'artifacts', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'artifact_exported', replay: unknown(NOT_INSPECTED) },
  browse_act: { brain: 'web', scope: 'deny', concurrent: false, probe: 'strip', paid: true, ownerTurnOnly: false, claim: 'browser_acted', tainted: { exempt: 'commits_on_card', reason: 'its steps change only the page in Waldo\'s own browser; anything that would send or submit waits on the owner\'s browser card' }, replay: unknown('real browser actions on a public page; page effects cannot be reconciled') },
  workspace_write: { brain: 'workspace', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'workspace_file_written', replay: { replay: 'provider_idempotent', basis: 'operation_id derived from user+turn+toolCall plus expected_revision; collapse is at the workspace store, not a remote provider', evidence: { file: 'tools/live/workspace.ts', needle: 'operation_id' } } },
  workspace_render: { brain: 'workspace', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'workspace_document_rendered', replay: unknown('not inspected') },
  set_reminder: { brain: 'core', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'reminder_set', replay: unknown(NOT_INSPECTED) },
  cancel_reminder: { brain: 'reminders', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'reminder_cancelled', replay: unknown(NOT_INSPECTED) },
  open_loop: { brain: 'core', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'loop_opened', tainted: { exempt: 'source_bound', reason: 'the mail follow-through opens a loop on the mail source it observed; it only checks back, and its title never reads as the owner\'s' }, replay: unknown(NOT_INSPECTED) },
  close_loop: { brain: 'reminders', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'loop_closed', tainted: { exempt: 'source_bound', reason: 'a loop the mail follow-through opened from an observed source closes as it opened; the owner\'s own loops close only from their card' }, replay: unknown(NOT_INSPECTED) },
  raise_approval: { brain: 'actions', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: true, claim: null, replay: unknown(NOT_INSPECTED) },
  track_responsibility: { brain: 'reminders', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'responsibility_tracked', replay: unknown(NOT_INSPECTED) },
  update_todo: { brain: 'actions', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'todo_updated', replay: unknown(NOT_INSPECTED) },
  list_responsibilities: { brain: 'reminders', scope: 'allow', concurrent: true, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  close_responsibility: { brain: 'reminders', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'responsibility_closed', replay: unknown(NOT_INSPECTED) },
  set_proactivity: { brain: 'settings', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'proactivity_set', replay: unknown(NOT_INSPECTED) },
  set_schedule_preference: { brain: 'settings', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'schedule_preference_set', replay: unknown(NOT_INSPECTED) },
  log_meal: { brain: 'health', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'meal_logged', replay: unknown(NOT_INSPECTED) },
  log_workout: { brain: 'health', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'workout_logged', replay: unknown(NOT_INSPECTED) },
  set_sleep_need: { brain: 'health', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: true, claim: 'sleep_need_set', tainted: { refused: 'owner_statement', reason: 'the stated sleep need is a health figure; a card would keep it in the owner\'s ledger' }, replay: unknown(NOT_INSPECTED) },
  set_standing_order: { brain: 'settings', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'standing_order_set', replay: unknown(NOT_INSPECTED) },
  cancel_standing_order: { brain: 'settings', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'standing_order_cancelled', replay: unknown(NOT_INSPECTED) },
  // claim null: proposes a card on the owner channel and executes directly elsewhere, so no single effect holds.
  call_mcp_tool: { brain: 'web', scope: 'deny', concurrent: false, probe: 'strip', paid: false, ownerTurnOnly: false, claim: null, replay: unknown('proposes a card on the owner channel, executes directly elsewhere; a tool that sends as the owner and that they allowed runs at once in their own untainted request under a host-derived intent the edge runs at most once (tools/live/mcp.ts); remote effect unknown') },
  // reminders, beside cancel_task: the core tool budget has no room for it, so the namespace line names it for the search.
  // scope deny: its worker reads mail, files and the web for the brief. Started is not done: the owner hears the result
  // from the apply turn.
  start_task: { brain: 'reminders', scope: 'deny', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'task_started', replay: { replay: 'provider_idempotent', basis: 'the job key is turn+toolCall and the job book keeps one job per key; a replay returns the job already made', evidence: { file: 'tasks/tools.ts', needle: 'idempotencyKey: key' } } },
  cancel_task: { brain: 'reminders', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'task_cancelled', replay: { replay: 'provider_idempotent', basis: 'cancels by job id; a second cancel finds the job settled and changes nothing', evidence: { file: 'tasks/jobs.ts', needle: 'WHERE id = ? AND status IN (${placeholders(OPEN)})' } } },
  // scope allow: the source guard is applied to the child's handlers too. claim null: it runs a read-only subagent.
  delegate_task: { brain: 'actions', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read('runs a read-only subagent (TOOL_CLAIM_EFFECT comment)') },
  remember: { brain: 'core', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'memory_stored', tainted: { exempt: 'honest_origin', reason: 'under outside text it saves the owner\'s quoted words as Waldo\'s inference until the owner confirms them, and never changes what the owner told Waldo' }, replay: { replay: 'reconcilable_write', basis: 'owner-local active claims dedupe by kind/text and corrections record supersedes_id', evidence: { file: 'tools/live/memory.ts', needle: 'supersedes_id' } } },
  // claim: a finding is stored unconfirmed; it says what Waldo found, never that the owner agreed.
  record_owner_finding: { brain: 'memory', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'owner_finding_recorded', tainted: { exempt: 'honest_origin', reason: 'it keeps a public-web finding unconfirmed, with its page and quote, until the owner keeps, corrects or forgets it; it never stands as the owner\'s word' }, replay: { replay: 'provider_idempotent', basis: 'a finding is keyed by its source URL and normalised text, so a re-run returns the stored finding', evidence: { file: 'onboarding/findings.ts', needle: 'duplicate' } } },
  list_owner_findings: { brain: 'memory', scope: 'deny', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: read() },
  forget_memory: { brain: 'memory', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'memory_forgotten', replay: unknown('local forget plus retained history cleanup; reconcile scope before retrying') },
  // No live handler in this tree, so the effect is unverified: give each a claim label when its handler ships.
  execute_action: { brain: 'actions', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: unknown(NO_HANDLER) },
  write_task: { brain: 'calendar', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: unknown(NO_HANDLER) },
  update_task: { brain: 'calendar', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: unknown(NO_HANDLER) },
  draft_document: { brain: 'artifacts', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: unknown(NO_HANDLER) },
  write_sheet_cell: { brain: 'artifacts', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: unknown(NO_HANDLER) },
  execute_code: { brain: 'actions', scope: 'allow', concurrent: false, probe: 'keep', paid: true, ownerTurnOnly: false, claim: null, replay: unknown(NO_HANDLER) },
  create_thread: { brain: 'memory', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: unknown(NO_HANDLER) },
  delete_message: { brain: 'mail', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: unknown(NO_HANDLER) },
  restore_message: { brain: 'mail', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: unknown(NO_HANDLER) },
  archive_thread: { brain: 'mail', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: unknown(NO_HANDLER) },
  update_thread_topics: { brain: 'memory', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: null, replay: unknown(NO_HANDLER) },
};

// The tools whose record says yes to one fact, for the callers that hold a set.
export const toolsWhere = (fact: (record: ToolRecord) => boolean): ReadonlySet<ToolName> =>
  new Set((Object.keys(TOOL_RECORDS) as ToolName[]).filter((name) => fact(TOOL_RECORDS[name])));

// A column of the records as its own table, for the callers that read one decision.
export const toolRecordColumn = <K extends keyof ToolRecord>(column: K): Readonly<Record<ToolName, ToolRecord[K]>> =>
  Object.fromEntries(Object.entries(TOOL_RECORDS).map(([name, record]) => [name, record[column]])) as Record<ToolName, ToolRecord[K]>;

// Tools in name order: the list leads the provider's cached prefix, so the same admitted set gives the same bytes
// whatever order the host assembled its handlers in.
export const byToolName = (a: Readonly<{ name: string }>, b: Readonly<{ name: string }>): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// The brain's tool list with each tool's place on the surface: core tools as they are, the rest named into their
// namespace and deferred, and the routing line of each namespace in use. A name outside the record (a test double) stays
// core. Off, every tool goes up front. Either way the list is in name order and namespaces in BRAIN_NAMESPACES order.
export const brainTools = (tools: readonly LLMTool[], toolSearch: boolean): Pick<LLMRequest, 'tools' | 'tool_search'> => {
  const ordered = [...tools].sort(byToolName);
  if (!toolSearch) return { tools: ordered };
  const placed = ordered.map((tool) => {
    const placement = (TOOL_RECORDS as Partial<Record<string, ToolRecord>>)[tool.name]?.brain ?? 'core';
    return placement === 'core' ? tool : { ...tool, namespace: placement, defer_loading: true };
  });
  const inUse = new Set(placed.flatMap((tool) => tool.namespace ? [tool.namespace as BrainNamespace] : []));
  const used = (Object.keys(BRAIN_NAMESPACES) as BrainNamespace[]).filter((name) => inUse.has(name));
  return { tools: placed, tool_search: { namespaces: Object.fromEntries(used.map((name) => [name, BRAIN_NAMESPACES[name]])) } };
};

// The kind of work the owner sees a running tool doing (app chat=3 `activity`). Not the brain placement: most of the
// slow reads (mail search, calendar, web, health) sit in core. Every tool is named so a new one fails the build here too.
const TOOL_ACTIVITY: Readonly<Record<ToolName, AppChatActivityKind>> = {
  search_communication: 'mail', read_thread: 'mail', get_communication: 'mail', search_contacts: 'mail', send_email: 'mail', draft_email: 'mail', archive_thread: 'mail', delete_message: 'mail', restore_message: 'mail',
  query_calendar: 'calendar', query_availability: 'calendar', propose_calendar_change: 'calendar', propose_schedule: 'calendar',
  get_tasks: 'tasks', propose_google_task_change: 'tasks', write_task: 'tasks', update_task: 'tasks',
  web_search: 'web', browse_page: 'web', browse_act: 'web',
  // A connected MCP server can be mail, calendar or anything else, and the kind comes from the tool name alone.
  read_mcp_tool: 'working', search_mcp_tools: 'working', call_mcp_tool: 'working', search_connector: 'working',
  read_drive: 'files', read_document: 'files', workspace_list: 'files', workspace_read: 'files', workspace_search: 'files', workspace_write: 'files', workspace_render: 'files',
  get_health: 'health', get_crs: 'health', get_master_metrics: 'health', list_health_logs: 'health', log_meal: 'health', log_workout: 'health', set_sleep_need: 'health',
  read_memory: 'memory', remember: 'memory', search_episodes: 'memory', forget_memory: 'memory', list_owner_findings: 'memory', record_owner_finding: 'memory', read_tool_output: 'memory', create_thread: 'memory', update_thread_topics: 'memory',
  set_reminder: 'reminders', list_reminders: 'reminders', cancel_reminder: 'reminders', open_loop: 'reminders', close_loop: 'reminders', track_responsibility: 'reminders', list_responsibilities: 'reminders', close_responsibility: 'reminders',
  create_artifact: 'artifacts', revise_artifact: 'artifacts', export_artifact: 'artifacts', list_artifacts: 'artifacts', read_artifact: 'artifacts', draft_document: 'artifacts', write_sheet_cell: 'artifacts',
  set_proactivity: 'settings', set_schedule_preference: 'settings', set_standing_order: 'settings', cancel_standing_order: 'settings', list_standing_orders: 'settings', send_console_link: 'settings', connect_app: 'settings',
  search_tools: 'skills', skills_list: 'skills', skills_load: 'skills', skills_install: 'skills', skills_disable: 'skills',
  send_message: 'actions', propose_action: 'actions', raise_approval: 'actions', send_progress_note: 'actions', attach_file: 'actions', react_to_message: 'actions', use_mac: 'actions', update_todo: 'actions', execute_action: 'actions', execute_code: 'actions',
  get_context: 'working', connect_service: 'working', delegate_task: 'working', start_task: 'working', cancel_task: 'working',
};
// From the name alone, never the call's arguments. A name outside the record (a connected server's tool, a test double) is generic work.
export const toolActivity = (name: string): AppChatActivityKind => (TOOL_ACTIVITY as Partial<Record<string, AppChatActivityKind>>)[name] ?? 'working';
