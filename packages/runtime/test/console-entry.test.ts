import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';

const origin = 'https://waldo.invalid';
describe('console entry across actual owner sessions', () => {
  it('serves the root shell after ticket redemption and preserves legacy JSON, notices and controls', async () => {
    const name = 'console-entry-owner';
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
    const ticket = await runInDurableObject(stub, (instance, state) => {
      Object.assign((instance as unknown as { env: Record<string, unknown> }).env, { TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key' });
      state.storage.kv.put('do_name', name);
      return consoleAccess(state.storage).mintLink(origin);
    });
    const bindings = { ...env, WALDO_OWNER_TELEGRAM_ID: name };
    const preview = await worker.fetch(new Request(ticket), bindings);
    expect(await preview.text()).toContain('Open console');
    const redeem = () => worker.fetch(new Request(origin + '/console', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t: new URL(ticket).searchParams.get('t')! }) }), bindings);
    const receipt = await redeem();
    expect(receipt.status).toBe(303);
    expect(receipt.headers.get('location')).toBe('/console');
    const cookie = receipt.headers.get('set-cookie')!.split(';')[0]!;
    expect((await redeem()).status).toBe(403);
    for (const path of ['/console', '/console/dashboard']) {
      const shell = await worker.fetch(new Request(origin + path, { headers: { cookie } }), bindings);
      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain('/console/dashboard/assets/');
      expect(shell.headers.get('cache-control')).toBe('private, no-store');
    }
    const json = async (path: string) => {
      const response = await worker.fetch(new Request(origin + path, { headers: { cookie, accept: 'application/json' } }), bindings);
      expect(response.status).toBe(200);
      return response.json() as Promise<{ csrf: string; timezone: string }>;
    };
    const current = await json('/console');
    expect((await json('/console/legacy')).csrf).toBe(current.csrf);
    const notice = await worker.fetch(new Request(origin + '/console?m=invalid', { headers: { cookie } }), bindings);
    expect(await notice.text()).toContain('That change could not be applied');
    const legacy = await worker.fetch(new Request(origin + '/console/legacy', { headers: { cookie } }), bindings);
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toContain('Overview');
    const waiting = await worker.fetch(new Request(origin + '/console/waiting', { headers: { cookie } }), bindings);
    expect(waiting.status).toBe(200);
    expect((await worker.fetch(new Request(origin + '/console/unknown', { headers: { cookie } }), bindings)).status).toBe(404);
    const denied = await worker.fetch(new Request(origin + '/console/action', { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'timezone.set', csrf: 'wrong', value: 'Pacific/Auckland' }) }), bindings);
    expect(denied.status).toBe(303);
    expect(denied.headers.get('location')).toBe('/console?m=invalid');
    expect((await json('/console')).timezone).toBe(current.timezone);
    const other = { ...bindings, WALDO_OWNER_TELEGRAM_ID: 'console-entry-other' };
    const crossed = await worker.fetch(new Request(origin + '/console', { headers: { cookie } }), other);
    expect(crossed.status).toBe(303);
    expect(crossed.headers.get('location')).toBe('/console/signin');
    expect(await crossed.text()).not.toContain('/console/dashboard/assets/');
  });
});
