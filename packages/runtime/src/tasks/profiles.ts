import type { ToolName } from '@waldo/contracts';
import { TOOL_REPLAY_CLASS } from '../hooks/tool-replay-class';
import { EGRESS_READ_TOOLS } from '../tools/records';
export { EGRESS_READ_TOOLS };
import { isMachine, jobCheckpoint, MACHINE_ORIGIN, taskBrief, type JobRow } from './jobs';
import { holdsPrivateAndEgress, MACHINE_READER, TASK_PROFILE_SPECS, withoutEgress } from './profile-tools';
export { holdsPrivateAndEgress, MACHINE_READER, TASK_PROFILE_SPECS, type ProfileSpec } from './profile-tools';

// The owner look-up's worker: the one machine job with egress reads. It holds no private read (no mail, calendar, memory or
// health), and its brief holds no time zone, so the only owner data it can carry out in a query is the name and address the
// owner agreed to be searched by. Its web search is the owner's without a location (lookupToolHandlers in the owner object),
// so the search provider is sent no country either. It writes nothing but unconfirmed findings, each grounded in a page this
// attempt read.
export const LOOKUP_READER: readonly ToolName[] = ['list_owner_findings', 'web_search', 'browse_page', 'record_owner_finding', 'read_tool_output'];
export const LOOKUP_ORIGIN = `${MACHINE_ORIGIN}owner_lookup`;
// The browser host serves one active run scope per owner, so these run in the brain's serial lane under the job's scope.
export const BROWSER_TOOLS: ReadonlySet<ToolName> = new Set(['browse_page', 'browse_act']);

// The worker's own tool that hands its result to Waldo. It runs in the worker and changes nothing outside it.
export const FINISH_TASK = 'finish_task';

// Tools whose effect cannot be told apart from a crash (TOOL_REPLAY_CLASS): a resumed attempt must not run one again
// blind. A job that crashed after starting one parks with that effect named as uncertain.
export const unreplayable = (name: string): boolean => {
  if (name === FINISH_TASK) return false;
  const row = TOOL_REPLAY_CLASS[name as ToolName];
  return row === undefined || (row.replay !== 'safe_read' && row.replay !== 'provider_idempotent');
};

// The job's instructions came after outside text: its brief or a later change to it was written in a turn that had read it,
// and the owner did not approve that brief or change on its own card.
export const outsideInstructions = (row: Pick<JobRow, 'brief_json' | 'checkpoint_json'>): boolean => {
  const brief = taskBrief(row as JobRow);
  return (brief.outside_text === true && brief.owner_approved !== true)
    || (jobCheckpoint(row as JobRow).steers ?? []).some((steer) => steer.outside_text === true && steer.owner_approved !== true);
};

// The tools a job's worker may call: its profile's, or the machine reader's for a job the brain started itself. A job whose
// instructions came after outside text and whose profile holds both halves loses its way out, so the brain refuses the web on
// every call however the job came to hold both. The worker keeps the owner's data the brief was about.
export const jobTools = (row: Pick<JobRow, 'profile' | 'origin' | 'brief_json' | 'checkpoint_json'>): readonly ToolName[] => {
  if (row.origin === LOOKUP_ORIGIN) return LOOKUP_READER;
  if (isMachine(row)) return MACHINE_READER;
  if (row.profile === null) return [];
  const tools = TASK_PROFILE_SPECS[row.profile].tools;
  return holdsPrivateAndEgress(tools) && outsideInstructions(row) ? withoutEgress(tools) : tools;
};
