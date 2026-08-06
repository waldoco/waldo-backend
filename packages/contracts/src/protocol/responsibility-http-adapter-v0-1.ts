import { z } from 'zod';

export const responsibilityHttpMediaTypeV01 =
  'application/vnd.waldo.responsibility.v0.1+json' as const;
export const responsibilityHttpMediaTypeV02 =
  'application/vnd.waldo.responsibility.v0.2+json' as const;

export const responsibilityHttpCapabilitiesV01Schema = z.strictObject({
  protocolName: z.literal('responsibility-handshake'),
  supportedVersions: z.tuple([z.literal('0.1'), z.literal('0.2')]),
  selectedVersion: z.enum(['0.1', '0.2']),
  offlineCommands: z.literal('none'),
});

const contentFreeProblem = <
  Status extends 400 | 401 | 404 | 406 | 409 | 429 | 500 | 503,
  Code extends string,
>(status: Status, code: Code, kind: string, title: string) => z.strictObject({
  type: z.literal(`https://api.heywaldo.com/problems/${kind}`),
  title: z.literal(title),
  status: z.literal(status),
  code: z.literal(code),
});

const responsibilityHttpProblemsV01 = {
  400: { code: 'invalid_request', kind: 'invalid-request', title: 'Request rejected' },
  401: { code: 'unauthorized', kind: 'unauthorized', title: 'Authentication required' },
  404: { code: 'not_found', kind: 'not-found', title: 'Resource not found' },
  406: { code: 'not_acceptable', kind: 'not-acceptable', title: 'Unsupported representation' },
  409: { code: 'request_conflict', kind: 'request-conflict', title: 'Request conflict' },
  429: { code: 'rate_limited', kind: 'rate-limited', title: 'Rate limited' },
  500: { code: 'internal_error', kind: 'internal-error', title: 'Internal error' },
  503: {
    code: 'temporarily_unavailable',
    kind: 'temporarily-unavailable',
    title: 'Temporarily unavailable',
  },
} as const;

function problemSchema<Status extends keyof typeof responsibilityHttpProblemsV01>(
  status: Status,
) {
  const descriptor = responsibilityHttpProblemsV01[status];
  return contentFreeProblem(status, descriptor.code, descriptor.kind, descriptor.title);
}

export const responsibilityHttpProblemV01Schema = z.discriminatedUnion('status', [
  problemSchema(400),
  problemSchema(401),
  problemSchema(404),
  problemSchema(406),
  problemSchema(409),
  problemSchema(429),
  problemSchema(500),
  problemSchema(503),
]);

export type ResponsibilityHttpProblemV01 = z.infer<
  typeof responsibilityHttpProblemV01Schema
>;

const fixtureHeadersSchema = z.record(z.string().min(1), z.string()).superRefine(
  (headers, context) => {
    if (Object.keys(headers).some((name) => name !== name.toLowerCase())) {
      context.addIssue({ code: 'custom', message: 'fixture header names must be lowercase' });
    }
  },
);
const fixtureRequestFields = {
  method: z.enum(['GET', 'POST']),
  path: z.string().min(1).max(1_024).startsWith('/public/responsibilities'),
  headers: fixtureHeadersSchema,
} as const;
const fixtureRequestSchema = z.union([
  z.strictObject({ ...fixtureRequestFields, bodyUtf8: z.string().max(65_536) }),
  z.strictObject({
    ...fixtureRequestFields,
    bodyBase64: z.string().min(4).max(90_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
  z.strictObject(fixtureRequestFields),
]);

export const responsibilityHttpFixtureManifestV01Schema = z.strictObject({
  adapterContractVersion: z.literal('0.1'),
  responsibilityProtocolVersions: z.tuple([z.literal('0.1'), z.literal('0.2')]),
  offlineCommands: z.literal('none'),
  proofLevel: z.literal('adapter_conformance_fixture'),
  files: z.array(z.strictObject({
    path: z.string().min(1).max(128),
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })).length(4),
});

export const responsibilityHttpProjectionFixturesV01Schema = z.strictObject({
  cases: z.tuple([
    z.strictObject({
      protocolVersion: z.literal('0.1'),
      query: z.literal('fromExclusiveCursor=0&limit=25'),
    }),
    z.strictObject({
      protocolVersion: z.literal('0.2'),
      query: z.literal('fromExclusiveCursor=14&limit=25&snapshotId=snapshot_01'),
    }),
  ]),
});

export const responsibilityHttpRejectionFixturesV01Schema = z.strictObject({
  cases: z.array(z.strictObject({
    name: z.enum([
      'duplicate-key',
      'malformed-unicode',
      'server-owned-field',
      'protocol-downgrade',
      'missing-or-revoked-auth',
      'wrong-owner-root',
      'digest-conflict',
      'stale-snapshot-or-cursor',
      'rate-limited',
    ]),
    request: fixtureRequestSchema,
    harnessState: z.enum([
      'allow',
      'auth_denied',
      'owner_root_mismatch',
      'digest_conflict',
      'cursor_rejected',
      'rate_limited',
    ]),
    expected: z.strictObject({
      status: z.union([
        z.literal(400), z.literal(401), z.literal(404), z.literal(406),
        z.literal(409), z.literal(429), z.literal(500), z.literal(503),
      ]),
      problem: responsibilityHttpProblemV01Schema,
    }),
  }).superRefine((fixture, context) => {
    if (fixture.request.method === 'POST' &&
        !('bodyUtf8' in fixture.request) && !('bodyBase64' in fixture.request)) {
      context.addIssue({ code: 'custom', message: 'POST fixture requires exact body bytes' });
    }
    if (fixture.expected.status !== fixture.expected.problem.status) {
      context.addIssue({ code: 'custom', message: 'fixture status and problem must match' });
    }
  })).length(9),
});

export type ResponsibilityHttpFixtureManifestV01 = z.infer<
  typeof responsibilityHttpFixtureManifestV01Schema
>;
export type ResponsibilityHttpProjectionFixturesV01 = z.infer<
  typeof responsibilityHttpProjectionFixturesV01Schema
>;
export type ResponsibilityHttpRejectionFixturesV01 = z.infer<
  typeof responsibilityHttpRejectionFixturesV01Schema
>;

export function responsibilityHttpProblemV01(
  status: ResponsibilityHttpProblemV01['status'],
): ResponsibilityHttpProblemV01 {
  const descriptor = responsibilityHttpProblemsV01[status];
  return responsibilityHttpProblemV01Schema.parse({
    type: `https://api.heywaldo.com/problems/${descriptor.kind}`,
    title: descriptor.title,
    status,
    code: descriptor.code,
  });
}
