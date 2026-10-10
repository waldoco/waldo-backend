import { TOOL_PERMISSIONS, buildSessionState, triggerTypeSchema, type TriggerType } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { GoogleTaskConnectorUnavailableError } from '../src/channels/google-task-approvals';
import { GoogleError } from '../src/connectors/google';
import { sanitise } from '../src/scribe/sanitiser';
import { dispatchTool, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { googleTaskHandlers } from '../src/tools/live/tasks';

// These run the real dispatcher: it rejects a handler result whose taint does not match the tool's origin class,
// after any card has already been posted, so a direct handler call cannot show this.
const trigger = triggerTypeSchema.options.find(candidate => TOOL_PERMISSIONS[candidate].includes('propose_google_task_change')) as TriggerType;
const context: ToolDispatcherContext = {
  authenticatedUserId: 'user-1', trigger, session: buildSessionState({ trigger, canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1_700_000_000_000 }),
  hasApproval: () => true, sourceTaint: null, toolArgSourceTaint: null, sanitise,
};
const call = { id: 'call-task-1', name: 'propose_google_task_change' as const, args: { source: 'google_tasks' as const, action: 'create' as const, task_list_id: 'list-a', changes: { title: 'Waldo test' }, reason: 'Owner asked' } };
const run = (propose: () => Promise<string>) => dispatchTool(call, context, { handlers: [googleTaskHandlers({ proposeGoogleTaskChange: propose })[0]!] });

describe('propose_google_task_change through the dispatcher', () => {
  it('reaches the model as an accepted proposal, not as an invalid handler result', async () => {
    const result = await run(async () => 'proposal-1');
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).toContain('proposal-1');
    expect(JSON.stringify(result)).toContain('awaiting_owner_approval');
  });
  it.each([
    ['an unconnected account', new GoogleTaskConnectorUnavailableError()],
    ['a provider refusal', new GoogleError(403, 'denied')],
    ['an ordinary failure', new Error('Approval card not confirmed')],
  ])('reports %s as that failure, never as an invalid handler result', async (_label, error) => {
    const result = await run(async () => { throw error; });
    expect(JSON.stringify(result)).not.toContain('invalid_handler_result');
  });
});
