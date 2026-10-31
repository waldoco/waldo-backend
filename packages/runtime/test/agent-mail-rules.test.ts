import { describe, expect, it } from 'vitest';
import {
  AGENT_MAIL_RULE_DUE_KEY, AGENT_MAIL_RULE_TRIES, agentMailRouting, agentMailRuleHandles, intendAgentMailRule,
  reconcileAgentMailRules, sweepAgentMailRules, type AgentMailRuleCode, type AgentMailRuleDirectory, type HeldHandle, type RuleState,
} from '../src/channels/agent-mail/rules';

const ZONE = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-token-canary-6d1f0c';
const DOMAIN = 'mail.test.invalid';
const PREFIX = 'waldo-staging-mail:';
const SCRIPT = 'waldo-runtime-staging';
const env = { AGENT_MAIL_INBOUND: '1', AGENT_MAIL_DOMAIN: DOMAIN, AGENT_MAIL_ZONE_ID: ZONE, CLOUDFLARE_EMAIL_ROUTING_TOKEN: TOKEN, WALDO_ENVIRONMENT: 'staging' };

type Rule = { id: string; name: string; enabled: boolean; matchers: unknown[]; actions: unknown[] };
const rule = (id: string, name: string, to: string, worker = SCRIPT): Rule =>
  ({ id, name, enabled: true, matchers: [{ type: 'literal', field: 'to', value: to }], actions: [{ type: 'worker', value: [worker] }] });
type Failure = 'network' | 'lost' | 500 | 400 | 401 | 429;

// The Email Routing rules API as its documentation describes it, over one zone. `lost` does the work and loses the answer.
const fakeCloudflare = (initial: Rule[] = []) => {
  const rules = [...initial];
  const calls: string[] = [];
  const failures: Partial<Record<'GET' | 'POST' | 'DELETE', Failure[]>> = {};
  let next = 1;
  const answer = (status: number, body: object) => Response.json(body, { status });
  const refused = (status: number) => answer(status, { success: false, errors: [{ code: 1000 + status, message: `refused ${rules.map(r => JSON.stringify(r.matchers)).join()}` }], messages: [], result: null });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)), method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE';
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(url.pathname.startsWith(`/client/v4/zones/${ZONE}/email/routing/rules`)).toBe(true);
    calls.push(method);
    const failure = failures[method]?.shift();
    if (failure === 'network') throw new TypeError(`network down ${TOKEN}`);
    if (typeof failure === 'number') return refused(failure);
    let result: Response;
    if (method === 'GET') {
      const page = Number(url.searchParams.get('page')), perPage = Number(url.searchParams.get('per_page'));
      result = answer(200, { success: true, errors: [], messages: [], result: rules.slice((page - 1) * perPage, page * perPage),
        result_info: { page, per_page: perPage, count: rules.slice((page - 1) * perPage, page * perPage).length, total_count: rules.length, total_pages: Math.max(1, Math.ceil(rules.length / perPage)) } });
    } else if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Omit<Rule, 'id'>;
      const created = { ...body, id: `r${String(next++).padStart(4, '0')}` };
      rules.push(created);
      result = answer(200, { success: true, errors: [], messages: [], result: created });
    } else {
      const id = url.pathname.split('/').pop()!, at = rules.findIndex(r => r.id === id);
      if (at < 0) return refused(404);
      rules.splice(at, 1);
      result = answer(200, { success: true, errors: [], messages: [], result: { id } });
    }
    if (failure === 'lost') throw new TypeError('answer lost');
    return result;
  };
  const addresses = () => rules.map(r => (r.matchers[0] as { value: string }).value);
  return { fetch, rules, calls, failures, addresses };
};

// The directory's side: which handle each owner holds and its rule state.
const fakeDirectory = (owner: string, holders: Map<string, { owner: string; state: RuleState }>): AgentMailRuleDirectory & { settles: string[] } => {
  const settles: string[] = [];
  return {
    settles,
    current: async (): Promise<HeldHandle | null> => {
      const [handle, held] = [...holders].find(([, entry]) => entry.owner === owner) ?? [];
      return handle && held ? { handle, state: held.state } : null;
    },
    held: async handles => new Set(handles.filter(handle => holders.has(handle))),
    settle: async (handle, state) => {
      const held = holders.get(handle);
      if (held?.owner !== owner || held.state !== 'pending') return false;
      held.state = state; settles.push(`${handle}:${state}`);
      return true;
    },
  };
};

const fakeKv = () => {
  const map = new Map<string, unknown>();
  return { map, get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => void map.set(key, value), delete: (key: string) => map.delete(key) };
};

const world = (initial: Rule[] = [], now = 1_000_000) => {
  const cloudflare = fakeCloudflare(initial);
  const holders = new Map<string, { owner: string; state: RuleState }>();
  const directory = fakeDirectory('owner-a', holders);
  const kv = fakeKv();
  const logs: { code: AgentMailRuleCode; cloudflare: readonly number[] }[] = [];
  const setup = agentMailRouting(env, cloudflare.fetch as typeof fetch)!;
  const pass = () => reconcileAgentMailRules({ kv: kv as never, setup, directory, now: () => now, log: (code, codes = []) => void logs.push({ code, cloudflare: codes }) });
  const claim = (handle: string, owner = 'owner-a') => {
    for (const [held, entry] of holders) if (entry.owner === owner) holders.delete(held);
    holders.set(handle, { owner, state: 'pending' });
    if (owner === 'owner-a') intendAgentMailRule(kv as never, handle, now);
  };
  return { cloudflare, holders, directory, kv, logs, setup, pass, claim, due: () => kv.get<number>(AGENT_MAIL_RULE_DUE_KEY) };
};

describe('agent mail routing rules', () => {
  it('matches its own rules whatever the case of the configured domain', async () => {
    const cloudflare = fakeCloudflare([rule('r1101', `${PREFIX}priya`, `priya@${DOMAIN}`)]);
    const setup = agentMailRouting({ ...env, AGENT_MAIL_DOMAIN: DOMAIN.toUpperCase() }, cloudflare.fetch as typeof fetch)!;
    const holders = new Map([['priya', { owner: 'owner-a', state: 'pending' as RuleState }]]);
    const kv = fakeKv();
    intendAgentMailRule(kv as never, 'priya', 1_000_000);
    await reconcileAgentMailRules({ kv: kv as never, setup, directory: fakeDirectory('owner-a', holders), now: () => 1_000_000, log: () => {} });
    expect(cloudflare.calls).toEqual(['GET']);
    expect(holders.get('priya')?.state).toBe('live');
  });

  it('makes no Cloudflare call unless agent mail is on and the rule API is configured', () => {
    let fetched = 0;
    const counting = (async () => { fetched++; return new Response(); }) as typeof fetch;
    for (const missing of [{ AGENT_MAIL_INBOUND: '0' }, { AGENT_MAIL_ZONE_ID: '' }, { AGENT_MAIL_ZONE_ID: '../accounts' }, { CLOUDFLARE_EMAIL_ROUTING_TOKEN: '' },
      { AGENT_MAIL_DOMAIN: '' }, { WALDO_ENVIRONMENT: 'test' }]) {
      expect(agentMailRouting({ ...env, ...missing }, counting)).toBeNull();
    }
    expect(agentMailRouting(env, counting)).not.toBeNull();
    expect(fetched).toBe(0);
  });

  it('creates one rule for a claimed handle and settles it live', async () => {
    const w = world();
    w.claim('priya');
    await w.pass();
    expect(w.cloudflare.rules).toEqual([{ id: 'r0001', name: `${PREFIX}priya`, enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: `priya@${DOMAIN}` }], actions: [{ type: 'worker', value: [SCRIPT] }] }]);
    expect(w.holders.get('priya')?.state).toBe('live');
    expect(w.due()).toBeUndefined();
    await w.pass();
    expect(w.cloudflare.calls).toEqual(['GET', 'POST', 'GET']);
  });

  it('a create whose answer was lost is listed on the retry, never created twice', async () => {
    const w = world();
    w.claim('priya');
    w.cloudflare.failures.POST = ['lost'];
    await w.pass();
    expect(w.holders.get('priya')?.state).toBe('pending');
    expect(w.due()).toBe(1_000_000 + 60_000);
    await w.pass();
    expect(w.cloudflare.addresses()).toEqual([`priya@${DOMAIN}`]);
    expect(w.cloudflare.calls).toEqual(['GET', 'POST', 'GET']);
    expect(w.holders.get('priya')?.state).toBe('live');
  });

  it('keeps one rule when a lost answer left two', async () => {
    const w = world([rule('r0101', `${PREFIX}priya`, `priya@${DOMAIN}`), rule('r0102', `${PREFIX}priya`, `priya@${DOMAIN}`)]);
    w.claim('priya');
    await w.pass();
    expect(w.cloudflare.rules.map(r => r.id)).toEqual(['r0101']);
    expect(w.holders.get('priya')?.state).toBe('live');
  });

  it('a refused create settles failed with only the numeric code logged', async () => {
    const w = world();
    w.claim('priya');
    w.cloudflare.failures.POST = [400];
    await w.pass();
    expect(w.holders.get('priya')?.state).toBe('failed');
    expect(w.logs).toEqual([{ code: 'failed', cloudflare: [1400] }]);
    // Cloudflare's refusal message quotes the rules, addresses included; only its numeric code is kept.
    expect(JSON.stringify(w.logs)).not.toContain(`@${DOMAIN}`);
    expect(w.due()).toBeUndefined();
  });

  it('auth, rate and server refusals are retried, and a create never answered ends unknown', async () => {
    const w = world();
    w.claim('priya');
    w.cloudflare.failures.POST = [401, 429, 500, 'network', 'network', 'network', 'network', 'network'];
    const waits: number[] = [];
    for (let pass = 0; pass < AGENT_MAIL_RULE_TRIES; pass++) { await w.pass(); waits.push((w.due() ?? 0) - 1_000_000); }
    expect(waits.slice(0, 3)).toEqual([60_000, 120_000, 240_000]);
    expect(w.holders.get('priya')?.state).toBe('unknown');
    expect(w.due()).toBeUndefined();
    expect(w.cloudflare.rules).toEqual([]);
  });

  it('an address with a rule that is not Waldo\'s fails and leaves that rule alone', async () => {
    const w = world([rule('r0201', 'team forward', `priya@${DOMAIN}`, 'someone-else')]);
    w.claim('priya');
    await w.pass();
    expect(w.holders.get('priya')?.state).toBe('failed');
    expect(w.logs.map(l => l.code)).toEqual(['conflict', 'failed']);
    expect(w.cloudflare.rules.map(r => r.id)).toEqual(['r0201']);
  });

  it('a released handle\'s rule is deleted, and the handle leaves the set once it is gone', async () => {
    const w = world();
    w.claim('priya');
    await w.pass();
    w.holders.delete('priya');
    w.cloudflare.failures.DELETE = [500];
    intendAgentMailRule(w.kv as never, 'priya', 1_000_000);
    await w.pass();
    expect(w.cloudflare.rules).toHaveLength(1);
    expect(agentMailRuleHandles(w.kv as never)).toEqual(['priya']);
    await w.pass();
    expect(w.cloudflare.rules).toEqual([]);
    expect(agentMailRuleHandles(w.kv as never)).toEqual([]);
    expect(w.due()).toBeUndefined();
  });

  it('a rename deletes the old rule and creates the new one', async () => {
    const w = world();
    w.claim('priya');
    await w.pass();
    w.claim('priya.k');
    await w.pass();
    expect(w.cloudflare.addresses()).toEqual([`priya.k@${DOMAIN}`]);
    expect(w.holders.get('priya.k')?.state).toBe('live');
    expect(agentMailRuleHandles(w.kv as never)).toEqual(['priya.k']);
  });

  it('never deletes a rule that is not Waldo\'s for that handle, even one pointing at this Worker', async () => {
    const w = world([rule('r1201', 'team rule', `gone@${DOMAIN}`), rule('r1202', `${PREFIX}gone`, `gone@${DOMAIN}`)]);
    intendAgentMailRule(w.kv as never, 'gone', 1_000_000);
    await w.pass();
    expect(w.cloudflare.rules.map(r => r.id)).toEqual(['r1201']);
    expect(agentMailRuleHandles(w.kv as never)).toEqual([]);
  });

  it('a delete never gives up: past the create limit it keeps retrying, at most a day apart', async () => {
    const w = world([rule('r1301', `${PREFIX}gone`, `gone@${DOMAIN}`)]);
    intendAgentMailRule(w.kv as never, 'gone', 1_000_000);
    w.cloudflare.failures.DELETE = Array.from({ length: AGENT_MAIL_RULE_TRIES + 4 }, () => 500 as const);
    for (let pass = 0; pass < AGENT_MAIL_RULE_TRIES + 4; pass++) await w.pass();
    expect(agentMailRuleHandles(w.kv as never)).toEqual(['gone']);
    expect(w.due()).toBe(1_000_000 + 24 * 60 * 60_000);
    await w.pass();
    expect(w.cloudflare.rules).toEqual([]);
    expect(agentMailRuleHandles(w.kv as never)).toEqual([]);
  });

  it('never deletes the rule of a handle another owner now holds', async () => {
    const w = world([rule('r0301', `${PREFIX}priya`, `priya@${DOMAIN}`)]);
    intendAgentMailRule(w.kv as never, 'priya', 1_000_000);
    w.holders.set('priya', { owner: 'owner-b', state: 'live' });
    await w.pass();
    expect(w.cloudflare.rules.map(r => r.id)).toEqual(['r0301']);
    expect(agentMailRuleHandles(w.kv as never)).toEqual([]);
  });

  it('with no list or no directory, nothing is created or deleted', async () => {
    const w = world([rule('r0401', `${PREFIX}old`, `old@${DOMAIN}`)]);
    w.claim('priya');
    intendAgentMailRule(w.kv as never, 'old', 1_000_000);
    w.cloudflare.failures.GET = [500];
    await w.pass();
    expect(w.cloudflare.calls).toEqual(['GET']);
    expect(w.holders.get('priya')?.state).toBe('pending');
    const down = { ...w.directory, current: async () => { throw new Error('directory down'); } };
    await reconcileAgentMailRules({ kv: w.kv as never, setup: w.setup, directory: down, now: () => 1_000_000, log: () => {} });
    expect(w.cloudflare.calls).toEqual(['GET', 'GET']);
    expect(w.cloudflare.rules.map(r => r.id)).toEqual(['r0401']);
    expect(w.due()).toBe(1_000_000 + 60_000);
  });

  it('a claim recorded while a pass waits on the directory survives the pass and wakes the next one', async () => {
    const w = world([rule('r0901', `${PREFIX}gone`, `gone@${DOMAIN}`)]);
    intendAgentMailRule(w.kv as never, 'gone', 1_000_000);
    const racing = { ...w.directory, held: async (handles: readonly string[]) => {
      // The owner claims a new handle while the pass waits for this answer.
      w.claim('fresh');
      return w.directory.held(handles);
    } };
    await reconcileAgentMailRules({ kv: w.kv as never, setup: w.setup, directory: racing, now: () => 1_000_000, log: () => {} });
    expect(w.cloudflare.rules).toEqual([]);
    expect(agentMailRuleHandles(w.kv as never)).toEqual(['fresh']);
    expect(w.due()).toBe(1_000_000);
    await w.pass();
    expect(w.holders.get('fresh')?.state).toBe('live');
  });

  it('a handle let go keeps a newer intent recorded during the pass', async () => {
    const w = world([rule('r1001', `${PREFIX}gone`, `gone@${DOMAIN}`)]);
    intendAgentMailRule(w.kv as never, 'gone', 1_000_000);
    const remove = w.setup.routing.remove;
    const racing = { ...w.setup, routing: { ...w.setup.routing, remove: async (id: string) => {
      await remove(id);
      intendAgentMailRule(w.kv as never, 'gone', 1_000_000);
      intendAgentMailRule(w.kv as never, 'next', 1_000_000);
    } } };
    await reconcileAgentMailRules({ kv: w.kv as never, setup: racing, directory: w.directory, now: () => 1_000_000, log: () => {} });
    expect(agentMailRuleHandles(w.kv as never)).toEqual(['gone', 'next']);
    expect(w.due()).toBe(1_000_000);
  });

  it('a settle refused because the handle changed mid-pass runs again at once', async () => {
    const w = world();
    w.claim('priya');
    const settle = w.directory.settle;
    const racing = { ...w.directory, settle: async (handle: string, state: Exclude<RuleState, 'pending'>) => { w.holders.delete('priya'); return settle(handle, state); } };
    await reconcileAgentMailRules({ kv: w.kv as never, setup: w.setup, directory: racing, now: () => 1_000_000, log: () => {} });
    expect(w.due()).toBe(1_000_000);
    await w.pass();
    expect(w.cloudflare.rules).toEqual([]);
  });

  it('the token never reaches a log, an error or storage, on any path', async () => {
    const w = world();
    w.claim('priya');
    w.cloudflare.failures.GET = ['network', 500];
    w.cloudflare.failures.POST = [400];
    for (let pass = 0; pass < 4; pass++) await w.pass();
    expect(JSON.stringify([w.logs, [...w.kv.map]])).not.toContain(TOKEN);
    expect(JSON.stringify(w.logs)).not.toContain('priya');
    w.cloudflare.failures.GET = ['network'];
    await expect(w.setup.routing.list().then(() => { throw new Error('unexpected'); }, (error: Error) => error.message)).resolves.not.toContain(TOKEN);
  });

  it('reads every page of the list', async () => {
    const others = Array.from({ length: 120 }, (_, i) => rule(`o${String(i).padStart(4, '0')}`, `other ${i}`, `other${i}@${DOMAIN}`, 'someone-else'));
    const w = world([...others, rule('r0501', `${PREFIX}priya`, `priya@${DOMAIN}`)]);
    w.claim('priya');
    await w.pass();
    expect(w.cloudflare.calls).toEqual(['GET', 'GET', 'GET']);
    expect(w.holders.get('priya')?.state).toBe('live');
  });
});

describe('agent mail rule sweep', () => {
  it('deletes this environment\'s rules whose handle no one holds, and nothing else', async () => {
    const w = world([
      rule('r0601', `${PREFIX}gone`, `gone@${DOMAIN}`),
      rule('r0602', `${PREFIX}kept`, `kept@${DOMAIN}`),
      rule('r0603', 'waldo-production-mail:gone', `gone@${DOMAIN}`, 'waldo-runtime'),
      rule('r0604', 'team forward', `postmaster@${DOMAIN}`, 'someone-else'),
      rule('r0605', `${PREFIX}gone`, `elsewhere@${DOMAIN}`),
    ]);
    w.holders.set('kept', { owner: 'owner-b', state: 'live' });
    expect(await sweepAgentMailRules(w.setup, w.directory.held)).toEqual({ removed: 1, state: 'ok' });
    expect(w.cloudflare.rules.map(r => r.id)).toEqual(['r0602', 'r0603', 'r0604', 'r0605']);
  });

  it('lists before it asks who holds what, so a rule created during the sweep survives it', async () => {
    const w = world([rule('r0700', `${PREFIX}gone`, `gone@${DOMAIN}`)]);
    const held = async (handles: readonly string[]) => {
      // A claim and its create land between the sweep's list and its directory read.
      w.holders.set('fresh', { owner: 'owner-b', state: 'pending' });
      w.cloudflare.rules.push(rule('r0701', `${PREFIX}fresh`, `fresh@${DOMAIN}`));
      return w.directory.held(handles);
    };
    expect(await sweepAgentMailRules(w.setup, held)).toEqual({ removed: 1, state: 'ok' });
    expect(w.cloudflare.rules.map(r => r.id)).toEqual(['r0701']);
  });

  it('deletes nothing when the directory cannot answer', async () => {
    const w = world([rule('r0801', `${PREFIX}gone`, `gone@${DOMAIN}`)]);
    expect(await sweepAgentMailRules(w.setup, async () => { throw new Error('down'); })).toEqual({ removed: 0, state: 'unavailable' });
    expect(w.cloudflare.rules).toHaveLength(1);
  });
});
