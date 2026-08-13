import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { buildResponsibilityClosureV04Bundle } from './responsibility-closure-v0-4-fixtures';
import {
  acceptanceMatchesAuthorityV04,
  acceptanceV04Schema,
  candidateEvidenceSubmissionV04Schema,
  verificationV04Schema,
  acceptanceCommandRequestV04Schema,
} from './responsibility-closure-v0-4';

const digest = `sha256:${'c'.repeat(64)}`;
const candidate = {
  protocolVersion: '0.4',
  submissionId: 'submission',
  source: { kind: 'provider', id: 'provider', version: '1.0.0' },
  subject: { kind: 'work_unit', id: 'work', revision: 1 },
  acceptanceCheckId: 'check',
  claim: { ref: 'claim', digest },
  artifactRefs: [],
  observedAt: '2026-08-13T12:00:00.000Z',
};
const verification = {
  protocolVersion: '0.4',
  id: 'verification',
  ownerId: 'owner',
  revision: 1,
  outcome: { id: 'outcome', revision: 1 },
  acceptanceCheck: { id: 'check', revision: 1, digest },
  evidence: [{ id: 'evidence', revision: 1, digest }],
  evidenceSetDigest: digest,
  verifier: {
    id: 'verifier',
    version: '1.0.0',
    availability: 'unavailable',
    independentFromProducer: true,
    disclosureRef: 'disclosure',
  },
  methodVersion: '1.0.0',
  state: 'indeterminate',
  findings: null,
  verifiedAt: '2026-08-13T12:01:00.000Z',
};

describe('responsibility closure v0.4', () => {
  it('round-trips candidate evidence without admitting or accepting it', () => {
    expect(candidateEvidenceSubmissionV04Schema.parse(candidate).source.kind).toBe('provider');
    for (const field of [
      'ownerId',
      'authorityGrant',
      'accepted',
      'outcomeState',
      'openLoopState',
      'inlineEvidence',
      'credential',
      'rawHealth',
      'fullTranscript',
      'composedPrompt',
    ]) {
      expect(
        candidateEvidenceSubmissionV04Schema.safeParse({ ...candidate, [field]: 'forbidden' })
          .success,
      ).toBe(false);
    }
  });
  it('represents unavailable verification only as indeterminate', () => {
    expect(verificationV04Schema.parse(verification).state).toBe('indeterminate');
    expect(verificationV04Schema.safeParse({ ...verification, state: 'unavailable' }).success).toBe(
      false,
    );
    expect(verificationV04Schema.safeParse({ ...verification, state: 'passed' }).success).toBe(
      false,
    );
    expect(verificationV04Schema.safeParse({ ...verification, state: 'failed' }).success).toBe(
      false,
    );
    expect(
      verificationV04Schema.safeParse({
        ...verification,
        verifier: { ...verification.verifier, availability: 'available' },
        state: 'passed',
      }).success,
    ).toBe(true);
    expect(
      verificationV04Schema.safeParse({
        ...verification,
        verifier: {
          ...verification.verifier,
          availability: 'available',
          independentFromProducer: false,
        },
        state: 'passed',
      }).success,
    ).toBe(false);
  });
  it('requires acceptance to be an explicit separate command', () => {
    const request = {
      protocolVersion: '0.4',
      requestId: 'request',
      commandType: 'acceptance.record',
      presenceRegistrationId: 'presence',
      aggregate: { kind: 'outcome', id: 'outcome', expectedRevision: 1 },
      decision: 'accept',
      evidenceSetDigest: digest,
      verificationIds: ['verification'],
      reasonRef: null,
      clientIssuedAt: '2026-08-13T12:02:00.000Z',
    };
    expect(acceptanceCommandRequestV04Schema.parse(request).decision).toBe('accept');
    expect(
      acceptanceCommandRequestV04Schema.safeParse({ ...request, authorityGrant: 'client' }).success,
    ).toBe(false);
  });
  it('compiles verification JSON Schema', () => {
    expect(
      new Ajv2020({ strict: false }).compile(verificationV04Schema.toJSONSchema())(verification),
    ).toBe(true);
  });

  it('portable schemas reject unavailable success and invalid Acceptance authority', () => {
    const bundle = buildResponsibilityClosureV04Bundle(() => 'c'.repeat(64));
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const verify = ajv.compile(JSON.parse(bundle['verification.schema.json']!));
    const accept = ajv.compile(JSON.parse(bundle['acceptance.schema.json']!));
    const acceptCommand = ajv.compile(
      JSON.parse(bundle['acceptance-command-request.schema.json']!),
    );
    const catalogue = JSON.parse(bundle['closure.rejections.json']!) as {
      cases: Array<{ name: string; value: unknown }>;
    };
    expect(
      verify(catalogue.cases.find(({ name }) => name === 'unavailable-as-passed')!.value),
    ).toBe(false);
    for (const name of ['provider-explicit-acceptance', 'delegated-without-policy']) {
      expect(accept(catalogue.cases.find((entry) => entry.name === name)!.value), name).toBe(false);
    }
    expect(
      acceptCommand(
        catalogue.cases.find(({ name }) => name === 'acceptance-command-client-authority')!.value,
      ),
    ).toBe(false);
  });

  it('binds explicit owner Acceptance and publishes its command seam', () => {
    const bundle = buildResponsibilityClosureV04Bundle(() => 'c'.repeat(64));
    const accepted = JSON.parse(bundle['acceptance.valid.json']!);
    expect(acceptanceV04Schema.parse(accepted)).toEqual(accepted);
    expect(acceptanceMatchesAuthorityV04(accepted, 'owner_fixture')).toBe(true);
    expect(acceptanceMatchesAuthorityV04(accepted, 'owner_other')).toBe(false);
    const delegated = JSON.parse(bundle['acceptance-delegated.valid.json']!);
    expect(acceptanceV04Schema.parse(delegated)).toEqual(delegated);
    expect(
      new Ajv2020({ strict: false, validateFormats: false }).compile(
        JSON.parse(bundle['acceptance.schema.json']!),
      )(delegated),
    ).toBe(true);
    expect(acceptanceMatchesAuthorityV04(delegated, 'owner_fixture')).toBe(false);
    expect(
      acceptanceMatchesAuthorityV04(delegated, 'owner_fixture', delegated.delegatedPolicy),
    ).toBe(true);
    expect(
      acceptanceMatchesAuthorityV04(delegated, 'owner_fixture', {
        ...delegated.delegatedPolicy,
        revision: 2,
      }),
    ).toBe(false);
    const command = JSON.parse(bundle['acceptance-command-request.valid.json']!);
    expect(acceptanceCommandRequestV04Schema.parse(command)).toEqual(command);
    expect(
      new Ajv2020({ strict: false, validateFormats: false }).compile(
        JSON.parse(bundle['acceptance-command-request.schema.json']!),
      )(command),
    ).toBe(true);
  });

  it('rejects every catalogued closure shortcut', () => {
    const bundle = buildResponsibilityClosureV04Bundle(() => 'c'.repeat(64));
    const catalogue = JSON.parse(bundle['closure.rejections.json']!) as {
      cases: Array<{ name: string; value: unknown }>;
    };
    expect(catalogue.cases.map(({ name }) => name)).toEqual([
      'provider-self-acceptance',
      'unavailable-as-passed',
      'inline-evidence',
      'provider-explicit-acceptance',
      'delegated-without-policy',
      'acceptance-command-client-authority',
    ]);
    expect(candidateEvidenceSubmissionV04Schema.safeParse(catalogue.cases[0]!.value).success).toBe(
      false,
    );
    expect(verificationV04Schema.safeParse(catalogue.cases[1]!.value).success).toBe(false);
    expect(candidateEvidenceSubmissionV04Schema.safeParse(catalogue.cases[2]!.value).success).toBe(
      false,
    );
    expect(acceptanceV04Schema.safeParse(catalogue.cases[3]!.value).success).toBe(false);
    expect(acceptanceV04Schema.safeParse(catalogue.cases[4]!.value).success).toBe(false);
    expect(acceptanceCommandRequestV04Schema.safeParse(catalogue.cases[5]!.value).success).toBe(
      false,
    );
  });
});
