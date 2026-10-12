import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

// The console must land on the owner's real DO - the one the Telegram webhook routes his
// turns to. With Supabase configured the DO name comes from the owner directory (console
// signup stores 'owner-<uuid>'), not the env telegram id. Regression: routing /console by
// the env id served an empty shell DO - one-time links minted in the turn DO 403'd on
// redeem, and account.delete would have wiped the wrong DO (staging receipts 2026-09-28).
const ownerDo = () => ({
  idFromName: (name: string) => name,
  get: (id: string) => ({ fetch: async () => new Response(`do:${id}`) }),
});
const supabaseEnv = {
  SUPABASE_PROJECT_URL: 'https://supa.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'pub',
  WALDO_ROUTER_HMAC_SECRET: 'secret',
};
const baseEnv = {
  WALDO_OWNER_TELEGRAM_ID: '5458446350',
  TELEGRAM_OWNER_DO: ownerDo(),
} as const;

afterEach(() => vi.unstubAllGlobals());

it('retains a read-only download intent when the legacy ticket session expires', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ do_name: 'owner-download', subject: '5458446350', timezone: null }]))));
  const ns = { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response('unauthorized', { status: 401 }) }) };
  const target = '/console/workspace/file?id=def993c9-db4d-49c4-8998-8465bed3606e&revision=1';
  const request = () => new Request(`https://waldo.invalid${target}`, { headers: { cookie: 'waldo_console=expired-ticket' } });
  const result = await worker.fetch(request(), { ...baseEnv, ...supabaseEnv, TELEGRAM_OWNER_DO: ns } as unknown as Cloudflare.Env);
  expect(result.status).toBe(303);
  expect(result.headers.get('location')).toBe(`/console/signin?return_to=${encodeURIComponent(target)}`);
  const unconfigured = await worker.fetch(request(), { ...baseEnv, TELEGRAM_OWNER_DO: ns } as unknown as Cloudflare.Env);
  expect(unconfigured.status).toBe(401);
});

describe('console owner-DO routing', () => {
  it('routes /console to the directory-resolved owner DO, not the env telegram id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ do_name: 'owner-test-uuid', subject: '5458446350', timezone: null }]))));
    const res = await worker.fetch(
      new Request('https://waldo.invalid/console', { headers: { cookie: 'waldo_console=a.b.c', accept: 'application/json' } }),
      { ...baseEnv, ...supabaseEnv } as unknown as Cloudflare.Env,
    );
    expect(await res.text()).toBe('do:owner-test-uuid');
  });

  it('does not route to the legacy DO when the directory has no presence row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    const res = await worker.fetch(
      new Request('https://waldo.invalid/console', { headers: { cookie: 'waldo_console=a.b.c', accept: 'application/json' } }),
      { ...baseEnv, ...supabaseEnv } as unknown as Cloudflare.Env,
    );
    expect(res.status).toBe(503);
  });

  it('uses the deploy-owner path when Supabase is not configured', async () => {
    const res = await worker.fetch(new Request('https://waldo.invalid/console', { headers: { accept: 'application/json' } }), baseEnv as unknown as Cloudflare.Env);
    expect(await res.text()).toBe('do:5458446350');
  });
});

it('routes a private artifact path through the same owner gate, never a public body route',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify([{do_name:'owner-artifact',subject:'5458446350',timezone:null}]))));
 const request=new Request('https://waldo.invalid/console/artifacts/art%3Aabc?revision=1',{headers:{cookie:'waldo_console=ticket'}});
 const result=await worker.fetch(request,{...baseEnv,...supabaseEnv} as unknown as Cloudflare.Env);
 expect(await result.text()).toBe('do:owner-artifact');
 const signedOut=await worker.fetch(new Request(request.url),{...baseEnv,...supabaseEnv} as unknown as Cloudflare.Env);
 expect(signedOut.status).toBe(303);expect(signedOut.headers.get('location')).toBe('/console/signin');
});

it('replaces caller-supplied owner routing headers on the ticket fallback before the DO sees them', async () => {
 const seen: string[] = [];
 const ns = { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async (request: Request) => { seen.push(request.headers.get('x-waldo-do-name')!); return new Response(name + ':' + request.headers.get('x-waldo-do-name')); } }) };
 for (const path of ['/console/legacy', '/console/dashboard']) {
  const response = await worker.fetch(new Request('https://waldo.invalid' + path, { headers: { cookie: 'waldo_console=invalid', 'x-waldo-do-name': 'attacker-selected-owner' } }), { ...baseEnv, TELEGRAM_OWNER_DO: ns, ASSETS: { fetch: async () => new Response('shell') } } as unknown as Cloudflare.Env);
  expect(await response.text()).toBe(path.endsWith('/dashboard') ? 'shell' : '5458446350:5458446350');
  expect(seen.at(-1)).toBe('5458446350');
 }
});
it('never selects a legacy console DO when directory lookup fails', async () => {
  const get = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
  const result = await worker.fetch(new Request('https://waldo.invalid/console', { headers: { cookie: 'waldo_console=a.b.c' } }),
    { ...baseEnv, ...supabaseEnv, TELEGRAM_OWNER_DO: { idFromName: (name: string) => name, get } } as unknown as Cloudflare.Env);
  expect(result.status).toBe(503);
  expect(get).not.toHaveBeenCalled();
});

it('routes a private export download through the same owner gate; signed out never reaches a body', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ do_name: 'owner-export', subject: '5458446350', timezone: null }]))));
 const request = new Request('https://waldo.invalid/console/exports/exp%3Aabc', { headers: { cookie: 'waldo_console=ticket' } });
 const result = await worker.fetch(request, { ...baseEnv, ...supabaseEnv } as unknown as Cloudflare.Env);
 expect(await result.text()).toBe('do:owner-export');
 const signedOut = await worker.fetch(new Request(request.url), { ...baseEnv, ...supabaseEnv } as unknown as Cloudflare.Env);
 expect(signedOut.status).toBe(303); expect(signedOut.headers.get('location')).toBe('/console/signin');
});
