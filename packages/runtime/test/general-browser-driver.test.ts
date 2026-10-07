import { expect, it } from 'vitest';
import { cloudflareGeneralBrowser } from '../src/channels/cloudflare-general-browser';
import type { BrowserSession } from '@waldo/contracts';

const session: BrowserSession = { id: 'host-session', ownerId: 'owner-a', provider: 'cloudflare_playwright', providerSessionId: 'PRIVATE_PROVIDER_ID', contextHandle: null, mode: 'public', state: 'active', generation: 1, expiresAt: 60000, updatedAt: 0 };
function harness(controlTag = 'a') {
  const calls: string[] = []; let ended = false, serial = 0, changed = false;
  const pages: any[] = [];
  const page = () => {
    const id = `PRIVATE_TARGET_${serial++}`; let url = 'about:blank', value = '';
    const p = { id, url: () => url, title: async () => 'Public documentation', setDefaultTimeout() {},
      goto: async (value: string) => { url = value; calls.push('navigate'); return { status: () => 200 }; },
      evaluate: async (fn: Function, args?: unknown) => {
        if (fn.name !== 'generalPageState') { calls.push(`scroll:${JSON.stringify(args)}`); return; }
        return { url, title: 'Public documentation', text: changed ? 'Changed by the human' : 'Compare Browser Run sessions and contexts.', width: 1280, height: 720, scrollX: 0, scrollY: 0, elements: [{ selector: 'html > body > a:nth-of-type(1)', tag: controlTag, role: controlTag === 'a' ? 'link' : 'textbox', name: 'Session reuse', href: controlTag === 'a' ? 'https://docs.example/reuse' : '', value, type: controlTag === 'input' ? 'text' : '', disabled: false, selected: false, checked: false, inForm: false, ...(controlTag === 'select' ? { options: [{ value: 'second', label: 'Second choice', disabled: false, selected: value === 'second' }] } : {}) }] };
      },
      locator: () => ({ click: async () => { calls.push('click'); url = 'https://docs.example/reuse'; }, fill: async (input: string) => { calls.push(`fill:${input}`); value = input; }, selectOption: async (input: string) => { calls.push(`select:${input}`); value = input; }, press: async (input: string) => { calls.push(`press:${input}`); } }),
      screenshot: async () => new Uint8Array([137, 80, 78, 71]), close: async () => { pages.splice(pages.indexOf(p), 1); },
    }; pages.push(p); return p;
  };
  page();
  let routeHandler: ((route: any) => Promise<void>) | undefined;
  const context = { pages: () => [...pages], newPage: async () => page(), route: async (_: string, handler: (route: any) => Promise<void>) => { routeHandler = handler; }, unroute: async () => {}, newCDPSession: async (p: any) => ({ send: async () => ({ targetInfo: { targetId: p.id } }), detach: async () => {} }) };
  const browser = { contexts: () => [context], newContext: async () => { throw Error('disposeOnDetach context would lose tabs'); }, close: async () => { calls.push('release'); }, newBrowserCDPSession: async () => ({ send: async () => { ended = true; } }) };
  const sdk = { acquire: async () => { calls.push('acquire'); return { sessionId: session.providerSessionId }; }, connect: async (_: unknown, options: any) => { expect(options).toEqual({ sessionId: session.providerSessionId, persistent: true }); if (ended) throw Error('session ended'); calls.push('attach'); return browser; }, sessions: async () => ended ? [] : [{ sessionId: session.providerSessionId }] };
  return { calls, pages, sdk, browser, route: (route: any) => routeHandler!(route), humanChange: () => { changed = true; } };
}
it('navigates a public page, returns actual image bytes, and retains two tabs across detached owner turns', async () => {
  const f = harness();
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const first = await driver.navigate(session, 'https://docs.example/index');
  expect(first.observation).toMatchObject({ url: 'https://docs.example/index', text: 'Compare Browser Run sessions and contexts.', elements: [{ role: 'link', name: 'Session reuse' }] });
  expect(first.image.bytes).toEqual(new Uint8Array([137, 80, 78, 71]));
  const second = await driver.openTab(session, 'https://docs.example/reuse');
  const resumed = await driver.observe(session, first.observation.tab_ref);
  expect(resumed.observation.tabs).toHaveLength(2);
  expect(resumed.observation.tab_ref).toBe(first.observation.tab_ref);
  expect(second.observation.tab_ref).not.toBe(first.observation.tab_ref);
  expect(JSON.stringify(resumed.observation)).not.toContain('PRIVATE_');
  expect(f.calls.filter(x => x === 'attach')).toHaveLength(3);
  expect(f.calls.filter(x => x === 'release')).toHaveLength(3);
  expect(f.calls).not.toContain('acquire');
  await driver.terminate(session);
  expect(await f.sdk.sessions()).toEqual([]);
});
it('dispatches typed fill and returns changed field state', async () => {
  const f = harness('input');
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const snapshot = await driver.navigate(session, 'https://docs.example/index');
  const ref = snapshot.observation.elements[0]!.ref;
  const after = await driver.act(session, snapshot, { operation: 'fill', element_ref: ref, value: 'Walrus' }, async () => {});
  expect(f.calls).toContain('fill:Walrus');
  expect(after.state.elements[0]!.value).toBe('Walrus');
});
it('selects, presses keys and scrolls without accepting model-authored code', async () => {
  const f = harness('select');
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const first = await driver.navigate(session, 'https://docs.example/index');
  expect(first.observation.elements[0]).toMatchObject({ options: [{ value: 'second', label: 'Second choice' }] });
  const selected = await driver.act(session, first, { operation: 'select', element_ref: first.observation.elements[0]!.ref, value: 'second' }, async () => {});
  expect(f.calls).toContain('select:second');
  const pressed = await driver.act(session, selected, { operation: 'press', element_ref: selected.observation.elements[0]!.ref, key: 'Tab' }, async () => {});
  expect(f.calls).toContain('press:Tab');
  await driver.act(session, pressed, { operation: 'scroll', direction: 'down' }, async () => {});
  expect(f.calls).toContain('scroll:{"x":0,"y":720}');
  await expect(driver.act(session, pressed, { operation: 'evaluate', code: 'steal()' } as never, async () => {})).rejects.toMatchObject({ code: 'rejected' });
});
it('withdraws authority before an effect and rejects foreign owner and expired reads', async () => {
  const f = harness(); let revoked = false;
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => { if (revoked) throw Error('revoked'); }, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const first = await driver.navigate(session, 'https://docs.example/index');
  await expect(driver.act(session, first, { operation: 'click', element_ref: first.observation.elements[0]!.ref }, async () => { revoked = true; })).rejects.toBeDefined();
  expect(f.calls).not.toContain('click');
  await expect(driver.observe({ ...session, ownerId: 'owner-b' })).rejects.toMatchObject({ code: 'rejected' });
  await expect(driver.observe({ ...session, expiresAt: 1 })).rejects.toMatchObject({ code: 'rejected' });
  await driver.terminate({ ...session, expiresAt: 1 });
  expect(await f.sdk.sessions()).toEqual([]);
});
it('never replaces a lost provider session or exposes its raw error', async () => {
  const f = harness();
  f.sdk.connect = async () => { throw Error('PRIVATE_PROVIDER_ID secret response'); };
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  await expect(driver.observe(session)).rejects.toMatchObject({ code: 'provider_unavailable', message: 'browser_provider_unavailable' });
  expect(f.calls).not.toContain('acquire');
  await expect(driver.terminate(session)).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
});
it('rejects oversized screenshots and keeps provider cancellation separate from disconnect', async () => {
  const f = harness();
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 3 });
  await expect(driver.navigate(session, 'https://docs.example/index')).rejects.toMatchObject({ code: 'image_oversize' });
  expect(await f.sdk.sessions()).toHaveLength(1);
  await driver.terminate(session);
  expect(await f.sdk.sessions()).toHaveLength(0);
});
it('closes the selected tab and rejects its old reference', async () => {
  const f = harness();
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const first = await driver.navigate(session, 'https://docs.example/index');
  await driver.openTab(session, 'https://docs.example/reuse');
  await driver.closeTab(session, first.observation.tab_ref, async () => {});
  await expect(driver.observe(session, first.observation.tab_ref)).rejects.toMatchObject({ code: 'stale_observation' });
  expect(f.pages).toHaveLength(1);
});
it('reserves before allocation and records the allocated id before rechecking authority', async () => {
  const f = harness(); let recorded = false;
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const id = await driver.start(['docs.example'], 60000, async () => { f.calls.push('reserve'); }, async id => { expect(id).toBe(session.providerSessionId); recorded = true; f.calls.push('record'); });
  expect(id).toBe(session.providerSessionId);
  expect(recorded).toBe(true);
  expect(f.calls).toEqual(['reserve', 'acquire', 'record']);
});
it('returns bounded 402 status, code and request id without provider body content', async () => {
  const f = harness();
  f.sdk.connect = async (binding: any) => { await binding.fetch('https://provider.example'); throw Error('SDK should not receive the provider body'); };
  const binding = { fetch: async () => new Response(JSON.stringify({ code: 'usage_limit', message: 'PRIVATE_SECRET' }), { status: 402, headers: { 'x-request-id': 'request-123' } }) };
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: binding as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  await expect(driver.observe(session)).rejects.toMatchObject({ code: 'provider_unavailable', diagnostic: { status: 402, code: 'usage_limit', request_id: 'request-123' } });
});
it('cleans an allocation if recording or the post-acquire authority check fails', async () => {
  const f = harness(); let recorded = false;
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => { if (recorded) throw Error('expired'); }, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  await expect(driver.start(['docs.example'], 60000, async () => {}, async () => { recorded = true; })).rejects.toBeDefined();
  expect(await f.sdk.sessions()).toEqual([]);
});
it('rechecks authority after the final observation await before dispatch', async () => {
  const f = harness(); let revoked = false, approved = false;
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => { if (revoked) throw Error('PRIVATE_REVOCATION'); }, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const first = await driver.navigate(session, 'https://docs.example/index');
  const originalTitle = f.pages[0].title;
  f.pages[0].title = async () => { if (approved) revoked = true; return originalTitle(); };
  await expect(driver.act(session, first, { operation: 'click', element_ref: first.observation.elements[0]!.ref }, async () => { approved = true; })).rejects.toMatchObject({ code: 'rejected' });
  expect(f.calls).not.toContain('click');
});
it('keeps an uncertain action outcome when disconnect also fails', async () => {
  const f = harness();
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const first = await driver.navigate(session, 'https://docs.example/index');
  f.pages[0].locator = () => ({ click: async () => { throw Error('PRIVATE_ACTION_ERROR'); } });
  f.browser.close = async () => { throw Error('PRIVATE_DISCONNECT_ERROR'); };
  await expect(driver.act(session, first, { operation: 'click', element_ref: first.observation.elements[0]!.ref }, async () => {})).rejects.toMatchObject({ code: 'outcome_uncertain', release_failed: true });
});
it('normalizes malformed identity and entry revocation without leaking raw errors', async () => {
  const f = harness();
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => { throw Error('PRIVATE_AUTHORITY_ERROR'); }, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  await expect(driver.observe(session)).rejects.toMatchObject({ code: 'rejected', message: 'browser_rejected' });
  await expect(driver.observe({ ...session, generation: 'invalid' } as never)).rejects.toMatchObject({ code: 'rejected', message: 'browser_rejected' });
  expect(f.calls).toEqual([]);
});
it('does not count a denied page as useful provider verification', async () => {
  const f = harness();
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const first = await driver.navigate(session, 'https://docs.example/index');
  f.pages[0].goto = async () => ({ status: () => 403 });
  await expect(driver.navigate(session, 'https://docs.example/index')).rejects.toMatchObject({ code: 'page_unavailable', diagnostic: { status: 403 } });
  await expect(driver.observe(session, first.observation.tab_ref)).rejects.toMatchObject({ code: 'stale_observation' });
});
it('does not fulfill a denied document or report a click into it as useful work', async () => {
  const f = harness(); const routeCalls: string[] = [];
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const first = await driver.navigate(session, 'https://docs.example/index');
  f.pages[0].locator = () => ({ click: async () => {
    await f.route({ request: () => ({ url: () => 'https://docs.example/denied', method: () => 'GET', isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null, page: () => f.pages[0] }) }),
      fetch: async () => ({ status: () => 403 }), fulfill: async () => { routeCalls.push('fulfilled'); }, abort: async () => { routeCalls.push('blocked'); } });
  } });
  await expect(driver.act(session, first, { operation: 'click', element_ref: first.observation.elements[0]!.ref }, async () => {})).rejects.toMatchObject({ code: 'outcome_uncertain', diagnostic: { status: 403 } });
  expect(routeCalls).toEqual(['blocked']);
});
it('physically ends the owned session when a denied document cannot be discarded', async () => {
  const f = harness();
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const first = await driver.navigate(session, 'https://docs.example/index');
  f.pages[0].goto = async () => ({ status: () => 403 });
  f.pages[0].close = async () => { throw Error('cannot discard document'); };
  await expect(driver.navigate(session, 'https://docs.example/index')).rejects.toMatchObject({ code: 'page_unavailable' });
  expect(await f.sdk.sessions()).toEqual([]);
  await expect(driver.observe(session, first.observation.tab_ref)).rejects.toMatchObject({ code: 'provider_unavailable' });
});
it('fits locator auto-wait within the actual host and session deadline', async () => {
  const f = harness(); let now = 1, observedTimeout: number | undefined;
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => now, deadline: () => 100, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const first = await driver.navigate(session, 'https://docs.example/index'); now = 99;
  f.pages[0].locator = () => ({ click: async (options?: { timeout: number }) => {
    observedTimeout = options?.timeout;
    // The control becomes ready only after this admitted deadline.
    if (observedTimeout !== undefined && observedTimeout < 2) throw Error('actionability timed out');
    f.calls.push('late-effect');
  } });
  await expect(driver.act(session, first, { operation: 'click', element_ref: first.observation.elements[0]!.ref }, async () => {})).rejects.toMatchObject({ code: 'outcome_uncertain' });
  expect(observedTimeout).toBe(1);
  expect(f.calls).not.toContain('late-effect');
});
it('keeps tab close uncertain when physical close succeeds but acknowledgement fails', async () => {
  const f = harness();
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const first = await driver.navigate(session, 'https://docs.example/index');
  f.pages[0].close = async () => { f.pages.splice(0, 1); throw Error('lost close acknowledgement'); };
  await expect(driver.closeTab(session, first.observation.tab_ref, async () => {})).rejects.toMatchObject({ code: 'outcome_uncertain' });
  expect(f.pages).toHaveLength(0);
});
it('rejects redirect chains before an unchecked redirected request', async () => {
  const f = harness();
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  await driver.navigate(session, 'https://docs.example/index');
  const calls: string[] = [];
  await f.route({ request: () => ({ url: () => 'https://docs.example/redirect', method: () => 'GET', isNavigationRequest: () => false }),
    continue: async () => { calls.push('unchecked'); },
    fetch: async (options: unknown) => { expect(options).toMatchObject({ maxRedirects: 0 }); return { status: () => 302 }; },
    fulfill: async () => { calls.push('fulfilled'); }, abort: async () => { calls.push('blocked'); } });
  expect(calls).toEqual(['blocked']);
});
it('acts on an observed ref and refuses human changes during asynchronous action approval', async () => {
  const f = harness();
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const snapshot = await driver.navigate(session, 'https://docs.example/index');
  const action = { operation: 'click' as const, element_ref: snapshot.observation.elements[0]!.ref };
  const after = await driver.act(session, snapshot, action, async () => {});
  expect(after.observation.url).toBe('https://docs.example/reuse');
  expect(f.calls.filter(x => x === 'click')).toHaveLength(1);
  await expect(driver.act(session, after, { operation: 'click', element_ref: after.observation.elements[0]!.ref }, async () => { f.humanChange(); })).rejects.toMatchObject({ code: 'stale_observation' });
  expect(f.calls.filter(x => x === 'click')).toHaveLength(1);
});
it('keeps a dispatched tab close uncertain when final host admission is withdrawn', async () => {
  const f = harness(); let revoked = false;
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => { if (revoked) throw Error('revoked'); }, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const first = await driver.navigate(session, 'https://docs.example/index');
  const close = f.pages[0].close;
  f.pages[0].close = async () => { await close(); revoked = true; };
  await expect(driver.closeTab(session, first.observation.tab_ref, async () => {})).rejects.toMatchObject({ code: 'outcome_uncertain' });
});
it('keeps routed mutation uncertainty and separately records unconfirmed denied-document cleanup', async () => {
  const f = harness();
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => f.sdk as never, now: () => 1, deadline: () => 60000, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  const first = await driver.navigate(session, 'https://docs.example/index');
  f.pages[0].close = async () => { throw Error('cannot discard'); };
  f.browser.newBrowserCDPSession = async () => ({ send: async () => { throw Error('termination unconfirmed'); } });
  f.pages[0].locator = () => ({ click: async () => {
    await f.route({ request: () => ({ url: () => 'https://docs.example/denied', method: () => 'GET', isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null, page: () => f.pages[0] }) }), fetch: async () => ({ status: () => 403 }), abort: async () => {} });
  } });
  await expect(driver.act(session, first, { operation: 'click', element_ref: first.observation.elements[0]!.ref }, async () => {})).rejects.toMatchObject({ code: 'outcome_uncertain', diagnostic: { status: 403 }, cleanup_failed: true });
});
