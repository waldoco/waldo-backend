import type { TaskProfile, ToolName } from '@waldo/contracts';
import { TOOL_REPLAY_CLASS } from '../hooks/tool-replay-class';
import { isMachine, MACHINE_ORIGIN, type JobRow } from './jobs';

// What each worker profile may call. The brain enforces this on every call a worker sends; the worker never holds a
// handler or a credential. No profile carries memory, send, approve, delegation or start_task (a worker cannot act for
// the owner or spawn more work), and none carries a turn-only health tool: a worker's checkpoints persist, and the owner's
// health values must never be stored. A reader reads public pages (browse_page) as well as searching for them: research needs
// the page, not the snippet. Acting on a page (browse_act) is the errand's. A read too large for one result is stored for the
// attempt and paged with read_tool_output, which reads that attempt's store and nothing else (brain.ts).
const READER: readonly ToolName[] = [
  'get_context', 'query_calendar', 'query_availability', 'get_communication', 'search_communication', 'read_thread', 'search_contacts', 'get_tasks',
  'read_drive', 'read_mcp_tool', 'web_search', 'browse_page', 'workspace_list', 'workspace_read', 'workspace_search', 'list_artifacts', 'read_artifact',
  'read_tool_output',
];
// The reads whose arguments leave the account: a search query, a page URL, an MCP call. Nothing cards a read, so a turn that
// starts on text nobody asked Waldo to read, with no owner in the loop, could be steered into carrying private data out in
// them. A machine job's worker and every unattended outside-text turn (channels/check-back) go without; the owner's own turns
// and the tasks the owner starts keep them.
export const EGRESS_READ_TOOLS: readonly ToolName[] = ['web_search', 'browse_page', 'read_mcp_tool'];
export const MACHINE_READER: readonly ToolName[] = READER.filter((name) => !EGRESS_READ_TOOLS.includes(name));
// The owner look-up's worker: the one machine job with egress reads. It holds no private read (no mail, calendar, memory or
// health), and its brief holds no time zone, so the only owner data it can carry out in a query is the name and address the
// owner agreed to be searched by. Its web search is the owner's without a location (lookupToolHandlers in the owner object),
// so the search provider is sent no country either. It writes nothing but unconfirmed findings, each grounded in a page this
// attempt read.
export const LOOKUP_READER: readonly ToolName[] = ['list_owner_findings', 'web_search', 'browse_page', 'record_owner_finding', 'read_tool_output'];
export const LOOKUP_ORIGIN = `${MACHINE_ORIGIN}owner_lookup`;
// The browser host serves one active run scope per owner, so these run in the brain's serial lane under the job's scope.
export const BROWSER_TOOLS: ReadonlySet<ToolName> = new Set(['browse_page', 'browse_act']);

// unavailable: why the profile cannot run on this Waldo, in words that tell the model what to do instead.
export type ProfileSpec = Readonly<{ tools: readonly ToolName[]; unavailable?: string }>;
export const TASK_PROFILE_SPECS: Readonly<Record<TaskProfile, ProfileSpec>> = {
  reader: { tools: READER },
  errand: { tools: [...READER, 'browse_act'] },
  // A code worker owns a sandbox container. execute_code has no handler on any deploy yet, so the profile is refused at
  // start with a reason the model can act on.
  code: {
    tools: ['execute_code'],
    unavailable: 'Code tasks need a sandbox, which this Waldo does not have yet. Use the reader or errand profile if the work fits, use_mac to run it on the owner\'s Mac, or tell the owner it is not available yet.',
  },
};

// The worker's own tool that hands its result to Waldo. It runs in the worker and changes nothing outside it.
export const FINISH_TASK = 'finish_task';

// Tools whose effect cannot be told apart from a crash (TOOL_REPLAY_CLASS): a resumed attempt must not run one again
// blind. A job that crashed after starting one parks with that effect named as uncertain.
export const unreplayable = (name: string): boolean => {
  if (name === FINISH_TASK) return false;
  const row = TOOL_REPLAY_CLASS[name as ToolName];
  return row === undefined || (row.replay !== 'safe_read' && row.replay !== 'provider_idempotent');
};

// The tools a job's worker may call: its profile's, or the machine reader's for a job the brain started itself.
export const jobTools = (row: Pick<JobRow, 'profile' | 'origin'>): readonly ToolName[] =>
  row.origin === LOOKUP_ORIGIN ? LOOKUP_READER : isMachine(row) ? MACHINE_READER : row.profile === null ? [] : TASK_PROFILE_SPECS[row.profile].tools;
