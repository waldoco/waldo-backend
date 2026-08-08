import { z } from 'zod';
import {
  acceptanceCheckV04Schema,
  protocolVersionV04Schema,
} from './responsibility-acceptance-check-v0-4';

type HashHex = (input: string) => string;
const file = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const schema = (value: z.ZodType, name: string) => ({
  ...(z.toJSONSchema(value, { target: 'draft-2020-12', io: 'input', reused: 'ref' }) as object),
  $id: `urn:waldo:protocol:responsibility-acceptance-check:0.4:${name}`,
  'x-waldo-validation-level': 'structural-plus-runtime-invariants',
  'x-waldo-offline-commands': 'none',
});

export const responsibilityAcceptanceCheckRejectionCatalogueV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  cases: z.array(z.strictObject({
    name: z.enum([
      'client-owned-authority',
      'inline-read-back-payload',
      'unbound-subject-revision',
      'malformed-expected-digest',
      'lone-surrogate-criterion',
      'criterion-byte-ceiling',
    ]),
    schema: z.literal('acceptance-check.schema.json'),
    layer: z.enum(['schema', 'runtime']),
    value: z.unknown(),
  })).length(6),
});

export function buildResponsibilityAcceptanceCheckV04Bundle(
  hashHex: HashHex,
): Record<string, string> {
  const acceptanceCheck = acceptanceCheckV04Schema.parse({
    protocolVersion: '0.4',
    id: 'acceptance_check_fixture_01',
    ownerId: 'owner_fixture_01',
    revision: 1,
    subject: { kind: 'outcome', id: 'outcome_fixture_01', revision: 3 },
    criterion: 'The calendar contains the approved investor meeting.',
    verificationMethod: {
      kind: 'deterministic_read_back',
      capability: 'calendar.event.read',
      targetRef: 'calendar_event_target_fixture_01',
      assertion: {
        operator: 'digest_equals',
        expectedDigest: `sha256:${'a'.repeat(64)}`,
      },
    },
    createdAt: '2026-08-08T18:00:00.000Z',
  });

  const files: Record<string, string> = {
    'acceptance-check.schema.json': file(schema(acceptanceCheckV04Schema, 'acceptance-check')),
    'acceptance-check.valid.json': file(acceptanceCheck),
    'acceptance-check.rejections.json': file(
      responsibilityAcceptanceCheckRejectionCatalogueV04Schema.parse({
        protocolVersion: '0.4',
        cases: [
          {
            name: 'client-owned-authority',
            schema: 'acceptance-check.schema.json',
            layer: 'schema',
            value: { ...acceptanceCheck, authorityGrant: { id: 'grant_attacker' } },
          },
          {
            name: 'inline-read-back-payload',
            schema: 'acceptance-check.schema.json',
            layer: 'schema',
            value: {
              ...acceptanceCheck,
              verificationMethod: {
                ...acceptanceCheck.verificationMethod,
                readBackPayload: { title: 'private inline content' },
              },
            },
          },
          {
            name: 'unbound-subject-revision',
            schema: 'acceptance-check.schema.json',
            layer: 'schema',
            value: { ...acceptanceCheck, subject: { ...acceptanceCheck.subject, revision: 0 } },
          },
          {
            name: 'malformed-expected-digest',
            schema: 'acceptance-check.schema.json',
            layer: 'schema',
            value: {
              ...acceptanceCheck,
              verificationMethod: {
                ...acceptanceCheck.verificationMethod,
                assertion: {
                  ...acceptanceCheck.verificationMethod.assertion,
                  expectedDigest: 'approved',
                },
              },
            },
          },
          {
            name: 'lone-surrogate-criterion',
            schema: 'acceptance-check.schema.json',
            layer: 'runtime',
            value: { ...acceptanceCheck, criterion: '\ud800' },
          },
          {
            name: 'criterion-byte-ceiling',
            schema: 'acceptance-check.schema.json',
            layer: 'runtime',
            value: { ...acceptanceCheck, criterion: '界'.repeat(2_048) },
          },
        ],
      }),
    ),
  };
  return {
    ...files,
    'manifest.json': file({
      protocolName: 'responsibility-acceptance-check',
      protocolVersion: '0.4',
      mediaType: 'application/vnd.waldo.responsibility.v0.4+json',
      offlineCommands: 'none',
      proofLevel: 'adapter_conformance_fixture',
      files: Object.keys(files).sort().map((path) => ({
        path,
        sha256: `sha256:${hashHex(files[path]!)}`,
      })),
    }),
  };
}
