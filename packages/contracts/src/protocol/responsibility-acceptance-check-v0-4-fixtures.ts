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

export const RESPONSIBILITY_ACCEPTANCE_CHECK_REJECTION_NAMES_V04 = [
  'client-owned-authority',
  'inline-read-back-payload',
  'unbound-subject-revision',
  'malformed-expected-digest',
  'lone-surrogate-criterion',
  'criterion-byte-ceiling',
  'artifact-check-readback-field',
  'semantic-check-missing-model-version',
  'semantic-check-missing-harness-version',
  'semantic-check-missing-grader-version',
  'semantic-check-missing-evidence-version',
  'semantic-check-missing-independence-disclosure',
  'nullable-negotiation-field',
] as const;

const acceptanceCheckRejectionCasesV04Schema = z.array(z.strictObject({
    name: z.enum(RESPONSIBILITY_ACCEPTANCE_CHECK_REJECTION_NAMES_V04),
    schema: z.literal('acceptance-check.schema.json'),
    layer: z.enum(['schema', 'runtime']),
    value: z.unknown(),
  }))
  .length(RESPONSIBILITY_ACCEPTANCE_CHECK_REJECTION_NAMES_V04.length)
  .superRefine((cases, context) => {
    const names = cases.map((entry) => entry.name);
    for (const [index, expected] of RESPONSIBILITY_ACCEPTANCE_CHECK_REJECTION_NAMES_V04.entries()) {
      if (names[index] !== expected) {
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: `rejection case ${index + 1} must be ${expected}`,
        });
      }
    }
  });

export const responsibilityAcceptanceCheckRejectionCatalogueV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  cases: acceptanceCheckRejectionCasesV04Schema,
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
  if (acceptanceCheck.verificationMethod.kind !== 'deterministic_read_back') {
    throw new Error('default acceptance fixture must retain deterministic read-back');
  }
  const readBackMethod = acceptanceCheck.verificationMethod;

  const artifactAcceptanceCheck = acceptanceCheckV04Schema.parse({
    ...acceptanceCheck,
    id: 'acceptance_check_artifact_fixture_01',
    criterion: 'The approved artifact bytes match the owner-reviewed release.',
    verificationMethod: {
      kind: 'deterministic_artifact_check',
      capability: 'artifact.digest.read',
      artifactRef: 'artifact_release_fixture_01',
      assertion: {
        operator: 'digest_equals',
        expectedDigest: `sha256:${'b'.repeat(64)}`,
      },
    },
  });

  const semanticAcceptanceCheck = acceptanceCheckV04Schema.parse({
    ...acceptanceCheck,
    id: 'acceptance_check_semantic_fixture_01',
    criterion: 'The release note communicates the approved decision and remaining limitation.',
    verificationMethod: {
      kind: 'declared_semantic_check',
      capability: 'artifact.semantic.verify',
      targetRef: 'artifact_release_fixture_01',
      model: { id: 'semantic_model_fixture_01', version: '2026-08-08' },
      harness: { id: 'semantic_harness_fixture_01', version: '0.4.0' },
      grader: { id: 'release_grader_fixture_01', version: '1.0.0' },
      evidence: {
        ref: 'evidence_bundle_fixture_01',
        version: '1.0.0',
        digest: `sha256:${'c'.repeat(64)}`,
      },
      independenceDisclosure: {
        independentFromProducer: true,
        disclosure: {
          ref: 'independence_disclosure_fixture_01',
          digest: `sha256:${'d'.repeat(64)}`,
        },
      },
    },
  });
  if (semanticAcceptanceCheck.verificationMethod.kind !== 'declared_semantic_check') {
    throw new Error('semantic acceptance fixture must retain its declared method');
  }
  const semanticMethod = semanticAcceptanceCheck.verificationMethod;
  const { version: _modelVersion, ...modelWithoutVersion } = semanticMethod.model;
  const { version: _harnessVersion, ...harnessWithoutVersion } = semanticMethod.harness;
  const { version: _graderVersion, ...graderWithoutVersion } = semanticMethod.grader;
  const { version: _evidenceVersion, ...evidenceWithoutVersion } = semanticMethod.evidence;
  const {
    independenceDisclosure: _independenceDisclosure,
    ...semanticWithoutIndependenceDisclosure
  } = semanticMethod;

  const files: Record<string, string> = {
    'acceptance-check.schema.json': file(schema(acceptanceCheckV04Schema, 'acceptance-check')),
    'acceptance-check.valid.json': file(acceptanceCheck),
    'acceptance-check-artifact.valid.json': file(artifactAcceptanceCheck),
    'acceptance-check-semantic.valid.json': file(semanticAcceptanceCheck),
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
                ...readBackMethod,
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
                ...readBackMethod,
                assertion: {
                  ...readBackMethod.assertion,
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
          {
            name: 'artifact-check-readback-field',
            schema: 'acceptance-check.schema.json',
            layer: 'schema',
            value: {
              ...artifactAcceptanceCheck,
              verificationMethod: {
                ...artifactAcceptanceCheck.verificationMethod,
                targetRef: 'read_back_target_not_allowed',
              },
            },
          },
          {
            name: 'semantic-check-missing-model-version',
            schema: 'acceptance-check.schema.json',
            layer: 'schema',
            value: {
              ...semanticAcceptanceCheck,
              verificationMethod: { ...semanticMethod, model: modelWithoutVersion },
            },
          },
          {
            name: 'semantic-check-missing-harness-version',
            schema: 'acceptance-check.schema.json',
            layer: 'schema',
            value: {
              ...semanticAcceptanceCheck,
              verificationMethod: { ...semanticMethod, harness: harnessWithoutVersion },
            },
          },
          {
            name: 'semantic-check-missing-grader-version',
            schema: 'acceptance-check.schema.json',
            layer: 'schema',
            value: {
              ...semanticAcceptanceCheck,
              verificationMethod: { ...semanticMethod, grader: graderWithoutVersion },
            },
          },
          {
            name: 'semantic-check-missing-evidence-version',
            schema: 'acceptance-check.schema.json',
            layer: 'schema',
            value: {
              ...semanticAcceptanceCheck,
              verificationMethod: { ...semanticMethod, evidence: evidenceWithoutVersion },
            },
          },
          {
            name: 'semantic-check-missing-independence-disclosure',
            schema: 'acceptance-check.schema.json',
            layer: 'schema',
            value: {
              ...semanticAcceptanceCheck,
              verificationMethod: semanticWithoutIndependenceDisclosure,
            },
          },
          {
            name: 'nullable-negotiation-field',
            schema: 'acceptance-check.schema.json',
            layer: 'schema',
            value: { ...acceptanceCheck, negotiation: null },
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
