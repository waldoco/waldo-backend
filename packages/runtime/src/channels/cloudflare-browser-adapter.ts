// SDK launch is injected by authenticated Worker host. Session-wide guardrails
// are latched BEFORE restored state reaches the browser; never use shared sessions.
import type {
  Browser,
  BrowserWorker,
  WorkersLaunchOptions,
  BrowserContext,
  BrowserContextOptions,
  Page,
  HandoffCompleteResponse,
  CDPSession,
} from "@cloudflare/playwright";
import type { PrivateBrowser } from "./browser-private-session";
export type CloudflareLauncher = (
  binding: BrowserWorker,
  options: WorkersLaunchOptions,
) => Promise<Browser>;
export function cloudflarePrivateLauncher(
  binding: BrowserWorker,
  launch: CloudflareLauncher,
  allowedDomains: readonly string[],
  keepAliveMs = 10000,
): () => Promise<PrivateBrowser<BrowserContext>> {
  const launchOptions = cloudflareBrowserGuardOptions(allowedDomains, keepAliveMs);
  return async () => {
    const browser = await launch(binding, launchOptions);
    return {
      newContext: async ({ storageState }) => {
        const context = await browser.newContext({
          serviceWorkers: "block",
          ...(storageState === undefined
            ? {}
            : {
                storageState:
                  storageState as BrowserContextOptions["storageState"],
              }),
        });
        return {
          value: context,
          storageState: (options) => context.storageState(options),
          close: () => context.close(),
        };
      },
      close: () => browser.close(),
    };
  };
}

// A Live View URL is a bearer credential. Only an authenticated owner transport
// receives it; neither the model nor durable state receives the URL or CDP result.
export async function cloudflareOwnerHandoff(options: Readonly<{
  context: BrowserContext; page: Page; ownerId: string; instructions: string;
  timeoutMs: number; liveViewExpiresMs: number; signal: AbortSignal;
  assertCurrent(): Promise<void>;
  deliverToOwner(ownerId: string, url: string): Promise<void>;
  verify(): Promise<boolean>;
}>): Promise<void> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 1800000
    || !Number.isSafeInteger(options.liveViewExpiresMs) || options.liveViewExpiresMs < 60000 || options.liveViewExpiresMs > 3600000
    || !options.instructions || options.instructions.length > 4096) throw Error('browser_handoff_invalid');
  let cdp:CDPSession|undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let received: HandoffCompleteResponse | undefined;
  let expected: { targetId: string; handoffId: string } | undefined;
  let resolve!: () => void, reject!: (reason: Error) => void;
  let stop!: (reason: Error) => void;
  const interrupted = new Promise<never>((_,no)=>{stop=no;});
  void interrupted.catch(()=>{});
  const bounded = <T>(work:Promise<T>) => Promise.race([work,interrupted]);
  const completed = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Handle rejection while the CDP/delivery awaits are still in flight.
  void completed.catch(() => {});
  const matches = () => {
    if (!expected || !received || received.targetId !== expected.targetId || received.handoffId !== expected.handoffId) return;
    if (received.success === true) resolve(); else { const error=Error('browser_handoff_failed');reject(error);stop(error); }
  };
  const listener = (event: HandoffCompleteResponse) => { received = event; matches(); };
  const abort = () => stop(Error('browser_handoff_interrupted'));
  try {
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) throw Error('browser_handoff_interrupted');
    timer = setTimeout(() => stop(Error('browser_handoff_timeout')), options.timeoutMs);
    await bounded(options.assertCurrent());
    cdp = await bounded(options.context.newCDPSession(options.page));
    (cdp.on as (event:string,callback:typeof listener)=>unknown).call(cdp,'Cloudflare.handoffComplete',listener);
    const view = await bounded(cdp.send('Cloudflare.getLiveView', { mode: 'tab', expiresInMs: options.liveViewExpiresMs }));
    const url = new URL(view.devtoolsFrontendUrl);
    if (url.origin !== 'https://live.browser.run' || url.username || url.password) throw Error('browser_handoff_invalid');
    expected = await bounded(cdp.send('Cloudflare.handoff', { instructions: options.instructions, timeout: options.timeoutMs }));
    if(expected.targetId!==view.id || typeof expected.handoffId!=='string' || !expected.handoffId) throw Error('browser_handoff_invalid');
    matches();
    await bounded(options.assertCurrent());
    if (options.signal.aborted) throw Error('browser_handoff_interrupted');
    await bounded(options.deliverToOwner(options.ownerId, url.href));
    await bounded(completed);
    await bounded(options.assertCurrent());
    // "Done" is a human signal, not proof of authenticated page access.
    if (await bounded(options.verify()) !== true) throw Error('browser_handoff_unverified');
    await bounded(options.assertCurrent());
  } finally {
    try {
      if(cdp){
        (cdp.off as (event:string,callback:typeof listener)=>unknown).call(cdp,'Cloudflare.handoffComplete',listener);
        await bounded(cdp.detach());
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
    }
  }
}

export function cloudflareBrowserGuardOptions(allowedDomains: readonly string[], keepAliveMs = 10000): WorkersLaunchOptions {
  if (
    !allowedDomains.length ||
    allowedDomains.length > 50 ||
    allowedDomains.some(
      (host) => !/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host),
    )
  )
    throw Error("browser_policy_invalid");
  if (!Number.isSafeInteger(keepAliveMs) || keepAliveMs < 10000 || keepAliveMs > 600000) throw Error("browser_policy_invalid");
  return { recording: false, keep_alive: keepAliveMs, guardrails: { allowedDomains: [...allowedDomains] } };
}
