import { withRequestTimeout } from '../../identity/request-timeout';

// The Email Routing rule behind each handle. Cloudflare routes a subdomain address only through a literal rule, so every
// claimed handle needs one rule pointing at this Worker. The directory holds what is wanted (a handle and whether its rule
// is set up); Cloudflare's own rule list is the truth of what exists, read before every change, so an attempt whose answer
// was lost is reconciled by address, never repeated blind. The owner's object is the one retry owner: its alarm creates and
// deletes the rules of the handles it claimed. The nightly sweep only deletes rules no held handle accounts for (an
// account deleted with its owner object leaves no one else to).

export const AGENT_MAIL_RULE_DUE_KEY = 'agent_mail_rule_due_v1';
// The handles this owner claimed whose rules may still exist: the current one, and any released or renamed away until
// Cloudflare's list shows their rules gone. Written before the directory call that claims or releases, each with a fresh
// token: a pass lets a handle go only if its token is the one the pass started from, so an intent recorded while the pass
// waited on Cloudflare or the directory is never lost.
export const AGENT_MAIL_RULE_HANDLES_KEY = 'agent_mail_rule_handles_v1';
type Intents = Record<string, string>;
const TRIES_KEY = 'agent_mail_rule_tries_v1';
// A create that keeps ending without an answer stops here and is reported as unknown; the owner retries by claiming the
// same handle again. A delete keeps retrying, at most once a day: a stale rule routes nothing, but it holds a slot.
export const AGENT_MAIL_RULE_TRIES = 8;
const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = 24 * 60 * 60_000;
// Rule lists come 50 to a page; the zone holds at most 200 rules, so more pages than this is not a zone this code knows.
const LIST_PAGES_MAX = 10;
const PER_PAGE = 50;
const API = 'https://api.cloudflare.com/client/v4';
// The Worker each environment's rules point at: the script names in wrangler.jsonc.
const SCRIPTS: Readonly<Record<string, string>> = { production: 'waldo-runtime', staging: 'waldo-runtime-staging' };

export type RoutingRule = Readonly<{ id: string; name: string; to: readonly string[]; worker: string | null }>;
export type EmailRouting = Readonly<{
  list(): Promise<RoutingRule[]>;
  create(name: string, address: string): Promise<void>;
  remove(id: string): Promise<void>;
}>;

// A refused or unanswered Cloudflare call. Only the status and Cloudflare's numeric error codes are kept: a response body
// can quote an address, so no text of it is held where it could be logged.
export class EmailRoutingError extends Error {
  constructor(readonly status: number | null, readonly codes: readonly number[]) { super(`email routing ${status ?? 'no answer'}`); }
  // A refusal that the same request will meet again. Auth and rate refusals are the deployment's, not the handle's: they
  // are retried, and a timeout or server error may have done the work.
  get definite(): boolean { return this.status !== null && this.status >= 400 && this.status < 500 && ![401, 403, 408, 429].includes(this.status); }
}

export type AgentMailRoutingEnv = Readonly<{
  AGENT_MAIL_INBOUND?: string;
  AGENT_MAIL_DOMAIN?: string;
  AGENT_MAIL_ZONE_ID?: string;
  CLOUDFLARE_EMAIL_ROUTING_TOKEN?: string;
  WALDO_ENVIRONMENT?: string;
}>;
export type AgentMailRouting = Readonly<{ routing: EmailRouting; domain: string; prefix: string; script: string }>;

const ZONE = /^[0-9a-f]{32}$/;
const RULE_ID = /^[A-Za-z0-9]{1,64}$/;
// While agent mail is off, recorded rule work waits and is looked at again daily: a claim or a view wakes it sooner.
const DEFER_MS = 24 * 60 * 60_000;

// Null unless agent mail is on and every part of the rule API is configured: with any of it missing no Cloudflare call is made.
export const agentMailRouting = (env: AgentMailRoutingEnv, fetcher: typeof fetch = fetch): AgentMailRouting | null => {
  const script = SCRIPTS[env.WALDO_ENVIRONMENT ?? ''];
  const { AGENT_MAIL_ZONE_ID: zone, CLOUDFLARE_EMAIL_ROUTING_TOKEN: token } = env, domain = env.AGENT_MAIL_DOMAIN?.toLowerCase();
  if (env.AGENT_MAIL_INBOUND !== '1' || !script || !domain || !token || !zone || !ZONE.test(zone)) return null;
  // The environment is in the name so one environment's sweep never takes another's rules on a shared zone.
  return { routing: cloudflareEmailRouting(token, zone, script, fetcher), domain, prefix: `waldo-${env.WALDO_ENVIRONMENT}-mail:`, script };
};

type Envelope = { success?: unknown; errors?: unknown; result?: unknown; result_info?: { total_pages?: unknown } };
type ApiRule = { id?: unknown; name?: unknown; matchers?: unknown; actions?: unknown };

const codes = (body: Envelope | null): number[] =>
  Array.isArray(body?.errors) ? body.errors.flatMap((error: { code?: unknown }) => typeof error?.code === 'number' ? [error.code] : []) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const ruleOf = (rule: ApiRule): RoutingRule | null => {
  if (typeof rule.id !== 'string' || !RULE_ID.test(rule.id)) return null;
  const matchers = Array.isArray(rule.matchers) ? rule.matchers as { type?: unknown; field?: unknown; value?: unknown }[] : [];
  const actions = Array.isArray(rule.actions) ? rule.actions as { type?: unknown; value?: unknown }[] : [];
  const worker = actions.length === 1 && actions[0]!.type === 'worker' ? strings(actions[0]!.value) : [];
  return {
    id: rule.id, name: typeof rule.name === 'string' ? rule.name : '',
    to: matchers.flatMap(m => m.type === 'literal' && m.field === 'to' && typeof m.value === 'string' ? [m.value.toLowerCase()] : []),
    worker: worker.length === 1 ? worker[0]! : null,
  };
};

export const cloudflareEmailRouting = (token: string, zone: string, script: string, fetcher: typeof fetch = fetch): EmailRouting => {
  const call = async (path: string, init: RequestInit = {}): Promise<Envelope> => {
    let status: number | null = null, body: Envelope | null = null;
    try {
      await withRequestTimeout(async signal => {
        const response = await fetcher(`${API}/zones/${zone}/email/routing/rules${path}`, {
          ...init, signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        });
        status = response.status;
        body = await response.json().catch(() => null) as Envelope | null;
      });
    } catch { throw new EmailRoutingError(status, []); }
    const answer = body as Envelope | null;
    if (status === null || status < 200 || status >= 300 || answer?.success !== true) throw new EmailRoutingError(status, codes(answer));
    return answer;
  };
  return {
    async list() {
      const rules: RoutingRule[] = [];
      for (let page = 1; page <= LIST_PAGES_MAX; page++) {
        const body = await call(`?page=${page}&per_page=${PER_PAGE}`);
        if (!Array.isArray(body.result)) throw new EmailRoutingError(200, []);
        rules.push(...body.result.flatMap((rule: ApiRule) => { const parsed = ruleOf(rule); return parsed ? [parsed] : []; }));
        const pages = typeof body.result_info?.total_pages === 'number' ? body.result_info.total_pages : 1;
        if (page >= pages) return rules;
      }
      // A list cut short could hide a rule; nothing is decided from it.
      throw new EmailRoutingError(200, []);
    },
    async create(name, address) {
      await call('', { method: 'POST', body: JSON.stringify({
        name, enabled: true, matchers: [{ type: 'literal', field: 'to', value: address }], actions: [{ type: 'worker', value: [script] }],
      }) });
    },
    async remove(id) {
      if (!RULE_ID.test(id)) throw new EmailRoutingError(null, []);
      await call(`/${id}`, { method: 'DELETE' });
    },
  };
};

// A rule is Waldo's for a handle only when its name, its single literal address and its single action all say so. Nothing
// else is ever deleted.
const ours = (setup: AgentMailRouting, handle: string) => (rule: RoutingRule): boolean =>
  rule.name === `${setup.prefix}${handle}` && rule.to.length === 1 && rule.to[0] === `${handle}@${setup.domain}` && rule.worker === setup.script;
const handleOf = (setup: AgentMailRouting, rule: RoutingRule): string | null => {
  if (!rule.name.startsWith(setup.prefix)) return null;
  const handle = rule.name.slice(setup.prefix.length);
  return ours(setup, handle)(rule) ? handle : null;
};

export type RuleState = 'pending' | 'live' | 'failed' | 'unknown';
export type HeldHandle = Readonly<{ handle: string; state: RuleState }>;
export type AgentMailRuleDirectory = Readonly<{
  // The handle this owner holds now, or null. Throws when the directory cannot say.
  current(): Promise<HeldHandle | null>;
  // Which of these handles any owner holds. Throws when the directory cannot say.
  held(handles: readonly string[]): Promise<ReadonlySet<string>>;
  // Moves this owner's handle out of pending; false when it is no longer this owner's pending handle.
  settle(handle: string, state: Exclude<RuleState, 'pending'>): Promise<boolean>;
}>;
// Fixed codes only: never a handle, an address, a rule id or a response body. Cloudflare's numeric codes may follow.
export type AgentMailRuleCode = 'live' | 'failed' | 'unknown' | 'conflict' | 'retry' | 'removed' | 'superseded' | 'unavailable';

type Kv = Pick<SyncKvStorage, 'get' | 'put' | 'delete'>;
const backoff = (tries: number) => Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(tries - 1, 0), BACKOFF_MAX_MS);

// Writes the handle into the set the alarm reconciles, and wakes it now. Called before the directory call that changes it.
export const intendAgentMailRule = (kv: Kv, handle: string, now = Date.now()): void => {
  kv.put(AGENT_MAIL_RULE_HANDLES_KEY, { ...kv.get<Intents>(AGENT_MAIL_RULE_HANDLES_KEY), [handle]: crypto.randomUUID() });
  kv.put(AGENT_MAIL_RULE_DUE_KEY, now);
};
export const agentMailRuleHandles = (kv: Pick<Kv, 'get'>): string[] => Object.keys(kv.get<Intents>(AGENT_MAIL_RULE_HANDLES_KEY) ?? {});

// Agent mail is off or unconfigured: no Cloudflare call, and recorded work waits rather than waking every pass.
export const deferAgentMailRules = (kv: Kv, now = Date.now()): void => {
  if (agentMailRuleHandles(kv).length) kv.put(AGENT_MAIL_RULE_DUE_KEY, now + DEFER_MS);
  else kv.delete(AGENT_MAIL_RULE_DUE_KEY);
};

export async function reconcileAgentMailRules(deps: Readonly<{
  kv: Kv; setup: AgentMailRouting; directory: AgentMailRuleDirectory; now(): number;
  log(code: AgentMailRuleCode, cloudflare?: readonly number[]): void;
}>): Promise<void> {
  const { kv, setup, directory } = deps;
  const started = kv.get<Intents>(AGENT_MAIL_RULE_HANDLES_KEY) ?? {}, handles = Object.keys(started);
  if (!handles.length) { kv.delete(AGENT_MAIL_RULE_DUE_KEY); kv.delete(TRIES_KEY); return; }
  const tries = kv.get<Record<string, number>>(TRIES_KEY) ?? {};
  let wait = Infinity;
  // An attempt that ended without an answer: retried after a backoff that grows with each one. A create gives up after
  // its last try (true); a delete never does.
  const missed = (handle: string, error: unknown, givesUp = false) => {
    tries[handle] = (tries[handle] ?? 0) + 1;
    if (givesUp && tries[handle] >= AGENT_MAIL_RULE_TRIES) return true;
    wait = Math.min(wait, backoff(tries[handle]));
    deps.log('retry', error instanceof EmailRoutingError ? error.codes : []);
    return false;
  };
  // Synchronous from here on: nothing recorded between this read and these writes.
  const finish = (done: ReadonlySet<string>, again: boolean) => {
    const fresh = kv.get<Intents>(AGENT_MAIL_RULE_HANDLES_KEY) ?? {};
    const next = Object.fromEntries(Object.entries(fresh).filter(([handle, token]) => !(done.has(handle) && started[handle] === token)));
    const renewed = Object.entries(next).some(([handle, token]) => started[handle] !== token);
    kv.put(AGENT_MAIL_RULE_HANDLES_KEY, next);
    kv.put(TRIES_KEY, Object.fromEntries(Object.entries(tries).filter(([handle]) => Object.hasOwn(next, handle))));
    if (again || renewed) kv.put(AGENT_MAIL_RULE_DUE_KEY, deps.now());
    else if (wait < Infinity) kv.put(AGENT_MAIL_RULE_DUE_KEY, deps.now() + wait);
    else kv.delete(AGENT_MAIL_RULE_DUE_KEY);
  };

  // Cloudflare first, then the directory: a rule in this list was created after its claim was recorded, so the reads below
  // see that claim, and a held handle's rule is never taken for an orphan. Without a list nothing is created or deleted.
  let listed: RoutingRule[] | null = null, listError: unknown = null;
  try { listed = await setup.routing.list(); } catch (error) { listError = error; }
  let current: HeldHandle | null, held: ReadonlySet<string>;
  try {
    current = await directory.current();
    held = listed ? await directory.held(handles.filter(handle => handle !== current?.handle)) : new Set();
  } catch {
    deps.log('unavailable');
    wait = BACKOFF_FIRST_MS;
    return finish(new Set(), false);
  }

  const done = new Set<string>();
  let again = false;
  for (const handle of handles) {
    const address = `${handle}@${setup.domain}`;
    if (current?.handle === handle) {
      if (current.state !== 'pending') { delete tries[handle]; continue; }
      let outcome: Exclude<RuleState, 'pending'>, refusal: readonly number[] = [];
      try {
        if (!listed) throw listError;
        const mine = listed.filter(ours(setup, handle));
        // A create whose answer was lost and then retried can leave two; one stays.
        for (const extra of mine.slice(1)) { await setup.routing.remove(extra.id); deps.log('removed'); }
        if (mine.length) outcome = 'live';
        else if (listed.some(rule => rule.to.includes(address))) { outcome = 'failed'; deps.log('conflict'); }
        else { await setup.routing.create(`${setup.prefix}${handle}`, address); outcome = 'live'; }
      } catch (error) {
        if (error instanceof EmailRoutingError && error.definite) { outcome = 'failed'; refusal = error.codes; }
        else if (missed(handle, error, true)) outcome = 'unknown';
        else continue;
      }
      try {
        if (await directory.settle(handle, outcome)) { delete tries[handle]; deps.log(outcome, refusal); }
        // The owner changed the handle during this pass: the next pass runs at once, against the new state.
        else { again = true; deps.log('superseded'); }
      } catch (error) {
        // The rule may exist with the directory still at pending: the next pass lists it and settles.
        missed(handle, error);
      }
      continue;
    }
    if (!listed) { missed(handle, listError); continue; }
    // Another owner holds it now: its rule is theirs.
    if (held.has(handle)) { done.add(handle); continue; }
    try {
      for (const rule of listed.filter(ours(setup, handle))) { await setup.routing.remove(rule.id); deps.log('removed'); }
      done.add(handle);
    } catch (error) { missed(handle, error); }
  }
  finish(done, again);
}

// The nightly sweep: Waldo's rules in this environment whose handle no owner holds, left by an account deletion (the owner
// object goes with the account, so no alarm is left to delete them). It only deletes, and lists before it asks the directory.
export async function sweepAgentMailRules(setup: AgentMailRouting, held: AgentMailRuleDirectory['held']): Promise<{ removed: number; state: 'ok' | 'unavailable' }> {
  let removed = 0;
  try {
    const rules = (await setup.routing.list()).flatMap(rule => { const handle = handleOf(setup, rule); return handle ? [{ rule, handle }] : []; });
    if (!rules.length) return { removed, state: 'ok' };
    const holding = await held([...new Set(rules.map(entry => entry.handle))]);
    for (const { rule, handle } of rules) {
      if (holding.has(handle)) continue;
      await setup.routing.remove(rule.id);
      removed++;
    }
    return { removed, state: 'ok' };
  } catch { return { removed, state: 'unavailable' }; }
}
