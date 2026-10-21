// SDK launch is injected by authenticated Worker host. Session-wide guardrails
// are latched BEFORE restored state reaches the browser; never use shared sessions.
import type {
  Browser,
  BrowserWorker,
  WorkersLaunchOptions,
  BrowserContext,
  BrowserContextOptions,
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
): () => Promise<PrivateBrowser<BrowserContext>> {
  const launchOptions = cloudflareBrowserGuardOptions(allowedDomains);
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
