import { signedRpc, type OwnerDirectoryEnv } from '../../identity/owner-directory';
import { AGENT_MAIL_RULE_HANDLES_KEY, intendAgentMailRule, type AgentMailRuleDirectory, type HeldHandle, type RuleState } from './rules';

// The owner's handle at the agent mail domain. The directory is the one writer of who holds which handle; the owner's object
// asks it, records the handle for its alarm before each call that changes it, and the alarm makes the rule.

// The same shape and reserved names the directory's table enforces; checked here first so the owner hears why.
export const AGENT_MAIL_HANDLE = /^[a-z0-9][a-z0-9.-]{1,30}[a-z0-9]$/;
export const AGENT_MAIL_RESERVED: readonly string[] = ['postmaster', 'abuse', 'hostmaster', 'webmaster', 'admin', 'support', 'info', 'security', 'noreply', 'waldo'];
// Each change creates and deletes a rule, and each released handle is gone for 180 days.
export const AGENT_MAIL_HANDLE_CHANGES_PER_DAY = 5;
const CHANGES_KEY = 'agent_mail_handle_changes_v1';

export type AgentMailClaim = 'claimed' | 'unchanged' | 'taken' | 'unavailable' | 'full' | 'invalid' | 'reserved' | 'too_many_changes' | 'no_owner';
export type AgentMailRelease = 'released' | 'none';
export type AgentMailHandleDirectory = AgentMailRuleDirectory & Readonly<{
  claim(handle: string): Promise<Exclude<AgentMailClaim, 'invalid' | 'reserved' | 'too_many_changes'>>;
  release(): Promise<AgentMailRelease>;
}>;

const CLAIMS = new Set(['claimed', 'unchanged', 'taken', 'unavailable', 'full', 'no_owner']);
const STATES = new Set<RuleState>(['pending', 'live', 'failed', 'unknown']);
const answered = <T extends string>(value: unknown, allowed: ReadonlySet<string>): T => {
  if (typeof value !== 'string' || !allowed.has(value)) throw new Error('agent mail directory answer');
  return value as T;
};

// Null without a directory. Every call throws when the directory cannot answer.
export const agentMailDirectory = (env: OwnerDirectoryEnv, doName: string, fetcher: typeof fetch = fetch, now = () => Date.now()): AgentMailHandleDirectory | null => {
  const call = signedRpc(env, fetcher, now);
  if (!call) return null;
  return {
    claim: async handle => answered<Awaited<ReturnType<AgentMailHandleDirectory['claim']>>>(await call('claim_agent_mail_handle', `mailclaim.${doName}.${handle}`, { p_do_name: doName, p_handle: handle }), CLAIMS),
    release: async () => answered<AgentMailRelease>(await call('release_agent_mail_handle', `mailrelease.${doName}`, { p_do_name: doName }), new Set(['released', 'none'])),
    current: async () => {
      const [row] = await call('agent_mail_handle', `mailhandle.${doName}`, { p_do_name: doName }) as { handle?: unknown; rule_state?: unknown }[];
      if (!row) return null;
      if (typeof row.handle !== 'string') throw new Error('agent mail directory answer');
      return { handle: row.handle, state: answered<RuleState>(row.rule_state, STATES) };
    },
    held: async handles => {
      if (!handles.length) return new Set();
      const list = [...handles].sort().join(',');
      const rows = await call('agent_mail_held_handles', `mailheld.${list}`, { p_handles: list });
      return new Set(Array.isArray(rows) ? rows.filter((handle): handle is string => typeof handle === 'string') : []);
    },
    settle: async (handle, state) => (await call('settle_agent_mail_rule', `mailsettle.${doName}.${handle}.${state}`, { p_do_name: doName, p_handle: handle, p_state: state })) === true,
  };
};

type Kv = Pick<SyncKvStorage, 'get' | 'put' | 'delete'>;
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export async function claimAgentMailHandle(kv: Kv, directory: AgentMailHandleDirectory, asked: string, now = Date.now()): Promise<AgentMailClaim> {
  const handle = asked.trim().toLowerCase();
  if (!AGENT_MAIL_HANDLE.test(handle) || handle.includes('..')) return 'invalid';
  if (AGENT_MAIL_RESERVED.includes(handle)) return 'reserved';
  const changes = kv.get<{ day: string; count: number }>(CHANGES_KEY);
  const today = changes?.day === dayOf(now) ? changes.count : 0;
  if (today >= AGENT_MAIL_HANDLE_CHANGES_PER_DAY) return 'too_many_changes';
  // Before the call: a claim whose answer is lost may still have landed, and the alarm finds out from the directory.
  intendAgentMailRule(kv, handle, now);
  const outcome = await directory.claim(handle);
  if (outcome === 'claimed') {
    kv.put(CHANGES_KEY, { day: dayOf(now), count: today + 1 });
    // Again after it: an alarm pass that ran during the call may have read the directory before the claim and let it go.
    intendAgentMailRule(kv, handle, now);
  }
  return outcome;
}

export async function releaseAgentMailHandle(kv: Kv, directory: AgentMailHandleDirectory, now = Date.now()): Promise<AgentMailRelease> {
  const current = await directory.current();
  if (!current) return 'none';
  intendAgentMailRule(kv, current.handle, now);
  return directory.release();
}

// What the owner's surfaces show. A pending handle the alarm is not set to work on (one claimed before this object kept
// the set, or one an alarm pass let go during its claim) is put back for it.
export async function agentMailHandleView(kv: Kv, directory: AgentMailHandleDirectory, now = Date.now()): Promise<HeldHandle | null> {
  const current = await directory.current();
  if (current?.state === 'pending' && !(kv.get<string[]>(AGENT_MAIL_RULE_HANDLES_KEY) ?? []).includes(current.handle)) intendAgentMailRule(kv, current.handle, now);
  return current;
}

// The name mail from Waldo carries: "Waldo, <first name>'s assistant", or "Waldo" with no name to use. Built when it is
// shown or sent, from the name the owner gave, never stored. Header-breaking characters are dropped.
export const agentMailDisplayName = (ownerName: string | null | undefined): string => {
  const first = (ownerName ?? '').replace(/[\u0000-\u001f\u007f"\\<>]/g, ' ').trim().split(/\s+/)[0]?.slice(0, 40) ?? '';
  return first ? `Waldo, ${first}'s assistant` : 'Waldo';
};
