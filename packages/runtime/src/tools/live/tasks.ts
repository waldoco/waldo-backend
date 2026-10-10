import { proposeGoogleTaskChangeArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type ProposeGoogleTaskChangeArgs, type ToolHandler } from '@waldo/contracts';
import { ownerEffectOperationRef } from '../../channels/owner-effect-ledger';
import type { ToolDispatcherContext } from '../dispatcher';
import { GoogleError } from '../../connectors/google';
import { GoogleTaskConnectorUnavailableError } from '../../channels/google-task-approvals';

type TaskProposalDesk = Readonly<{ proposeGoogleTaskChange(args: ProposeGoogleTaskChangeArgs, operationRef?: string, ctx?: ToolDispatcherContext): Promise<string> }>;
type TaskProposalResult = { approval_ref: string; status: 'awaiting_owner_approval'; applied: false; source: 'google_tasks' };
export const googleTaskHandlers = (desk: TaskProposalDesk): readonly ToolHandler<ProposeGoogleTaskChangeArgs, TaskProposalResult, ToolDispatcherContext>[] => [{
  name: 'propose_google_task_change',
  description: 'Prepare an approval for an explicit Google Tasks account/list: create, edit selected fields, complete or reopen. Discover list/task IDs with get_tasks first. Google due_date is a calendar date and cannot store a time. This tool does not apply the change; the owner reviews the exact account, target and content in the shared approval desk. An uncertain provider result stays unknown and is never blindly repeated.',
  schema: proposeGoogleTaskChangeArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes('propose_google_task_change')),
  autonomy_gated: false,
  mutates_state: true,
  requires_connector: true,
  async handle(args, ctx) {
    try {
      await ctx?.assertTaskSourceCurrent?.();
      const approvalRef = await desk.proposeGoogleTaskChange(args, await ownerEffectOperationRef(ctx), ctx);
      return { ok: true, data: { approval_ref: approvalRef, status: 'awaiting_owner_approval', applied: false, source: 'google_tasks' }, source_taint: 'external' };
    } catch (error) {
      if (error instanceof GoogleTaskConnectorUnavailableError || error instanceof GoogleError && (error.status === 401 || error.status === 403 && error.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')) return { ok: false, code: 'auth_failed', error: 'Google Tasks needs an authorized connection before a proposal can be prepared', source_taint: 'external', connect: { status: 'auth_required', service: 'google', feature: 'tasks', reason: error instanceof GoogleTaskConnectorUnavailableError ? 'not_connected' : error.status === 401 ? 'reauth_needed' : 'scope_missing' } };
      if (error instanceof GoogleError && error.status === 403) return { ok: false, code: 'rejected', error: `Google Tasks refused the request: ${error.message}`, source_taint: 'external' };
      return { ok: false, code: 'transient', error: error instanceof Error ? error.message : String(error), source_taint: 'external' };
    }
  },
}];
