import { z } from 'zod';
import {
  canonicalizeConfirmedOutcomeAcceptanceCriteriaV04ForDigest,
  outcomeObligationContextV04Schema,
} from './responsibility-obligation-context-v0-4';
import { protocolVersionV04Schema } from './responsibility-acceptance-check-v0-4';

type HashHex = (input: string) => string;
const file = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const schema = (value: z.ZodType, name: string) => ({
  ...(z.toJSONSchema(value, { target: 'draft-2020-12', io: 'input', reused: 'ref' }) as object),
  $id: `urn:waldo:protocol:responsibility-obligation-context:0.4:${name}`,
  'x-waldo-validation-level': 'structural-plus-runtime-and-binding-invariants',
  'x-waldo-offline-commands': 'none',
});

export const RESPONSIBILITY_OBLIGATION_CONTEXT_REJECTION_NAMES_V04 = [
  'owner-mismatch',
  'outcome-revision-relabeled',
  'criteria-digest-mismatch',
  'criteria-revision-zero',
  'declared-empty-checks',
  'declared-missing-verification-method',
  'declared-semantic-verification-method',
  'declared-too-many-checks',
  'criterion-provider-done-field',
  'read-back-method-provider-done-field',
  'artifact-method-provider-done-field',
  'criterion-length-2049',
  'absent-hidden-criteria',
  'declined-hidden-criteria',
  'inferred-criteria-field',
  'provider-done-field',
  'effect-receipt-field',
  'artifact-field',
  'evidence-field',
  'verification-field',
  'acceptance-field',
  'closure-field',
  'lone-surrogate-criterion',
] as const;

const obligationContextRejectionCasesV04Schema = z
  .array(
    z.strictObject({
      name: z.enum(RESPONSIBILITY_OBLIGATION_CONTEXT_REJECTION_NAMES_V04),
      schema: z.literal('obligation-context.schema.json'),
      layer: z.enum(['schema', 'runtime', 'binding']),
      zodOutcome: z.enum(['accept', 'reject']),
      expectedError: z.string().min(1).max(256).optional(),
      value: z.unknown(),
    }),
  )
  .length(RESPONSIBILITY_OBLIGATION_CONTEXT_REJECTION_NAMES_V04.length)
  .superRefine((cases, context) => {
    for (const [
      index,
      expected,
    ] of RESPONSIBILITY_OBLIGATION_CONTEXT_REJECTION_NAMES_V04.entries()) {
      if (cases[index]?.name !== expected) {
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: `rejection case ${index + 1} must be ${expected}`,
        });
      }
      if (cases[index]?.layer === 'binding' && cases[index]?.expectedError === undefined) {
        context.addIssue({
          code: 'custom',
          path: [index, 'expectedError'],
          message: 'binding rejection must declare its exact error oracle',
        });
      }
    }
  });

export const responsibilityObligationContextRejectionCatalogueV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  cases: obligationContextRejectionCasesV04Schema,
});

export function buildResponsibilityObligationContextV04Bundle(
  hashHex: HashHex,
): Record<string, string> {
  const declaredCandidate = {
    protocolVersion: '0.4',
    id: 'obligation_context_fixture_01',
    ownerId: 'owner_fixture_01',
    revision: 1,
    outcome: { id: 'outcome_fixture_01', revision: 3 },
    accountability: { kind: 'self' },
    consequence: {
      kind: 'missed_opportunity',
      statementRef: 'consequence_fixture_01',
      statementDigest: `sha256:${'c'.repeat(64)}`,
    },
    temporalBinding: { kind: 'hard_deadline', at: '2026-08-15T18:00:00.000Z' },
    acceptanceCriteria: {
      state: 'confirmed',
      revision: 2,
      digest: `sha256:${'0'.repeat(64)}`,
      checks: [
        {
          id: 'acceptance_check_read_back_fixture_01',
          revision: 1,
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
        },
        {
          id: 'acceptance_check_artifact_fixture_01',
          revision: 1,
          criterion: 'The owner-reviewed release artifact bytes match exactly.',
          verificationMethod: {
            kind: 'deterministic_artifact_check',
            capability: 'artifact.digest.read',
            artifactRef: 'artifact_release_fixture_01',
            assertion: {
              operator: 'digest_equals',
              expectedDigest: `sha256:${'b'.repeat(64)}`,
            },
          },
        },
      ],
    },
    recordedAt: '2026-08-08T18:00:00.000Z',
  } as const;
  const declared = outcomeObligationContextV04Schema.parse({
    ...declaredCandidate,
    acceptanceCriteria: {
      ...declaredCandidate.acceptanceCriteria,
      digest: `sha256:${hashHex(
        canonicalizeConfirmedOutcomeAcceptanceCriteriaV04ForDigest(declaredCandidate),
      )}`,
    },
  });
  if (declared.acceptanceCriteria.state !== 'confirmed') {
    throw new Error('default obligation context must retain confirmed criteria');
  }
  const declaredCriteria = declared.acceptanceCriteria;
  const [readBackCheck, artifactCheck] = declaredCriteria.checks;
  if (
    readBackCheck?.verificationMethod.kind !== 'deterministic_read_back' ||
    artifactCheck?.verificationMethod.kind !== 'deterministic_artifact_check'
  ) {
    throw new Error('default obligation context must retain deterministic criteria methods');
  }
  const { verificationMethod: _method, ...checkWithoutMethod } = readBackCheck;

  const absent = outcomeObligationContextV04Schema.parse({
    ...declared,
    id: 'obligation_context_absent_fixture_01',
    acceptanceCriteria: { state: 'absent_by_owner_choice' },
  });
  const declined = outcomeObligationContextV04Schema.parse({
    ...declared,
    id: 'obligation_context_declined_fixture_01',
    acceptanceCriteria: { state: 'declined' },
  });

  const bindingError = 'obligation context must bind canonical owner and exact Outcome id/revision';
  const digestError = 'confirmed acceptance criteria digest must match canonical criteria bytes';
  const tooManyChecks = Array.from({ length: 17 }, (_, index) => ({
    ...readBackCheck,
    id: `acceptance_check_fixture_${String(index + 1).padStart(2, '0')}`,
  }));

  const files: Record<string, string> = {
    'obligation-context.schema.json': file(
      schema(outcomeObligationContextV04Schema, 'obligation-context'),
    ),
    'obligation-context-confirmed.valid.json': file(declared),
    'obligation-context-absent.valid.json': file(absent),
    'obligation-context-declined.valid.json': file(declined),
    'obligation-context.rejections.json': file(
      responsibilityObligationContextRejectionCatalogueV04Schema.parse({
        protocolVersion: '0.4',
        cases: [
          {
            name: 'owner-mismatch',
            schema: 'obligation-context.schema.json',
            layer: 'binding',
            zodOutcome: 'accept',
            expectedError: bindingError,
            value: { ...declared, ownerId: 'owner_other' },
          },
          {
            name: 'outcome-revision-relabeled',
            schema: 'obligation-context.schema.json',
            layer: 'binding',
            zodOutcome: 'accept',
            expectedError: bindingError,
            value: { ...declared, outcome: { ...declared.outcome, revision: 4 } },
          },
          {
            name: 'criteria-digest-mismatch',
            schema: 'obligation-context.schema.json',
            layer: 'binding',
            zodOutcome: 'accept',
            expectedError: digestError,
            value: {
              ...declared,
              acceptanceCriteria: {
                ...declaredCriteria,
                digest: `sha256:${'f'.repeat(64)}`,
              },
            },
          },
          {
            name: 'criteria-revision-zero',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...declared,
              acceptanceCriteria: { ...declaredCriteria, revision: 0 },
            },
          },
          {
            name: 'declared-empty-checks',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...declared,
              acceptanceCriteria: { ...declaredCriteria, checks: [] },
            },
          },
          {
            name: 'declared-missing-verification-method',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...declared,
              acceptanceCriteria: {
                ...declaredCriteria,
                checks: [checkWithoutMethod],
              },
            },
          },
          {
            name: 'declared-semantic-verification-method',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...declared,
              acceptanceCriteria: {
                ...declaredCriteria,
                checks: [
                  {
                    ...readBackCheck,
                    verificationMethod: {
                      kind: 'declared_semantic_check',
                      capability: 'artifact.semantic.verify',
                    },
                  },
                ],
              },
            },
          },
          {
            name: 'declared-too-many-checks',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...declared,
              acceptanceCriteria: { ...declaredCriteria, checks: tooManyChecks },
            },
          },
          {
            name: 'criterion-provider-done-field',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...declared,
              acceptanceCriteria: {
                ...declaredCriteria,
                checks: [{ ...readBackCheck, providerDone: true }],
              },
            },
          },
          {
            name: 'read-back-method-provider-done-field',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...declared,
              acceptanceCriteria: {
                ...declaredCriteria,
                checks: [
                  {
                    ...readBackCheck,
                    verificationMethod: {
                      ...readBackCheck.verificationMethod,
                      providerDone: true,
                    },
                  },
                ],
              },
            },
          },
          {
            name: 'artifact-method-provider-done-field',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...declared,
              acceptanceCriteria: {
                ...declaredCriteria,
                checks: [
                  {
                    ...artifactCheck,
                    verificationMethod: {
                      ...artifactCheck.verificationMethod,
                      providerDone: true,
                    },
                  },
                ],
              },
            },
          },
          {
            name: 'criterion-length-2049',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...declared,
              acceptanceCriteria: {
                ...declaredCriteria,
                checks: [{ ...readBackCheck, criterion: 'a'.repeat(2_049) }],
              },
            },
          },
          {
            name: 'absent-hidden-criteria',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...absent,
              acceptanceCriteria: { state: 'absent_by_owner_choice', checks: [readBackCheck] },
            },
          },
          {
            name: 'declined-hidden-criteria',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...declined,
              acceptanceCriteria: { state: 'declined', checks: [readBackCheck] },
            },
          },
          {
            name: 'inferred-criteria-field',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: { ...declared, inferredCriteria: ['provider guess'] },
          },
          {
            name: 'provider-done-field',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: { ...declared, providerDone: true },
          },
          {
            name: 'effect-receipt-field',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: { ...declared, effectReceipt: { id: 'effect_receipt_attacker' } },
          },
          {
            name: 'artifact-field',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: { ...declared, artifact: { id: 'artifact_attacker' } },
          },
          {
            name: 'evidence-field',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: { ...declared, evidence: { id: 'evidence_attacker' } },
          },
          {
            name: 'verification-field',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: { ...declared, verification: 'passed' },
          },
          {
            name: 'acceptance-field',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: { ...declared, acceptance: 'accepted' },
          },
          {
            name: 'closure-field',
            schema: 'obligation-context.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: { ...declared, closure: { state: 'closed' } },
          },
          {
            name: 'lone-surrogate-criterion',
            schema: 'obligation-context.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...declared,
              acceptanceCriteria: {
                ...declaredCriteria,
                checks: [{ ...readBackCheck, criterion: '\ud800' }],
              },
            },
          },
        ],
      }),
    ),
  };

  return {
    ...files,
    'manifest.json': file({
      protocolName: 'responsibility-obligation-context',
      protocolVersion: '0.4',
      mediaType: 'application/vnd.waldo.responsibility.v0.4+json',
      offlineCommands: 'none',
      proofLevel: 'adapter_conformance_fixture',
      files: Object.keys(files)
        .sort()
        .map((path) => ({
          path,
          sha256: `sha256:${hashHex(files[path]!)}`,
        })),
    }),
  };
}
