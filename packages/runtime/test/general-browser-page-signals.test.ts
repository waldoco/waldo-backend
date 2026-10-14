import { expect, it, vi } from 'vitest';
import { cloudflareGeneralBrowser } from '../src/channels/cloudflare-general-browser';
import { generalPageState } from '../src/channels/general-browser-observation';
import type { BrowserSession } from '@waldo/contracts';

const session: BrowserSession = { id: 'host-session', ownerId: 'owner-a', provider: 'cloudflare_playwright', providerSessionId: 'provider-session', contextHandle: null, mode: 'public', state: 'active', generation: 1, expiresAt: 60000, updatedAt: 0 };

// One page whose document is served through the driver's own route guard, so the
// HTTP status and headers the model's facts depend on come from the real guard path.
function harness(document: { status: number; headers?: Record<string, string>; inputType?: string; challenge?: boolean }, maxScreenshotBytes = 1024) {
  let routeHandler: ((route: unknown) => Promise<void>) | undefined, url = 'about:blank';
  const pages: any[] = [];
  const page: any = {
    url: () => url, title: async () => 'Fixture', setDefaultTimeout() {},
    goto: async (target: string) => {
      let settled = '';
      await routeHandler!({ request: () => ({ url: () => target, method: () => 'GET', isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null, page: () => page }) }),
        fetch: async () => ({ status: () => document.status, headers: () => document.headers ?? {} }), fulfill: async () => { settled = 'fulfill'; }, abort: async () => { settled = 'abort'; } });
      if (settled === 'abort') throw Error('net::ERR_BLOCKED_BY_CLIENT');
      url = target; return { status: () => document.status };
    },
    evaluate: async () => ({ url, title: 'Fixture', text: 'Fixture page text', width: 1280, height: 720, scrollX: 0, scrollY: 0, ...(document.challenge ? { challenge: true } : {}),
      elements: document.inputType ? [{ selector: 'input', tag: 'input', role: 'textbox', name: 'Field', href: '', value: '', type: document.inputType, ...(['password'].includes(document.inputType) ? { secret: true } : {}), disabled: false, selected: false, checked: false, inForm: true }] : [] }),
    locator: () => ({ click: async () => {} }), screenshot: async () => new Uint8Array([137, 80, 78, 71]), close: async () => { pages.splice(pages.indexOf(page), 1); },
  };
  pages.push(page);
  const context = { pages: () => [...pages], serviceWorkers: () => [], newPage: async () => page, route: async (_: string, handler: (route: unknown) => Promise<void>) => { routeHandler = handler; },
    newCDPSession: async () => ({ send: async (method: string) => method === 'Accessibility.getFullAXTree' ? { nodes: [{ nodeId: 'n1', backendDOMNodeId: 1, role: { value: 'textbox' }, name: { value: 'Field' } }] }
      : method === 'DOM.getDocument' ? { root: { nodeName: 'INPUT', backendNodeId: 1, attributes: ['type', 'password'] } } : { targetInfo: { targetId: 'target' } }, detach: async () => {} }) };
  const browser = { contexts: () => [context], close: async () => {} };
  const sdk = { connect: async () => browser, sessions: async () => [] };
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes });
  return { driver, pages };
}

it('a visible password field is reported to the model as a typed sign-in request, not inferred from page text', async () => {
  const signIn = await harness({ status: 200, inputType: 'password' }).driver.navigate(session, 'https://accounts.example/login');
  expect(signIn.observation.page_signals).toEqual(['sign_in_requested']);
  const plain = await harness({ status: 200, inputType: 'text' }).driver.navigate(session, 'https://accounts.example/search');
  expect(plain.observation.page_signals).toBeUndefined();
});

it('a Cloudflare-mitigated challenge document is observed with a typed challenge signal instead of failing as unavailable', async () => {
  const challenged = await harness({ status: 403, headers: { 'cf-mitigated': 'challenge' } }).driver.navigate(session, 'https://shop.example/');
  expect(challenged.observation.page_signals).toEqual(['verification_challenge']);
  await expect(harness({ status: 403 }).driver.navigate(session, 'https://shop.example/')).rejects.toMatchObject({ code: 'page_unavailable', diagnostic: { status: 403 } });
});

it('a challenge widget found in the page is the same typed signal', async () => {
  const widget = await harness({ status: 200, challenge: true, inputType: 'password' }).driver.navigate(session, 'https://shop.example/login');
  expect(widget.observation.page_signals).toEqual(['sign_in_requested', 'verification_challenge']);
});

it('page evaluation reports only visible challenge widgets', () => {
  type Widget = Readonly<{ selector: string; src?: string; size?: string; box?: number }>;
  const evaluate = (widget?: Widget) => {
    const node = widget && { getBoundingClientRect: () => ({ width: widget.box ?? 300, height: widget.box ?? 80 }), getAttribute: (name: string) => name === 'src' ? widget.src ?? null : name === 'data-size' ? widget.size ?? null : null };
    const document: any = { body: { innerText: 'Page' }, title: 'Page', querySelectorAll: (selector: string) => node && selector.split(',').map(part => part.trim()).includes(widget!.selector) ? [node] : [] };
    vi.stubGlobal('document', document); vi.stubGlobal('location', { href: 'https://shop.example/' }); vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', display: 'block' }));
    try { return generalPageState().challenge === true; } finally { vi.unstubAllGlobals(); }
  };
  expect(evaluate()).toBe(false);
  expect(evaluate({ selector: 'iframe[src*="challenges.cloudflare.com"]', src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile' })).toBe(true);
  expect(evaluate({ selector: '.g-recaptcha' })).toBe(true);
  expect(evaluate({ selector: 'iframe[src*="/recaptcha/api2/anchor"]', src: 'https://www.google.com/recaptcha/api2/anchor?k=site&size=normal' })).toBe(true);
  expect(evaluate({ selector: '.h-captcha' })).toBe(true);
  expect(evaluate({ selector: 'iframe[src*="captcha-delivery.com"]', src: 'https://geo.captcha-delivery.com/captcha/' })).toBe(true);
  // Invisible reCAPTCHA (v3, or v2 invisible) and hidden widgets sit on ordinary pages and ask nothing of anyone.
  expect(evaluate({ selector: 'iframe[src*="/recaptcha/api2/anchor"]', src: 'https://www.google.com/recaptcha/api2/anchor?k=site&size=invisible' })).toBe(false);
  expect(evaluate({ selector: '.g-recaptcha', size: 'invisible' })).toBe(false);
  expect(evaluate({ selector: 'iframe[src*="hcaptcha.com"]', src: 'https://newassets.hcaptcha.com/captcha/v1/static/hcaptcha.html#frame=checkbox-invisible' })).toBe(false);
  expect(evaluate({ selector: '.cf-turnstile', box: 0 })).toBe(false);
});

it('the challenge signal clears once the same tab loads an ordinary document', async () => {
  const document = { status: 403, headers: { 'cf-mitigated': 'challenge' } as Record<string, string> };
  const f = harness(document);
  expect((await f.driver.navigate(session, 'https://shop.example/')).observation.page_signals).toEqual(['verification_challenge']);
  document.status = 200; document.headers = {};
  expect((await f.driver.navigate(session, 'https://shop.example/')).observation.page_signals).toBeUndefined();
});

it('an over-limit page image degrades to a text observation instead of ending the errand', async () => {
  const observed = await harness({ status: 200, inputType: 'text' }, 2).driver.navigate(session, 'https://hotels.example/listing');
  expect(observed.observation).toMatchObject({ text: 'Fixture page text', image_omitted: 'oversize' });
  expect(observed.image).toBeUndefined();
  const within = await harness({ status: 200, inputType: 'text' }).driver.navigate(session, 'https://hotels.example/listing');
  expect(within.observation.image_omitted).toBeUndefined(); expect(within.image?.bytes.byteLength).toBe(4);
});

it('a click followed by an over-limit page image is a completed action, not an uncertain outcome', async () => {
  const { driver } = harness({ status: 200, inputType: 'text' }, 2);
  const before = await driver.navigate(session, 'https://flights.example/search');
  const after = await driver.act(session, before, { operation: 'click', element_ref: before.observation.elements[0]!.ref }, async () => {});
  expect(after.observation.image_omitted).toBe('oversize');
});
