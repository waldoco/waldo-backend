import { it, expect } from "vitest";
import {
  cloudflarePrivateLauncher,
  type CloudflareLauncher,
} from "../src/channels/cloudflare-browser-adapter";
import type { Browser, BrowserWorker } from "@cloudflare/playwright";
it("launches isolated nonrecorded minimal keepalive browser with latched allowlist", async () => {
  let launchArgs: unknown, contextArgs: unknown;
  const domains = ["example.org"];
  const launch: CloudflareLauncher = async (_binding, args) => {
    launchArgs = args;
    return {
      newContext: async (input: unknown) => {
        contextArgs = input;
        return {
          storageState: async () => ({ cookies: [] }),
          close: async () => {},
        };
      },
      close: async () => {},
    } as unknown as Browser;
  };
  const start = cloudflarePrivateLauncher({} as BrowserWorker, launch, domains);
  domains[0] = "attacker.org";
  const browser = await start();
  await browser.newContext({ storageState: { cookies: [] } });
  expect(launchArgs).toEqual({
    recording: false,
    keep_alive: 10000,
    guardrails: { allowedDomains: ["example.org"] },
  });
  expect(contextArgs).toEqual({
    serviceWorkers: "block",
    storageState: { cookies: [] },
  });
});
for (const domains of [
  [],
  ["*"],
  ["https://example.org"],
  ["*.example.org"],
  ["localhost"],
  ["127.0.0.1"],
  ["example.org/path"],
])
  it(`rejects invalid network roster ${domains}`, () => {
    expect(() =>
      cloudflarePrivateLauncher(
        {} as BrowserWorker,
        async () => {
          throw Error("must not launch");
        },
        domains,
      ),
    ).toThrow("browser_policy_invalid");
  });
