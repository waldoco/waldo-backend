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

describe('console owner-DO routing', () => {
  it('routes /console to the directory-resolved owner DO, not the env telegram id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ do_name: 'owner-test-uuid', subject: '5458446350', timezone: null }]))));
    const res = await worker.fetch(
      new Request('https://waldo.invalid/console', { headers: { cookie: 'waldo_console=a.b.c' } }),
      { ...baseEnv, ...supabaseEnv } as unknown as Cloudflare.Env,
    );
    expect(await res.text()).toBe('do:owner-test-uuid');
  });

  it('falls back to the env telegram id when the directory has no presence row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    const res = await worker.fetch(
      new Request('https://waldo.invalid/console', { headers: { cookie: 'waldo_console=a.b.c' } }),
      { ...baseEnv, ...supabaseEnv } as unknown as Cloudflare.Env,
    );
    expect(await res.text()).toBe('do:5458446350');
  });

  it('uses the deploy-owner path when Supabase is not configured', async () => {
    const res = await worker.fetch(new Request('https://waldo.invalid/console'), baseEnv as unknown as Cloudflare.Env);
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
