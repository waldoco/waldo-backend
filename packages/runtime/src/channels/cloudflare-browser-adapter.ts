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
  if (
    !allowedDomains.length ||
    allowedDomains.length > 50 ||
    allowedDomains.some(
      (host) => !/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host),
    )
  )
    throw Error("browser_policy_invalid");
  const domains = [...allowedDomains];
  return async () => {
    const browser = await launch(binding, {
      recording: false,
      keep_alive: 10_000,
      guardrails: { allowedDomains: domains },
    });
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
