import type { TaskProfile, ToolName } from '@waldo/contracts';
import { EGRESS_READ_TOOLS } from '../tools/records';

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
export const MACHINE_READER: readonly ToolName[] = READER.filter((name) => !EGRESS_READ_TOOLS.includes(name));
// The two halves of a reader. Private data, instructions from outside text and a way out are what exfiltration needs, so a
// worker whose instructions came after outside text holds one half, never both, unless the owner approved that task on a card.
// web: public look-ups, and nothing of the owner's to carry out. private: the owner's own data, and no way to send it anywhere.
const WEB_READER: readonly ToolName[] = ['web_search', 'browse_page', 'read_tool_output'];
const EGRESS: ReadonlySet<ToolName> = new Set([...EGRESS_READ_TOOLS, 'browse_act']);
const PRIVATE_READS: ReadonlySet<ToolName> = new Set(MACHINE_READER.filter((name) => name !== 'read_tool_output'));
// unavailable: why the profile cannot run on this Waldo, in words that tell the model what to do instead.
export type ProfileSpec = Readonly<{ tools: readonly ToolName[]; unavailable?: string }>;
export const TASK_PROFILE_SPECS: Readonly<Record<TaskProfile, ProfileSpec>> = {
  reader: { tools: READER },
  errand: { tools: [...READER, 'browse_act'] },
  web: { tools: WEB_READER },
  private: { tools: MACHINE_READER },
  // A code worker owns a sandbox container. execute_code has no handler on any deploy yet, so the profile is refused at
  // start with a reason the model can act on.
  code: {
    tools: ['execute_code'],
    unavailable: 'Code tasks need a sandbox, which this Waldo does not have yet. Use the reader or errand profile if the work fits, use_mac to run it on the owner\'s Mac, or tell the owner it is not available yet.',
  },
};

// Whether a profile holds both halves: a private read and a way out.
export const holdsPrivateAndEgress = (tools: readonly ToolName[]): boolean => tools.some((name) => PRIVATE_READS.has(name)) && tools.some((name) => EGRESS.has(name));
// The web tools a job loses when its instructions came after outside text and its profile holds both halves.
export const withoutEgress = (tools: readonly ToolName[]): readonly ToolName[] => tools.filter((name) => !EGRESS.has(name));
