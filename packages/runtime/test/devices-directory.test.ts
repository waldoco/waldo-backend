import { expect, it, vi } from 'vitest';
import { deviceDirectory } from '../src/devices/device-directory';
import { routerSignature } from '../src/identity/owner-directory';
const config = { SUPABASE_PROJECT_URL: 'https://fictional-db.test', SUPABASE_PUBLISHABLE_KEY: 'fictional-pub', WALDO_ROUTER_HMAC_SECRET: 'fictional-router' };
it('stops at a rejected IP budget before creating presented-code throttle keys', async () => {
  const fetcher = vi.fn(async () => Response.json(false));
  expect(await deviceDirectory(config, fetcher as typeof fetch).throttle('fixture-ip', 'a'.repeat(64))).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('binds label bytes and capability selection to the signed redeem RPC', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const args = JSON.parse(String(init?.body)) as { p_at: number; p_sig: string };
    expect(args.p_sig).toBe(await routerSignature(config.WALDO_ROUTER_HMAC_SECRET, args.p_at, `devredeem.${'a'.repeat(64)}.A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg.436166c3a9.machine_state_query`));
    return Response.json([{ owner_id: 'owner_fixture', device_id: 'device_fixture' }]);
  });
  expect(await deviceDirectory(config, fetcher as typeof fetch).redeemPairing({ code: 'unused', device_pubkey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', label: 'Café', declared_capabilities: ['machine_state_query'], contract_version: '0.2.3' }, 'a'.repeat(64))).toEqual({ owner_id: 'owner_fixture', device_id: 'device_fixture' });
});
