import { describe, expect, it } from 'vitest';
import { APP_CONTROLS_CONNECTIONS_CATALOGUE_REVISION, APP_CONTROLS_CLAIM_CONTROLS_REVISION, APP_GOOGLE_PICTURE_PATH_V1, APP_WEARABLES_MAX_V1, appControlProjectionV1Schema, appGooglePictureRouteV1, appWearableV1Schema } from './controls';

const revision = 'f'.repeat(64);
const account = { id: 'conn-1', email: 'owner@example.test', calendar: true, mail: true, tasks: false, health: 'access_granted' };
const connections = (data: object = {}) => ({
  version: 1, state: 'available', revision, view: 'connections',
  data: { google: { connectAvailable: true, accounts: [account] }, telegram: { linked: false, unlinkAvailable: false }, sessions: { until: '2026-11-06T20:00:00Z', count: 1, items: [] }, ...data },
});
const picture = `${APP_GOOGLE_PICTURE_PATH_V1}/${'a1'.repeat(16)}`;
const apple = { id: 'apple', kind: 'device', label: 'Apple Watch', access: 'healthkit', platform: 'ios', available: true, connection: null };
const whoop = { id: 'whoop', kind: 'device', label: 'WHOOP', access: 'oauth', platform: null, available: true, connection: { status: 'active', connected_at: 1_762_000_000_000 } };

describe('connections catalogue revision', () => {
  it('comes after every earlier controls revision', () => {
    expect(APP_CONTROLS_CONNECTIONS_CATALOGUE_REVISION).toBe(17);
    expect(APP_CONTROLS_CONNECTIONS_CATALOGUE_REVISION).toBeGreaterThan(APP_CONTROLS_CLAIM_CONTROLS_REVISION);
  });
});

describe('a Google account picture', () => {
  it('is optional and nullable, so an older account or a failed read shows the fallback', () => {
    expect(appControlProjectionV1Schema.safeParse(connections()).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(connections({ google: { connectAvailable: true, accounts: [{ ...account, picture: null }] } })).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(connections({ google: { connectAvailable: true, accounts: [{ ...account, picture }] } })).success).toBe(true);
  });

  it('is only ever a Waldo path, never Google\'s address or any other', () => {
    for (const bad of ['https://lh3.googleusercontent.com/a/abc=s96-c', `${APP_GOOGLE_PICTURE_PATH_V1}/conn-1`, `${APP_GOOGLE_PICTURE_PATH_V1}/${'A1'.repeat(16)}`, `${picture}?v=1`, `https://waldo.test${picture}`, '', 42]) {
      expect(appControlProjectionV1Schema.safeParse(connections({ google: { connectAvailable: true, accounts: [{ ...account, picture: bad }] } })).success).toBe(false);
    }
  });

  it('is served at the route the path names, as an image', () => {
    expect(appGooglePictureRouteV1).toMatchObject({ method: 'GET', path: `${APP_GOOGLE_PICTURE_PATH_V1}/{key}`, authenticated: true });
    expect(appGooglePictureRouteV1.response_media).toContain('image/jpeg');
  });
});

describe('the Workspace services on a Google account', () => {
  it('are optional booleans', () => {
    expect(appControlProjectionV1Schema.safeParse(connections({ google: { connectAvailable: true, accounts: [{ ...account, drive: true, docs: true, sheets: false, slides: false }] } })).success).toBe(true);
    for (const bad of [{ drive: 'yes' }, { slides: null }, { forms: true }]) expect(appControlProjectionV1Schema.safeParse(connections({ google: { connectAvailable: true, accounts: [{ ...account, ...bad }] } })).success).toBe(false);
  });
});

describe('the wearables catalogue', () => {
  it('is optional on the view and lists each source once', () => {
    expect(appControlProjectionV1Schema.safeParse(connections({ wearables: [] })).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(connections({ wearables: [apple, whoop] })).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(connections({ wearables: [apple, apple] })).success).toBe(false);
    expect(appControlProjectionV1Schema.safeParse(connections({ wearables: Array.from({ length: APP_WEARABLES_MAX_V1 + 1 }, (_, n) => ({ ...apple, id: `apple_${n}` })) })).success).toBe(false);
  });

  it('takes a single reading entered by hand and a source Waldo cannot connect yet', () => {
    expect(appWearableV1Schema.safeParse({ id: 'body_temperature', kind: 'reading', label: 'Body temperature', access: 'manual', platform: null, available: false, connection: null }).success).toBe(true);
    expect(appWearableV1Schema.safeParse({ ...whoop, id: 'oura', label: 'Oura Ring', available: false, connection: null }).success).toBe(true);
  });

  it('carries Waldo\'s state only for a cloud account, and a platform only for a phone permission', () => {
    expect(appWearableV1Schema.safeParse({ ...apple, connection: { status: 'active', connected_at: null } }).success).toBe(false);
    expect(appWearableV1Schema.safeParse({ ...apple, platform: null }).success).toBe(false);
    expect(appWearableV1Schema.safeParse({ ...apple, platform: 'android' }).success).toBe(false);
    expect(appWearableV1Schema.safeParse({ ...apple, id: 'samsung', access: 'samsung-health', platform: 'ios' }).success).toBe(false);
    expect(appWearableV1Schema.safeParse({ ...apple, id: 'samsung', access: 'samsung-health', platform: 'android' }).success).toBe(true);
    expect(appWearableV1Schema.safeParse({ ...whoop, platform: 'android' }).success).toBe(false);
    expect(appWearableV1Schema.safeParse({ ...whoop, connection: { status: 'reauth_needed', connected_at: null } }).success).toBe(true);
    expect(appWearableV1Schema.safeParse({ ...whoop, connection: { status: 'consent_required', connected_at: 1 } }).success).toBe(true);
  });

  it('refuses an unknown access, kind, status, or key', () => {
    for (const bad of [{ ...apple, access: 'bluetooth' }, { ...apple, kind: 'app' }, { ...whoop, connection: { status: 'syncing', connected_at: null } }, { ...apple, id: 'Apple Watch' }, { ...apple, label: '' }, { ...apple, logo: 'x' }, { ...whoop, connection: { status: 'active' } }]) {
      expect(appWearableV1Schema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('the primary Google account', () => {
  const second = { ...account, id: 'conn-2', email: 'second@example.test' };
  it('comes at revision 20, with exactly one primary account whenever primary is named', async () => {
    const { APP_CONTROLS_GOOGLE_PRIMARY_REVISION } = await import('./controls');
    expect(APP_CONTROLS_GOOGLE_PRIMARY_REVISION).toBe(20);
    const shown = (accounts: object[]) => appControlProjectionV1Schema.safeParse(connections({ google: { connectAvailable: true, accounts } })).success;
    expect(shown([{ ...account, primary: true }, { ...second, primary: false }])).toBe(true);
    expect(shown([account, second])).toBe(true);
    expect(shown([{ ...account, primary: true }, { ...second, primary: true }])).toBe(false);
    expect(shown([{ ...account, primary: false }, { ...second, primary: false }])).toBe(false);
  });
  it('is chosen from the connections view naming one account and nothing else', async () => {
    const { appControlActionV1Schema } = await import('./controls');
    const choose = { view: 'connections', action: 'google.set_primary', id: 'conn-2', revision, request_id: 'primary-0001' };
    expect(appControlActionV1Schema.safeParse(choose).success).toBe(true);
    for (const bad of [{ ...choose, id: undefined }, { ...choose, view: 'account' }, { ...choose, value: 'x' }, { ...choose, account: 'signin' }]) expect(appControlActionV1Schema.safeParse(bad).success).toBe(false);
  });
});
