import { expect, it } from 'vitest';
import { guardGeneralBrowserRoute } from '../src/channels/general-browser-redirects';

function route(method = 'GET', navigation = true) {
  const calls: any[] = [], page = {};
  const request = { url: () => 'https://docs.example/start', method: () => method, isNavigationRequest: () => navigation,
    frame: () => ({ parentFrame: () => null, page: () => page }), allHeaders: async () => ({ authorization: 'private-origin-auth', cookie: 'private-origin-cookie', accept: 'text/html' }) };
  const responses = [{ status: () => 302, headers: () => ({ location: 'https://assets.example/final' }) }, { status: () => 200, headers: () => ({}) }];
  return { calls, page, route: { request: () => request, fetch: async (options: any) => { calls.push(['fetch', options]); return responses.shift(); }, fulfill: async (options: any) => { calls.push(['fulfill', options]); }, abort: async () => { calls.push(['abort']); } }, responses };
}
it('authorizes a main-document redirect and schedules a new navigation rather than fulfilling a redirect', async () => {
  const f = route(); const authorized: any[] = [], redirected: any[] = [];
  await guardGeneralBrowserRoute(f.route as never, { authorize: async (url, method) => { authorized.push([url, method]); }, timeout: () => 1000, admit: async () => {},
    redirect: (page, url) => { redirected.push([page, url]); }, denied: () => {} });
  expect(authorized).toEqual([['https://docs.example/start', 'GET'], ['https://assets.example/final', 'GET']]);
  expect(redirected).toEqual([[f.page, 'https://assets.example/final']]);
  expect(f.calls.map(call => call[0])).toEqual(['fetch', 'fulfill']);
  expect(f.calls[1][1]).toEqual({ status: 200, contentType: 'text/html', body: '' });
});
it('vets resource redirect hops and drops cross-origin credential headers', async () => {
  const f = route('GET', false); const authorized: string[] = [];
  await guardGeneralBrowserRoute(f.route as never, { authorize: async url => { authorized.push(url); }, timeout: () => 1000, admit: async () => {}, redirect: () => {}, denied: () => {} });
  expect(authorized).toEqual(['https://docs.example/start', 'https://assets.example/final']);
  expect(f.calls[1]).toEqual(['fetch', { url: 'https://assets.example/final', method: 'GET', maxRedirects: 0, timeout: 1000, headers: { accept: 'text/html' } }]);
  expect(f.calls.map(call => call[0])).toEqual(['fetch', 'fetch', 'fulfill']);
});
it('blocks a disallowed redirect target before fetching it', async () => {
  const f = route('GET', false);
  await expect(guardGeneralBrowserRoute(f.route as never, { authorize: async url => { if (url.includes('assets')) throw Error('denied'); }, timeout: () => 1000, admit: async () => {}, redirect: () => {}, denied: () => {} })).rejects.toThrow();
  expect(f.calls.filter(call => call[0] === 'fetch')).toHaveLength(1);
});
it('allows POST-to-GET redirect without replaying the approved POST, and rejects 307 POST replay', async () => {
  const f = route('POST'); const redirected: string[] = [];
  await guardGeneralBrowserRoute(f.route as never, { authorize: async () => {}, timeout: () => 1000, admit: async () => {}, redirect: (_, url) => { redirected.push(url); }, denied: () => {} });
  expect(redirected).toEqual(['https://assets.example/final']);
  const g = route('POST'); g.responses[0] = { status: () => 307, headers: () => ({ location: '/replay' }) };
  await expect(guardGeneralBrowserRoute(g.route as never, { authorize: async () => {}, timeout: () => 1000, admit: async () => {}, redirect: () => {}, denied: () => {} })).rejects.toMatchObject({ code: 'rejected' });
  expect(g.calls.filter(call => call[0] === 'fetch')).toHaveLength(1);
});
it('rejects redirect cycles before fetching a previously visited resource', async () => {
  const f = route('GET', false);
  f.responses[1] = { status: () => 302, headers: () => ({ location: 'https://docs.example/start' }) };
  await expect(guardGeneralBrowserRoute(f.route as never, { authorize: async () => {}, timeout: () => 1000, admit: async () => {}, redirect: () => {}, denied: () => {} })).rejects.toMatchObject({ code: 'rejected' });
  expect(f.calls.filter(call => call[0] === 'fetch')).toHaveLength(2);
});
it('uses the installed SDK twenty-redirect bound without retrying a request', async () => {
  const f = route('GET', false); f.responses.length = 0;
  for (let index = 0; index <= 20; index++) f.responses.push({ status: () => 302, headers: () => ({ location: `https://docs.example/hop-${index}` }) });
  await expect(guardGeneralBrowserRoute(f.route as never, { authorize: async () => {}, timeout: () => 1000, admit: async () => {}, redirect: () => {}, denied: () => {} })).rejects.toMatchObject({ code: 'rejected' });
  expect(f.calls.filter(call => call[0] === 'fetch')).toHaveLength(21);
});
it('does not fetch the next hop after authority is withdrawn', async () => {
  const f = route('GET', false); let admissions = 0;
  await expect(guardGeneralBrowserRoute(f.route as never, { authorize: async () => { if (++admissions === 2) throw Error('authority withdrawn'); }, timeout: () => 1000, admit: async () => {}, redirect: () => {}, denied: () => {} })).rejects.toThrow();
  expect(f.calls.filter(call => call[0] === 'fetch')).toHaveLength(1);
});
it('clears the original POST body and content headers on a resource POST-to-GET redirect', async () => {
  const f = route('POST', false);
  f.route.request().allHeaders = async () => ({ authorization: 'private-origin-auth', cookie: 'private-origin-cookie', accept: 'text/html', 'content-type': 'application/json' } as any);
  await guardGeneralBrowserRoute(f.route as never, { authorize: async () => {}, timeout: () => 1000, admit: async () => {}, redirect: () => {}, denied: () => {} });
  expect(f.calls[1][1]).toMatchObject({ method: 'GET', postData: '', headers: { accept: 'text/html' } });
  expect(f.calls[1][1].headers).not.toHaveProperty('content-type');
});

it('does not fulfill fetched content when authority expires during transport', async () => {
  const f = route();
  await expect(guardGeneralBrowserRoute(f.route as never, { authorize: async () => {}, timeout: () => 1000, admit: async () => { throw Error('expired'); }, redirect: () => {}, denied: () => {} })).rejects.toThrow();
  expect(f.calls.map(call => call[0])).toEqual(['fetch']);
});
