import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseResponsibilityAuthority } from '../src/responsibility/supabase-authority';
import {
  createResponsibilityWorkerAdapter,
  type ResponsibilityOwnerRoot,
} from '../src/responsibility/worker-adapter';

const MEDIA_TYPE = 'application/vnd.waldo.responsibility.v0.2+json';
const OWNER_ID = 'owner_local_revocation_01';
const PRESENCE_ID = 'presence_local_revocation_01';
const REGISTRATION_ID = 'presence_registration_local_revocation_01';

type LocalSupabase = Readonly<{
  API_URL: string;
  PUBLISHABLE_KEY: string;
  SECRET_KEY: string;
}>;

describe.sequential('local Supabase responsibility revocation', () => {
  let local: LocalSupabase;
  let userId: string | undefined;
  let accessToken: string;
  let routedOwnerRoots = 0;
  let captureCalls = 0;
  let projectionCalls = 0;

  const requestLocal = (
    path: string,
    { key, token = key, method = 'GET', body }: {
      key: string;
      token?: string;
      method?: string;
      body?: unknown;
    },
  ) => fetch(`${local.API_URL}${path}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  beforeAll(async () => {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const status = spawnSync(
      npx,
      ['-y', 'supabase@2.109.1', 'status', '--output', 'json'],
      { cwd: new URL('../../..', import.meta.url), encoding: 'utf8' },
    );
    if (status.error) throw status.error;
    if (status.status !== 0) throw new Error('local Supabase status is unavailable');
    local = JSON.parse(status.stdout) as LocalSupabase;
    if (
      local.API_URL !== 'http://127.0.0.1:54321'
      || !local.PUBLISHABLE_KEY
      || !local.SECRET_KEY
    ) {
      throw new Error('local Supabase Auth/REST services are not running');
    }

    const email = `gate-a-${randomUUID()}@example.invalid`;
    const password = `Gate-A-${randomUUID()}`;
    const created = await requestLocal('/auth/v1/admin/users', {
      key: local.SECRET_KEY,
      method: 'POST',
      body: {
        email,
        password,
        email_confirm: true,
        app_metadata: {
          waldo_responsibility_authority: {
            owner_id: OWNER_ID,
            presence_id: PRESENCE_ID,
            presence_registration_id: REGISTRATION_ID,
            owner_policy_revision: 1,
            owner_root_routing_version: 1,
            state: 'active',
            expires_at: '2099-01-01T00:00:00.000Z',
          },
        },
      },
    });
    if (!created.ok) throw new Error(`local test-user creation failed (${created.status})`);
    userId = ((await created.json()) as { id: string }).id;

    const signedIn = await requestLocal('/auth/v1/token?grant_type=password', {
      key: local.PUBLISHABLE_KEY,
      method: 'POST',
      body: { email, password },
    });
    if (!signedIn.ok) throw new Error(`local sign-in failed (${signedIn.status})`);
    accessToken = ((await signedIn.json()) as { access_token: string }).access_token;
    const claims = JSON.parse(
      Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      claims.sub !== userId
      || typeof claims.session_id !== 'string'
      || typeof claims.exp !== 'number'
      || claims.exp * 1_000 <= Date.now()
    ) {
      throw new Error('local sign-in returned an invalid session-bound access token');
    }
  });

  afterAll(async () => {
    if (!userId) return;
    const deleted = await requestLocal(`/auth/v1/admin/users/${userId}`, {
      key: local.SECRET_KEY,
      method: 'DELETE',
    });
    if (!deleted.ok) throw new Error(`local test-user cleanup failed (${deleted.status})`);
  });

  it('denies the exact unexpired signed-out token before owner-root routing', async () => {
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture() {
        captureCalls += 1;
        return {
          protocolVersion: '0.2',
          ownerId: OWNER_ID,
          requestId: 'request_local_revocation_01',
          outcome: {
            id: 'outcome_local_revocation_01',
            ownerId: OWNER_ID,
            revision: 1,
            userStatement: 'Prepare a reviewable update, but do not publish it.',
            state: 'captured',
            createdAt: '2026-08-06T12:00:01.000Z',
            updatedAt: '2026-08-06T12:00:01.000Z',
          },
          mission: null,
          workUnits: [],
          projectionCursor: 1,
        };
      },
      async readProjection() {
        projectionCalls += 1;
        return {
          protocolVersion: '0.2',
          ownerId: OWNER_ID,
          projectionName: 'responsibility.summary',
          snapshotId: 'snapshot_local_revocation_01',
          snapshotBaseCursor: 0,
          fromExclusiveCursor: 0,
          highWaterCursor: 1,
          nextCursor: 1,
          items: [],
          hasMore: false,
          generatedAt: '2026-08-06T12:00:01.000Z',
        };
      },
    };
    const authority = createSupabaseResponsibilityAuthority({
      projectUrl: 'https://local-supabase.invalid',
      publishableKey: local.PUBLISHABLE_KEY,
      fetch: (input, init) => fetch(
        String(input).replace('https://local-supabase.invalid', local.API_URL),
        init,
      ),
    });
    const adapter = createResponsibilityWorkerAdapter({
      authority,
      edgeRateLimit: { admit: async () => true },
      failureReporter: { report: () => undefined },
      ownerRootFor: async () => {
        routedOwnerRoots += 1;
        return ownerRoot;
      },
      now: () => '2026-08-06T12:00:01.000Z',
      newId: (kind) => `${kind}_local_revocation_01`,
    });
    const captureRequest = () => new Request(
      'https://api.heywaldo.com/public/responsibilities',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: MEDIA_TYPE,
          'content-type': MEDIA_TYPE,
        },
        body: JSON.stringify({
          protocolVersion: '0.2',
          requestId: 'request_local_revocation_01',
          commandType: 'responsibility.capture',
          presenceRegistrationId: REGISTRATION_ID,
          clientIssuedAt: '2026-08-06T12:00:00.000Z',
          payload: { userStatement: 'Prepare a reviewable update, but do not publish it.' },
        }),
      },
    );
    const projectionRequest = () => new Request(
      'https://api.heywaldo.com/public/responsibilities/projection?fromExclusiveCursor=0&limit=25',
      { headers: { authorization: `Bearer ${accessToken}`, accept: MEDIA_TYPE } },
    );

    expect((await adapter.fetch(captureRequest())).status).toBe(201);
    expect((await adapter.fetch(projectionRequest())).status).toBe(200);
    expect({ routedOwnerRoots, captureCalls, projectionCalls }).toEqual({
      routedOwnerRoots: 2,
      captureCalls: 1,
      projectionCalls: 1,
    });

    const signedOut = await requestLocal('/auth/v1/logout?scope=local', {
      key: local.PUBLISHABLE_KEY,
      token: accessToken,
      method: 'POST',
    });
    expect(signedOut.status).toBe(204);

    for (const revokedRequest of [captureRequest(), projectionRequest()]) {
      const response = await adapter.fetch(revokedRequest);
      expect(response.status).toBe(401);
      expect(Object.keys(await response.json()).sort()).toEqual([
        'code', 'status', 'title', 'type',
      ]);
    }
    expect({ routedOwnerRoots, captureCalls, projectionCalls }).toEqual({
      routedOwnerRoots: 2,
      captureCalls: 1,
      projectionCalls: 1,
    });
  });
});
