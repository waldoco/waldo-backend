import { syntheticCommandAdapter, type SyntheticCommand, type SyntheticObservation, type SyntheticTransport } from '../../src/channels/browser-synthetic-commands';
import type { BrowserGateApprovalStore, BrowserGateOptions } from '../../src/channels/browser-gate-types';

// Core-owned fixture for the browser gate tests. A fake REQUEST BROKER, not a firewall: an in-memory synthetic
// site behind Dalda's syntheticCommandAdapter, with a request log so every test asserts what reached the "network".
// The fake supplies raw element facts only; it never decides a hold. Layer: SOURCE.
export type SiteRequest = Readonly<{ method: string; url: string; body?: string; blocked: boolean }>;
type El = SyntheticObservation['elements'][number];
const ORIGIN = 'https://site.example';
const PAGE = `${ORIGIN}/form`;
export type Submitter = 'submit' | 'untyped' | 'image';
export const fakeSite = (submitter: Submitter = 'submit') => {
  const requests: SiteRequest[] = [];
  const values: Record<string, string> = { name: '' };
  let elements: El[] = [
    { ref: 'name', tag: 'input', type: 'text', field: 'name', inForm: true },
    submitter === 'submit' ? { ref: 'send-submit', tag: 'button', type: 'submit', inForm: true }
      : submitter === 'untyped' ? { ref: 'send-submit', tag: 'button', inForm: true }
      : { ref: 'send-submit', tag: 'input', type: 'image', field: undefined as never, inForm: true },
    { ref: 'plain-button', tag: 'button', type: 'button', inForm: false },
    { ref: 'script-post-button', tag: 'button', type: 'button', inForm: false },   // its page script POSTs
    { ref: 'self-link', tag: 'a', href: PAGE, inForm: false },
    { ref: 'other-page-link', tag: 'a', href: `${ORIGIN}/items/delete?id=1`, inForm: false },
  ];
  if (submitter === 'image') elements = elements.map((e) => (e.ref === 'send-submit' ? { ref: 'send-submit', tag: 'input', type: 'image', inForm: true } as El : e));
  let allow: (r: { url: string; method: string; body?: string }) => boolean = () => false;
  let redirectTo: string | undefined;
  let before: (() => void) | undefined;
  const send = (method: string, target: string, body?: string) => {
    const ok = allow({ url: target, method, ...(body === undefined ? {} : { body }) });
    requests.push({ method, url: target, ...(body === undefined ? {} : { body }), blocked: !ok });
    return ok;
  };
  const observe = (): SyntheticObservation => ({ url: PAGE, text: 'synthetic page', elements, form: { action: `${ORIGIN}/submit`, method: 'POST', values: { ...values } } });
  const execute = async (command: SyntheticCommand, guard: () => Promise<void>, assertCurrent?: () => void) => {
    await guard();
    if (command.operation === 'goto') { if (send('GET', command.url) && redirectTo) send('POST', redirectTo, '{}'); return; }
    if (command.operation === 'type') { if (command.value !== undefined) values.name = command.value; return; }
    if (command.operation !== 'click') return;
    const e = elements.find((x) => x.ref === command.element_ref); if (!e) throw Error('no such element');
    if (e.tag === 'a' && e.href) { send('GET', e.href); return; }
    if (e.ref === 'script-post-button') { send('POST', `${ORIGIN}/api/side-effect`, '{}'); return; }
    if (e.ref === 'send-submit') { before?.(); assertCurrent?.(); send('POST', `${ORIGIN}/submit`, new URLSearchParams(values).toString()); }
  };
  return {
    origin: ORIGIN, pageUrl: PAGE, requests, values,
    posts: () => requests.filter((r) => r.method !== 'GET' && !r.blocked),
    blockedWrites: () => requests.filter((r) => r.method !== 'GET' && r.blocked),
    gets: () => requests.filter((r) => r.method === 'GET'),
    addElement: (e: El) => { elements = [...elements, e]; },
    redirectGotoTo: (target: string) => { redirectTo = target; },
    beforeEffect: (fn: () => void) => { before = fn; },
    wire: (next: typeof allow) => { allow = next; },
    transportBody: { observe, execute },
  };
};

export const memoryStore = () => {
  let record: unknown = null;
  let chain: Promise<unknown> = Promise.resolve();
  return { load: async () => record, save: async (next: unknown) => { record = next; }, exclusive: <T,>(work: () => Promise<T>) => { const run = chain.then(work, work); chain = run.catch(() => undefined); return run; } };
};

// In-memory approval store with the same one-time rule as the real desk ledger.
export const memoryApprovals = () => {
  const open = new Map<string, { proposal: unknown; used: boolean }>();
  let n = 0;
  const store: BrowserGateApprovalStore = {
    async create(proposal) { const ref = `approval-${++n}`; open.set(ref, { proposal, used: false }); return ref; },
    async consume(_ownerId, proposal, ref) {
      const row = open.get(ref); if (!row || row.used || JSON.stringify(row.proposal) !== JSON.stringify(proposal)) return false;
      row.used = true; return true;
    },
  };
  return Object.assign(store, { open });
};

export const OWNER = 'owner-1';
export const harness = (opts: Partial<{ now: number; submitter: Submitter }> = {}) => {
  const site = fakeSite(opts.submitter);
  const clock = { now: opts.now ?? 1_000_000 };
  const approvals = memoryApprovals();
  const store = memoryStore();
  const sessions = { started: [] as { lifetimeMs: number }[], closed: [] as string[] };
  let alive = false;
  const transport: SyntheticTransport = {
    async start(lifetimeMs, allowRequest) { sessions.started.push({ lifetimeMs }); site.wire(allowRequest); alive = true; return 'sess-1'; },
    async observe() { return site.transportBody.observe(); },
    async execute(_id, command, _digest, guard, assertCurrent) { await site.transportBody.execute(command, guard, assertCurrent); },
    async close(id) { sessions.closed.push(id); alive = false; },
    async absent() { return !alive; },
    async verify() { return null; },
  };
  const driver = syntheticCommandAdapter({ origin: site.origin, pageUrl: site.pageUrl, runId: 'run-1', submitRef: 'send-submit', transport });
  const options = {
    enabled: true, ownerId: OWNER, manifestDigest: `sha256:${'a'.repeat(64)}`, driver, store, approvals,
    now: () => clock.now, newId: (() => { let i = 0; return () => `id-${++i}`; })(), admit: async () => 'grant-ref',
  } as unknown as BrowserGateOptions;
  return { options, site, clock, approvals, store, sessions, isAlive: () => alive };
};
