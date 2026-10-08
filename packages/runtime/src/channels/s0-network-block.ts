import type { BrowserWorker } from '@cloudflare/playwright';
import { cloudflareBrowserGuardOptions } from './cloudflare-browser-adapter';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';

// S0: prove the provider-side (network) domain guard blocks off-host traffic with NO
// client-side routing in place. Staging only. Runs one short session on one allowed host
// and probes off-host origins from inside the page. Result is data only; it never reads
// owner state, makes a model call, or touches the spend ledger.
export const S0_ALLOWED_HOST = 'example.com';
export const S0_BLOCKED_PROBES = ['https://en.wikipedia.org/', 'https://github.com/', 'https://httpbin.org/get'] as const;
export type S0Probe = Readonly<{ url: string; reached: boolean; detail: string }>;
export type S0Result = Readonly<{ passed: boolean; allowedLoaded: boolean; probes: readonly S0Probe[]; terminated: boolean; sessionMs: number }>;
export type S0PageLike = Readonly<{ gotoAllowed: () => Promise<boolean>; probe: (url: string) => Promise<S0Probe> }>;

// Pure decision: pass only if the allowed host loaded and every off-host probe failed.
export const evaluateS0 = (allowedLoaded: boolean, probes: readonly S0Probe[], terminated: boolean, sessionMs: number): S0Result =>
  ({ passed: allowedLoaded && terminated && probes.length === S0_BLOCKED_PROBES.length && probes.every(p => !p.reached && !p.detail.includes('TimeoutError')), allowedLoaded, probes, terminated, sessionMs });

export const S0_TOTAL_DEADLINE_MS = 60_000;
const S0_PROBE_TIMEOUT_MS = 5_000;
const S0_WORK_CUTOFF_MS = 46_000; // absolute from start; plus 12s cleanup stays under 60s
const S0_CLEANUP_BUDGET_MS = 12_000;
const within = <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('s0 deadline')), ms); })]).finally(() => clearTimeout(timer));
};

// Hard ceiling measured from start: load 10s, acquire 25s, all page work 46s, then cleanup 12s, so the run stays under 60s. A client
// timeout is never treated as closure: `terminated` is true only when the provider session list no
// longer contains the session after Browser.close.
export async function runS0(binding: BrowserWorker, loadSdk: CloudflareBrowserSdkLoader): Promise<S0Result> {
  const started = Date.now(), left = (cutoff: number) => Math.max(1, started + cutoff - Date.now());
  const sdk = await within(loadSdk(), left(10_000));
  const session = await within(sdk.acquire(binding, cloudflareBrowserGuardOptions([S0_ALLOWED_HOST], 10000)), left(25_000));
  const id = session.sessionId;
  let browser: Awaited<ReturnType<typeof sdk.connect>> | undefined, allowedLoaded = false, terminated = false;
  const probes: S0Probe[] = [];
  try {
    await within((async () => {
      browser = await sdk.connect(binding, { sessionId: id, persistent: true } as never);
      const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
      page.setDefaultTimeout(10000);
      const response = await page.goto(`https://${S0_ALLOWED_HOST}/`, { waitUntil: 'domcontentloaded', timeout: 10000 });
      allowedLoaded = !!response && response.status() < 400;
      for (const url of S0_BLOCKED_PROBES) {
        const detail = await page.evaluate(async ({ target, timeoutMs }: { target: string; timeoutMs: number }) => {
          try { const r = await fetch(target, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) } as RequestInit); return `reached:${r.type}`; } catch (e) { return `blocked:${String(e).slice(0, 60)}`; }
        }, { target: url, timeoutMs: S0_PROBE_TIMEOUT_MS });
        // A probe that only timed out is not proof of a block.
        probes.push({ url, reached: detail.startsWith('reached:'), detail });
      }
    })(), left(S0_WORK_CUTOFF_MS));
  } catch { /* an incomplete run fails the pass check below */ }
  finally {
    try { await within((async () => { browser ??= await sdk.connect(binding, { sessionId: id, persistent: true } as never); const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close'); })(), S0_CLEANUP_BUDGET_MS / 2); } catch { /* termination can disconnect first */ }
    try { terminated = !(await within(sdk.sessions(binding), S0_CLEANUP_BUDGET_MS / 2)).some(s => s.sessionId === id); } catch { /* unconfirmed stays false */ }
  }
  return evaluateS0(allowedLoaded, probes, terminated, Date.now() - started);
}

// Staging-only throwaway entry. Requires a bearer token set as a deployment secret by the
// operator; this code never sees or logs it. Not routed on the owner-facing worker.
export async function handleS0(request: Request, env: Readonly<{ WALDO_ENVIRONMENT?: string; S0_TOKEN?: string; BROWSER?: BrowserWorker }>, loadSdk: CloudflareBrowserSdkLoader): Promise<Response> {
  if (env.WALDO_ENVIRONMENT !== 'staging' || !env.S0_TOKEN || !env.BROWSER) return new Response('not found', { status: 404 });
  const given = request.headers.get('authorization') ?? '', want = `Bearer ${env.S0_TOKEN}`;
  if (request.method !== 'POST' || given.length !== want.length || !crypto.subtle || given !== want) return new Response('not found', { status: 404 });
  return Response.json(await runS0(env.BROWSER, loadSdk));
}
