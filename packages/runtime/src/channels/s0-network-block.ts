import type { BrowserWorker } from '@cloudflare/playwright';
import { browserSessionSchema } from '@waldo/contracts';
import { cloudflareBrowserGuardOptions } from './cloudflare-browser-adapter';
import { cloudflareGeneralBrowser } from './cloudflare-general-browser';
import { publicBrowserRequestAuthorizer } from './public-browser-request-filter';
import { PUBLIC_WEB_ORIGIN } from './public-web-policy';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';

// S0: prove egress control on the two browser paths a Worker can exercise without owner state. Staging only.
// Neither check reads owner state, makes a model call or touches the spend ledger.
//   one-shot  : the provider-side domain guard blocks off-host traffic with no client routing in place.
//   retained  : the real retained-session driver in 'public' mode, behind the production request filter
//               (no provider guard), refuses private and metadata addresses. Evidence is the filter's own log.
export const S0_ALLOWED_HOST = 'example.com';
export const S0_BLOCKED_PROBES = ['https://en.wikipedia.org/', 'https://github.com/', 'https://httpbin.org/get'] as const;
export type S0Probe = Readonly<{ url: string; reached: boolean; detail: string }>;
export type S0Result = Readonly<{ passed: boolean; allowedLoaded: boolean; probes: readonly S0Probe[]; terminated: boolean; sessionMs: number }>;

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
export type S0Budgets = Readonly<{ load: number; acquire: number; work: number; cleanup: number }>;
export const S0_BUDGETS: S0Budgets = { load: 10_000, acquire: 25_000, work: S0_WORK_CUTOFF_MS, cleanup: S0_CLEANUP_BUDGET_MS };

export async function runS0(binding: BrowserWorker, loadSdk: CloudflareBrowserSdkLoader, budgets: S0Budgets = S0_BUDGETS): Promise<S0Result> {
  const started = Date.now(), left = (cutoff: number) => Math.max(1, started + cutoff - Date.now());
  const sdk = await within(loadSdk(), left(budgets.load));
  const closeById = async (sessionId: string): Promise<boolean> => {
    try { const b = await within(sdk.connect(binding, { sessionId, persistent: true } as never), budgets.cleanup / 2); const cdp = await b.newBrowserCDPSession(); await within(cdp.send('Browser.close'), budgets.cleanup / 2); } catch { /* termination can disconnect first */ }
    try { return !(await within(sdk.sessions(binding), budgets.cleanup / 2)).some(x => x.sessionId === sessionId); } catch { return false; }
  };
  // If acquire misses its deadline it can still resolve later: close that exact session, never leave it running.
  const acquiring = sdk.acquire(binding, cloudflareBrowserGuardOptions([S0_ALLOWED_HOST], 10000));
  let session: Awaited<typeof acquiring>;
  try { session = await within(acquiring, left(budgets.acquire)); }
  catch (error) { void acquiring.then(late => { if (typeof late?.sessionId === 'string') void closeById(late.sessionId); }, () => undefined); throw error; }
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
    })(), left(budgets.work));
  } catch { /* an incomplete run fails the pass check below */ }
  finally {
    try { await within((async () => { browser ??= await sdk.connect(binding, { sessionId: id, persistent: true } as never); const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close'); })(), budgets.cleanup / 2); } catch { /* termination can disconnect first */ }
    try { terminated = !(await within(sdk.sessions(binding), budgets.cleanup / 2)).some(s => s.sessionId === id); } catch { /* unconfirmed stays false */ }
  }
  return evaluateS0(allowedLoaded, probes, terminated, Date.now() - started);
}


// Retained-session probes. All https, so a request reaches the route handler before any mixed-content
// or connection check could hide it from the filter log.
export const S0_PRIVATE_PROBES = ['https://127.0.0.1/', 'https://localhost/', 'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.1/', 'https://[::1]/', 'https://metadata.google.internal/'] as const;
export const S0_REDIRECT_TARGET = 'https://169.254.169.254/latest/api/token';
export type S0Decision = Readonly<{ url: string; method: string; allowed: boolean }>;
export type S0RetainedResult = Readonly<{ passed: boolean; pageLoaded: boolean; redirectRejected: boolean; terminated: boolean; decisions: readonly S0Decision[]; sessionMs: number }>;

// A probe that never reached the filter is not proof of a block, so each target must appear in the log, only as denied.
export const evaluateS0Retained = (input: Readonly<{ origin: string; decisions: readonly S0Decision[]; pageLoaded: boolean; redirectRejected: boolean; terminated: boolean }>): Readonly<{ passed: boolean }> => {
  const deniedOnly = (url: string) => { const rows = input.decisions.filter(d => d.url === url); return rows.length > 0 && rows.every(d => !d.allowed); };
  const controlAllowed = input.decisions.some(d => d.url === `${input.origin}${S0_CONTROL_PATH}` && d.allowed);
  return { passed: input.pageLoaded && input.redirectRejected && input.terminated && controlAllowed && S0_PRIVATE_PROBES.every(deniedOnly) && deniedOnly(S0_REDIRECT_TARGET) };
};

const S0_RETAINED_SESSION_MS = 30_000;
const S0_RETAINED_WORK_MS = 46_000;
const S0_PROBE_SETTLE_MS = 8_000;
const S0_DECISION_CAP = 200;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function runS0Retained(binding: BrowserWorker, loadSdk: CloudflareBrowserSdkLoader, origin: string,
  authorize: (url: string, method: string) => Promise<boolean> = publicBrowserRequestAuthorizer([PUBLIC_WEB_ORIGIN]), budgets: S0Budgets = S0_BUDGETS): Promise<S0RetainedResult> {
  const started = Date.now(), left = (cutoff: number) => Math.max(1, started + cutoff - Date.now());
  const decisions: S0Decision[] = [];
  const filter = async (url: string, method: string) => {
    const allowed = await authorize(url, method);
    if (decisions.length < S0_DECISION_CAP) decisions.push({ url, method, allowed });
    return allowed;
  };
  const driver = cloudflareGeneralBrowser({ ownerId: 's0', publicRead: true, retainConnection: true, binding, loadSdk, now: Date.now, deadline: () => started + S0_RETAINED_WORK_MS, cleanupTimeoutMs: 10_000, admit: async () => {}, authorizeRequest: filter, maxScreenshotBytes: 1_000_000 });
  let providerId: string | undefined, session: ReturnType<typeof browserSessionSchema.parse> | undefined, pageLoaded = false, redirectRejected = false, terminated = false;
  const starting = driver.start('public', S0_RETAINED_SESSION_MS, async () => {}, async id => { providerId = id; });
  try {
    try { await within(starting, left(budgets.acquire)); }
    catch (error) { void starting.then(late => closeLate(loadSdk, binding, late, budgets.cleanup), () => undefined); throw error; }
    session = browserSessionSchema.parse({ id: crypto.randomUUID(), ownerId: 's0', provider: 'cloudflare_playwright', providerSessionId: providerId, contextHandle: null, mode: 'public', state: 'active', generation: 1, expiresAt: Date.now() + S0_RETAINED_SESSION_MS, updatedAt: Date.now() });
    const live = session;
    await within((async () => {
      await driver.navigate(live, `${origin}${S0_PROBE_PAGE_PATH}`);
      pageLoaded = true;
      const expected = [`${origin}${S0_CONTROL_PATH}`, ...S0_PRIVATE_PROBES];
      for (const settleBy = Date.now() + S0_PROBE_SETTLE_MS; Date.now() < settleBy && !expected.every(url => decisions.some(d => d.url === url));) await sleep(250);
      // Last, because a refused main document drops the retained connection.
      try { await driver.navigate(live, `${origin}${S0_REDIRECT_PATH}`); } catch { redirectRejected = true; }
    })(), left(budgets.work));
  } catch { /* an incomplete run fails the pass check below */ }
  finally {
    try { await driver.disconnect(); } catch { /* termination below is authoritative */ }
    if (session) try { await driver.terminate(session); } catch { /* the independent readback decides */ }
    if (providerId) try { terminated = !(await within((await loadSdk()).sessions(binding), budgets.cleanup / 2)).some(s => s.sessionId === providerId); } catch { /* unconfirmed stays false */ }
  }
  const evaluation = evaluateS0Retained({ origin, decisions, pageLoaded, redirectRejected, terminated });
  return { passed: evaluation.passed, pageLoaded, redirectRejected, terminated, decisions, sessionMs: Date.now() - started };
}

const closeLate = async (loadSdk: CloudflareBrowserSdkLoader, binding: BrowserWorker, sessionId: string, cleanupMs: number) => {
  try { const sdk = await loadSdk(); const b = await within(sdk.connect(binding, { sessionId, persistent: true } as never), cleanupMs / 2); await within((await b.newBrowserCDPSession()).send('Browser.close'), cleanupMs / 2); } catch { /* the session expires on its own keep-alive */ }
};

export const S0_CONTROL_PATH = '/s0/control';
export const S0_PROBE_PAGE_PATH = '/s0/probe-page';
export const S0_REDIRECT_PATH = '/s0/redirect';
export const S0_PATHS: readonly string[] = ['/s0', '/s0/ready', '/s0/retained', S0_PROBE_PAGE_PATH, S0_REDIRECT_PATH, S0_CONTROL_PATH];

const probePageHtml = (origin: string) => `<!doctype html><meta charset="utf-8"><title>S0 probe page</title><p>S0 probe page</p><script>
for (const url of ${JSON.stringify([`${origin}${S0_CONTROL_PATH}`, ...S0_PRIVATE_PROBES])}) fetch(url, { mode: 'no-cors', cache: 'no-store' }).catch(() => undefined);
</script>`;

const digest = (text: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
const bearerMatches = async (given: string, token: string) => { const [a, b] = await Promise.all([digest(given), digest(`Bearer ${token}`)]); return crypto.subtle.timingSafeEqual(a, b); };

// Staging-only throwaway entry. Requires a bearer token set as a deployment secret by the
// operator; this code never sees or logs it. Not routed on the owner-facing worker.
// The probe routes are static, carry no secret and make no browser call: the retained check's own
// browser has to fetch them, and it cannot send the bearer.
export const S0_HANDLER_VERSION = 's0-gate-v4';
export async function handleS0(request: Request, env: Readonly<{ WALDO_ENVIRONMENT?: string; S0_TOKEN?: string; BROWSER?: BrowserWorker }>, loadSdk: CloudflareBrowserSdkLoader): Promise<Response> {
  // Opaque bodies stay; a header names this worker and the failed check so a 403 from the edge is distinguishable from ours.
  const reply = (body: BodyInit | null, status: number, reason: string, type?: string, extra: Record<string, string> = {}) => new Response(body, { status, headers: { 'x-waldo-s0': `waldo-s0-staging;${reason}`, ...(type ? { 'content-type': type } : {}), ...extra } });
  const url = new URL(request.url);
  if (!S0_PATHS.includes(url.pathname)) return reply('not found', 404, 'path');
  if (request.method === 'GET' && env.WALDO_ENVIRONMENT === 'staging') {
    if (url.pathname === S0_PROBE_PAGE_PATH) return reply(probePageHtml(url.origin), 200, 'probe', 'text/html; charset=utf-8');
    if (url.pathname === S0_CONTROL_PATH) return reply('ok', 200, 'control', 'text/plain');
    if (url.pathname === S0_REDIRECT_PATH) return reply(null, 302, 'redirect', undefined, { location: S0_REDIRECT_TARGET });
  }
  if (env.WALDO_ENVIRONMENT !== 'staging' || !env.S0_TOKEN || !env.BROWSER) return reply('not found', 404, 'config');
  const authed = await bearerMatches(request.headers.get('authorization') ?? '', env.S0_TOKEN);
  // Authenticated readiness: same gate as the POST, no browser call, no session.
  if (request.method === 'GET' && url.pathname === '/s0/ready') return authed ? reply(JSON.stringify({ ready: true, version: S0_HANDLER_VERSION }), 200, 'ready', 'application/json') : reply('not found', 404, 'auth');
  if (request.method !== 'POST' || (url.pathname !== '/s0' && url.pathname !== '/s0/retained')) return reply('not found', 404, 'method');
  if (!authed) return reply('not found', 404, 'auth');
  try {
    // The session is paid and the in-isolate state is not shared, so the provider's own list is the throttle.
    if ((await (await loadSdk()).sessions(env.BROWSER)).length) return reply('busy', 429, 'busy');
    const result = url.pathname === '/s0' ? await runS0(env.BROWSER, loadSdk) : await runS0Retained(env.BROWSER, loadSdk, url.origin);
    return reply(JSON.stringify(result), 200, 'ok', 'application/json');
  }
  catch (error) { return reply(JSON.stringify({ error: error instanceof Error ? error.name : 'unknown' }), 502, 'error', 'application/json'); }
}
