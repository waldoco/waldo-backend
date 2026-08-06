import { describe, expect, it } from 'vitest';
import worker, { responsibilityEdgeRateKey } from '../src/index';
import {
  createResponsibilityWorkerAdapter,
  type ResponsibilityAuthority,
  type ResponsibilityOwnerRoot,
  type TrustedResponsibilityContext,
} from '../src/responsibility/worker-adapter';

const trustedContext: TrustedResponsibilityContext = Object.freeze({
  ownerId: 'owner_server_01',
  actor: { kind: 'presence' as const, id: 'presence_server_01' },
  presenceId: 'presence_server_01',
  presenceRegistrationId: 'presence_registration_01',
  authenticatedSessionId: 'authenticated_session_01',
  ownerPolicyRevision: 7,
  authAssurance: 'supabase_verified_session',
  ownerRootRoutingVersion: 2,
});

const captureBody = {
  protocolVersion: '0.2',
  requestId: 'request_capture_01',
  commandType: 'responsibility.capture',
  presenceRegistrationId: 'presence_registration_01',
  clientIssuedAt: '2026-08-06T12:00:00.000Z',
  payload: { userStatement: 'Prepare a reviewable update, but do not publish it.' },
};

function request(body: string | object, headers: Record<string, string> = {}): Request {
  return new Request('https://api.heywaldo.com/public/responsibilities', {
    method: 'POST',
    headers: {
      authorization: 'Bearer session-token',
      accept: 'application/vnd.waldo.responsibility.v0.2+json',
      'content-type': 'application/vnd.waldo.responsibility.v0.2+json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function harness(options: {
  authority?: ResponsibilityAuthority;
  ownerRoot?: ResponsibilityOwnerRoot;
} = {}) {
  const calls: Array<{ ownerId: string; input: unknown }> = [];
  let ownerRootCalls = 0;
  const ownerRoot = options.ownerRoot ?? {
    async capture(input) {
      calls.push({ ownerId: trustedContext.ownerId, input });
      return {
        protocolVersion: '0.2', ownerId: trustedContext.ownerId,
        requestId: captureBody.requestId,
        outcome: {
          id: 'outcome_01', ownerId: trustedContext.ownerId, revision: 1,
          userStatement: captureBody.payload.userStatement, state: 'captured',
          createdAt: '2026-08-06T12:00:01.000Z', updatedAt: '2026-08-06T12:00:01.000Z',
        },
        mission: null, workUnits: [], projectionCursor: 1,
      };
    },
    async readProjection() {
      throw new Error('not used');
    },
  } satisfies ResponsibilityOwnerRoot;
  const adapter = createResponsibilityWorkerAdapter({
    authority: options.authority ?? { authenticate: async () => trustedContext },
    edgeRateLimit: { admit: async () => true },
    failureReporter: { report: () => undefined },
    ownerRootFor: async (context) => {
      ownerRootCalls += 1;
      expect(context).toEqual(trustedContext);
      return ownerRoot;
    },
    now: () => '2026-08-06T12:00:01.000Z',
    newId: (kind) => `${kind}_server_01`,
  });
  return { adapter, calls, ownerRootCalls: () => ownerRootCalls };
}

describe('responsibility Worker adapter', () => {
  it('keeps the production route behind an explicit fail-closed deployment switch', async () => {
    const disabled = await worker.fetch(request(captureBody), {} as Cloudflare.Env);
    expect(disabled.status).toBe(404);
    const unconfigured = await worker.fetch(request(captureBody), {
      RESPONSIBILITY_PUBLIC_API_ENABLED: 'true',
    } as Cloudflare.Env);
    expect(unconfigured.status).toBe(503);
  });

  it('applies the edge rate limit before body parsing or authentication', async () => {
    let authCalls = 0;
    const adapter = createResponsibilityWorkerAdapter({
      authority: { authenticate: async () => { authCalls += 1; return trustedContext; } },
      edgeRateLimit: { admit: async () => false },
      failureReporter: { report: () => undefined },
      ownerRootFor: async () => { throw new Error('must not route'); },
      now: () => '2026-08-06T12:00:01.000Z',
      newId: (kind) => `${kind}_server_01`,
    });
    const response = await adapter.fetch(request('{invalid-json'));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(authCalls).toBe(0);
  });

  it('does not let rotating invalid credentials bypass the trusted edge-source bucket', async () => {
    const first = await responsibilityEdgeRateKey(new Request('https://api.heywaldo.com', {
      headers: { authorization: 'Bearer attacker-token-one', 'cf-connecting-ip': '203.0.113.7' },
    }));
    const second = await responsibilityEdgeRateKey(new Request('https://api.heywaldo.com', {
      headers: { authorization: 'Bearer attacker-token-two', 'cf-connecting-ip': '203.0.113.7' },
    }));
    expect(second).toBe(first);
    await expect(responsibilityEdgeRateKey(new Request('https://api.heywaldo.com')))
      .rejects.toThrow('edge source unavailable');
  });

  it('derives every trusted envelope field from authenticated server context', async () => {
    const { adapter, calls } = harness();
    const response = await adapter.fetch(request(captureBody));

    expect(response.status).toBe(201);
    expect(response.headers.get('waldo-protocol-version')).toBe('0.2');
    expect(await response.json()).toMatchObject({ ownerId: trustedContext.ownerId });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({
      routedOwnerId: trustedContext.ownerId,
      trustedEnvelope: {
        ownerId: trustedContext.ownerId,
        actor: trustedContext.actor,
        presenceId: trustedContext.presenceId,
        authenticatedSessionId: trustedContext.authenticatedSessionId,
        ownerPolicyRevision: trustedContext.ownerPolicyRevision,
        ownerRootRoutingVersion: trustedContext.ownerRootRoutingVersion,
        payload: captureBody.payload,
      },
    });
  });

  it('keeps released v0.1 capture version-pinned without downgrading v0.2', async () => {
    const admissions: unknown[] = [];
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture(input) {
        admissions.push(input);
        return {
          protocolVersion: '0.1', ownerId: trustedContext.ownerId,
          requestId: captureBody.requestId,
          outcome: {
            id: 'outcome_01', ownerId: trustedContext.ownerId, revision: 1,
            userStatement: captureBody.payload.userStatement, state: 'captured',
            createdAt: '2026-08-06T12:00:01.000Z', updatedAt: '2026-08-06T12:00:01.000Z',
          },
          mission: null, workUnits: [], projectionCursor: 1,
        };
      },
      async readProjection() { throw new Error('not used'); },
    };
    const { adapter } = harness({ ownerRoot });
    const response = await adapter.fetch(request({ ...captureBody, protocolVersion: '0.1' }, {
      accept: 'application/vnd.waldo.responsibility.v0.1+json',
      'content-type': 'application/vnd.waldo.responsibility.v0.1+json',
    }));
    expect(response.status).toBe(201);
    expect(response.headers.get('waldo-protocol-version')).toBe('0.1');
    expect(admissions).toEqual([expect.objectContaining({
      trustedEnvelope: expect.objectContaining({ protocolVersion: '0.1' }),
    })]);
  });

  it('validates the owner-root RPC response before public serialization', async () => {
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture() {
        return { protocolVersion: '0.2', ownerId: trustedContext.ownerId, secret: 'leak' };
      },
      async readProjection() { throw new Error('not used'); },
    };
    const { adapter } = harness({ ownerRoot });
    const response = await adapter.fetch(request(captureBody));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret');
  });

  it('maps digest conflicts, stale cursors, and unbound owners without leaking internals', async () => {
    const cases: Array<{ ownerRoot: ResponsibilityOwnerRoot; request: Request; status: number }> = [
      {
        ownerRoot: {
          async capture() { throw new Error('responsibility capture digest conflict: secret'); },
          async readProjection() { throw new Error('not used'); },
        },
        request: request(captureBody), status: 409,
      },
      {
        ownerRoot: {
          async capture() { throw new Error('not used'); },
          async readProjection() { throw new Error('responsibility projection cursor rejected: cursor_ahead'); },
        },
        request: new Request(
          'https://api.heywaldo.com/public/responsibilities/projection?fromExclusiveCursor=1&limit=25&snapshotId=snapshot_01',
          { headers: { authorization: 'Bearer session-token', accept: 'application/vnd.waldo.responsibility.v0.2+json' } },
        ), status: 409,
      },
      {
        ownerRoot: {
          async capture() { throw new Error('not used'); },
          async readProjection() { throw new Error('owner authority root mismatch: owner_secret'); },
        },
        request: new Request(
          'https://api.heywaldo.com/public/responsibilities/projection?fromExclusiveCursor=0&limit=25',
          { headers: { authorization: 'Bearer session-token', accept: 'application/vnd.waldo.responsibility.v0.2+json' } },
        ), status: 404,
      },
    ];
    for (const entry of cases) {
      const { adapter } = harness({ ownerRoot: entry.ownerRoot });
      const response = await adapter.fetch(entry.request);
      expect(response.status).toBe(entry.status);
      expect(JSON.stringify(await response.json())).not.toContain('secret');
    }
  });

  it('preserves exact retry and rejects a changed digest at the HTTP seam', async () => {
    let storedDigest: string | null = null;
    const result = {
      protocolVersion: '0.2', ownerId: trustedContext.ownerId,
      requestId: captureBody.requestId,
      outcome: {
        id: 'outcome_01', ownerId: trustedContext.ownerId, revision: 1,
        userStatement: captureBody.payload.userStatement, state: 'captured',
        createdAt: '2026-08-06T12:00:01.000Z', updatedAt: '2026-08-06T12:00:01.000Z',
      }, mission: null, workUnits: [], projectionCursor: 1,
    };
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture(input) {
        const digest = (input.trustedEnvelope as { requestDigest: string }).requestDigest;
        if (storedDigest !== null && digest !== storedDigest) {
          throw new Error('responsibility capture digest conflict');
        }
        storedDigest = digest;
        return result;
      },
      async readProjection() { throw new Error('not used'); },
    };
    const { adapter } = harness({ ownerRoot });
    const first = await adapter.fetch(request(captureBody));
    expect(first.status).toBe(201);
    await first.text();
    const retry = await adapter.fetch(request(captureBody));
    expect(retry.status).toBe(201);
    await retry.text();
    const conflict = await adapter.fetch(request({
      ...captureBody,
      payload: { userStatement: 'A changed statement under the same request ID.' },
    }));
    expect(conflict.status).toBe(409);
    await conflict.text();
  });

  it.each([
    ['top-level duplicate', '{"protocolVersion":"0.2","protocolVersion":"0.1"}'],
    ['nested duplicate', '{"protocolVersion":"0.2","payload":{"userStatement":"a","userStatement":"b"}}'],
    ['escaped-equivalent duplicate', '{"protocolVersion":"0.2","payload":{"ownerId":"a","\\u006fwnerId":"b"}}'],
    ['unpaired surrogate', JSON.stringify(captureBody).replace('Prepare', '\\ud800Prepare')],
  ])('rejects %s from raw JSON before routing', async (_name, body) => {
    const { adapter, calls } = harness();
    const response = await adapter.fetch(request(body));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
    expect(Object.keys(await response.json()).sort()).toEqual(['code', 'status', 'title', 'type']);
  });

  it('rejects a media/body protocol mismatch instead of downgrading', async () => {
    const { adapter, calls } = harness();
    const response = await adapter.fetch(request({ ...captureBody, protocolVersion: '0.1' }));
    expect(response.status).toBe(406);
    expect(calls).toEqual([]);
  });

  it.each([
    'application/vnd.waldo.responsibility.v0.2+json;q=0',
    'application/vnd.waldo.responsibility.v0.2+json, application/json',
    'application/vnd.waldo.responsibility.v0.1+json;q=1',
  ])('rejects ambiguous or qualified negotiation %s', async (accept) => {
    const { adapter, calls } = harness();
    const response = await adapter.fetch(request(captureBody, { accept }));
    expect(response.status).toBe(406);
    expect(calls).toEqual([]);
  });

  it('uses one non-enumerating denial for absent, expired, revoked, and mismatched presence authority', async () => {
    for (const authenticate of [
      async () => null,
      async () => ({ ...trustedContext, presenceRegistrationId: 'presence_registration_other' }),
    ]) {
      const { adapter, calls } = harness({ authority: { authenticate } });
      const response = await adapter.fetch(request(captureBody));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        type: 'https://api.heywaldo.com/problems/unauthorized',
        title: 'Authentication required',
        status: 401,
        code: 'unauthorized',
      });
      expect(calls).toEqual([]);
    }
  });

  it('rejects server-owned field smuggling without routing', async () => {
    const { adapter, calls } = harness();
    const response = await adapter.fetch(request({ ...captureBody, ownerId: 'owner_attacker' }));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('rejects v0.1 aggregate targeting before owner routing', async () => {
    const { adapter, calls } = harness();
    const response = await adapter.fetch(request({
      ...captureBody,
      protocolVersion: '0.1',
      aggregate: { kind: 'outcome', id: 'outcome_other', expectedRevision: 1 },
    }, {
      accept: 'application/vnd.waldo.responsibility.v0.1+json',
      'content-type': 'application/vnd.waldo.responsibility.v0.1+json',
    }));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('bounds a streamed body before authentication or routing', async () => {
    let authCalls = 0;
    const adapter = createResponsibilityWorkerAdapter({
      authority: { authenticate: async () => { authCalls += 1; return trustedContext; } },
      edgeRateLimit: { admit: async () => true },
      failureReporter: { report: () => undefined },
      ownerRootFor: async () => { throw new Error('must not route'); },
      now: () => '2026-08-06T12:00:01.000Z',
      newId: (kind) => `${kind}_server_01`,
    });
    const response = await adapter.fetch(request('x'.repeat(24_577)));
    expect(response.status).toBe(400);
    expect(authCalls).toBe(0);
  });

  it('rejects unknown projection parameters instead of accepting route substitution', async () => {
    const { adapter, calls, ownerRootCalls } = harness();
    const response = await adapter.fetch(new Request(
      'https://api.heywaldo.com/public/responsibilities/projection?fromExclusiveCursor=0&limit=25&ownerId=owner_attacker',
      { headers: {
        authorization: 'Bearer session-token',
        accept: 'application/vnd.waldo.responsibility.v0.2+json',
      } },
    ));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
    expect(ownerRootCalls()).toBe(0);
  });

  it('rejects duplicate projection parameters instead of choosing an attacker-controlled value', async () => {
    const { adapter, calls, ownerRootCalls } = harness();
    const response = await adapter.fetch(new Request(
      'https://api.heywaldo.com/public/responsibilities/projection?fromExclusiveCursor=0&fromExclusiveCursor=99&limit=25',
      { headers: {
        authorization: 'Bearer session-token',
        accept: 'application/vnd.waldo.responsibility.v0.2+json',
      } },
    ));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
    expect(ownerRootCalls()).toBe(0);
  });

  it('reads only the authenticated owner projection with version-pinned pagination', async () => {
    const reads: unknown[] = [];
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture() { throw new Error('not used'); },
      async readProjection(input) {
        reads.push(input);
        return {
          protocolVersion: '0.1', ownerId: trustedContext.ownerId,
          projectionName: 'responsibility.summary', snapshotId: 'snapshot_01',
          snapshotBaseCursor: 0, fromExclusiveCursor: 0, highWaterCursor: 0,
          nextCursor: 0, items: [], hasMore: false,
          generatedAt: '2026-08-06T12:00:01.000Z',
        };
      },
    };
    const { adapter } = harness({ ownerRoot });
    const response = await adapter.fetch(new Request(
      'https://api.heywaldo.com/public/responsibilities/projection?fromExclusiveCursor=0&limit=25',
      { headers: {
        authorization: 'Bearer session-token',
        accept: 'application/vnd.waldo.responsibility.v0.1+json',
      } },
    ));
    expect(response.status).toBe(200);
    expect(reads).toEqual([{
      routedOwnerId: trustedContext.ownerId,
      protocolVersion: '0.1',
      fromExclusiveCursor: 0,
      limit: 25,
    }]);
  });
});
