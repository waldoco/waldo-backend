import { describe, expect, it } from 'vitest';
import { appChannelsRequest, type AppChannelsHost } from '../src/channels/app-channels';
import { appChannelsV1Schema } from '../../contracts/src/app/channels';
const fixture = () => {
  const values = new Map<string, unknown>([['owner:browser', 'browser-state'], ['owner:workspace', 'workspace-state']]); let linked = true, calls = 0;
  const host: AppChannelsHost = { accountRef: `acct_${'a'.repeat(64)}`, sessionHash: 'b'.repeat(64), now: () => 1000,
    storage: { get: <T>(key: string) => values.get(key) as T | undefined, put: (key, value) => { values.set(key, value); } },
    commit: work => work(), assertCurrent: async () => {}, rateLimit: async () => true, configured: { telegram: true, whatsapp: false },
    directory: { inventory: async () => ({ revision: linked ? '0:1' : '0:2', linked: linked ? ['telegram'] : [] }),
      issueLink: async () => ({ revision: '0:1', code: 'ABCDEFGHJK', expiresAt: 601000 }),
      unlink: async (_provider, revision) => { calls++; if (revision !== (linked ? '0:1' : '0:2')) throw Error('stale'); linked = false; return { revision: '0:2' }; } },
  };
  return { host, values, calls: () => calls };
};
const request = (path: string, body?: unknown) => new Request(`https://app.invalid/app/v1/channels${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
describe('neutral app channels', () => {
  it('reports real inventory and absent iMessage integration without deriving owner authority from a channel', async () => {
    const f = fixture(), response = await appChannelsRequest(request(''), f.host);
    const view = appChannelsV1Schema.parse(await response!.json());
    expect(view.channels.map(row => [row.provider, row.state])).toEqual([['app', 'linked'], ['telegram', 'linked'], ['whatsapp', 'unavailable'], ['imessage', 'unavailable']]);
    expect(view.channels[3]!.reason).toBe('integration_absent');
  });
  it('unlinks once under revision control while preserving owner browser and workspace state', async () => {
    const f = fixture(), args = { operation_id: 'unlink-operation-01', provider: 'telegram', expected_revision: '0:1' };
    const receipt = await (await appChannelsRequest(request('/unlink', args), f.host))!.json();
    expect(receipt).toMatchObject({ state: 'recorded', revision: '0:2', authority: 'channel_only', owner_state: 'preserved' });
    expect(await (await appChannelsRequest(request('/unlink', args), f.host))!.json()).toEqual(receipt);
    expect(f.calls()).toBe(1);
    expect(f.values.get('owner:browser')).toBe('browser-state'); expect(f.values.get('owner:workspace')).toBe('workspace-state');
    expect((await appChannelsRequest(request('/unlink', { ...args, operation_id: 'unlink-operation-02' }), f.host))!.status).toBe(409);
    expect(f.calls()).toBe(1);
  });
  it('never claims a provider is linked merely because a code was issued, and rejects unknown authority fields', async () => {
    const f = fixture(), args = { operation_id: 'link-operation-01', provider: 'telegram', expected_revision: '0:1' };
    const result = await (await appChannelsRequest(request('/link', args), f.host))!.json();
    expect(result).toMatchObject({ state: 'recorded', link: { completion: 'provider_redemption_required' } });
    expect(await (await appChannelsRequest(request('/operations/link-operation-01'), f.host))!.json()).toEqual(result);
    expect((await appChannelsRequest(request('/operations/link-operation-01'), { ...f.host, sessionHash: 'c'.repeat(64) }))!.status).toBe(403);
    let reads = 0; const revokedDuringRead = { ...f.host, assertCurrent: async () => { if (++reads > 1) throw Error('revoked while reading'); } };
    expect((await appChannelsRequest(request('/operations/link-operation-01'), revokedDuringRead))!.status).toBe(503);
    expect((await appChannelsRequest(request('/link', { ...args, owner_id: 'other-owner' }), f.host))!.status).toBe(400);
    expect((await appChannelsRequest(request('/link', { ...args, provider: 'imessage' }), f.host))!.status).toBe(400);
    expect((await appChannelsRequest(request('/link', { ...args, operation_id: 'link-operation-02', provider: 'whatsapp' }), f.host))!.status).toBe(403);
  });
  it('persists ambiguous external outcomes without replay and denies session or payload reuse', async () => {
    const f = fixture(), args = { operation_id: 'unlink-operation-01', provider: 'telegram', expected_revision: '0:1' }; let calls = 0;
    f.host.directory.unlink = async () => { calls++; throw Error('lost reply'); };
    expect(await (await appChannelsRequest(request('/unlink', args), f.host))!.json()).toMatchObject({ state: 'unconfirmed', revision: null });
    await appChannelsRequest(request('/unlink', args), f.host); expect(calls).toBe(1);
    expect((await appChannelsRequest(request('/unlink', args), { ...f.host, sessionHash: 'c'.repeat(64) }))!.status).toBe(409);
    expect((await appChannelsRequest(request('/unlink', { ...args, provider: 'whatsapp' }), f.host))!.status).toBe(409);
    f.host.assertCurrent = async () => { throw Error('revoked'); };
    expect((await appChannelsRequest(request(''), f.host))!.status).toBe(503);
  });
});
