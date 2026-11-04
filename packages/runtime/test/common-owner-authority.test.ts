import { expect, it, vi } from 'vitest';
import { commonOwnerAuthority } from '../src/identity/common-owner-authority';
import { routerSignature } from '../src/identity/owner-directory';
const env = { SUPABASE_PROJECT_URL: 'https://db.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-public', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret' };
const row = { owner_id: '10000000-0000-0000-0000-000000000001', auth_user_id: '30000000-0000-0000-0000-000000000001',
  do_name: 'fixture-owner', presence_id: '20000000-0000-0000-0000-000000000001', provider: 'telegram', subject: '81101', state_version: 0, admission_revision: '9007199254740993' };
it('resolves one common auth-user root through a signed exact directory binding, not trace metadata', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(row));
  const at = () => 1790000000000;
  const admitted = await commonOwnerAuthority(env, fetcher, at).resolve('telegram', '81101', 'fixture-owner');
  expect(admitted).toMatchObject({ directoryOwnerId: row.owner_id, authenticatedUserId: row.auth_user_id, presenceId: row.presence_id, admissionRevision: row.admission_revision });
  expect(admitted?.ownerId).toBe('owner_951e948de811c4033f33a0ced78a17b1edf1c0c705a278780079f3e417a63484');
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.p_sig).toBe(await routerSignature(env.WALDO_ROUTER_HMAC_SECRET, at()/1000, 'common.owner.' + JSON.stringify(['telegram','81101','fixture-owner'])));
});
it('same directory owner across presences reaches one root but retains distinct issuer custody', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(row)).mockResolvedValueOnce(Response.json({ ...row, provider:'whatsapp', subject:'15550001111', presence_id:'20000000-0000-0000-0000-000000000002' }));
  const authority = commonOwnerAuthority(env, fetcher);
  const tg = await authority.resolve('telegram','81101','fixture-owner');
  const wa = await authority.resolve('whatsapp','15550001111','fixture-owner');
  expect(tg?.ownerId).toBe(wa?.ownerId); expect(tg?.presenceId).not.toBe(wa?.presenceId);
});
it('missing auth-user mapping, foreign locator/provider and lossy revision fail closed', async () => {
  for (const patch of [{ auth_user_id:null }, { do_name:'foreign' }, { provider:'whatsapp' }, { subject:'81102' }, { admission_revision:9007199254740993 }, { admission_revision:'01' }]) {
    await expect(commonOwnerAuthority(env, async () => Response.json({ ...row, ...patch })).resolve('telegram','81101','fixture-owner')).rejects.toThrow('common owner authority rejected');
  }
});
it('fresh currentness detects a changed global custody epoch without assuming independent revocation', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(row)).mockResolvedValueOnce(Response.json({ ...row, admission_revision:'9007199254740994' }));
  const service = commonOwnerAuthority(env,fetcher); const admitted = await service.resolve('telegram','81101','fixture-owner');
  await expect(service.assertCurrent(admitted!)).rejects.toThrow('common owner authority rejected');
});
it('no deploy-owner fallback or absent live mapping creates canonical authority', async () => {
  await expect(commonOwnerAuthority({}).resolve('telegram','81101','fixture-owner')).rejects.toThrow('common owner authority unavailable');
  expect(await commonOwnerAuthority(env, async () => Response.json(null)).resolve('telegram','81101','fixture-owner')).toBeNull();
});
