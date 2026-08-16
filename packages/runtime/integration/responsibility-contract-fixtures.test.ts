import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  canonicalizeResponsibilityCaptureRequestV02ForDigest,
  canonicalizeSurfaceCommandRequestForDigest,
  responsibilityCaptureRequestSchema,
  responsibilityCaptureRequestV02Schema,
  responsibilityHttpFixtureManifestV01Schema,
  responsibilityHttpProjectionFixturesV01Schema,
  responsibilityHttpRejectionFixturesV01Schema,
  type ResponsibilityHttpRejectionFixturesV01,
} from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import {
  ResponsibilityDigestConflictError,
  ResponsibilityIngressRateLimitError,
  ResponsibilityOwnerRootMismatchError,
  ResponsibilityProjectionCursorError,
} from '../src/responsibility/errors';
import {
  createResponsibilityWorkerAdapter,
  type ResponsibilityOwnerRoot,
  type TrustedResponsibilityContext,
} from '../src/responsibility/worker-adapter';

const FIXTURE_DIRECTORY = new URL(
  '../../contracts/fixtures/responsibility-http-adapter/v0.1/',
  import.meta.url,
);
const MEDIA_TYPES = {
  '0.1': 'application/vnd.waldo.responsibility.v0.1+json',
  '0.2': 'application/vnd.waldo.responsibility.v0.2+json',
} as const;
const trustedContext: TrustedResponsibilityContext = Object.freeze({
  ownerId: 'owner_fixture_01',
  authenticatedSubjectRef: `supabase_subject_${'a'.repeat(64)}`,
  actor: Object.freeze({ kind: 'presence', id: 'presence_fixture_01' }),
  presenceId: 'presence_fixture_01',
  presenceRegistrationId: 'presence_registration_01',
  authenticatedSessionId: `authenticated_session_${'b'.repeat(64)}`,
  authenticatedSessionExpiresAt: '2099-08-06T13:00:00.000Z',
  ownerPolicyRevision: 7,
  authAssurance: 'supabase_verified_session',
  ownerRootRoutingVersion: 2,
});
const manifest = responsibilityHttpFixtureManifestV01Schema.parse(
  JSON.parse(readFileSync(new URL('manifest.json', FIXTURE_DIRECTORY), 'utf8')),
);

type HarnessState = ResponsibilityHttpRejectionFixturesV01['cases'][number]['harnessState'];

function readFixture<T>(name: string): T {
  const entry = manifest.files.find((candidate) => candidate.path === name);
  if (entry === undefined) throw new Error(`fixture is not pinned: ${name}`);
  const bytes = readFileSync(new URL(name, FIXTURE_DIRECTORY));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== entry.sha256) throw new Error(`fixture digest mismatch: ${name}`);
  return JSON.parse(bytes.toString('utf8')) as T;
}

function adapterFor(state: HarnessState, calls: unknown[]) {
  const ownerRoot: ResponsibilityOwnerRoot = {
    async capture(input, ingress) {
      calls.push({ kind: 'capture', input, ingress });
      if (state === 'owner_root_mismatch') throw new ResponsibilityOwnerRootMismatchError();
      if (state === 'digest_conflict') throw new ResponsibilityDigestConflictError();
      const request = input.request as {
        protocolVersion: '0.1' | '0.2';
        requestId: string;
        payload: { userStatement: string };
      };
      const base = {
        protocolVersion: request.protocolVersion,
        ownerId: trustedContext.ownerId,
        requestId: request.requestId,
        outcome: {
          id: 'outcome_fixture_01', ownerId: trustedContext.ownerId, revision: 1,
          userStatement: request.payload.userStatement, state: 'captured',
          createdAt: '2026-08-06T12:00:01.000Z',
          updatedAt: '2026-08-06T12:00:01.000Z',
        },
        mission: null,
        workUnits: [],
        projectionCursor: 1,
      };
      return base;
    },
    async readProjection(input, ingress) {
      calls.push({ kind: 'projection', input, ingress });
      if (state === 'cursor_rejected') {
        throw new ResponsibilityProjectionCursorError('snapshot_replaced');
      }
      if (state === 'rate_limited') throw new ResponsibilityIngressRateLimitError();
      return {
        protocolVersion: input.protocolVersion ?? '0.2',
        ownerId: trustedContext.ownerId,
        projectionName: 'responsibility.summary',
        snapshotId: input.snapshotId ?? 'snapshot_fixture_01',
        snapshotBaseCursor: input.fromExclusiveCursor,
        fromExclusiveCursor: input.fromExclusiveCursor,
        highWaterCursor: input.fromExclusiveCursor,
        nextCursor: input.fromExclusiveCursor,
        items: [], hasMore: false, generatedAt: '2026-08-06T12:00:01.000Z',
      };
    },
  };
  return createResponsibilityWorkerAdapter({
    authority: { authenticate: async () => state === 'auth_denied' ? null : trustedContext },
    edgeRateLimit: { admit: async () => true },
    failureReporter: {
      report: (code, error) => calls.push({
        kind: 'failure', code,
        error: error instanceof Error ? `${error.name}:${error.message}` : String(error),
      }),
    },
    ownerRootFor: async () => ownerRoot,
    now: () => '2026-08-06T12:00:01.000Z',
    newId: (kind) => `${kind}_fixture_01`,
  });
}

describe('responsibility HTTP adapter v0.1 executable fixtures', () => {
  it('executes only the strict hash-pinned manifest inventory', () => {
    expect(manifest.files.map((entry) => entry.path)).toEqual([
      'capture-v0.1.valid.json',
      'capture-v0.2.valid.json',
      'projection-queries.valid.json',
      'rejections.json',
    ]);
    for (const entry of manifest.files) readFixture(entry.path);
  });

  it('executes both version-pinned capture bodies', async () => {
    for (const version of ['0.1', '0.2'] as const) {
      const body = version === '0.1'
        ? responsibilityCaptureRequestSchema.parse(readFixture(`capture-v${version}.valid.json`))
        : responsibilityCaptureRequestV02Schema.parse(readFixture(`capture-v${version}.valid.json`));
      const calls: unknown[] = [];
      const response = await adapterFor('allow', calls).fetch(new Request(
        'https://api.heywaldo.com/public/responsibilities',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer fixture-token',
            accept: MEDIA_TYPES[version],
            'content-type': MEDIA_TYPES[version],
          },
          body: JSON.stringify(body),
        },
      ));
      expect(response.status, JSON.stringify(calls)).toBe(201);
      const canonical = version === '0.1'
        ? canonicalizeSurfaceCommandRequestForDigest(body)
        : canonicalizeResponsibilityCaptureRequestV02ForDigest(body);
      const requestDigest = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
      expect(calls).toEqual([{
        kind: 'capture',
        input: {
          routedOwnerId: trustedContext.ownerId,
          request: body,
          trustedEnvelope: {
            protocolVersion: version,
            commandId: 'command_fixture_01',
            commandType: 'responsibility.capture',
            ownerId: trustedContext.ownerId,
            actor: trustedContext.actor,
            presenceId: trustedContext.presenceId,
            authenticatedSessionId: trustedContext.authenticatedSessionId,
            ownerPolicyRevision: trustedContext.ownerPolicyRevision,
            authAssurance: trustedContext.authAssurance,
            ownerRootRoutingVersion: trustedContext.ownerRootRoutingVersion,
            requestDigest,
            correlationId: 'correlation_fixture_01',
            receivedAt: '2026-08-06T12:00:01.000Z',
            payload: body.payload,
          },
        },
        ingress: {
          authenticatedSubjectRef: trustedContext.authenticatedSubjectRef,
          authenticatedSessionId: trustedContext.authenticatedSessionId,
          authenticatedSessionExpiresAt: trustedContext.authenticatedSessionExpiresAt,
          ownerPolicyRevision: trustedContext.ownerPolicyRevision,
          authAssurance: trustedContext.authAssurance,
        },
      }]);
      expect(await response.json()).toEqual({
        protocolVersion: version,
        ownerId: trustedContext.ownerId,
        requestId: body.requestId,
        outcome: {
          id: 'outcome_fixture_01', ownerId: trustedContext.ownerId, revision: 1,
          userStatement: body.payload.userStatement, state: 'captured',
          createdAt: '2026-08-06T12:00:01.000Z',
          updatedAt: '2026-08-06T12:00:01.000Z',
        },
        mission: null,
        workUnits: [],
        projectionCursor: 1,
      });
    }
  });

  it('executes every version-pinned projection query', async () => {
    const fixtures = responsibilityHttpProjectionFixturesV01Schema.parse(
      readFixture('projection-queries.valid.json'),
    );
    for (const fixture of fixtures.cases) {
      const calls: unknown[] = [];
      const response = await adapterFor('allow', calls).fetch(new Request(
        `https://api.heywaldo.com/public/responsibilities/projection?${fixture.query}`,
        { headers: {
          authorization: 'Bearer fixture-token',
          accept: MEDIA_TYPES[fixture.protocolVersion],
        } },
      ));
      expect(response.status).toBe(200);
      const parameters = new URLSearchParams(fixture.query);
      expect(calls).toEqual([{
        kind: 'projection',
        input: {
          routedOwnerId: trustedContext.ownerId,
          protocolVersion: fixture.protocolVersion,
          fromExclusiveCursor: Number(parameters.get('fromExclusiveCursor')),
          limit: Number(parameters.get('limit')),
          ...(parameters.get('snapshotId') === null
            ? {} : { snapshotId: parameters.get('snapshotId') }),
        },
        ingress: {
          authenticatedSubjectRef: trustedContext.authenticatedSubjectRef,
          authenticatedSessionId: trustedContext.authenticatedSessionId,
          authenticatedSessionExpiresAt: trustedContext.authenticatedSessionExpiresAt,
          ownerPolicyRevision: trustedContext.ownerPolicyRevision,
          authAssurance: trustedContext.authAssurance,
        },
      }]);
      const cursor = Number(parameters.get('fromExclusiveCursor'));
      expect(await response.json()).toEqual({
        protocolVersion: fixture.protocolVersion,
        ownerId: trustedContext.ownerId,
        projectionName: 'responsibility.summary',
        snapshotId: parameters.get('snapshotId') ?? 'snapshot_fixture_01',
        snapshotBaseCursor: cursor,
        fromExclusiveCursor: cursor,
        highWaterCursor: cursor,
        nextCursor: cursor,
        items: [], hasMore: false, generatedAt: '2026-08-06T12:00:01.000Z',
      });
    }
  });

  it('executes raw rejection requests and exact public problem responses', async () => {
    const fixtures = responsibilityHttpRejectionFixturesV01Schema.parse(
      readFixture('rejections.json'),
    );
    for (const fixture of fixtures.cases) {
      const calls: unknown[] = [];
      const body = 'bodyBase64' in fixture.request
        ? Buffer.from(fixture.request.bodyBase64, 'base64')
        : ('bodyUtf8' in fixture.request ? fixture.request.bodyUtf8 : undefined);
      if (fixture.name === 'duplicate-key') {
        if (!('bodyUtf8' in fixture.request)) throw new Error('fixture drift');
        expect(responsibilityCaptureRequestV02Schema.safeParse(
          JSON.parse(fixture.request.bodyUtf8),
        ).success).toBe(true);
      }
      if (fixture.name === 'malformed-unicode') {
        if (!Buffer.isBuffer(body)) throw new Error('fixture drift');
        expect(responsibilityCaptureRequestV02Schema.safeParse(
          JSON.parse(new TextDecoder().decode(body)),
        ).success).toBe(true);
      }
      const response = await adapterFor(fixture.harnessState, calls).fetch(new Request(
        `https://api.heywaldo.com${fixture.request.path}`,
        {
          method: fixture.request.method,
          headers: fixture.request.headers,
          body,
        },
      ));
      expect(response.status, fixture.name).toBe(fixture.expected.status);
      expect(await response.json(), fixture.name).toEqual(fixture.expected.problem);
    }
  });
});
