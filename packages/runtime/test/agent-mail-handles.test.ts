import { describe, expect, it } from 'vitest';
import {
  AGENT_MAIL_HANDLE_CHANGES_PER_DAY, agentMailDirectory, agentMailDisplayName, agentMailHandleView, claimAgentMailHandle, releaseAgentMailHandle,
  type AgentMailHandleDirectory,
} from '../src/channels/agent-mail/handles';
import { AGENT_MAIL_RULE_DUE_KEY, AGENT_MAIL_RULE_HANDLES_KEY, type HeldHandle } from '../src/channels/agent-mail/rules';
import { routerSignature } from '../src/identity/owner-directory';

const NOW = Date.parse('2026-10-31T10:00:00Z');
const fakeKv = () => {
  const map = new Map<string, unknown>();
  return { map, get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => void map.set(key, value), delete: (key: string) => map.delete(key) };
};
const fakeDirectory = (answer: Awaited<ReturnType<AgentMailHandleDirectory['claim']>> = 'claimed', held: HeldHandle | null = null) => {
  const calls: string[] = [];
  const directory: AgentMailHandleDirectory = {
    claim: async handle => { calls.push(`claim:${handle}`); return answer; },
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
    for (const bad of ['a', 'Priya Sharma', '-ab', 'ab-', 'a..b', 'a+b', 'a@b', 'x'.repeat(33)]) expect(await claimAgentMailHandle(kv as never, directory, bad, NOW)).toBe('invalid');
    for (const reserved of ['postmaster', 'Abuse', ' waldo ']) expect(await claimAgentMailHandle(kv as never, directory, reserved, NOW)).toBe('reserved');
    expect(calls).toEqual([]);
    expect(kv.map.size).toBe(0);
  });

  it('records the handle for the alarm before the claim, wakes it, and lower-cases what the owner typed', async () => {
    const kv = fakeKv();
    const directory: AgentMailHandleDirectory = { ...fakeDirectory().directory, claim: async handle => {
      expect(kv.get(AGENT_MAIL_RULE_HANDLES_KEY)).toEqual([handle]);
      expect(kv.get(AGENT_MAIL_RULE_DUE_KEY)).toBe(NOW);
      return 'claimed';
    } };
    expect(await claimAgentMailHandle(kv as never, directory, ' Priya.K ', NOW)).toBe('claimed');
    expect(kv.get(AGENT_MAIL_RULE_HANDLES_KEY)).toEqual(['priya.k']);
  });

  it('a claim that lands while an alarm pass lets the handle go is recorded again after it', async () => {
    const kv = fakeKv();
    const directory: AgentMailHandleDirectory = { ...fakeDirectory().directory, claim: async () => {
      kv.put(AGENT_MAIL_RULE_HANDLES_KEY, []); kv.delete(AGENT_MAIL_RULE_DUE_KEY);
      return 'claimed';
    } };
    await claimAgentMailHandle(kv as never, directory, 'priya', NOW);
    expect(kv.get(AGENT_MAIL_RULE_HANDLES_KEY)).toEqual(['priya']);
    expect(kv.get(AGENT_MAIL_RULE_DUE_KEY)).toBe(NOW);
  });

  it('passes the directory\'s refusal through and stops after a day\'s changes', async () => {
    const kv = fakeKv();
    expect(await claimAgentMailHandle(kv as never, fakeDirectory('taken').directory, 'priya', NOW)).toBe('taken');
    expect(await claimAgentMailHandle(kv as never, fakeDirectory('full').directory, 'priya', NOW)).toBe('full');
    for (let change = 0; change < AGENT_MAIL_HANDLE_CHANGES_PER_DAY; change++) expect(await claimAgentMailHandle(kv as never, fakeDirectory().directory, `name${change}`, NOW)).toBe('claimed');
    const { directory, calls } = fakeDirectory();
    expect(await claimAgentMailHandle(kv as never, directory, 'onemore', NOW)).toBe('too_many_changes');
    expect(calls).toEqual([]);
    expect(await claimAgentMailHandle(kv as never, directory, 'onemore', NOW + 24 * 60 * 60_000)).toBe('claimed');
  });

  it('a release records the current handle for the alarm first; with none it changes nothing', async () => {
    const kv = fakeKv();
    expect(await releaseAgentMailHandle(kv as never, fakeDirectory().directory, NOW)).toBe('none');
    expect(kv.map.size).toBe(0);
    const { directory } = fakeDirectory('claimed', { handle: 'priya', state: 'live' });
    expect(await releaseAgentMailHandle(kv as never, directory, NOW)).toBe('released');
    expect(kv.get(AGENT_MAIL_RULE_HANDLES_KEY)).toEqual(['priya']);
    expect(kv.get(AGENT_MAIL_RULE_DUE_KEY)).toBe(NOW);
  });

  it('a view of a pending handle the alarm is not working on puts it back; a live one is left alone', async () => {
    const kv = fakeKv();
    expect(await agentMailHandleView(kv as never, fakeDirectory('claimed', { handle: 'priya', state: 'live' }).directory, NOW)).toEqual({ handle: 'priya', state: 'live' });
    expect(kv.map.size).toBe(0);
    await agentMailHandleView(kv as never, fakeDirectory('claimed', { handle: 'priya', state: 'pending' }).directory, NOW);
    expect(kv.get(AGENT_MAIL_RULE_HANDLES_KEY)).toEqual(['priya']);
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
    expect(await directory.claim('priya')).toBe('claimed');
    answer = [{ handle: 'priya', rule_state: 'live' }];
    expect(await directory.current()).toEqual({ handle: 'priya', state: 'live' });
    answer = true;
    expect(await directory.settle('priya', 'failed')).toBe(true);
    answer = ['b', 'a'];
    expect(await directory.held(['b', 'a'])).toEqual(new Set(['a', 'b']));
    const at = Math.floor(NOW / 1000);
    for (const [index, message] of ['mailclaim.owner-do.priya', 'mailhandle.owner-do', 'mailsettle.owner-do.priya.failed', 'mailheld.a,b'].entries()) {
      expect(seen[index]!.body.p_sig).toBe(await routerSignature(env.WALDO_ROUTER_HMAC_SECRET, at, message));
    }
    answer = 'granted';
    await expect(directory.claim('priya')).rejects.toThrow('agent mail directory answer');
    answer = [{ handle: 'priya', rule_state: 'releasing' }];
    await expect(directory.current()).rejects.toThrow('agent mail directory answer');
    expect(agentMailDirectory({}, 'owner-do', fetcher)).toBeNull();
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
