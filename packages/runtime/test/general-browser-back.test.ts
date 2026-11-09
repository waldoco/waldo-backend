import { expect, it } from 'vitest';
import { cloudflareGeneralBrowser } from '../src/channels/cloudflare-general-browser';
import type { BrowserSession } from '@waldo/contracts';

const session: BrowserSession = { id: 'host-session', ownerId: 'owner-a', provider: 'cloudflare_playwright', providerSessionId: 'provider-session', contextHandle: null, mode: 'public', state: 'active', generation: 1, expiresAt: 60000, updatedAt: 0 };

// One tab with a real history list. Every document, forward or back, is served through the driver's own route guard.
function harness(authorize: (url: string) => boolean = () => true) {
  let routeHandler: ((route: unknown) => Promise<void>) | undefined;
  const calls: string[] = [], history = ['about:blank'];
  let index = 0;
  const load = async (target: string) => {
    let settled = '';
    await routeHandler!({ request: () => ({ url: () => target, method: () => 'GET', isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null, page: () => page }) }),
      fetch: async () => ({ status: () => 200, headers: () => ({}) }), fulfill: async () => { settled = 'fulfill'; }, abort: async () => { settled = 'abort'; } });
    if (settled === 'abort') throw Error('net::ERR_BLOCKED_BY_CLIENT');
  };
  const page: any = {
    url: () => history[index], title: async () => 'Fixture', setDefaultTimeout() {},
    goto: async (target: string) => { await load(target); history.splice(index + 1, history.length, target); index = history.length - 1; calls.push(`goto:${target}`); return { status: () => 200 }; },
    goBack: async () => { calls.push('history'); if (index === 0) return null; await load(history[index - 1]!); index--; calls.push(`back:${history[index]}`); return { status: () => 200 }; },
    evaluate: async () => ({ url: history[index], title: 'Fixture', text: `Text of ${history[index]}`, width: 1280, height: 720, scrollX: 0, scrollY: 0, elements: [] }),
    locator: () => ({}), screenshot: async () => new Uint8Array([137, 80, 78, 71]), close: async () => {},
  };
  const context = { pages: () => [page], serviceWorkers: () => [], newPage: async () => page, route: async (_: string, handler: (route: unknown) => Promise<void>) => { routeHandler = handler; },
    newCDPSession: async () => ({ send: async (method: string) => method === 'Page.getNavigationHistory' ? { currentIndex: index, entries: history.map((url, id) => ({ id, url, title: '' })) }
      : method === 'Accessibility.getFullAXTree' ? { nodes: [] } : { targetInfo: { targetId: 'target' } }, detach: async () => {} }) };
  const browser = { contexts: () => [context], close: async () => {} };
  const sdk = { connect: async () => browser, sessions: async () => [] };
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async url => authorize(url), maxScreenshotBytes: 1024 });
  return { driver, calls };
}

it('back after two navigations returns a fresh observation of the first page', async () => {
  const { driver, calls } = harness();
  const first = await driver.navigate(session, 'https://shop.example/results');
  const second = await driver.navigate(session, 'https://shop.example/item', first.observation.tab_ref);
  const back = await driver.back(session, second.observation.tab_ref);
  expect(back).toMatchObject({ observation: { url: 'https://shop.example/results', text: 'Text of https://shop.example/results', tab_ref: first.observation.tab_ref } });
  expect(calls.at(-1)).toBe('back:https://shop.example/results');
});

it('back with no earlier page in the tab reports that, without navigating', async () => {
  const { driver, calls } = harness();
  const only = await driver.navigate(session, 'https://shop.example/results');
  expect(await driver.back(session, only.observation.tab_ref)).toBeUndefined();
  expect(calls).toEqual(['goto:https://shop.example/results']);
});

it('back to a page the egress check now denies is refused before any request', async () => {
  let denied = false;
  const { driver, calls } = harness(url => !(denied && new URL(url).hostname === 'internal.example'));
  const first = await driver.navigate(session, 'https://internal.example/');
  const second = await driver.navigate(session, 'https://shop.example/item', first.observation.tab_ref);
  denied = true;
  await expect(driver.back(session, second.observation.tab_ref)).rejects.toMatchObject({ code: 'rejected' });
  expect(calls).not.toContain('history');
});
