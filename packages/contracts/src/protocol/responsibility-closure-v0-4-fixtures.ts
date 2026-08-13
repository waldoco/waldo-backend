import { z } from 'zod';
import {
  acceptanceCommandRequestV04Schema,
  acceptanceV04Schema,
  candidateEvidenceSubmissionV04Schema,
  evidenceV04Schema,
  verificationV04Schema,
} from './responsibility-closure-v0-4';
const file = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const schema = (v: z.ZodType, n: string) => ({
  ...(z.toJSONSchema(v, { target: 'draft-2020-12', io: 'input', reused: 'ref' }) as object),
  $id: `urn:waldo:protocol:responsibility-closure:0.4:${n}`,
  'x-waldo-validation-level': 'structural-plus-runtime-invariants',
});
export function buildResponsibilityClosureV04Bundle(
  hashHex: (value: string) => string,
): Record<string, string> {
  const digest = `sha256:${hashHex('fixture')}`;
  const subject = { kind: 'work_unit', id: 'work_fixture', revision: 1 } as const;
  const candidate = candidateEvidenceSubmissionV04Schema.parse({
    protocolVersion: '0.4',
    submissionId: 'submission_fixture',
    source: { kind: 'provider', id: 'provider_fixture', version: '1.0.0' },
    subject,
    acceptanceCheckId: 'check_fixture',
    claim: { ref: 'claim_fixture', digest },
    artifactRefs: [],
    observedAt: '2026-08-13T12:00:00.000Z',
  });
  const evidence = evidenceV04Schema.parse({
    protocolVersion: '0.4',
    id: 'evidence_fixture',
    ownerId: 'owner_fixture',
    revision: 1,
    subject,
    acceptanceCheckId: 'check_fixture',
    acceptanceCheckRevision: 1,
    claimRef: 'claim_fixture',
    claimDigest: digest,
    source: candidate.source,
    artifactRefs: [],
    state: 'admitted',
    admittedAt: '2026-08-13T12:01:00.000Z',
  });
  const verification = verificationV04Schema.parse({
    protocolVersion: '0.4',
    id: 'verification_fixture',
    ownerId: 'owner_fixture',
    revision: 1,
    outcome: { id: 'outcome_fixture', revision: 1 },
    acceptanceCheck: { id: 'check_fixture', revision: 1, digest },
    evidence: [{ id: evidence.id, revision: 1, digest }],
    evidenceSetDigest: digest,
    verifier: {
      id: 'verifier_fixture',
      version: '1.0.0',
      availability: 'unavailable',
      independentFromProducer: true,
      disclosureRef: 'disclosure_fixture',
    },
    methodVersion: '1.0.0',
    state: 'indeterminate',
    findings: null,
    verifiedAt: '2026-08-13T12:02:00.000Z',
  });
  const acceptance = acceptanceV04Schema.parse({
    protocolVersion: '0.4',
    id: 'acceptance_fixture',
    ownerId: 'owner_fixture',
    revision: 1,
    outcome: { id: 'outcome_fixture', revision: 1 },
    evidenceSetDigest: digest,
    verificationIds: [verification.id],
    actor: { kind: 'owner', id: 'owner_fixture' },
    mode: 'explicit_owner',
    delegatedPolicy: null,
    decision: 'accepted',
    reasonRef: null,
    recordedAt: '2026-08-13T12:03:00.000Z',
  });
  const delegatedAcceptance = acceptanceV04Schema.parse({
    ...acceptance,
    id: 'delegated_acceptance_fixture',
    actor: { kind: 'service', id: 'acceptance_policy_service_fixture' },
    mode: 'delegated_policy',
    delegatedPolicy: { id: 'acceptance_policy_fixture', revision: 1, digest },
  });
  const acceptanceCommand = acceptanceCommandRequestV04Schema.parse({
    protocolVersion: '0.4',
    requestId: 'acceptance_request_fixture',
    commandType: 'acceptance.record',
    presenceRegistrationId: 'presence_fixture',
    aggregate: { kind: 'outcome', id: 'outcome_fixture', expectedRevision: 1 },
    decision: 'accept',
    evidenceSetDigest: digest,
    verificationIds: [verification.id],
    reasonRef: null,
    clientIssuedAt: '2026-08-13T12:03:00.000Z',
  });
  const valid = {
    'candidate-evidence.valid.json': candidate,
    'evidence.valid.json': evidence,
    'verification-indeterminate.valid.json': verification,
    'acceptance.valid.json': acceptance,
    'acceptance-delegated.valid.json': delegatedAcceptance,
    'acceptance-command-request.valid.json': acceptanceCommand,
  };
  const schemas = {
    'candidate-evidence': candidateEvidenceSubmissionV04Schema,
    evidence: evidenceV04Schema,
    verification: verificationV04Schema,
    acceptance: acceptanceV04Schema,
    'acceptance-command-request': acceptanceCommandRequestV04Schema,
  };
  const bundle: Record<string, string> = {};
  for (const [n, v] of Object.entries(schemas)) bundle[`${n}.schema.json`] = file(schema(v, n));
  for (const [p, v] of Object.entries(valid)) bundle[p] = file(v);
  bundle['closure.rejections.json'] = file({
    protocolVersion: '0.4',
    cases: [
      { name: 'provider-self-acceptance', value: { ...candidate, acceptance: 'accepted' } },
      { name: 'unavailable-as-passed', value: { ...verification, state: 'passed' } },
      { name: 'inline-evidence', value: { ...candidate, inlineEvidence: { secret: true } } },
      {
        name: 'provider-explicit-acceptance',
        value: { ...acceptance, actor: { kind: 'provider', id: 'provider_fixture' } },
      },
      {
        name: 'delegated-without-policy',
        value: {
          ...acceptance,
          mode: 'delegated_policy',
          actor: { kind: 'service', id: 'service_fixture' },
        },
      },
      {
        name: 'acceptance-command-client-authority',
        value: { ...acceptanceCommand, authorityGrant: 'grant_attacker' },
      },
    ],
  });
  bundle['manifest.json'] = file({
    protocolVersion: '0.4',
    family: 'responsibility-closure',
    files: Object.fromEntries(Object.entries(bundle).map(([p, v]) => [p, `sha256:${hashHex(v)}`])),
  });
  return bundle;
}
