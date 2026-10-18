import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import worker from '../src/index';
import { consoleAccess, NOTICES } from '../src/channels/console';

const origin = 'https://waldo.invalid';
describe('console entry across actual owner sessions', () => {
  it('serves the root shell after ticket redemption, opens classic pages in the new console and keeps JSON and controls', async () => {
    const name = 'console-entry-owner';
    const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
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
    const opens = async (path: string) => {
      const response = await worker.fetch(new Request(origin + path, { redirect: 'manual', headers: { cookie } }), bindings);
      expect({ path, status: response.status }).toEqual({ path, status: 303 });
      return response.headers.get('location');
    };
    expect(await opens('/console/waiting')).toBe('/console#/waiting');
    expect(await opens('/console?m=invalid')).toBe('/console');
    expect(await opens('/console?m=' + encodeURIComponent('Your account is locked. Call +1 555 0100.'))).toBe('/console');
    expect(await opens('/console/legacy')).toBe('/console');
    expect(await opens('/console/activity')).toBe('/console#/patrol');
    expect(await opens('/console/invites')).toBe('/console#/invites');
    expect((await json('/console/waiting')).csrf).toBe(current.csrf);
    expect((await json('/console?m=' + encodeURIComponent('Your account is locked.')) as { notice?: unknown }).notice ?? null).toBeNull();
    expect((await json('/console?m=invalid') as { notice?: unknown }).notice).toBe(NOTICES.invalid);
    expect((await json('/console?m=__proto__') as { notice?: unknown }).notice ?? null).toBeNull();
    const signedOut = await worker.fetch(new Request(origin + '/console/waiting', { redirect: 'manual' }), bindings);
    expect({ status: signedOut.status, location: signedOut.headers.get('location') }).toEqual({ status: 401, location: null });
    const imessage = await worker.fetch(new Request(origin + '/console/imessage', { redirect: 'manual', headers: { cookie } }), bindings);
    expect(imessage.headers.get('location') ?? '').not.toContain('#/');
    const missingFile = await worker.fetch(new Request(origin + '/console/file?id=987654', { redirect: 'manual', headers: { cookie } }), bindings);
    expect({ status: missingFile.status, location: missingFile.headers.get('location'), type: missingFile.headers.get('content-type'), cache: missingFile.headers.get('cache-control'), body: await missingFile.text() })
      .toEqual({ status: 502, location: null, type: 'text/plain; charset=utf-8', cache: 'no-store', body: NOTICES['file.unavailable'] });
    expect((await worker.fetch(new Request(origin + '/console/unknown', { headers: { cookie } }), bindings)).status).toBe(404);
    const denied = await worker.fetch(new Request(origin + '/console/action', { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'timezone.set', csrf: 'wrong', value: 'Pacific/Auckland' }) }), bindings);
    expect({ status: denied.status, location: denied.headers.get('location'), body: await denied.text() }).toEqual({ status: 400, location: null, body: NOTICES.invalid });
    const adminFormFailure = await worker.fetch(new Request(origin + '/console/action', { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'invite.revoke', csrf: current.csrf, id: 'no-such-invite' }) }), bindings);
    expect({ status: adminFormFailure.status, location: adminFormFailure.headers.get('location'), body: await adminFormFailure.text() }).toEqual({ status: 400, location: null, body: NOTICES.invalid });
    expect((await json('/console')).timezone).toBe(current.timezone);
    const other = { ...bindings, WALDO_OWNER_TELEGRAM_ID: 'console-entry-other' };
    const crossed = await worker.fetch(new Request(origin + '/console', { headers: { cookie } }), other);
    expect(crossed.status).toBe(303);
    expect(crossed.headers.get('location')).toBe('/console/signin');
    expect(await crossed.text()).not.toContain('/console/dashboard/assets/');
  });
});
