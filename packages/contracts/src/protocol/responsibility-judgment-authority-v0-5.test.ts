// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authorityGrantV05Schema,
  canonicalizeJudgmentAnswerRequestV05ForDigest,
  canonicalizeJudgmentRequestV05ForDigest,
  createJudgmentAuthorityBindingVerifierV05,
  judgmentAnswerRequestV05Schema,
  judgmentAnswerResultV05Schema,
  judgmentAnswerRetrySemanticsV05,
  judgmentAuthorityBindingV05Schema,
  judgmentDecisionV05Schema,
  judgmentProjectionPageV05Schema,
  judgmentProjectionQueryV05Schema,
  judgmentRequestV05Schema,
} from './responsibility-judgment-authority-v0-5';

const validRequest = {
  protocolVersion: '0.5',
  id: 'judgment_request_01',
  ownerId: 'owner_01',
  revision: 2,
  subject: { kind: 'work_unit', id: 'work_unit_01', revision: 4 },
  question: { ref: 'judgment_question_01', digest: `sha256:${'1'.repeat(64)}` },
  options: [
    {
      id: 'option_approve',
      authorityDisposition: 'grant',
      content: { ref: 'option_content_approve', digest: `sha256:${'2'.repeat(64)}` },
    },
    {
      id: 'option_reject',
      authorityDisposition: 'refuse',
      content: { ref: 'option_content_reject', digest: `sha256:${'3'.repeat(64)}` },
    },
  ],
  recommendation: 'option_approve',
  uncertainty: { ref: 'uncertainty_summary_01', digest: `sha256:${'4'.repeat(64)}` },
  evidence: [{ ref: 'evidence_summary_01', digest: `sha256:${'5'.repeat(64)}` }],
  costOfWaiting: { ref: 'cost_of_waiting_summary_01', digest: `sha256:${'6'.repeat(64)}` },
  risk: { ref: 'risk_summary_01', digest: `sha256:${'7'.repeat(64)}` },
  reversibility: { ref: 'reversibility_summary_01', digest: `sha256:${'8'.repeat(64)}` },
  affectedDigest: `sha256:${'9'.repeat(64)}`,
  requestedAuthority: {
    purpose: 'calendar.follow_up.schedule',
    effectFamily: 'calendar.event.create',
    resources: [{ kind: 'calendar', ref: 'calendar_primary' }],
    scopes: ['calendar.event.create'],
    audiences: ['calendar.account'],
    argumentDigest: `sha256:${'a'.repeat(64)}`,
    contextDigest: `sha256:${'b'.repeat(64)}`,
    artifactDigest: null,
    useLimit: 1,
    validUntil: '2026-08-15T18:30:00.000Z',
  },
  authorityAdmission: {
    grantee: { kind: 'service', id: 'effect_engine' },
    ownerPolicyRevision: 7,
    admissionContextDigest: `sha256:${'c'.repeat(64)}`,
  },
  reEntryPointId: 'reentry_01',
  expiresAt: '2026-08-15T18:30:00.000Z',
  decisionId: null,
  state: 'open',
  createdAt: '2026-08-15T18:05:00.000Z',
  updatedAt: '2026-08-15T18:05:00.000Z',
} as const;

function validDecisionAndGrant(displayedRequestDigest = `sha256:${'d'.repeat(64)}`) {
  const decision = {
    protocolVersion: '0.5',
    id: 'judgment_decision_01',
    ownerId: validRequest.ownerId,
    revision: 1,
    judgmentRequestId: validRequest.id,
    judgmentRequestRevision: validRequest.revision,
    subject: validRequest.subject,
    selectedOptionId: 'option_approve',
    displayedRequestDigest,
    actor: { kind: 'owner', id: validRequest.ownerId },
    presenceId: 'presence_01',
    authenticatedSessionId: 'authenticated_session_01',
    ownerPolicyRevision: validRequest.authorityAdmission.ownerPolicyRevision,
    authAssurance: 'verified_session',
    state: 'recorded',
    decidedAt: '2026-08-15T18:11:00.000Z',
  } as const;
  const grant = {
    protocolVersion: '0.5',
    id: 'authority_grant_01',
    ownerId: validRequest.ownerId,
    revision: 1,
    judgmentRequestId: validRequest.id,
    judgmentRequestRevision: validRequest.revision,
    judgmentDecisionId: decision.id,
    grantor: { kind: 'owner', id: validRequest.ownerId },
    grantee: validRequest.authorityAdmission.grantee,
    subject: validRequest.subject,
    purpose: validRequest.requestedAuthority.purpose,
    effectFamily: validRequest.requestedAuthority.effectFamily,
    resources: validRequest.requestedAuthority.resources,
    scopes: validRequest.requestedAuthority.scopes,
    audiences: validRequest.requestedAuthority.audiences,
    argumentDigest: validRequest.requestedAuthority.argumentDigest,
    contextDigest: validRequest.requestedAuthority.contextDigest,
    artifactDigest: validRequest.requestedAuthority.artifactDigest,
    useLimit: 1,
    usesConsumed: 0,
    nextUseIndex: 1,
    validFrom: decision.decidedAt,
    expiresAt: validRequest.requestedAuthority.validUntil,
    revocationGeneration: 0,
    state: 'active',
    createdAt: decision.decidedAt,
    updatedAt: decision.decidedAt,
  } as const;
  return { decision, grant };
}

describe('responsibility judgment and authority v0.5', () => {
  it('makes every displayed authorization input part of one strict canonical request', () => {
    expect(judgmentRequestV05Schema.parse(validRequest)).toEqual(validRequest);
    const canonical = canonicalizeJudgmentRequestV05ForDigest(validRequest);
    expect(canonicalizeJudgmentRequestV05ForDigest({
      ...validRequest,
      subject: {
        revision: validRequest.subject.revision,
        id: validRequest.subject.id,
        kind: validRequest.subject.kind,
      },
    })).toBe(canonical);

    for (const mutation of [
      { id: 'judgment_request_02' },
      { ownerId: 'owner_02' },
      { revision: 3 },
      { subject: { ...validRequest.subject, id: 'work_unit_02' } },
      { question: { ...validRequest.question, digest: `sha256:${'d'.repeat(64)}` } },
      { question: { ...validRequest.question, ref: 'judgment_question_02' } },
      {
        options: validRequest.options.map((option) => option.id === 'option_approve'
          ? { ...option, content: { ...option.content, digest: `sha256:${'d'.repeat(64)}` } }
          : option),
      },
      {
        options: validRequest.options.map((option) => option.id === 'option_approve'
          ? { ...option, id: 'option_approve_02' }
          : option),
        recommendation: null,
      },
      {
        options: validRequest.options.map((option) => option.id === 'option_reject'
          ? { ...option, authorityDisposition: 'grant' as const }
          : option),
      },
      {
        options: validRequest.options.map((option) => option.id === 'option_approve'
          ? { ...option, content: { ...option.content, ref: 'option_content_approve_02' } }
          : option),
      },
      { recommendation: null },
      { uncertainty: { ...validRequest.uncertainty, ref: 'uncertainty_summary_02' } },
      { uncertainty: { ...validRequest.uncertainty, digest: `sha256:${'d'.repeat(64)}` } },
      { evidence: [{ ...validRequest.evidence[0], ref: 'evidence_summary_02' }] },
      {
        evidence: [{ ...validRequest.evidence[0], digest: `sha256:${'d'.repeat(64)}` }],
      },
      { costOfWaiting: { ...validRequest.costOfWaiting, ref: 'cost_of_waiting_summary_02' } },
      { costOfWaiting: { ...validRequest.costOfWaiting, digest: `sha256:${'d'.repeat(64)}` } },
      { risk: { ...validRequest.risk, ref: 'risk_summary_02' } },
      { risk: { ...validRequest.risk, digest: `sha256:${'d'.repeat(64)}` } },
      {
        reversibility: {
          ...validRequest.reversibility,
          ref: 'reversibility_summary_02',
        },
      },
      {
        reversibility: {
          ...validRequest.reversibility,
          digest: `sha256:${'d'.repeat(64)}`,
        },
      },
      { subject: { ...validRequest.subject, revision: 5 } },
      { affectedDigest: `sha256:${'d'.repeat(64)}` },
      {
        requestedAuthority: {
          ...validRequest.requestedAuthority,
          purpose: 'calendar.follow_up.reschedule',
        },
      },
      {
        requestedAuthority: {
          ...validRequest.requestedAuthority,
          effectFamily: 'calendar.event.update',
        },
      },
      {
        requestedAuthority: {
          ...validRequest.requestedAuthority,
          resources: [{ kind: 'calendar', ref: 'calendar_secondary' }],
        },
      },
      {
        requestedAuthority: {
          ...validRequest.requestedAuthority,
          scopes: ['calendar.event.update'],
        },
      },
      {
        requestedAuthority: {
          ...validRequest.requestedAuthority,
          audiences: ['calendar.secondary_account'],
        },
      },
      {
        requestedAuthority: {
          ...validRequest.requestedAuthority,
          argumentDigest: `sha256:${'d'.repeat(64)}`,
        },
      },
      {
        requestedAuthority: {
          ...validRequest.requestedAuthority,
          contextDigest: `sha256:${'d'.repeat(64)}`,
        },
      },
      {
        requestedAuthority: {
          ...validRequest.requestedAuthority,
          artifactDigest: `sha256:${'d'.repeat(64)}`,
        },
      },
      {
        requestedAuthority: {
          ...validRequest.requestedAuthority,
          validUntil: '2026-08-15T18:29:00.000Z',
        },
      },
      {
        authorityAdmission: {
          ...validRequest.authorityAdmission,
          grantee: { kind: 'presence', id: 'presence_other' },
        },
      },
      {
        authorityAdmission: {
          ...validRequest.authorityAdmission,
          ownerPolicyRevision: 8,
        },
      },
      {
        authorityAdmission: {
          ...validRequest.authorityAdmission,
          admissionContextDigest: `sha256:${'d'.repeat(64)}`,
        },
      },
      { reEntryPointId: 'reentry_02' },
      { expiresAt: '2026-08-15T18:31:00.000Z' },
      { state: 'expired' },
      { createdAt: '2026-08-15T18:04:00.000Z' },
      { updatedAt: '2026-08-15T18:06:00.000Z' },
    ] as const) {
      expect(canonicalizeJudgmentRequestV05ForDigest({ ...validRequest, ...mutation }))
        .not.toBe(canonical);
    }
    expect(JSON.parse(canonical).requestedAuthority.useLimit).toBe(1);
    expect(() => canonicalizeJudgmentRequestV05ForDigest({
      ...validRequest,
      requestedAuthority: { ...validRequest.requestedAuthority, useLimit: 2 },
    })).toThrow();
    expect(judgmentRequestV05Schema.safeParse({
      ...validRequest,
      transcript: 'private transcript',
    }).success).toBe(false);
  });

  it('accepts only an exact authenticated surface answer and rejects every authority-bearing client field', () => {
    const answer = {
      protocolVersion: '0.5',
      requestId: 'answer_judgment_01',
      commandType: 'judgment.answer',
      presenceRegistrationId: 'presence_registration_01',
      aggregate: {
        kind: 'judgment_request',
        id: validRequest.id,
        expectedRevision: validRequest.revision,
      },
      correlationId: 'correlation_judgment_01',
      clientIssuedAt: '2026-08-15T18:10:00.000Z',
      payload: {
        selectedOptionId: 'option_approve',
        displayedRequestDigest: `sha256:${'d'.repeat(64)}`,
      },
    } as const;

    expect(judgmentAnswerRequestV05Schema.parse(answer)).toEqual(answer);
    expect(canonicalizeJudgmentAnswerRequestV05ForDigest(answer)).toBe(
      canonicalizeJudgmentAnswerRequestV05ForDigest({
        payload: answer.payload,
        clientIssuedAt: answer.clientIssuedAt,
        correlationId: answer.correlationId,
        aggregate: answer.aggregate,
        presenceRegistrationId: answer.presenceRegistrationId,
        commandType: answer.commandType,
        requestId: answer.requestId,
        protocolVersion: answer.protocolVersion,
      }),
    );

    const forbidden = {
      ownerId: 'owner_attacker',
      actor: { kind: 'owner', id: 'owner_attacker' },
      authenticatedSessionId: 'session_attacker',
      ownerPolicyRevision: 99,
      ownerRootRoutingVersion: 99,
      grantee: { kind: 'service', id: 'service_attacker' },
      authorityAdmission: validRequest.authorityAdmission,
      judgmentDecision: { id: 'decision_attacker' },
      authorityGrant: { id: 'grant_attacker' },
      requestedAuthority: validRequest.requestedAuthority,
      purpose: 'calendar.unrequested',
      effectFamily: 'calendar.event.delete',
      resources: [{ kind: 'calendar', ref: 'calendar_other' }],
      scopes: ['calendar.admin'],
      audiences: ['calendar.other_account'],
      argumentDigest: `sha256:${'e'.repeat(64)}`,
      contextDigest: `sha256:${'e'.repeat(64)}`,
      artifactDigest: `sha256:${'e'.repeat(64)}`,
      useLimit: 99,
      expiresAt: '2099-01-01T00:00:00.000Z',
      revocationGeneration: 99,
      providerId: 'provider_attacker',
      modelId: 'model_attacker',
      executorRef: 'executor_attacker',
      credential: 'secret_attacker',
      context: 'private context',
    } as const;

    for (const [field, value] of Object.entries(forbidden)) {
      expect(judgmentAnswerRequestV05Schema.safeParse({
        ...answer,
        [field]: value,
      }).success, `top-level ${field}`).toBe(false);
      expect(judgmentAnswerRequestV05Schema.safeParse({
        ...answer,
        aggregate: { ...answer.aggregate, [field]: value },
      }).success, `aggregate ${field}`).toBe(false);
      expect(judgmentAnswerRequestV05Schema.safeParse({
        ...answer,
        payload: { ...answer.payload, [field]: value },
      }).success, `payload ${field}`).toBe(false);
    }
  });

  it('returns a strict granted or refused result with immutable duplicate semantics', () => {
    const base = {
      protocolVersion: '0.5',
      requestId: 'answer_judgment_01',
      judgmentRequest: { id: validRequest.id, revision: 3 },
      judgmentDecision: { id: 'judgment_decision_01', revision: 1 },
      selectedOptionId: 'option_approve',
      projectionCursor: 27,
    } as const;
    const granted = {
      ...base,
      authorityDisposition: 'granted',
      grant: {
        id: 'authority_grant_01',
        revision: 1,
        grantee: validRequest.authorityAdmission.grantee,
        state: 'active',
        expiresAt: validRequest.expiresAt,
        revocationGeneration: 0,
      },
    } as const;
    const refused = {
      ...base,
      selectedOptionId: 'option_reject',
      authorityDisposition: 'refused',
    } as const;

    expect(judgmentAnswerResultV05Schema.parse(granted)).toEqual(granted);
    expect(judgmentAnswerResultV05Schema.parse(refused)).toEqual(refused);
    expect(judgmentAnswerResultV05Schema.safeParse({
      ...refused,
      grant: granted.grant,
    }).success).toBe(false);
    expect(judgmentAnswerResultV05Schema.safeParse({
      ...granted,
      requestedAuthority: validRequest.requestedAuthority,
    }).success).toBe(false);
    expect(judgmentAnswerRetrySemanticsV05).toEqual({
      identity: 'requestId',
      exactDuplicate: 'return_persisted_result_byte_for_byte',
      changedDuplicate: 'reject_request_conflict',
    });
  });

  it('projects ordered owner-bound JudgmentRequests through a bounded cursor page', () => {
    const query = {
      protocolVersion: '0.5',
      fromExclusiveCursor: 26,
      limit: 25,
      snapshotId: 'judgment_snapshot_01',
    } as const;
    const page = {
      protocolVersion: '0.5',
      ownerId: validRequest.ownerId,
      projectionName: 'judgment.needs_you',
      snapshotId: 'judgment_snapshot_01',
      snapshotBaseCursor: 20,
      fromExclusiveCursor: 26,
      highWaterCursor: 28,
      nextCursor: 27,
      items: [{
        cursor: 27,
        itemType: 'judgment_request',
        request: validRequest,
        displayedRequestDigest: `sha256:${'d'.repeat(64)}`,
      }],
      hasMore: true,
      generatedAt: '2026-08-15T18:10:00.000Z',
    } as const;

    expect(judgmentProjectionQueryV05Schema.parse(query)).toEqual(query);
    expect(judgmentProjectionPageV05Schema.parse(page)).toEqual(page);
    for (const invalid of [
      { ...page, ownerId: 'owner_other' },
      { ...page, nextCursor: 28 },
      { ...page, items: [{ ...page.items[0], cursor: 26 }] },
      {
        ...page,
        items: [{
          ...page.items[0],
          request: { ...validRequest, ownerId: 'owner_other' },
        }],
      },
      { ...page, privateContext: 'private context' },
      {
        ...page,
        items: page.items.map(({ displayedRequestDigest: _digest, ...item }) => item),
      },
    ]) {
      expect(judgmentProjectionPageV05Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('records the authenticated decision and server-created grant as separate strict aggregates', () => {
    const { decision, grant } = validDecisionAndGrant();

    expect(judgmentDecisionV05Schema.parse(decision)).toEqual(decision);
    expect(authorityGrantV05Schema.parse(grant)).toEqual(grant);
    expect(judgmentDecisionV05Schema.safeParse({
      ...decision,
      actor: { kind: 'owner', id: 'owner_other' },
    }).success).toBe(false);
    expect(authorityGrantV05Schema.safeParse({
      ...grant,
      credential: 'secret-value',
    }).success).toBe(false);
    expect(authorityGrantV05Schema.safeParse({
      ...grant,
      usesConsumed: 1,
      nextUseIndex: 1,
    }).success).toBe(false);
  });

  it('verifies one exact request-answer-decision-grant binding and rejects refusal at expiry', () => {
    const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
    const requestDigest = `sha256:${sha256Hex(
      canonicalizeJudgmentRequestV05ForDigest(validRequest),
    )}`;
    const answer = {
      protocolVersion: '0.5',
      requestId: 'answer_judgment_01',
      commandType: 'judgment.answer',
      presenceRegistrationId: 'presence_registration_01',
      aggregate: {
        kind: 'judgment_request',
        id: validRequest.id,
        expectedRevision: validRequest.revision,
      },
      clientIssuedAt: '2026-08-15T18:10:00.000Z',
      payload: {
        selectedOptionId: 'option_approve',
        displayedRequestDigest: requestDigest,
      },
    } as const;
    const { decision, grant } = validDecisionAndGrant(requestDigest);
    const granted = {
      requestDigest,
      request: validRequest,
      answer,
      decision,
      authorityDisposition: 'granted',
      grant,
    } as const;

    expect(createJudgmentAuthorityBindingVerifierV05(sha256Hex)(granted)).toEqual(granted);
    expect(judgmentAuthorityBindingV05Schema.safeParse({
      ...granted,
      grant: { ...grant, grantee: { kind: 'service', id: 'service_other' } },
    }).success).toBe(false);
    expect(judgmentAuthorityBindingV05Schema.safeParse({
      ...granted,
      decision: { ...decision, ownerPolicyRevision: 8 },
    }).success).toBe(false);

    const refusedAnswer = {
      ...answer,
      requestId: 'answer_judgment_refused_01',
      payload: { ...answer.payload, selectedOptionId: 'option_reject' },
    } as const;
    const refusedDecision = {
      ...decision,
      id: 'judgment_decision_refused_01',
      selectedOptionId: 'option_reject',
      decidedAt: new Date(Date.parse(validRequest.expiresAt) - 1).toISOString(),
    };
    const refused = {
      requestDigest,
      request: validRequest,
      answer: refusedAnswer,
      decision: refusedDecision,
      authorityDisposition: 'refused',
    } as const;

    expect(judgmentAuthorityBindingV05Schema.parse(refused)).toEqual(refused);
    for (const decidedAt of [
      validRequest.expiresAt,
      new Date(Date.parse(validRequest.expiresAt) + 1).toISOString(),
    ]) {
      const result = judgmentAuthorityBindingV05Schema.safeParse({
        ...refused,
        decision: { ...refused.decision, decidedAt },
      });
      expect(result.success, decidedAt).toBe(false);
      if (result.success) throw new Error('expired refusal unexpectedly passed');
      expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([{
        path: ['decision', 'decidedAt'],
        message: 'decision must occur after the current request snapshot and before its expiry',
      }]);
    }
  });
});
