import type { BrowserWorker } from '@cloudflare/playwright';

// A CDP browser vendor as the pinned Cloudflare Playwright SDK needs it. The SDK reaches a browser only through three
// binding requests (allocate, list, devtools upgrade), so a vendor behind this binding runs the general driver, its
// route guard and its custody unchanged: Waldo's own tools drive the page, never a vendor agent.
export type CdpVendor = Readonly<{
  create(lifetimeMs: number): Promise<string>;
  running(): Promise<readonly string[]>;
  connectUrl(id: string): Promise<string | undefined>;
  release(id: string): Promise<void>;
}>;

export class CdpVendorStatus extends Error {
  constructor(readonly status: number) { super(`browser_vendor_${status}`); }
}

const SESSION_PATH = /^\/v1\/devtools\/browser\/([a-zA-Z0-9_-]{1,128})$/;
// Vendor prose and keys never reach the driver's diagnostic: only the status survives.
const refusal = (status: number) => Response.json({ code: 'browser_vendor_refused' }, { status });
const vendorStatus = (error: unknown) => error instanceof CdpVendorStatus ? error.status : 502;

export function cdpVendorBinding(vendor: CdpVendor, fetcher: typeof fetch = fetch): BrowserWorker {
  return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input)), method = init?.method ?? 'GET';
    if (url.pathname === '/v1/devtools/browser' && method === 'POST') {
      // Cloudflare guardrails ride in the body. This vendor cannot enforce them, so a guarded allocation is refused
      // rather than silently widened; the driver's route guard still authorizes every request either way.
      if (init?.body) return refusal(400);
      const lifetimeMs = Number(url.searchParams.get('keep_alive'));
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) return refusal(400);
      try { return Response.json({ sessionId: await vendor.create(lifetimeMs) }); }
      catch (error) { return refusal(vendorStatus(error)); }
    }
    if (url.pathname === '/v1/sessions' && method === 'GET') {
      try { return Response.json({ sessions: (await vendor.running()).map(sessionId => ({ sessionId })) }); }
      catch (error) { return refusal(vendorStatus(error)); }
    }
    const session = SESSION_PATH.exec(url.pathname)?.[1];
    if (session && new Headers(init?.headers).get('upgrade')?.toLowerCase() === 'websocket') {
      let target: string | undefined;
      try { target = await vendor.connectUrl(session); }
      catch (error) { return refusal(vendorStatus(error)); }
      if (!target) return refusal(404);
      // Workers open an outbound WebSocket as an https fetch carrying the upgrade header.
      const upgrade = new URL(target);
      if (upgrade.protocol !== 'wss:') return refusal(502);
      upgrade.protocol = 'https:';
      return fetcher(upgrade, { headers: { Upgrade: 'websocket' } });
    }
    return refusal(404);
  } } as BrowserWorker;
}

// Browserbase's per-browser-hour overage on the Developer plan (https://docs.browserbase.com/guides/plans-and-pricing).
// Hours inside the plan are already paid for, so metering every hour at this rate errs on the safe side of the cap.
export const BROWSERBASE_MICROUSD_PER_HOUR = 120_000;
const BROWSERBASE_API = 'https://api.browserbase.com/v1/sessions';
type BrowserbaseSession = Readonly<{ id?: unknown; connectUrl?: unknown }>;

export function browserbaseVendor(options: Readonly<{ apiKey: string; projectId: string; fetcher?: typeof fetch }>): CdpVendor {
  const fetcher = options.fetcher ?? fetch;
  // A connect URL carries a signing key, so it lives only in this isolate's memory, never in storage or logs.
  const connectUrls = new Map<string, string>();
  const call = async (url: string, init?: Readonly<{ method: 'POST'; body: unknown }>) => {
    const response = await fetcher(url, { method: init?.method ?? 'GET', headers: { 'x-bb-api-key': options.apiKey, 'content-type': 'application/json' }, ...(init ? { body: JSON.stringify(init.body) } : {}) });
    if (!response.ok) { await response.body?.cancel(); throw new CdpVendorStatus(response.status); }
    return response.json() as Promise<unknown>;
  };
  const remember = (row: BrowserbaseSession) => {
    if (typeof row.id === 'string' && typeof row.connectUrl === 'string') connectUrls.set(row.id, row.connectUrl);
    return row;
  };
  return {
    async create(lifetimeMs) {
      const row = remember(await call(BROWSERBASE_API, { method: 'POST', body: { projectId: options.projectId, keepAlive: true, timeout: Math.ceil(lifetimeMs / 1000) } }) as BrowserbaseSession);
      if (typeof row.id !== 'string') throw new CdpVendorStatus(502);
      return row.id;
    },
    async running() {
      const rows = await call(`${BROWSERBASE_API}?status=RUNNING`);
      if (!Array.isArray(rows)) throw new CdpVendorStatus(502);
      return rows.flatMap((row: BrowserbaseSession) => typeof row.id === 'string' ? [row.id] : []);
    },
    async connectUrl(id) {
      const known = connectUrls.get(id);
      if (known) return known;
      const row = remember(await call(`${BROWSERBASE_API}/${encodeURIComponent(id)}`) as BrowserbaseSession);
      return typeof row.connectUrl === 'string' ? row.connectUrl : undefined;
    },
    async release(id) {
      await call(`${BROWSERBASE_API}/${encodeURIComponent(id)}`, { method: 'POST', body: { projectId: options.projectId, status: 'REQUEST_RELEASE' } });
      connectUrls.delete(id);
    },
  };
}
