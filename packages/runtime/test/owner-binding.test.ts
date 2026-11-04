import { afterEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { localOwnerBinding, ownerBindingCurrent, verifyOwnerBinding } from '../src/identity/owner-binding';

const OWNER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PRESENCE = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic', WALDO_ROUTER_HMAC_SECRET: 'synthetic' };
const kv = (values: Record<string, unknown>) => ({ get: <T>(key: string) => values[key] as T | undefined });
const owners = { idFromName: (name: string) => ({ toString: () => `id-of-${name}` }) };
const asked: string[] = [];
const answer = { revoked: false };
const stubDirectory = () => vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const fn = /\/rpc\/([a-z_]+)$/.exec(String(input))?.[1] ?? '';
  asked.push(fn);
  const body = JSON.parse(String(init?.body)) as Record<string, string>;
  if (answer.revoked) return Response.json(null);
  if (fn === 'common_owner_authority') return Response.json({ owner_id: OWNER, auth_user_id: OWNER, do_name: body.p_do_name, presence_id: PRESENCE, provider: body.p_provider, subject: body.p_subject, state_version: 2, admission_revision: '4' });
  if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER, auth_user_id: OWNER, do_name: body.p_do_name, state_version: 2, admission_revision: '4' });
  return new Response('unexpected', { status: 500 });
});
afterEach(() => { vi.unstubAllGlobals(); asked.length = 0; answer.revoked = false; });

describe('the local owner binding', () => {
  const app = String(appSubjectFor('owner-a'));
  it('reads the Telegram presence first and the app binding otherwise, each only on its own physical object', () => {
    expect(localOwnerBinding(kv({ do_name: 'owner-a', telegram_subject: '81', app_subject: app }), owners, 'id-of-owner-a')).toEqual({ surface: 'telegram', doName: 'owner-a', subject: '81' });
    expect(localOwnerBinding(kv({ do_name: 'owner-a', app_subject: app }), owners, 'id-of-owner-a')).toEqual({ surface: 'app', doName: 'owner-a', subject: app });
    expect(localOwnerBinding(kv({ do_name: 'owner-a', telegram_subject: '81', telegram_unlinked: true, app_subject: app }), owners, 'id-of-owner-a')).toEqual({ surface: 'app', doName: 'owner-a', subject: app });
  });

  it('holds no binding for a foreign object, an app subject minted for another owner, or unlinked surfaces', () => {
    expect(localOwnerBinding(kv({ do_name: 'owner-a', telegram_subject: '81', app_subject: app }), owners, 'id-of-owner-b')).toBeUndefined();
    expect(localOwnerBinding(kv({ do_name: 'owner-a', app_subject: String(appSubjectFor('owner-b')) }), owners, 'id-of-owner-a')).toBeUndefined();
    expect(localOwnerBinding(kv({ do_name: 'owner-a', app_subject: app, app_unlinked: true }), owners, 'id-of-owner-a')).toBeUndefined();
    expect(localOwnerBinding(kv({ do_name: 'owner-a', telegram_subject: 'not-a-chat' }), owners, 'id-of-owner-a')).toBeUndefined();
    expect(localOwnerBinding(kv({ telegram_subject: '81' }), owners, 'id-of-owner-a')).toBeUndefined();
    expect(localOwnerBinding(kv({ do_name: 'owner-a', telegram_subject: '81' }), undefined, 'id-of-owner-a')).toBeUndefined();
  });

  it('stays current only while the same binding holds', () => {
    const values: Record<string, unknown> = { do_name: 'owner-a', app_subject: app };
    const binding = localOwnerBinding(kv(values), owners, 'id-of-owner-a')!;
    expect(ownerBindingCurrent(kv(values), owners, 'id-of-owner-a', binding)).toBe(true);
    values.telegram_subject = '81';
    expect(ownerBindingCurrent(kv(values), owners, 'id-of-owner-a', binding)).toBe(false);
  });

  it('stops being current when the Telegram presence is rebound to another subject in place', () => {
    const values: Record<string, unknown> = { do_name: 'owner-a', telegram_subject: '81' };
    const binding = localOwnerBinding(kv(values), owners, 'id-of-owner-a')!;
    expect(ownerBindingCurrent(kv(values), owners, 'id-of-owner-a', binding)).toBe(true);
    values.telegram_subject = '82';
    expect(ownerBindingCurrent(kv(values), owners, 'id-of-owner-a', binding)).toBe(false);
  });
});

describe('the directory\'s answer for a binding', () => {
  it('verifies a Telegram binding through its presence and an app binding through the account, naming the same owner', async () => {
    stubDirectory();
    const viaTelegram = await verifyOwnerBinding(directory, { surface: 'telegram', doName: 'owner-a', subject: '81' }, 'id-of-owner-a', owners);
    const viaApp = await verifyOwnerBinding(directory, { surface: 'app', doName: 'owner-a', subject: String(appSubjectFor('owner-a')) }, 'id-of-owner-a', owners);
    expect(asked).toEqual(['common_owner_authority', 'owner_runtime_authority']);
    expect(viaTelegram).toMatchObject({ directoryOwnerId: OWNER, stateVersion: 2, doName: 'owner-a', subject: '81' });
    expect(viaApp).toMatchObject({ directoryOwnerId: OWNER, stateVersion: 2, doName: 'owner-a' });
    expect(viaTelegram!.custodyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(viaApp!.custodyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(viaApp!.custodyDigest).not.toBe(viaTelegram!.custodyDigest);
  });

  it('answers null for an owner the directory no longer admits, on either surface', async () => {
    stubDirectory(); answer.revoked = true;
    expect(await verifyOwnerBinding(directory, { surface: 'telegram', doName: 'owner-a', subject: '81' }, 'id-of-owner-a', owners)).toBeNull();
    expect(await verifyOwnerBinding(directory, { surface: 'app', doName: 'owner-a', subject: String(appSubjectFor('owner-a')) }, 'id-of-owner-a', owners)).toBeNull();
  });

  it('refuses to verify an app binding on another physical object without asking the directory', async () => {
    stubDirectory();
    await expect(verifyOwnerBinding(directory, { surface: 'app', doName: 'owner-a', subject: String(appSubjectFor('owner-a')) }, 'id-of-owner-b', owners)).rejects.toThrow();
    expect(asked).toEqual([]);
  });
});
