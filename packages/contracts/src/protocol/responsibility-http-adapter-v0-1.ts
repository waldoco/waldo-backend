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

export const responsibilityHttpProblemV01Schema = z.discriminatedUnion('status', [
  contentFreeProblem(400, 'invalid_request', 'invalid-request', 'Request rejected'),
  contentFreeProblem(401, 'unauthorized', 'unauthorized', 'Authentication required'),
  contentFreeProblem(404, 'not_found', 'not-found', 'Resource not found'),
  contentFreeProblem(406, 'not_acceptable', 'not-acceptable', 'Unsupported representation'),
  contentFreeProblem(409, 'request_conflict', 'request-conflict', 'Request conflict'),
  contentFreeProblem(429, 'rate_limited', 'rate-limited', 'Rate limited'),
  contentFreeProblem(500, 'internal_error', 'internal-error', 'Internal error'),
  contentFreeProblem(
    503,
    'temporarily_unavailable',
    'temporarily-unavailable',
    'Temporarily unavailable',
  ),
]);

export type ResponsibilityHttpProblemV01 = z.infer<
  typeof responsibilityHttpProblemV01Schema
>;
