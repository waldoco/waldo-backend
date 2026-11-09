import type { ConsoleAction } from '../console';
import type { ControlReceipt } from '../dashboard-control-actions';
import { APP_AGENT_MAIL_RECEIPTS_V1 } from '../../../../contracts/src/app/controls';
import type { OwnerDirectoryEnv } from '../../identity/owner-directory';
import { agentMailDirectory, agentMailDisplayName, agentMailHandleView, claimAgentMailHandle, releaseAgentMailHandle } from './handles';
import { AGENT_MAIL_NOTICE } from './notice';
import { agentMailRouting, type AgentMailRoutingEnv, type RuleState } from './rules';

// The owner's Waldo address on the app and the console: the handle, where its routing rule stands, the notice a claim
// accepts, the name mail from Waldo carries, and the claim and release actions. Like the phone view, the read lists its
// own actions and is the eligibility check for them.

export type AgentMailControlsDeps = Readonly<{
  env: AgentMailRoutingEnv & OwnerDirectoryEnv;
  kv: Pick<SyncKvStorage, 'get' | 'put' | 'delete'>;
  // The owner object's directory name.
  owner: string;
  // What the owner asked to be called, or null.
  ownerName(): string | null;
  // Arms the owner alarm for the rule a claim or release recorded.
  wake(): Promise<void>;
}>;
type AgentMailAction = 'agent_mail.claim' | 'agent_mail.release';
export type AgentMailControls = Readonly<{ version: 1; view: 'agent_mail'; state: 'available'; csrf: string;
  data: Readonly<{ enabled: boolean; domain?: string; handle?: string; address?: string; rule?: RuleState; rule_reason?: 'not_configured';
    notice?: typeof AGENT_MAIL_NOTICE; display_name: string; actions: readonly AgentMailAction[] }> }>;

// Claims are open while agent mail is on and the directory answers. The rule API may still be unconfigured: a claim then
// stays pending, and the view says why.
const setUp = (deps: AgentMailControlsDeps) => {
  const domain = deps.env.AGENT_MAIL_DOMAIN?.toLowerCase(), directory = deps.owner ? agentMailDirectory(deps.env, deps.owner) : null;
  return deps.env.AGENT_MAIL_INBOUND === '1' && domain && directory ? { domain, directory, routed: agentMailRouting(deps.env) !== null } : null;
};

// Rejects when the directory cannot say which handle the owner holds.
export async function agentMailControls(deps: AgentMailControlsDeps, csrf: string): Promise<AgentMailControls> {
  const display_name = agentMailDisplayName(deps.ownerName());
  const on = setUp(deps);
  if (!on) return { version: 1, view: 'agent_mail', state: 'available', csrf, data: { enabled: false, display_name, actions: [] } };
  const held = await agentMailHandleView(deps.kv, on.directory);
  if (held?.state === 'pending') await deps.wake();
  return { version: 1, view: 'agent_mail', state: 'available', csrf, data: {
    enabled: true, domain: on.domain,
    ...(held ? { handle: held.handle, address: `${held.handle}@${on.domain}`, rule: held.state, ...(held.state === 'pending' && !on.routed ? { rule_reason: 'not_configured' as const } : {}) } : {}),
    notice: AGENT_MAIL_NOTICE, display_name, actions: held ? ['agent_mail.claim', 'agent_mail.release'] : ['agent_mail.claim'],
  } };
}

// `read` is the fresh read the action was checked against; `fields.notice` the notice version the claim showed.
export async function agentMailControlAct(deps: AgentMailControlsDeps, read: AgentMailControls, action: ConsoleAction, fields: Readonly<Record<string, string>>): Promise<ControlReceipt> {
  const on = setUp(deps);
  if (!on) return APP_AGENT_MAIL_RECEIPTS_V1.unavailable;
  try {
    if (action.action === 'agent_mail.release') {
      const released = await releaseAgentMailHandle(deps.kv, on.directory);
      if (released === 'released') await deps.wake();
      return APP_AGENT_MAIL_RECEIPTS_V1[released];
    }
    if (action.action !== 'agent_mail.claim') return APP_AGENT_MAIL_RECEIPTS_V1.unavailable;
    if (fields.notice !== AGENT_MAIL_NOTICE.version) return APP_AGENT_MAIL_RECEIPTS_V1.notice_stale;
    const claimed = await claimAgentMailHandle(deps.kv, on.directory, action.value, AGENT_MAIL_NOTICE.version);
    if (claimed === 'claimed') await deps.wake();
    if (claimed === 'no_owner') return APP_AGENT_MAIL_RECEIPTS_V1.unavailable;
    // A claim of a different handle released the one the owner held, in the same directory transaction.
    return APP_AGENT_MAIL_RECEIPTS_V1[claimed === 'claimed' && read.data.handle !== undefined && read.data.handle !== action.value.trim().toLowerCase() ? 'changed' : claimed];
  } catch { return APP_AGENT_MAIL_RECEIPTS_V1.unknown; }
}
