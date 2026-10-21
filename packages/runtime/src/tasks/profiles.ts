import type { TaskProfile, ToolName } from '@waldo/contracts';
import { TOOL_REPLAY_CLASS } from '../hooks/tool-replay-class';

// What each worker profile may call. The brain enforces this on every call a worker sends; the worker never holds a
// handler or a credential. No profile carries memory, send, approve, delegation or start_task (a worker cannot act for
// the owner or spawn more work), and none carries a turn-only health tool: a worker's checkpoints persist, and the owner's
// health values must never be stored.
const READER: readonly ToolName[] = [
  'get_context', 'query_calendar', 'query_availability', 'get_communication', 'search_communication', 'read_thread', 'search_contacts', 'get_tasks',
  'read_drive', 'read_mcp_tool', 'web_search', 'workspace_list', 'workspace_read', 'workspace_search', 'list_artifacts', 'read_artifact',
];
// The browser host serves one active run scope per owner, so these run in the brain's serial lane under the job's scope.
export const BROWSER_TOOLS: ReadonlySet<ToolName> = new Set(['browse_page', 'browse_act']);

// unavailable: why the profile cannot run on this Waldo, in words that tell the model what to do instead.
export type ProfileSpec = Readonly<{ tools: readonly ToolName[]; unavailable?: string }>;
export const TASK_PROFILE_SPECS: Readonly<Record<TaskProfile, ProfileSpec>> = {
  reader: { tools: READER },
  errand: { tools: [...READER, 'browse_page', 'browse_act'] },
  // A code worker owns a sandbox container. execute_code has no handler on any deploy yet, so the profile is refused at
  // start with a reason the model can act on.
  code: {
    tools: ['execute_code'],
    unavailable: 'Code tasks need a sandbox, which this Waldo does not have yet. Use the reader or errand profile if the work fits, use_mac to run it on the owner\'s Mac, or tell the owner it is not available yet.',
  },
};

// Tools whose effect cannot be told apart from a crash (TOOL_REPLAY_CLASS): a resumed attempt must not run one again
// blind. A job that crashed after starting one parks with that effect named as uncertain.
export const unreplayable = (name: string): boolean => {
  const row = TOOL_REPLAY_CLASS[name as ToolName];
  return row === undefined || (row.replay !== 'safe_read' && row.replay !== 'provider_idempotent');
};
