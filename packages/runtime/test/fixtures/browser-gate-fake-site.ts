import type { BrowserGateApprovalStore, BrowserGateCommand, BrowserGateObservation, BrowserGateOptions } from '../../src/channels/browser-gate-types';

// Core-owned fixture for the browser gate tests. An in-memory synthetic site with a request log,
// so every test can assert exactly what reached the "network". Layer: SOURCE (no real browser).
export type SiteRequest = Readonly<{ method: string; url: string; body?: string; blocked: boolean }>;
type El = BrowserGateObservation['elements'][number];
const ORIGIN = 'https://site.example';
export const fakeSite = () => {
  const requests: SiteRequest[] = [];
  const values: Record<string, string> = {};
  let url = `${ORIGIN}/form`;
  let allow: (r: { url: string; method: string; body?: string }) => boolean = () => true;
  const pages: Record<string, readonly El[]> = {
    [`${ORIGIN}/form`]: [
      { ref: 'name', tag: 'input', type: 'text', field: 'name', inForm: true },
      { ref: 'send-submit', tag: 'button', type: 'submit', inForm: true },
      { ref: 'send-untyped', tag: 'button', inForm: true },                 // a button with no type inside a form submits
      { ref: 'plain-button', tag: 'button', type: 'button', inForm: false },
      { ref: 'script-post-button', tag: 'button', type: 'button', inForm: false }, // its page script POSTs
      { ref: 'feedback-link', tag: 'a', href: `${ORIGIN}/feedback`, inForm: false },
      { ref: 'delete-link', tag: 'a', href: `${ORIGIN}/items/delete?id=1`, inForm: false },
      { ref: 'password', tag: 'input', type: 'password', field: 'password', inForm: true },
    ],
    [`${ORIGIN}/feedback`]: [],
    [`${ORIGIN}/items/delete?id=1`]: [],
  };
  const redirects: Record<string, string> = {};
  let before: (() => void) | undefined;
  const send = (method: string, target: string, body?: string) => {
    if (method !== 'GET') before?.();
    const ok = allow({ url: target, method, ...(body === undefined ? {} : { body }) });
    requests.push({ method, url: target, ...(body === undefined ? {} : { body }), blocked: !ok });
    return ok;
  };
  const el = (ref: string) => pages[url]?.find((e) => e.ref === ref);
  return {
    origin: ORIGIN, requests, values,
    posts: () => requests.filter((r) => r.method !== 'GET' && !r.blocked),
    blockedWrites: () => requests.filter((r) => r.method !== 'GET' && r.blocked),
    gets: () => requests.filter((r) => r.method === 'GET'),
    addElement: (e: El) => { pages[url] = [...(pages[url] ?? []), e]; },
    addRedirect: (from: string, to: string) => { redirects[from] = to; },
    beforeEffect: (fn: () => void) => { before = fn; },
    setAllow: (fn: typeof allow) => { allow = fn; },
    observe: (): BrowserGateObservation => ({ url, text: 'synthetic page', elements: pages[url] ?? [], form: { action: `${ORIGIN}/submit`, method: 'POST', values: { ...values } } }),
    apply(command: BrowserGateCommand): void {
      if (command.operation === 'goto') { if (!send('GET', command.url)) return; const hop = redirects[command.url]; if (hop) { send('POST', hop, '{}'); return; } url = command.url; return; }
      if (command.operation === 'type') {
        const e = el(command.element_ref); if (!e?.field || e.type === 'password') throw Error('field not typeable');
        if (command.value !== undefined) values[e.field] = command.value;
        if (command.key === 'Enter') send('POST', `${ORIGIN}/submit`, JSON.stringify(values));
        return;
      }
      if (command.operation !== 'click') return;
      const e = el(command.element_ref); if (!e) throw Error('no such element');
      if (e.tag === 'a' && e.href) { if (send('GET', e.href)) url = e.href; return; }
      if (e.ref === 'script-post-button') { send('POST', `${ORIGIN}/api/side-effect`, '{}'); return; }
      if ((e.tag === 'button' || e.tag === 'input') && e.inForm && (e.type === undefined || e.type === 'submit' || e.type === 'image')) send('POST', `${ORIGIN}/submit`, JSON.stringify(values));
    },
  };
};

export const memoryStore = () => {
  let record: unknown;
  let chain: Promise<unknown> = Promise.resolve();
  return { load: async () => record, save: async (next: unknown) => { record = next; }, exclusive: <T,>(work: () => Promise<T>) => { const run = chain.then(work, work); chain = run.catch(() => undefined); return run; } };
};

// In-memory approval store with the same one-time rule as the real desk ledger: consume succeeds once, for the owner and proposal it was created for.
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
export const harness = (overrides: Partial<{ now: number }> = {}) => {
  const site = fakeSite();
  const clock = { now: overrides.now ?? 1_000_000 };
  const approvals = memoryApprovals();
  const store = memoryStore();
  const sessions = { started: [] as { lifetimeMs: number }[], closed: [] as string[] };
  let alive = false;
  let ids = 0;
  const driver = {
    provider: 'cloudflare_playwright', origin: site.origin, pageUrl: `${site.origin}/form`, runId: 'run-1', submitRef: 'submit',
    start: async (lifetimeMs: number) => { sessions.started.push({ lifetimeMs }); alive = true; return 'sess-1'; },
    navigate: async () => undefined, inspect: async () => ({ url: site.observe().url, stateDigest: `sha256:${'b'.repeat(64)}`, binding: {} }),
    fill: async () => undefined, submit: async () => undefined, verify: async () => null,
    end: async (id: string) => { sessions.closed.push(id); alive = false; },
    command: async (_id: string, command: BrowserGateCommand) => { site.apply(command); return { held: false }; },
  };
  // SEAM REQUEST: the gate must see element facts (tag/type/inForm), which BrowserGateSessionDriver does not expose.
  // The tests pass the observation port as `port`; Dalda to confirm the real shape or tell Core the alternative.
  const port = { observe: async (_id: string) => site.observe(), absent: async (_id: string) => !alive, close: async (id: string) => driver.end(id) };
  const options = {
    enabled: true, ownerId: OWNER, manifestDigest: `sha256:${'a'.repeat(64)}`, driver, store, approvals, port,
    now: () => clock.now, newId: () => `id-${++ids}`, admit: async () => 'grant-ref',
  } as unknown as BrowserGateOptions;
  return { options, site, clock, approvals, store, sessions, isAlive: () => alive };
};
