import { describe, expect, it, vi } from 'vitest';
import { ownerRuntimeAuthority } from '../src/identity/owner-runtime-authority';
import { routerSignature } from '../src/identity/owner-directory';

const env = { SUPABASE_PROJECT_URL: 'https://owner-root.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-hmac' };
const row = { owner_id: '10000000-0000-0000-0000-000000000001', auth_user_id: '20000000-0000-0000-0000-000000000001', do_name: 'owner-root-fixture', state_version: 0, admission_revision: '9007199254740993' };
const physical = { doName: row.do_name, actualDoId: 'fixture-do-a', expectedDoId: (_name: string) => 'fixture-do-a', assertCurrent: () => {} };

describe('canonical owner runtime authority', () => {
  it('admits an active app-only owner through a signed physical owner read with no Telegram subject', async () => {
    const fetcher = vi.fn(async () => Response.json(row)), at = () => 1791600000000;
    const authority = await ownerRuntimeAuthority(env, fetcher, at).resolve(physical);
    expect(authority).toEqual({ ownerId: row.owner_id, authenticatedUserId: row.auth_user_id, doName: row.do_name, stateVersion: 0, admissionRevision: row.admission_revision });
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const args = JSON.parse(String(call[1].body));
    expect(args.p_sig).toBe(await routerSignature(env.WALDO_ROUTER_HMAC_SECRET, at() / 1000, `owner.runtime.${row.do_name}`));
    expect(Object.keys(args).sort()).toEqual(['p_at', 'p_do_name', 'p_sig']);
  });
  it('rejects wrong physical owner before directory I/O and checks a rebind after directory await', async () => {
    const fetcher = vi.fn(async () => Response.json(row));
    await expect(ownerRuntimeAuthority(env, fetcher).resolve({ ...physical, actualDoId: 'other-do' })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    let current = true;
    const delayed = vi.fn(async () => { current = false; return Response.json(row); });
    await expect(ownerRuntimeAuthority(env, delayed).resolve({ ...physical, assertCurrent: () => { if (!current) throw Error('owner revoked'); } })).rejects.toThrow('owner revoked');
  });
  it('rejects missing Auth owner, wrong owner locator, lossy revision and unknown fields', async () => {
    for (const patch of [{ auth_user_id: null }, { do_name: 'other-owner' }, { admission_revision: 9007199254740993 }, { extra: 'untrusted' }]) {
      await expect(ownerRuntimeAuthority(env, async () => Response.json({ ...row, ...patch })).resolve(physical)).rejects.toThrow('owner runtime authority rejected');
    }
    await expect(ownerRuntimeAuthority(env, async () => Response.json(null)).resolve(physical)).rejects.toThrow('owner runtime authority revoked');
  });
  it('rechecks the current owner lifecycle without substituting another account or relying on a surface link', async () => {
    let value = { ...row };
    const service = ownerRuntimeAuthority(env, async () => Response.json(value));
    const initial = await service.resolve(physical);
    await service.assertCurrent(initial, physical);
    value = { ...row, state_version: 1 };
    await expect(service.assertCurrent(initial, physical)).rejects.toThrow('owner runtime authority revoked');
    value = { ...row, owner_id: '10000000-0000-0000-0000-000000000002' };
    await expect(service.assertCurrent(initial, physical)).rejects.toThrow('owner runtime authority revoked');
  });
  it('has no missing-directory or deploy-owner fallback', async () => {
    await expect(ownerRuntimeAuthority({ WALDO_OWNER_TELEGRAM_ID: '123' }).resolve(physical)).rejects.toThrow('owner runtime authority unavailable');
  });
});
