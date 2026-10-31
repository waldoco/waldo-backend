import { describe, expect, it } from 'vitest';
import {
  AGENT_MAIL_HANDLE_CHANGES_PER_DAY, agentMailDirectory, agentMailSigned, agentMailDisplayName, agentMailHandleView, claimAgentMailHandle, releaseAgentMailHandle,
  type AgentMailHandleDirectory,
} from '../src/channels/agent-mail/handles';
import { AGENT_MAIL_RULE_DUE_KEY, agentMailRuleHandles, type HeldHandle } from '../src/channels/agent-mail/rules';
import { routerSignature } from '../src/identity/owner-directory';

const NOW = Date.parse('2026-10-31T10:00:00Z');
const fakeKv = () => {
  const map = new Map<string, unknown>();
  return { map, get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => void map.set(key, value), delete: (key: string) => map.delete(key) };
};
const fakeDirectory = (answer: Awaited<ReturnType<AgentMailHandleDirectory['claim']>> = 'claimed', held: HeldHandle | null = null) => {
  const calls: string[] = [];
  const directory: AgentMailHandleDirectory = {
    claim: async (handle, notice) => { calls.push(`claim:${handle}:${notice}`); return answer; },
    release: async () => { calls.push('release'); return held ? 'released' : 'none'; },
    current: async () => held,
    held: async () => new Set(),
    settle: async () => true,
  };
  return { directory, calls };
};

describe('agent mail handle claim', () => {
  it('refuses a malformed or reserved handle without asking the directory', async () => {
    const kv = fakeKv(), { directory, calls } = fakeDirectory();
    for (const bad of ['a', 'Priya Sharma', '-ab', 'ab-', 'a..b', 'a+b', 'a@b', 'x'.repeat(33)]) expect(await claimAgentMailHandle(kv as never, directory, bad, '2026-10-31', NOW)).toBe('invalid');
    for (const reserved of ['postmaster', 'Abuse', ' waldo ']) expect(await claimAgentMailHandle(kv as never, directory, reserved, '2026-10-31', NOW)).toBe('reserved');
    expect(calls).toEqual([]);
    expect(kv.map.size).toBe(0);
  });

  it('records the handle for the alarm before the claim, wakes it, and lower-cases what the owner typed', async () => {
    const kv = fakeKv();
    const directory: AgentMailHandleDirectory = { ...fakeDirectory().directory, claim: async handle => {
      expect(agentMailRuleHandles(kv as never)).toEqual([handle]);
      expect(kv.get(AGENT_MAIL_RULE_DUE_KEY)).toBe(NOW);
      return 'claimed';
    } };
    expect(await claimAgentMailHandle(kv as never, directory, ' Priya.K ', '2026-10-31', NOW)).toBe('claimed');
    expect(agentMailRuleHandles(kv as never)).toEqual(['priya.k']);
  });

  it('a claim that lands while an alarm pass lets the handle go is recorded again after it', async () => {
    const kv = fakeKv();
    const directory: AgentMailHandleDirectory = { ...fakeDirectory().directory, claim: async () => {
      kv.map.clear();
      return 'claimed';
    } };
    await claimAgentMailHandle(kv as never, directory, 'priya', '2026-10-31', NOW);
    expect(agentMailRuleHandles(kv as never)).toEqual(['priya']);
    expect(kv.get(AGENT_MAIL_RULE_DUE_KEY)).toBe(NOW);
  });

  it('passes the directory\'s refusal through and stops after a day\'s changes', async () => {
    const kv = fakeKv();
    expect(await claimAgentMailHandle(kv as never, fakeDirectory('taken').directory, 'priya', '2026-10-31', NOW)).toBe('taken');
    expect(await claimAgentMailHandle(kv as never, fakeDirectory('full').directory, 'priya', '2026-10-31', NOW)).toBe('full');
    for (let change = 0; change < AGENT_MAIL_HANDLE_CHANGES_PER_DAY; change++) expect(await claimAgentMailHandle(kv as never, fakeDirectory().directory, `name${change}`, '2026-10-31', NOW)).toBe('claimed');
    const { directory, calls } = fakeDirectory();
    expect(await claimAgentMailHandle(kv as never, directory, 'onemore', '2026-10-31', NOW)).toBe('too_many_changes');
    expect(calls).toEqual([]);
    expect(await claimAgentMailHandle(kv as never, directory, 'onemore', '2026-10-31', NOW + 24 * 60 * 60_000)).toBe('claimed');
  });

  it('a release records the current handle for the alarm first; with none it changes nothing', async () => {
    const kv = fakeKv();
    expect(await releaseAgentMailHandle(kv as never, fakeDirectory().directory, NOW)).toBe('none');
    expect(kv.map.size).toBe(0);
    const { directory } = fakeDirectory('claimed', { handle: 'priya', state: 'live' });
    expect(await releaseAgentMailHandle(kv as never, directory, NOW)).toBe('released');
    expect(agentMailRuleHandles(kv as never)).toEqual(['priya']);
    expect(kv.get(AGENT_MAIL_RULE_DUE_KEY)).toBe(NOW);
  });

  it('a view of a pending handle the alarm is not working on puts it back; a live one is left alone', async () => {
    const kv = fakeKv();
    expect(await agentMailHandleView(kv as never, fakeDirectory('claimed', { handle: 'priya', state: 'live' }).directory, NOW)).toEqual({ handle: 'priya', state: 'live' });
    expect(kv.map.size).toBe(0);
    await agentMailHandleView(kv as never, fakeDirectory('claimed', { handle: 'priya', state: 'pending' }).directory, NOW);
    expect(agentMailRuleHandles(kv as never)).toEqual(['priya']);
  });
});

describe('agent mail directory calls', () => {
  it('signs each call with its own message and refuses an answer outside the contract', async () => {
    const env = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
    const seen: { fn: string; body: Record<string, unknown> }[] = [];
    let answer: unknown = 'claimed';
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ fn: String(input).split('/').pop()!, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json(answer);
    }) as typeof fetch;
    const directory = agentMailDirectory(env, 'owner-do', fetcher, () => NOW)!;
    expect(await directory.claim('priya', '2026-10-31')).toBe('claimed');
    answer = [{ handle: 'priya', rule_state: 'live' }];
    expect(await directory.current()).toEqual({ handle: 'priya', state: 'live' });
    answer = true;
    expect(await directory.settle('priya', 'failed')).toBe(true);
    answer = ['b', 'a'];
    expect(await directory.held(['b', 'a'])).toEqual(new Set(['a', 'b']));
    const at = Math.floor(NOW / 1000);
    for (const [index, message] of ['mailclaim.8:owner-do.5:priya.10:2026-10-31', 'mailhandle.8:owner-do', 'mailsettle.8:owner-do.5:priya.6:failed', 'mailheld.3:a,b'].entries()) {
      expect(seen[index]!.body.p_sig).toBe(await routerSignature(env.WALDO_ROUTER_HMAC_SECRET, at, message));
    }
    answer = 'granted';
    await expect(directory.claim('priya', '2026-10-31')).rejects.toThrow('agent mail directory answer');
    answer = [{ handle: 'priya', rule_state: 'releasing' }];
    await expect(directory.current()).rejects.toThrow('agent mail directory answer');
    expect(agentMailDirectory({}, 'owner-do', fetcher)).toBeNull();
  });
  it('signs each argument with its length, so no two splits of dotted text sign alike, exactly as the directory builds it', () => {
    expect(agentMailSigned('mailclaim', 'owner-do', 'priya.k', '2026-10-31')).toBe('mailclaim.8:owner-do.7:priya.k.10:2026-10-31');
    expect(agentMailSigned('mailsettle', 'do', 'a.b', 'c')).not.toBe(agentMailSigned('mailsettle', 'do', 'a', 'b.c'));
    expect(agentMailSigned('mailhandle', 'é')).toBe('mailhandle.2:é');
  });
});

describe('agent mail display name', () => {
  it('is "Waldo, <first name>\'s assistant", with nothing that could break a header', () => {
    expect(agentMailDisplayName('Priya Sharma')).toBe("Waldo, Priya's assistant");
    expect(agentMailDisplayName('  Ana ')).toBe("Waldo, Ana's assistant");
    expect(agentMailDisplayName('"Evil"\r\nBcc: x@y <z>')).toBe("Waldo, Evil's assistant");
    expect(agentMailDisplayName(null)).toBe('Waldo');
    expect(agentMailDisplayName(' \r\n ')).toBe('Waldo');
  });
});
