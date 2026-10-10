import { describe, expect, it } from 'vitest';
import { ownerChannelDirectory } from '../src/identity/owner-channel-directory';
import { routerSignature } from '../src/identity/owner-directory';
const env = { SUPABASE_PROJECT_URL: 'https://channel.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-public', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const owner = { ownerId: '10000000-0000-0000-0000-000000000001', authenticatedUserId: '20000000-0000-0000-0000-000000000001', doName: 'canonical-owner-a', stateVersion: 0, admissionRevision: '1' };
const session = { ownerId: owner.ownerId, doName: owner.doName, sessionHash: 'a'.repeat(64), revision: '0:1', expires: Date.now() + 600000 };
const locator = { doName: owner.doName, actualDoId: 'physical-a', expectedDoId: () => 'physical-a', assertCurrent: () => {} };
const fixture = () => {
  let revision = '1', revoked = false, foreign = false; const calls: { fn: string; args: Record<string, string | number> }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const fn = String(url).split('/').at(-1)!, args = JSON.parse(String(init!.body)); calls.push({ fn, args });
    const messages: Record<string, string> = {
      owner_runtime_authority: `owner.runtime.${owner.doName}`, app_session_authority: `app.session.${owner.doName}.${session.sessionHash}`,
      owner_channel_inventory: `app.channels.inventory.${owner.doName}.${session.sessionHash}.0:1`,
      unlink_presence: `app.channels.unlink.${owner.doName}.${session.sessionHash}.0:1.telegram`,
      issue_link_code: `app.channels.link.${owner.doName}.${session.sessionHash}.0:1.whatsapp.${args.p_code_hash}`,
    };
    expect(args.p_sig).toBe(await routerSignature(env.WALDO_ROUTER_HMAC_SECRET, Number(args.p_at), messages[fn]!));
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: owner.ownerId, auth_user_id: owner.authenticatedUserId, do_name: owner.doName, state_version: 0, admission_revision: revision });
    if (fn === 'app_session_authority') return Response.json(revoked ? null : { owner_id: foreign ? '10000000-0000-0000-0000-000000000002' : owner.ownerId, do_name: owner.doName, session_hash: session.sessionHash, state_version: 0, admission_revision: revision, expires_at: session.expires });
    if (fn === 'unlink_presence') revision = '2';
    return Response.json({ owner_id: owner.ownerId, do_name: owner.doName, revision: `0:${revision}`,
      ...(fn === 'owner_channel_inventory' ? { linked: ['telegram'] } : fn === 'issue_link_code' ? { expires_at: Date.now() + 599000 } : {}) });
  };
  return { directory: ownerChannelDirectory(env, owner, session, locator, fetcher), fetcher, calls,
    revoke: () => { revoked = true; }, crossOwner: () => { foreign = true; }, stale: () => { revision = '3'; } };
};
describe('signed canonical owner channel directory', () => {
  it('signs current session-bound inventory and both provider operations on the existing directory rail', async () => {
    const f = fixture(); expect(await f.directory.inventory()).toEqual({ revision: '0:1', linked: ['telegram'] });
    expect(await f.directory.issueLink('whatsapp', '0:1')).toMatchObject({ revision: '0:1', code: expect.stringMatching(/^[A-Z2-9]{10}$/) });
    expect(await f.directory.unlink('telegram', '0:1')).toEqual({ revision: '0:2' });
    const args = f.calls.find(call => call.fn === 'unlink_presence')!.args;
    expect(args).toMatchObject({ p_do_name: owner.doName, p_session_hash: session.sessionHash, p_expected_revision: '0:1', p_provider: 'telegram' });
  });
  it('rejects foreign physical DO before signed I/O', async () => {
    let calls = 0;
    const directory = ownerChannelDirectory(env, owner, session, { ...locator, actualDoId: 'physical-b' }, async () => { calls++; throw Error('must not fetch'); });
    await expect(directory.inventory()).rejects.toThrow(); expect(calls).toBe(0);
  });
  it('rejects wrong owner session, revoked session and changed admission before any channel mutation', async () => {
    for (const change of ['crossOwner', 'revoke', 'stale'] as const) {
      const f = fixture(); f[change](); await expect(f.directory.unlink('telegram', '0:1')).rejects.toThrow();
      expect(f.calls.some(call => call.fn === 'unlink_presence')).toBe(false);
    }
    const f = fixture(); await expect(f.directory.unlink('telegram', '0:999')).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  });
  it('rejects session revocation after mutation instead of returning a success receipt', async () => {
    const f = fixture(); const fetcher: typeof fetch = async (url, init) => { const response = await f.fetcher(url, init); if (String(url).endsWith('/unlink_presence')) f.revoke(); return response; };
    await expect(ownerChannelDirectory(env, owner, session, locator, fetcher).unlink('telegram', '0:1')).rejects.toThrow();
  });
});
