import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { candidateEvidenceSubmissionV04Schema, verificationV04Schema, acceptanceCommandRequestV04Schema } from './responsibility-closure-v0-4';

const digest = `sha256:${'c'.repeat(64)}`;
const candidate = { protocolVersion: '0.4', submissionId: 'submission', source: { kind: 'provider', id: 'provider', version: '1.0.0' },
  subject: { kind: 'work_unit', id: 'work', revision: 1 }, acceptanceCheckId: 'check', claim: { ref: 'claim', digest },
  artifactRefs: [], observedAt: '2026-08-13T12:00:00.000Z' };
const verification = { protocolVersion: '0.4', id: 'verification', ownerId: 'owner', revision: 1,
  outcome: { id: 'outcome', revision: 1 }, acceptanceCheck: { id: 'check', revision: 1, digest },
  evidence: [{ id: 'evidence', revision: 1, digest }], evidenceSetDigest: digest,
  verifier: { id: 'verifier', version: '1.0.0', independentFromProducer: true, disclosureRef: 'disclosure' },
  methodVersion: '1.0.0', state: 'indeterminate', findingsRef: null, findingsDigest: null,
  verifiedAt: '2026-08-13T12:01:00.000Z' };

describe('responsibility closure v0.4', () => {
  it('round-trips candidate evidence without admitting or accepting it', () => {
    expect(candidateEvidenceSubmissionV04Schema.parse(candidate).source.kind).toBe('provider');
    for (const field of ['ownerId', 'authorityGrant', 'accepted', 'outcomeState', 'openLoopState', 'inlineEvidence', 'credential', 'rawHealth', 'fullTranscript', 'composedPrompt']) {
      expect(candidateEvidenceSubmissionV04Schema.safeParse({ ...candidate, [field]: 'forbidden' }).success).toBe(false);
    }
  });
  it('represents unavailable verification only as indeterminate', () => {
    expect(verificationV04Schema.parse(verification).state).toBe('indeterminate');
    expect(verificationV04Schema.safeParse({ ...verification, state: 'unavailable' }).success).toBe(false);
  });
  it('requires acceptance to be an explicit separate command', () => {
    const request = { protocolVersion: '0.4', requestId: 'request', commandType: 'acceptance.record', presenceRegistrationId: 'presence',
      aggregate: { kind: 'outcome', id: 'outcome', expectedRevision: 1 }, decision: 'accept', evidenceSetDigest: digest,
      verificationIds: ['verification'], reasonRef: null, clientIssuedAt: '2026-08-13T12:02:00.000Z' };
    expect(acceptanceCommandRequestV04Schema.parse(request).decision).toBe('accept');
    expect(acceptanceCommandRequestV04Schema.safeParse({ ...request, authorityGrant: 'client' }).success).toBe(false);
  });
  it('compiles verification JSON Schema', () => {
    expect(new Ajv2020({ strict: false }).compile(verificationV04Schema.toJSONSchema())(verification)).toBe(true);
  });
});
