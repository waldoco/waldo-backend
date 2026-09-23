import {
  canonicalizeJudgmentAnswerRequestV05ForDigest,
  canonicalizeJudgmentRequestV05ForDigest,
  canonicalizeResponsibilityCaptureRequestV02ForDigest,
  judgmentAnswerRequestV05Schema,
  judgmentAnswerResultV05Schema,
  judgmentProjectionPageV05Schema,
  judgmentProjectionItemV05Schema,
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureTrustedEnvelopeV02Schema,
  type ResponsibilityCaptureRequestV02,
} from '@waldo/contracts';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  WaldoCoordinator,
  type CoordinatorDependencies,
} from '../src/coordinator/waldo-coordinator';
import type { RunLoopDO } from '../src/run-loop/do';

let sequence = 0;

function freshStub(): DurableObjectStub<RunLoopDO> {
  sequence += 1;
  return env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName(`judgment-coordinator-${sequence}`));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const authority = Object.freeze({
  ownerId: 'owner_judgment_01',
  authenticatedSubjectRef: `supabase_subject_${'1'.repeat(64)}`,
  presenceId: 'presence_judgment_01',
  presenceRegistrationId: 'presence_registration_judgment_01',
  authenticatedSessionId: `authenticated_session_${'2'.repeat(64)}`,
  ownerPolicyRevision: 7,
  ownerRootRoutingVersion: 2,
});

async function captureWorkUnit(coordinator: WaldoCoordinator) {
  const canonicalAuthority = coordinator.admitCanonicalAuthority({
    ...authority,
    authAssurance: 'supabase_verified_session',
    authenticatedSessionExpiresAt: '2026-08-17T00:00:00.000Z',
    presenceState: 'active',
    at: '2026-08-16T09:59:00.000Z',
  });
  const request = responsibilityCaptureRequestV02Schema.parse({
    protocolVersion: '0.2',
    requestId: 'capture_for_judgment_01',
    commandType: 'responsibility.capture',
    presenceRegistrationId: authority.presenceRegistrationId,
    clientIssuedAt: '2026-08-16T09:59:01.000Z',
    payload: {
      userStatement: 'Schedule the review only after I explicitly approve it.',
      workUnits: [{
        responsibility: 'Prepare the review scheduling decision.',
        inputs: [],
        dependencyPositions: [],
        expectedEvidence: [],
        requiredCapabilities: [],
        stopConditions: ['Do not schedule without an AuthorityGrant.'],
      }],
    },
  });
  const requestDigest = `sha256:${await sha256Hex(
    canonicalizeResponsibilityCaptureRequestV02ForDigest(request),
  )}` as const;
  const captured = await coordinator.captureAuthorizedResponsibility({
    routedOwnerId: authority.ownerId,
    request,
    trustedEnvelope: responsibilityCaptureTrustedEnvelopeV02Schema.parse({
      protocolVersion: '0.2',
      commandId: 'command_capture_for_judgment_01',
      commandType: 'responsibility.capture',
      ownerId: authority.ownerId,
      actor: { kind: 'presence', id: authority.presenceId },
      presenceId: authority.presenceId,
      authenticatedSessionId: authority.authenticatedSessionId,
      ownerPolicyRevision: authority.ownerPolicyRevision,
      authAssurance: 'verified_session',
      ownerRootRoutingVersion: authority.ownerRootRoutingVersion,
      requestDigest,
      correlationId: 'correlation_capture_for_judgment_01',
      receivedAt: '2026-08-16T09:59:02.000Z',
      payload: request.payload,
    }),
  }, canonicalAuthority) as {
    outcome: { id: string };
    workUnits: Array<{ id: string; revision: number }>;
  };
  return { captured, canonicalAuthority };
}

function proposal(workUnit: { id: string; revision: number }) {
  return {
    subject: { kind: 'work_unit' as const, id: workUnit.id, expectedRevision: workUnit.revision },
    question: { ref: 'question_schedule_review', digest: `sha256:${'1'.repeat(64)}` as const },
    options: [
      {
        id: 'approve_schedule',
        authorityDisposition: 'grant' as const,
        content: { ref: 'option_approve_schedule', digest: `sha256:${'2'.repeat(64)}` as const },
      },
      {
        id: 'refuse_schedule',
        authorityDisposition: 'refuse' as const,
        content: { ref: 'option_refuse_schedule', digest: `sha256:${'3'.repeat(64)}` as const },
      },
    ],
    recommendation: 'approve_schedule',
    uncertainty: { ref: 'uncertainty_schedule', digest: `sha256:${'4'.repeat(64)}` as const },
    evidence: [],
    costOfWaiting: { ref: 'cost_schedule', digest: `sha256:${'5'.repeat(64)}` as const },
    risk: { ref: 'risk_schedule', digest: `sha256:${'6'.repeat(64)}` as const },
    reversibility: { ref: 'reversibility_schedule', digest: `sha256:${'7'.repeat(64)}` as const },
    requestedAuthority: {
      purpose: 'calendar.review.schedule',
      effectFamily: 'calendar.event.create',
      resources: [{ kind: 'calendar', ref: 'calendar_primary' }],
      scopes: ['calendar.event.create'],
      audiences: ['calendar.account'],
      argumentDigest: `sha256:${'8'.repeat(64)}` as const,
      contextDigest: `sha256:${'9'.repeat(64)}` as const,
      artifactDigest: null,
      useLimit: 1 as const,
      validUntil: '2026-08-16T10:30:00.000Z',
    },
    reEntryPointId: null,
    expiresAt: '2026-08-16T10:30:00.000Z',
  };
}

function outcomeProposal(outcome: { id: string; revision: number }) {
  const base = proposal({ id: 'work_unit_unused_for_outcome', revision: 1 });
  return {
    ...base,
    subject: {
      kind: 'outcome' as const,
      id: outcome.id,
      expectedRevision: outcome.revision,
    },
    options: base.options.map((option) => ({
      ...option,
      authorityDisposition: 'refuse' as const,
    })),
    requestedAuthority: null,
  };
}

function answerFor(
  item: ReturnType<typeof judgmentProjectionItemV05Schema.parse>,
  selectedOptionId = 'approve_schedule',
  requestId = 'answer_judgment_01',
) {
  return judgmentAnswerRequestV05Schema.parse({
    protocolVersion: '0.5',
    requestId,
    commandType: 'judgment.answer',
    presenceRegistrationId: authority.presenceRegistrationId,
    aggregate: {
      kind: 'judgment_request',
      id: item.request.id,
      expectedRevision: item.request.revision,
    },
    correlationId: 'correlation_answer_judgment_01',
    clientIssuedAt: '2026-08-16T09:59:59.000Z',
    payload: { selectedOptionId, displayedRequestDigest: item.displayedRequestDigest },
  });
}

describe('JudgmentAuthority Coordinator', () => {
  it('creates an exact WorkUnit judgment with only server-derived authority material', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const workUnit = captured.workUnits[0]!;
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(workUnit),
        canonicalAuthority,
      );
      return {
        item: judgmentProjectionItemV05Schema.parse(item),
        requestRows: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_requests',
        ).one().count,
        admissionBasis: state.storage.sql.exec<{ admission_basis_json: string }>(
          'SELECT admission_basis_json FROM judgment_requests',
        ).one().admission_basis_json,
      };
    });

    expect(proof.item).toMatchObject({
      cursor: 3,
      itemType: 'judgment_request',
      request: {
        ownerId: authority.ownerId,
        revision: 1,
        subject: { kind: 'work_unit', revision: 1 },
        authorityAdmission: {
          grantee: { kind: 'service', id: 'effect_engine' },
          ownerPolicyRevision: authority.ownerPolicyRevision,
        },
        decisionId: null,
        state: 'open',
        createdAt: '2026-08-16T10:00:00.000Z',
        updatedAt: '2026-08-16T10:00:00.000Z',
      },
    });
    expect(proof.item.displayedRequestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(proof.requestRows).toBe(1);
    expect(proof.admissionBasis).not.toContain('Schedule the review');
    expect(proof.admissionBasis).not.toContain('Prepare the review');
  });

  it('creates a judgment from exact canonical Outcome material', async () => {
    const item = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      return coordinator.createTrustedJudgmentRequestV05(
        outcomeProposal({ id: captured.outcome.id, revision: 1 }),
        canonicalAuthority,
      );
    });
    expect(item).toMatchObject({
      cursor: 3,
      request: {
        subject: { kind: 'outcome', revision: 1 },
        affectedDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        state: 'open',
      },
    });
  });

  it('rejects a stale Outcome revision without judgment residue', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      let rejection = '';
      try {
        await coordinator.createTrustedJudgmentRequestV05(
          outcomeProposal({ id: captured.outcome.id, revision: 2 }),
          canonicalAuthority,
        );
      } catch (error) {
        rejection = (error as Error).name;
      }
      return {
        rejection,
        requests: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_requests',
        ).one().count,
        events: state.storage.sql.exec<{ count: number }>(
          "SELECT count(*) AS count FROM owner_domain_events WHERE schema_version = '0.5'",
        ).one().count,
        projectionRows: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_projection',
        ).one().count,
      };
    });
    expect(proof).toEqual({
      rejection: 'ResponsibilityJudgmentConflictError',
      requests: 0,
      events: 0,
      projectionRows: 0,
    });
  });

  it('rolls back Outcome judgment creation when exact material changes during hashing', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      let armed = false;
      let outcomeId = '';
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex: async (value) => {
          if (armed) {
            armed = false;
            state.storage.sql.exec(
              `UPDATE outcomes SET user_statement = 'Changed during Outcome admission'
                WHERE id = ?`,
              outcomeId,
            );
          }
          return sha256Hex(value);
        },
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      outcomeId = captured.outcome.id;
      armed = true;
      let rejection = '';
      try {
        await coordinator.createTrustedJudgmentRequestV05(
          outcomeProposal({ id: outcomeId, revision: 1 }),
          canonicalAuthority,
        );
      } catch (error) {
        rejection = (error as Error).name;
      }
      return {
        rejection,
        requests: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_requests',
        ).one().count,
        events: state.storage.sql.exec<{ count: number }>(
          "SELECT count(*) AS count FROM owner_domain_events WHERE schema_version = '0.5'",
        ).one().count,
        projectionRows: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_projection',
        ).one().count,
      };
    });
    expect(proof).toEqual({
      rejection: 'ResponsibilityDigestConflictError',
      requests: 0,
      events: 0,
      projectionRows: 0,
    });
  });

  it('supersedes an Outcome judgment after affected material digest drift', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        outcomeProposal({ id: captured.outcome.id, revision: 1 }),
        canonicalAuthority,
      );
      state.storage.sql.exec(
        `UPDATE outcomes SET user_statement = 'Changed after Outcome judgment display'
          WHERE id = ?`,
        captured.outcome.id,
      );
      let rejection = '';
      try {
        await coordinator.answerAuthorizedJudgmentV05(
          {
            routedOwnerId: authority.ownerId,
            request: answerFor(item, 'refuse_schedule'),
          },
          canonicalAuthority,
        );
      } catch (error) {
        rejection = (error as Error).name;
      }
      return {
        rejection,
        request: state.storage.sql.exec<{ revision: number; state: string }>(
          'SELECT revision, state FROM judgment_requests',
        ).one(),
        decisions: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_decisions',
        ).one().count,
        grants: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM authority_grants',
        ).one().count,
      };
    });
    expect(proof).toEqual({
      rejection: 'ResponsibilityJudgmentConflictError',
      request: { revision: 2, state: 'superseded' },
      decisions: 0,
      grants: 0,
    });
  });

  it('records one server-authored Decision and Grant and replays an exact duplicate', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!),
        canonicalAuthority,
      );
      const answer = answerFor(item);
      const admission = { routedOwnerId: authority.ownerId, request: answer };
      const first = await coordinator.answerAuthorizedJudgmentV05(admission, canonicalAuthority);
      const duplicate = await coordinator.answerAuthorizedJudgmentV05(admission, canonicalAuthority);
      return {
        first: judgmentAnswerResultV05Schema.parse(first),
        duplicate: judgmentAnswerResultV05Schema.parse(duplicate),
        exactJson: JSON.stringify(first) === JSON.stringify(duplicate),
        requestDigest: `sha256:${await sha256Hex(
          canonicalizeJudgmentAnswerRequestV05ForDigest(answer),
        )}`,
        command: state.storage.sql.exec<{
          request_digest: string; result_json: string;
        }>('SELECT request_digest, result_json FROM judgment_commands').one(),
        requestRow: state.storage.sql.exec<{
          revision: number; state: string; decision_id: string;
        }>('SELECT revision, state, decision_id FROM judgment_requests').one(),
        decisionRows: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_decisions',
        ).one().count,
        grant: state.storage.sql.exec<{
          use_limit: number; uses_consumed: number; next_use_index: number; state: string;
        }>('SELECT use_limit, uses_consumed, next_use_index, state FROM authority_grants').one(),
      };
    });

    expect(proof.first).toMatchObject({
      protocolVersion: '0.5',
      requestId: 'answer_judgment_01',
      judgmentRequest: { revision: 2 },
      judgmentDecision: { revision: 1 },
      selectedOptionId: 'approve_schedule',
      authorityDisposition: 'granted',
      grant: {
        revision: 1,
        grantee: { kind: 'service', id: 'effect_engine' },
        state: 'active',
        revocationGeneration: 0,
      },
    });
    expect(proof.duplicate).toEqual(proof.first);
    expect(proof.exactJson).toBe(true);
    expect(proof.command.request_digest).toBe(proof.requestDigest);
    expect(JSON.parse(proof.command.result_json)).toEqual(proof.first);
    expect(proof.requestRow).toMatchObject({ revision: 2, state: 'answered' });
    expect(proof.decisionRows).toBe(1);
    expect(proof.grant).toEqual({
      use_limit: 1,
      uses_consumed: 0,
      next_use_index: 1,
      state: 'active',
    });
  });

  it('rejects a changed duplicate without changing the recorded Decision or Grant', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      await coordinator.answerAuthorizedJudgmentV05(
        { routedOwnerId: authority.ownerId, request: answerFor(item) },
        canonicalAuthority,
      );
      let rejection = '';
      try {
        await coordinator.answerAuthorizedJudgmentV05({
          routedOwnerId: authority.ownerId,
          request: answerFor(item, 'refuse_schedule'),
        }, canonicalAuthority);
      } catch (error) {
        rejection = (error as Error).name;
      }
      return {
        rejection,
        decisions: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_decisions',
        ).one().count,
        grants: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM authority_grants',
        ).one().count,
        commands: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_commands',
        ).one().count,
      };
    });
    expect(proof).toEqual({
      rejection: 'ResponsibilityJudgmentConflictError',
      decisions: 1,
      grants: 1,
      commands: 1,
    });
  });

  it('atomically expires an open request at exact expiry without a Decision or Grant', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      let now = '2026-08-16T10:00:00.000Z';
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      now = item.request.expiresAt;
      let rejection = '';
      try {
        await coordinator.answerAuthorizedJudgmentV05(
          { routedOwnerId: authority.ownerId, request: answerFor(item) },
          canonicalAuthority,
        );
      } catch (error) {
        rejection = (error as Error).name;
      }
      return {
        rejection,
        request: state.storage.sql.exec<{ revision: number; state: string }>(
          'SELECT revision, state FROM judgment_requests',
        ).one(),
        decisions: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_decisions',
        ).one().count,
        grants: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM authority_grants',
        ).one().count,
        highWater: state.storage.sql.exec<{ high_water_cursor: number }>(
          'SELECT high_water_cursor FROM owner_event_state WHERE root_key = 1',
        ).one().high_water_cursor,
      };
    });
    expect(proof).toEqual({
      rejection: 'ResponsibilityJudgmentConflictError',
      request: { revision: 2, state: 'expired' },
      decisions: 0,
      grants: 0,
      highWater: 4,
    });
  });

  it('atomically expires when the exact boundary is crossed during answer commit', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      let armed = false;
      let answerClockReads = 0;
      const beforeExpiry = '2026-08-16T10:29:59.999Z';
      const exactExpiry = '2026-08-16T10:30:00.000Z';
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => {
          if (!armed) return '2026-08-16T10:00:00.000Z';
          answerClockReads += 1;
          return answerClockReads >= 3 ? exactExpiry : beforeExpiry;
        },
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      armed = true;
      let rejection = '';
      try {
        await coordinator.answerAuthorizedJudgmentV05(
          { routedOwnerId: authority.ownerId, request: answerFor(item) },
          canonicalAuthority,
        );
      } catch (error) {
        rejection = (error as Error).name;
      }
      return {
        rejection,
        request: state.storage.sql.exec<{ revision: number; state: string }>(
          'SELECT revision, state FROM judgment_requests',
        ).one(),
        decisions: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_decisions',
        ).one().count,
      };
    });
    expect(proof).toEqual({
      rejection: 'ResponsibilityJudgmentConflictError',
      request: { revision: 2, state: 'expired' },
      decisions: 0,
    });
  });

  it('does not terminalize after the authenticated session expires during terminal hashing', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      let armed = false;
      let answerClockReads = 0;
      const sessionExpiry = '2026-08-16T10:15:00.000Z';
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => {
          if (!armed) return '2026-08-16T10:00:00.000Z';
          answerClockReads += 1;
          return answerClockReads >= 4
            ? sessionExpiry
            : '2026-08-16T10:14:59.999Z';
        },
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      state.storage.sql.exec(
        'UPDATE presence_sessions SET expires_at = ? WHERE authenticated_session_id = ?',
        sessionExpiry,
        canonicalAuthority.authenticatedSessionId,
      );
      state.storage.sql.exec(
        `UPDATE work_units SET responsibility = 'Changed after display' WHERE id = ?`,
        item.request.subject.id,
      );
      armed = true;
      let rejection = '';
      try {
        await coordinator.answerAuthorizedJudgmentV05(
          { routedOwnerId: authority.ownerId, request: answerFor(item) },
          canonicalAuthority,
        );
      } catch (error) {
        rejection = (error as Error).name;
      }
      return {
        rejection,
        request: state.storage.sql.exec<{ revision: number; state: string }>(
          'SELECT revision, state FROM judgment_requests',
        ).one(),
        highWater: state.storage.sql.exec<{ high_water_cursor: number }>(
          'SELECT high_water_cursor FROM owner_event_state WHERE root_key = 1',
        ).one().high_water_cursor,
        projectionRows: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_projection',
        ).one().count,
      };
    });
    expect(proof).toEqual({
      rejection: 'ResponsibilityAuthorityDeniedError',
      request: { revision: 1, state: 'open' },
      highWater: 3,
      projectionRows: 1,
    });
  });

  it('does not create a request when requested authority expires during creation hashing', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      let armed = false;
      let creationClockReads = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => {
          if (!armed) return '2026-08-16T10:00:00.000Z';
          creationClockReads += 1;
          return creationClockReads >= 2
            ? '2026-08-16T10:15:00.000Z'
            : '2026-08-16T10:14:59.999Z';
        },
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const candidate = proposal(captured.workUnits[0]!);
      armed = true;
      let rejection = '';
      try {
        await coordinator.createTrustedJudgmentRequestV05({
          ...candidate,
          requestedAuthority: {
            ...candidate.requestedAuthority!,
            validUntil: '2026-08-16T10:15:00.000Z',
          },
          expiresAt: '2026-08-16T10:30:00.000Z',
        }, canonicalAuthority);
      } catch (error) {
        rejection = (error as Error).name;
      }
      return {
        rejection,
        requests: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_requests',
        ).one().count,
        highWater: state.storage.sql.exec<{ high_water_cursor: number }>(
          'SELECT high_water_cursor FROM owner_event_state WHERE root_key = 1',
        ).one().high_water_cursor,
      };
    });
    expect(proof).toEqual({
      rejection: 'ResponsibilityJudgmentConflictError',
      requests: 0,
      highWater: 2,
    });
  });

  it('does not persist an already-expired active Grant at the authority boundary', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      let armed = false;
      let answerClockReads = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => {
          if (!armed) return '2026-08-16T10:00:00.000Z';
          answerClockReads += 1;
          return answerClockReads >= 3
            ? '2026-08-16T10:15:00.000Z'
            : '2026-08-16T10:14:59.999Z';
        },
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const candidate = proposal(captured.workUnits[0]!);
      const item = await coordinator.createTrustedJudgmentRequestV05({
        ...candidate,
        requestedAuthority: {
          ...candidate.requestedAuthority!,
          validUntil: '2026-08-16T10:15:00.000Z',
        },
        expiresAt: '2026-08-16T10:30:00.000Z',
      }, canonicalAuthority);
      armed = true;
      let rejection = '';
      try {
        await coordinator.answerAuthorizedJudgmentV05(
          { routedOwnerId: authority.ownerId, request: answerFor(item) },
          canonicalAuthority,
        );
      } catch (error) {
        rejection = (error as Error).name;
      }
      return {
        rejection,
        request: state.storage.sql.exec<{ revision: number; state: string }>(
          'SELECT revision, state FROM judgment_requests',
        ).one(),
        decisions: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_decisions',
        ).one().count,
        grants: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM authority_grants',
        ).one().count,
      };
    });
    expect(proof).toEqual({
      rejection: 'ResponsibilityJudgmentConflictError',
      request: { revision: 2, state: 'superseded' },
      decisions: 0,
      grants: 0,
    });
  });

  it('records refusal after authority expiry but still rejects refusal at request expiry', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      let now = '2026-08-16T10:00:00.000Z';
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const first = await coordinator.createTrustedJudgmentRequestV05({
        ...proposal(captured.workUnits[0]!),
        requestedAuthority: {
          ...proposal(captured.workUnits[0]!).requestedAuthority!,
          validUntil: '2026-08-16T10:15:00.000Z',
        },
        expiresAt: '2026-08-16T10:30:00.000Z',
      }, canonicalAuthority);
      now = '2026-08-16T10:20:00.000Z';
      const refused = await coordinator.answerAuthorizedJudgmentV05(
        {
          routedOwnerId: authority.ownerId,
          request: answerFor(first, 'refuse_schedule', 'answer_refusal_after_authority'),
        },
        canonicalAuthority,
      );
      const second = await coordinator.createTrustedJudgmentRequestV05({
        ...proposal(captured.workUnits[0]!),
        requestedAuthority: {
          ...proposal(captured.workUnits[0]!).requestedAuthority!,
          validUntil: '2026-08-16T10:30:00.000Z',
        },
        expiresAt: '2026-08-16T10:30:00.000Z',
      }, canonicalAuthority);
      now = '2026-08-16T10:30:00.000Z';
      let expiryRejection = '';
      try {
        await coordinator.answerAuthorizedJudgmentV05(
          {
            routedOwnerId: authority.ownerId,
            request: answerFor(second, 'refuse_schedule', 'answer_refusal_at_request_expiry'),
          },
          canonicalAuthority,
        );
      } catch (error) {
        expiryRejection = (error as Error).name;
      }
      return {
        refused,
        expiryRejection,
        requests: state.storage.sql.exec<{ state: string }>(
          'SELECT state FROM judgment_requests ORDER BY created_at, id',
        ).toArray().map((row) => row.state).sort(),
        decisions: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_decisions',
        ).one().count,
        grants: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM authority_grants',
        ).one().count,
      };
    });
    expect(proof.refused).toMatchObject({ authorityDisposition: 'refused' });
    expect(proof.expiryRejection).toBe('ResponsibilityJudgmentConflictError');
    expect(proof.requests).toEqual(['answered', 'expired']);
    expect(proof.decisions).toBe(1);
    expect(proof.grants).toBe(0);
  });

  it.each(['preflight', 'commit'] as const)(
    'propagates unexpected %s subject corruption without terminalizing the request',
    async (failureStage) => {
      const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
        let id = 0;
        let armed = false;
        let answerHashReads = 0;
        let workUnitId = '';
        const coordinator = new WaldoCoordinator(state.storage, {
          now: () => '2026-08-16T10:00:00.000Z',
          newId: (kind) => `${kind}_judgment_${++id}`,
          sha256Hex: async (value) => {
            if (armed) {
              answerHashReads += 1;
              if (failureStage === 'commit' && answerHashReads === 5) {
                state.storage.sql.exec(
                  "UPDATE work_units SET inputs_json = '{' WHERE id = ?",
                  workUnitId,
                );
              }
            }
            return sha256Hex(value);
          },
        });
        const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
        workUnitId = captured.workUnits[0]!.id;
        const item = await coordinator.createTrustedJudgmentRequestV05(
          proposal(captured.workUnits[0]!), canonicalAuthority,
        );
        if (failureStage === 'preflight') {
          state.storage.sql.exec(
            "UPDATE work_units SET inputs_json = '{' WHERE id = ?",
            workUnitId,
          );
        } else {
          armed = true;
        }
        let rejection = '';
        try {
          await coordinator.answerAuthorizedJudgmentV05(
            { routedOwnerId: authority.ownerId, request: answerFor(item) },
            canonicalAuthority,
          );
        } catch (error) {
          rejection = (error as Error).name;
        }
        return {
          rejection,
          request: state.storage.sql.exec<{ revision: number; state: string }>(
            'SELECT revision, state FROM judgment_requests',
          ).one(),
          decisions: state.storage.sql.exec<{ count: number }>(
            'SELECT count(*) AS count FROM judgment_decisions',
          ).one().count,
          highWater: state.storage.sql.exec<{ high_water_cursor: number }>(
            'SELECT high_water_cursor FROM owner_event_state WHERE root_key = 1',
          ).one().high_water_cursor,
        };
      });
      expect(proof).toEqual({
        rejection: 'SyntaxError',
        request: { revision: 1, state: 'open' },
        decisions: 0,
        highWater: 3,
      });
    },
  );

  it.each(['subject', 'policy', 'grantee', 'admission'] as const)(
    'atomically supersedes on current %s drift without a Decision or Grant',
    async (drift) => {
      const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
        let id = 0;
        let granteeId = 'effect_engine';
        let admissionVersion = 'current';
        const dependencies: CoordinatorDependencies = {
          now: () => '2026-08-16T10:00:00.000Z',
          newId: (kind) => `${kind}_judgment_${++id}`,
          sha256Hex,
          resolveJudgmentAdmissionV05: (input) => {
            if (input.requestedAuthority === null) {
              return { grantee: null, revocationGeneration: 0, admissionContextMaterial: null };
            }
            const grantee = { kind: 'service' as const, id: granteeId };
            return {
              grantee,
              revocationGeneration: 0,
              admissionContextMaterial: JSON.stringify([
                'test-current-admission', input.ownerId, input.subject, input.affectedDigest,
                grantee, input.ownerPolicyRevision, admissionVersion,
              ]),
            };
          },
        };
        const coordinator = new WaldoCoordinator(state.storage, dependencies);
        const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
        const item = await coordinator.createTrustedJudgmentRequestV05(
          proposal(captured.workUnits[0]!), canonicalAuthority,
        );
        let currentAuthority = canonicalAuthority;
        if (drift === 'subject') {
          state.storage.sql.exec(
            `UPDATE work_units SET responsibility = 'Changed after display' WHERE id = ?`,
            item.request.subject.id,
          );
        } else if (drift === 'policy') {
          state.storage.sql.exec(
            'UPDATE owner_roots SET owner_policy_revision = 8 WHERE root_key = 1',
          );
          currentAuthority = Object.freeze({ ...canonicalAuthority, ownerPolicyRevision: 8 });
        } else if (drift === 'grantee') {
          granteeId = 'effect_engine_secondary';
        } else {
          admissionVersion = 'changed';
        }
        let rejection = '';
        try {
          await coordinator.answerAuthorizedJudgmentV05(
            { routedOwnerId: authority.ownerId, request: answerFor(item) },
            currentAuthority,
          );
        } catch (error) {
          rejection = (error as Error).name;
        }
        return {
          rejection,
          request: state.storage.sql.exec<{ revision: number; state: string }>(
            'SELECT revision, state FROM judgment_requests',
          ).one(),
          decisions: state.storage.sql.exec<{ count: number }>(
            'SELECT count(*) AS count FROM judgment_decisions',
          ).one().count,
          grants: state.storage.sql.exec<{ count: number }>(
            'SELECT count(*) AS count FROM authority_grants',
          ).one().count,
          highWater: state.storage.sql.exec<{ high_water_cursor: number }>(
            'SELECT high_water_cursor FROM owner_event_state WHERE root_key = 1',
          ).one().high_water_cursor,
        };
      });
      expect(proof).toEqual({
        rejection: 'ResponsibilityJudgmentConflictError',
        request: { revision: 2, state: 'superseded' },
        decisions: 0,
        grants: 0,
        highWater: 4,
      });
    },
  );

  it.each(['preflight', 'commit'] as const)(
    'atomically supersedes on revocation generation 0 to 1 at %s',
    async (stage) => {
      const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
        let id = 0;
        let armed = false;
        let answerHashReads = 0;
        let revocationGeneration = 0;
        const coordinator = new WaldoCoordinator(state.storage, {
          now: () => '2026-08-16T10:00:00.000Z',
          newId: (kind) => `${kind}_judgment_${++id}`,
          sha256Hex: async (value) => {
            if (armed) {
              answerHashReads += 1;
              if (stage === 'commit' && answerHashReads === 5) revocationGeneration = 1;
            }
            return sha256Hex(value);
          },
          resolveJudgmentAdmissionV05: (input) => {
            const grantee = { kind: 'service' as const, id: 'effect_engine' };
            return {
              grantee,
              revocationGeneration,
              admissionContextMaterial: JSON.stringify([
                'revocation-test', input.ownerId, input.subject, input.affectedDigest,
                grantee, input.ownerPolicyRevision, revocationGeneration,
              ]),
            };
          },
        });
        const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
        const item = await coordinator.createTrustedJudgmentRequestV05(
          proposal(captured.workUnits[0]!), canonicalAuthority,
        );
        if (stage === 'preflight') revocationGeneration = 1;
        armed = true;
        let rejection = '';
        try {
          await coordinator.answerAuthorizedJudgmentV05(
            { routedOwnerId: authority.ownerId, request: answerFor(item) },
            canonicalAuthority,
          );
        } catch (error) {
          rejection = (error as Error).name;
        }
        return {
          rejection,
          request: state.storage.sql.exec<{ revision: number; state: string }>(
            'SELECT revision, state FROM judgment_requests',
          ).one(),
          decisions: state.storage.sql.exec<{ count: number }>(
            'SELECT count(*) AS count FROM judgment_decisions',
          ).one().count,
          grants: state.storage.sql.exec<{ count: number }>(
            'SELECT count(*) AS count FROM authority_grants',
          ).one().count,
          commands: state.storage.sql.exec<{ count: number }>(
            'SELECT count(*) AS count FROM judgment_commands',
          ).one().count,
          highWater: state.storage.sql.exec<{ high_water_cursor: number }>(
            'SELECT high_water_cursor FROM owner_event_state WHERE root_key = 1',
          ).one().high_water_cursor,
        };
      });
      expect(proof).toEqual({
        rejection: 'ResponsibilityJudgmentConflictError',
        request: { revision: 2, state: 'superseded' },
        decisions: 0,
        grants: 0,
        commands: 0,
        highWater: 4,
      });
    },
  );

  it('reconstructs and verifies Request, Decision, and Grant from the owner journal', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const dependencies: CoordinatorDependencies = {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      };
      const coordinator = new WaldoCoordinator(state.storage, dependencies);
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      await coordinator.answerAuthorizedJudgmentV05(
        { routedOwnerId: authority.ownerId, request: answerFor(item) },
        canonicalAuthority,
      );
      return new WaldoCoordinator(state.storage, dependencies).replayJudgmentsV05(
        authority.ownerId,
        canonicalAuthority,
      );
    });
    expect(proof.requests).toHaveLength(1);
    expect(proof.requests[0]).toMatchObject({ revision: 2, state: 'answered' });
    expect(proof.decisions).toHaveLength(1);
    expect(proof.grants).toHaveLength(1);
  });

  it('rejects coordinated request digest forgery before replay or snapshot deletion', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      await coordinator.answerAuthorizedJudgmentV05(
        { routedOwnerId: authority.ownerId, request: answerFor(item) },
        canonicalAuthority,
      );
      const forgedDigest = `sha256:${'f'.repeat(64)}`;
      for (const row of state.storage.sql.exec<{
        owner_cursor: number; aggregate_kind: string; payload_json: string;
      }>(
        `SELECT owner_cursor, aggregate_kind, payload_json FROM owner_domain_events
          WHERE schema_version = '0.5' ORDER BY owner_cursor`,
      ).toArray()) {
        const payload = JSON.parse(row.payload_json);
        if (row.aggregate_kind === 'judgment_request') {
          payload.displayedRequestDigest = forgedDigest;
        } else if (row.aggregate_kind === 'judgment_decision') {
          payload.displayedRequestDigest = forgedDigest;
        } else {
          continue;
        }
        state.storage.sql.exec(
          'UPDATE owner_domain_events SET payload_json = ? WHERE owner_cursor = ?',
          JSON.stringify(payload),
          row.owner_cursor,
        );
      }
      state.storage.sql.exec(
        'UPDATE judgment_requests SET displayed_request_digest = ?',
        forgedDigest,
      );
      const decisionRow = state.storage.sql.exec<{ decision_json: string }>(
        'SELECT decision_json FROM judgment_decisions',
      ).one();
      state.storage.sql.exec(
        'UPDATE judgment_decisions SET decision_json = ?',
        JSON.stringify({ ...JSON.parse(decisionRow.decision_json),
          displayedRequestDigest: forgedDigest }),
      );
      for (const row of state.storage.sql.exec<{ owner_cursor: number; item_json: string }>(
        'SELECT owner_cursor, item_json FROM judgment_projection ORDER BY owner_cursor',
      ).toArray()) {
        state.storage.sql.exec(
          'UPDATE judgment_projection SET item_json = ? WHERE owner_cursor = ?',
          JSON.stringify({ ...JSON.parse(row.item_json), displayedRequestDigest: forgedDigest }),
          row.owner_cursor,
        );
      }
      const before = {
        snapshot: state.storage.sql.exec(
          'SELECT * FROM judgment_projection_state',
        ).toArray(),
        projection: state.storage.sql.exec(
          'SELECT * FROM judgment_projection ORDER BY owner_cursor',
        ).toArray(),
      };
      let replayRejection = '';
      try {
        await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
      } catch (error) {
        replayRejection = (error as Error).name;
      }
      let rebuildRejection = '';
      try {
        await coordinator.rebuildJudgmentProjectionV05(authority.ownerId, canonicalAuthority);
      } catch (error) {
        rebuildRejection = (error as Error).name;
      }
      return {
        replayRejection,
        rebuildRejection,
        before,
        after: {
          snapshot: state.storage.sql.exec(
            'SELECT * FROM judgment_projection_state',
          ).toArray(),
          projection: state.storage.sql.exec(
            'SELECT * FROM judgment_projection ORDER BY owner_cursor',
          ).toArray(),
        },
      };
    });
    expect(proof.replayRejection).toBe('ResponsibilityJudgmentConflictError');
    expect(proof.rebuildRejection).toBe('ResponsibilityJudgmentConflictError');
    expect(proof.after).toEqual(proof.before);
  });

  it('rejects an unknown v0.5 journal aggregate even when current tables still reconcile', async () => {
    const rejection = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      state.storage.sql.exec(
        `INSERT INTO owner_domain_events (
          owner_cursor, schema_version, event_id, owner_id, aggregate_kind, aggregate_id,
          revision, event_type, causation_id, correlation_id, occurred_at, payload_json
        ) VALUES (4, '0.5', 'event_unknown_01', ?, 'unknown_judgment_kind',
          'unknown_aggregate_01', 1, 'unknown.event', 'cause_unknown_01',
          'correlation_unknown_01', '2026-08-16T10:00:00.000Z', '{}')`,
        authority.ownerId,
      );
      state.storage.sql.exec(
        'UPDATE owner_event_state SET high_water_cursor = 4 WHERE root_key = 1',
      );
      try {
        await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
        return '';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(rejection).toBe('ResponsibilityJudgmentConflictError');
  });

  it.each(['relabel_only', 'relabel_and_remove_current'] as const)(
    'rejects a known judgment aggregate relabeled away from v0.5: %s',
    async (mutation) => {
      const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
        let id = 0;
        const coordinator = new WaldoCoordinator(state.storage, {
          now: () => '2026-08-16T10:00:00.000Z',
          newId: (kind) => `${kind}_judgment_${++id}`,
          sha256Hex,
        });
        const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
        await coordinator.createTrustedJudgmentRequestV05(
          proposal(captured.workUnits[0]!), canonicalAuthority,
        );
        state.storage.sql.exec(
          `UPDATE owner_domain_events SET schema_version = '0.4'
            WHERE aggregate_kind = 'judgment_request'`,
        );
        if (mutation === 'relabel_and_remove_current') {
          state.storage.sql.exec('DELETE FROM judgment_requests');
        }
        const before = state.storage.sql.exec(
          'SELECT * FROM judgment_projection_state',
        ).toArray();
        const rejection: string[] = [];
        for (const operation of ['replay', 'rebuild'] as const) {
          try {
            if (operation === 'replay') {
              await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
            } else {
              await coordinator.rebuildJudgmentProjectionV05(
                authority.ownerId,
                canonicalAuthority,
              );
            }
          } catch (error) {
            rejection.push((error as Error).name);
          }
        }
        return {
          rejection,
          snapshotUnchanged: JSON.stringify(before) === JSON.stringify(
            state.storage.sql.exec('SELECT * FROM judgment_projection_state').toArray(),
          ),
        };
      });
      expect(proof).toEqual({
        rejection: [
          'ResponsibilityJudgmentConflictError',
          'ResponsibilityJudgmentConflictError',
        ],
        snapshotUnchanged: true,
      });
    },
  );

  it.each(['remove', 'corrupt', 'coordinated_corrupt', 'insert'] as const)(
    'rejects %s judgment command drift from the answered journal transition',
    async (mutation) => {
      const rejection = await runInDurableObject(freshStub(), async (_instance, state) => {
        let id = 0;
        const coordinator = new WaldoCoordinator(state.storage, {
          now: () => '2026-08-16T10:00:00.000Z',
          newId: (kind) => `${kind}_judgment_${++id}`,
          sha256Hex,
        });
        const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
        const item = await coordinator.createTrustedJudgmentRequestV05(
          proposal(captured.workUnits[0]!), canonicalAuthority,
        );
        await coordinator.answerAuthorizedJudgmentV05(
          { routedOwnerId: authority.ownerId, request: answerFor(item) },
          canonicalAuthority,
        );
        if (mutation === 'remove') {
          state.storage.sql.exec('DELETE FROM judgment_commands');
        } else if (mutation === 'corrupt') {
          state.storage.sql.exec(
            `UPDATE judgment_commands SET request_digest = ?`,
            `sha256:${'a'.repeat(64)}`,
          );
        } else if (mutation === 'coordinated_corrupt') {
          const event = state.storage.sql.exec<{
            owner_cursor: number; payload_json: string;
          }>(
            `SELECT owner_cursor, payload_json FROM owner_domain_events
              WHERE event_type = 'judgment_request.answered'`,
          ).one();
          const payload = JSON.parse(event.payload_json);
          payload.answerProof.result = {
            ...payload.answerProof.result,
            selectedOptionId: 'refuse_schedule',
          };
          state.storage.sql.exec(
            'UPDATE owner_domain_events SET payload_json = ? WHERE owner_cursor = ?',
            JSON.stringify(payload), event.owner_cursor,
          );
          state.storage.sql.exec(
            'UPDATE judgment_commands SET result_json = ?',
            JSON.stringify(payload.answerProof.result),
          );
        } else {
          state.storage.sql.exec(
            `INSERT INTO judgment_commands (
              request_id, owner_id, request_digest, result_json, recorded_at
            ) SELECT 'answer_inserted_01', owner_id, request_digest, result_json, recorded_at
                FROM judgment_commands LIMIT 1`,
          );
        }
        try {
          await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
          return '';
        } catch (error) {
          return (error as Error).name;
        }
      });
      expect(rejection).toBe('ResponsibilityJudgmentConflictError');
    },
  );

  it.each([
    'opened_causation', 'decision_causation', 'answered_causation',
    'grant_causation', 'correlation_drift', 'coordinated_command_id',
  ] as const)('rejects judgment event audit-chain drift: %s', async (mutation) => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      await coordinator.answerAuthorizedJudgmentV05(
        { routedOwnerId: authority.ownerId, request: answerFor(item) },
        canonicalAuthority,
      );
      if (mutation === 'opened_causation') {
        state.storage.sql.exec(
          `UPDATE owner_domain_events SET causation_id = 'cause_attacker'
            WHERE event_type = 'judgment_request.opened'`,
        );
      } else if (mutation === 'decision_causation') {
        state.storage.sql.exec(
          `UPDATE owner_domain_events SET causation_id = 'cause_attacker'
            WHERE aggregate_kind = 'judgment_decision'`,
        );
      } else if (mutation === 'answered_causation') {
        state.storage.sql.exec(
          `UPDATE owner_domain_events SET causation_id = 'cause_attacker'
            WHERE event_type = 'judgment_request.answered'`,
        );
      } else if (mutation === 'grant_causation') {
        state.storage.sql.exec(
          `UPDATE owner_domain_events SET causation_id = 'cause_attacker'
            WHERE aggregate_kind = 'authority_grant'`,
        );
      } else if (mutation === 'correlation_drift') {
        state.storage.sql.exec(
          `UPDATE owner_domain_events SET correlation_id = 'correlation_attacker'
            WHERE aggregate_kind = 'judgment_decision'`,
        );
      } else {
        const rewrittenId = 'answer_rewritten_01';
        state.storage.sql.exec(
          `UPDATE owner_domain_events SET causation_id = ?
            WHERE aggregate_kind = 'judgment_decision'
               OR event_type = 'judgment_request.answered'`,
          rewrittenId,
        );
        const answered = state.storage.sql.exec<{
          owner_cursor: number; payload_json: string;
        }>(
          `SELECT owner_cursor, payload_json FROM owner_domain_events
            WHERE event_type = 'judgment_request.answered'`,
        ).one();
        const payload = JSON.parse(answered.payload_json);
        payload.answerProof = {
          ...payload.answerProof,
          requestId: rewrittenId,
          result: { ...payload.answerProof.result, requestId: rewrittenId },
        };
        state.storage.sql.exec(
          'UPDATE owner_domain_events SET payload_json = ? WHERE owner_cursor = ?',
          JSON.stringify(payload), answered.owner_cursor,
        );
        state.storage.sql.exec(
          `UPDATE judgment_commands SET request_id = ?, result_json = ?`,
          rewrittenId,
          JSON.stringify(payload.answerProof.result),
        );
      }
      const before = {
        projection: state.storage.sql.exec(
          'SELECT * FROM judgment_projection ORDER BY owner_cursor',
        ).toArray(),
        snapshot: state.storage.sql.exec(
          'SELECT * FROM judgment_projection_state',
        ).toArray(),
      };
      const rejection: string[] = [];
      for (const operation of ['replay', 'rebuild'] as const) {
        try {
          if (operation === 'replay') {
            await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
          } else {
            await coordinator.rebuildJudgmentProjectionV05(
              authority.ownerId,
              canonicalAuthority,
            );
          }
        } catch (error) {
          rejection.push((error as Error).name);
        }
      }
      return {
        rejection,
        before,
        after: {
          projection: state.storage.sql.exec(
            'SELECT * FROM judgment_projection ORDER BY owner_cursor',
          ).toArray(),
          snapshot: state.storage.sql.exec(
            'SELECT * FROM judgment_projection_state',
          ).toArray(),
        },
      };
    });
    expect(proof.rejection).toEqual([
      'ResponsibilityJudgmentConflictError',
      'ResponsibilityJudgmentConflictError',
    ]);
    expect(proof.after).toEqual(proof.before);
  });

  it.each(['terminal_causation', 'coordinated_terminal_trigger'] as const)(
    'rejects terminal judgment trigger-chain drift: %s',
    async (mutation) => {
      const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
        let id = 0;
        let now = '2026-08-16T10:00:00.000Z';
        const coordinator = new WaldoCoordinator(state.storage, {
          now: () => now,
          newId: (kind) => `${kind}_judgment_${++id}`,
          sha256Hex,
        });
        const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
        const item = await coordinator.createTrustedJudgmentRequestV05(
          proposal(captured.workUnits[0]!), canonicalAuthority,
        );
        now = item.request.expiresAt;
        await expect(coordinator.answerAuthorizedJudgmentV05(
          { routedOwnerId: authority.ownerId, request: answerFor(item) },
          canonicalAuthority,
        )).rejects.toMatchObject({ name: 'ResponsibilityJudgmentConflictError' });
        const terminal = state.storage.sql.exec<{
          owner_cursor: number; payload_json: string;
        }>(
          `SELECT owner_cursor, payload_json FROM owner_domain_events
            WHERE event_type = 'judgment_request.expired'`,
        ).one();
        if (mutation === 'terminal_causation') {
          state.storage.sql.exec(
            `UPDATE owner_domain_events SET causation_id = 'cause_attacker'
              WHERE owner_cursor = ?`,
            terminal.owner_cursor,
          );
        } else {
          const rewrittenId = 'answer_terminal_rewritten_01';
          const payload = JSON.parse(terminal.payload_json);
          const answer = JSON.parse(payload.terminalTriggerProof.requestMaterial);
          answer.requestId = rewrittenId;
          payload.terminalTriggerProof = {
            ...payload.terminalTriggerProof,
            requestId: rewrittenId,
            requestMaterial: canonicalizeJudgmentAnswerRequestV05ForDigest(answer),
          };
          state.storage.sql.exec(
            `UPDATE owner_domain_events
                SET causation_id = ?, correlation_id = ?, payload_json = ?
              WHERE owner_cursor = ?`,
            rewrittenId,
            rewrittenId,
            JSON.stringify(payload),
            terminal.owner_cursor,
          );
        }
        const before = {
          projection: state.storage.sql.exec(
            'SELECT * FROM judgment_projection ORDER BY owner_cursor',
          ).toArray(),
          snapshot: state.storage.sql.exec(
            'SELECT * FROM judgment_projection_state',
          ).toArray(),
        };
        const rejection: string[] = [];
        for (const operation of ['replay', 'rebuild'] as const) {
          try {
            if (operation === 'replay') {
              await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
            } else {
              await coordinator.rebuildJudgmentProjectionV05(
                authority.ownerId,
                canonicalAuthority,
              );
            }
          } catch (error) {
            rejection.push((error as Error).name);
          }
        }
        return {
          rejection,
          before,
          after: {
            projection: state.storage.sql.exec(
              'SELECT * FROM judgment_projection ORDER BY owner_cursor',
            ).toArray(),
            snapshot: state.storage.sql.exec(
              'SELECT * FROM judgment_projection_state',
            ).toArray(),
          },
        };
      });
      expect(proof.rejection).toEqual([
        'ResponsibilityJudgmentConflictError',
        'ResponsibilityJudgmentConflictError',
      ]);
      expect(proof.after).toEqual(proof.before);
    },
  );

  it('rejects a coordinated pre-EffectEngine consumed Grant in journal and current state', async () => {
    const rejection = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      await coordinator.answerAuthorizedJudgmentV05(
        { routedOwnerId: authority.ownerId, request: answerFor(item) },
        canonicalAuthority,
      );
      const event = state.storage.sql.exec<{ owner_cursor: number; payload_json: string }>(
        `SELECT owner_cursor, payload_json FROM owner_domain_events
          WHERE aggregate_kind = 'authority_grant'`,
      ).one();
      const exhausted = {
        ...JSON.parse(event.payload_json),
        state: 'exhausted',
        usesConsumed: 1,
        nextUseIndex: 2,
      };
      state.storage.sql.exec(
        'UPDATE owner_domain_events SET payload_json = ? WHERE owner_cursor = ?',
        JSON.stringify(exhausted),
        event.owner_cursor,
      );
      state.storage.sql.exec(
        `UPDATE authority_grants
            SET grant_json = ?, state = 'exhausted', uses_consumed = 1, next_use_index = 2`,
        JSON.stringify(exhausted),
      );
      try {
        await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
        return '';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(rejection).toBe('ResponsibilityJudgmentConflictError');
  });

  it('rejects legacy Decision assurance even when journal and current state agree', async () => {
    const rejection = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      await coordinator.answerAuthorizedJudgmentV05(
        { routedOwnerId: authority.ownerId, request: answerFor(item, 'refuse_schedule') },
        canonicalAuthority,
      );
      const event = state.storage.sql.exec<{ owner_cursor: number; payload_json: string }>(
        `SELECT owner_cursor, payload_json FROM owner_domain_events
          WHERE aggregate_kind = 'judgment_decision'`,
      ).one();
      const legacy = { ...JSON.parse(event.payload_json), authAssurance: 'legacy_unverified' };
      state.storage.sql.exec(
        'UPDATE owner_domain_events SET payload_json = ? WHERE owner_cursor = ?',
        JSON.stringify(legacy),
        event.owner_cursor,
      );
      state.storage.sql.exec(
        'UPDATE judgment_decisions SET decision_json = ?',
        JSON.stringify(legacy),
      );
      try {
        await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
        return '';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(rejection).toBe('ResponsibilityJudgmentConflictError');
  });

  it('rejects a coordinated refusal Decision at request expiry', async () => {
    const rejection = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      await coordinator.answerAuthorizedJudgmentV05(
        { routedOwnerId: authority.ownerId, request: answerFor(item, 'refuse_schedule') },
        canonicalAuthority,
      );
      const decidedAt = item.request.expiresAt;
      const decisionEvent = state.storage.sql.exec<{
        owner_cursor: number; payload_json: string;
      }>(
        `SELECT owner_cursor, payload_json FROM owner_domain_events
          WHERE aggregate_kind = 'judgment_decision'`,
      ).one();
      const decision = { ...JSON.parse(decisionEvent.payload_json), decidedAt };
      state.storage.sql.exec(
        `UPDATE owner_domain_events SET payload_json = ?, occurred_at = ?
          WHERE owner_cursor = ?`,
        JSON.stringify(decision), decidedAt, decisionEvent.owner_cursor,
      );
      state.storage.sql.exec(
        'UPDATE judgment_decisions SET decision_json = ?, decided_at = ?',
        JSON.stringify(decision), decidedAt,
      );
      const answeredEvent = state.storage.sql.exec<{
        owner_cursor: number; payload_json: string;
      }>(
        `SELECT owner_cursor, payload_json FROM owner_domain_events
          WHERE event_type = 'judgment_request.answered'`,
      ).one();
      const answeredPayload = JSON.parse(answeredEvent.payload_json);
      answeredPayload.request = { ...answeredPayload.request, updatedAt: decidedAt };
      answeredPayload.answerProof = { ...answeredPayload.answerProof, recordedAt: decidedAt };
      answeredPayload.displayedRequestDigest = `sha256:${await sha256Hex(
        canonicalizeJudgmentRequestV05ForDigest(answeredPayload.request),
      )}`;
      state.storage.sql.exec(
        `UPDATE owner_domain_events SET payload_json = ?, occurred_at = ?
          WHERE owner_cursor = ?`,
        JSON.stringify(answeredPayload), decidedAt, answeredEvent.owner_cursor,
      );
      state.storage.sql.exec(
        `UPDATE judgment_requests
            SET request_json = ?, displayed_request_digest = ?, updated_at = ?`,
        canonicalizeJudgmentRequestV05ForDigest(answeredPayload.request),
        answeredPayload.displayedRequestDigest,
        decidedAt,
      );
      state.storage.sql.exec(
        'UPDATE judgment_commands SET recorded_at = ?',
        decidedAt,
      );
      const projection = state.storage.sql.exec<{
        owner_cursor: number; item_json: string;
      }>(
        'SELECT owner_cursor, item_json FROM judgment_projection WHERE owner_cursor = ?',
        answeredEvent.owner_cursor,
      ).one();
      state.storage.sql.exec(
        'UPDATE judgment_projection SET item_json = ? WHERE owner_cursor = ?',
        JSON.stringify({
          ...JSON.parse(projection.item_json),
          request: answeredPayload.request,
          displayedRequestDigest: answeredPayload.displayedRequestDigest,
        }),
        projection.owner_cursor,
      );
      try {
        await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
        return '';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(rejection).toBe('ResponsibilityJudgmentConflictError');
  });

  it('rejects a coordinated Grant whose update time differs from its issue Decision', async () => {
    const rejection = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      await coordinator.answerAuthorizedJudgmentV05(
        { routedOwnerId: authority.ownerId, request: answerFor(item) },
        canonicalAuthority,
      );
      const event = state.storage.sql.exec<{ owner_cursor: number; payload_json: string }>(
        `SELECT owner_cursor, payload_json FROM owner_domain_events
          WHERE aggregate_kind = 'authority_grant'`,
      ).one();
      const grant = {
        ...JSON.parse(event.payload_json),
        updatedAt: '2026-08-16T10:00:00.001Z',
      };
      state.storage.sql.exec(
        'UPDATE owner_domain_events SET payload_json = ? WHERE owner_cursor = ?',
        JSON.stringify(grant), event.owner_cursor,
      );
      state.storage.sql.exec(
        'UPDATE authority_grants SET grant_json = ?, updated_at = ?',
        JSON.stringify(grant), grant.updatedAt,
      );
      try {
        await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
        return '';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(rejection).toBe('ResponsibilityJudgmentConflictError');
  });

  it('rejects a coordinated expired transition recorded before request expiry', async () => {
    const rejection = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      let now = '2026-08-16T10:00:00.000Z';
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      now = item.request.expiresAt;
      await expect(coordinator.answerAuthorizedJudgmentV05(
        { routedOwnerId: authority.ownerId, request: answerFor(item) },
        canonicalAuthority,
      )).rejects.toMatchObject({ name: 'ResponsibilityJudgmentConflictError' });
      const terminalEvent = state.storage.sql.exec<{
        owner_cursor: number; payload_json: string;
      }>(
        `SELECT owner_cursor, payload_json FROM owner_domain_events
          WHERE event_type = 'judgment_request.expired'`,
      ).one();
      const payload = JSON.parse(terminalEvent.payload_json);
      payload.request = {
        ...payload.request,
        updatedAt: '2026-08-16T10:29:59.999Z',
      };
      payload.displayedRequestDigest = `sha256:${await sha256Hex(
        canonicalizeJudgmentRequestV05ForDigest(payload.request),
      )}`;
      state.storage.sql.exec(
        `UPDATE owner_domain_events SET payload_json = ?, occurred_at = ?
          WHERE owner_cursor = ?`,
        JSON.stringify(payload), payload.request.updatedAt, terminalEvent.owner_cursor,
      );
      state.storage.sql.exec(
        `UPDATE judgment_requests
            SET request_json = ?, displayed_request_digest = ?, updated_at = ?`,
        canonicalizeJudgmentRequestV05ForDigest(payload.request),
        payload.displayedRequestDigest,
        payload.request.updatedAt,
      );
      const projection = state.storage.sql.exec<{ item_json: string }>(
        'SELECT item_json FROM judgment_projection WHERE owner_cursor = ?',
        terminalEvent.owner_cursor,
      ).one();
      state.storage.sql.exec(
        'UPDATE judgment_projection SET item_json = ? WHERE owner_cursor = ?',
        JSON.stringify({
          ...JSON.parse(projection.item_json),
          request: payload.request,
          displayedRequestDigest: payload.displayedRequestDigest,
        }),
        terminalEvent.owner_cursor,
      );
      try {
        await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
        return '';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(rejection).toBe('ResponsibilityJudgmentConflictError');
  });

  it.each(['opened_state', 'terminal_type', 'decision_type', 'grant_type'] as const)(
    'rejects strict v0.5 journal transition violation %s',
    async (violation) => {
      const rejection = await runInDurableObject(freshStub(), async (_instance, state) => {
        let id = 0;
        const coordinator = new WaldoCoordinator(state.storage, {
          now: () => '2026-08-16T10:00:00.000Z',
          newId: (kind) => `${kind}_judgment_${++id}`,
          sha256Hex,
        });
        const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
        const item = await coordinator.createTrustedJudgmentRequestV05(
          proposal(captured.workUnits[0]!), canonicalAuthority,
        );
        await coordinator.answerAuthorizedJudgmentV05(
          { routedOwnerId: authority.ownerId, request: answerFor(item) },
          canonicalAuthority,
        );
        if (violation === 'opened_state') {
          const row = state.storage.sql.exec<{ owner_cursor: number; payload_json: string }>(
            `SELECT owner_cursor, payload_json FROM owner_domain_events
              WHERE event_type = 'judgment_request.opened'`,
          ).one();
          const payload = JSON.parse(row.payload_json);
          payload.request = { ...payload.request, state: 'expired' };
          state.storage.sql.exec(
            'UPDATE owner_domain_events SET payload_json = ? WHERE owner_cursor = ?',
            JSON.stringify(payload),
            row.owner_cursor,
          );
        } else if (violation === 'terminal_type') {
          state.storage.sql.exec(
            `UPDATE owner_domain_events SET event_type = 'judgment_request.superseded'
              WHERE event_type = 'judgment_request.answered'`,
          );
        } else if (violation === 'decision_type') {
          state.storage.sql.exec(
            `UPDATE owner_domain_events SET event_type = 'judgment_decision.unknown'
              WHERE aggregate_kind = 'judgment_decision'`,
          );
        } else {
          state.storage.sql.exec(
            `UPDATE owner_domain_events SET event_type = 'authority_grant.unknown'
              WHERE aggregate_kind = 'authority_grant'`,
          );
        }
        try {
          await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
          return '';
        } catch (error) {
          return (error as Error).name;
        }
      });
      expect(rejection).toBe('ResponsibilityJudgmentConflictError');
    },
  );

  it.each(['decision_request', 'grant_admission'] as const)(
    'rejects mutually matching journal/current corruption of %s relationships',
    async (corruption) => {
      const rejection = await runInDurableObject(freshStub(), async (_instance, state) => {
        let id = 0;
        const coordinator = new WaldoCoordinator(state.storage, {
          now: () => '2026-08-16T10:00:00.000Z',
          newId: (kind) => `${kind}_judgment_${++id}`,
          sha256Hex,
        });
        const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
        const item = await coordinator.createTrustedJudgmentRequestV05(
          proposal(captured.workUnits[0]!), canonicalAuthority,
        );
        await coordinator.answerAuthorizedJudgmentV05(
          { routedOwnerId: authority.ownerId, request: answerFor(item) },
          canonicalAuthority,
        );
        if (corruption === 'decision_request') {
          const row = state.storage.sql.exec<{ payload_json: string }>(
            `SELECT payload_json FROM owner_domain_events
              WHERE aggregate_kind = 'judgment_decision'`,
          ).one();
          const corrupt = {
            ...JSON.parse(row.payload_json),
            judgmentRequestId: 'judgment_request_orphan_01',
          };
          state.storage.sql.exec(
            `UPDATE owner_domain_events SET payload_json = ?
              WHERE aggregate_kind = 'judgment_decision'`,
            JSON.stringify(corrupt),
          );
          state.storage.sql.exec(
            'UPDATE judgment_decisions SET decision_json = ?',
            JSON.stringify(corrupt),
          );
        } else {
          const row = state.storage.sql.exec<{ payload_json: string }>(
            `SELECT payload_json FROM owner_domain_events
              WHERE aggregate_kind = 'authority_grant'`,
          ).one();
          const corrupt = {
            ...JSON.parse(row.payload_json),
            grantee: { kind: 'service', id: 'attacker_service' },
          };
          state.storage.sql.exec(
            `UPDATE owner_domain_events SET payload_json = ?
              WHERE aggregate_kind = 'authority_grant'`,
            JSON.stringify(corrupt),
          );
          state.storage.sql.exec(
            'UPDATE authority_grants SET grant_json = ?',
            JSON.stringify(corrupt),
          );
        }
        try {
          await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
          return '';
        } catch (error) {
          return (error as Error).name;
        }
      });
      expect(rejection).toBe('ResponsibilityJudgmentConflictError');
    },
  );

  it.each([
    'request_corrupt', 'request_basis_corrupt', 'request_remove', 'request_insert',
    'decision_corrupt', 'decision_remove', 'decision_insert',
    'grant_corrupt', 'grant_remove', 'grant_insert',
  ] as const)('rejects independent %s current-state drift from the journal', async (mutation) => {
    const rejection = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      await coordinator.answerAuthorizedJudgmentV05(
        { routedOwnerId: authority.ownerId, request: answerFor(item) },
        canonicalAuthority,
      );
      if (mutation === 'request_corrupt') {
        state.storage.sql.exec("UPDATE judgment_requests SET request_json = '{}'");
      } else if (mutation === 'request_basis_corrupt') {
        const row = state.storage.sql.exec<{ admission_basis_json: string }>(
          'SELECT admission_basis_json FROM judgment_requests',
        ).one();
        state.storage.sql.exec(
          'UPDATE judgment_requests SET admission_basis_json = ?',
          JSON.stringify({
            ...JSON.parse(row.admission_basis_json),
            revocationGeneration: 1,
          }),
        );
      } else if (mutation === 'request_remove') {
        state.storage.sql.exec('DELETE FROM judgment_requests');
      } else if (mutation === 'request_insert') {
        state.storage.sql.exec(
          `INSERT INTO judgment_requests (
            id, owner_id, revision, subject_kind, subject_id, subject_revision,
            affected_digest, displayed_request_digest, request_json, admission_basis_json,
            state, decision_id, expires_at, created_at, updated_at
          ) SELECT 'judgment_request_inserted', owner_id, revision, subject_kind, subject_id,
            subject_revision, affected_digest, displayed_request_digest, request_json,
            admission_basis_json, state, decision_id, expires_at, created_at, updated_at
          FROM judgment_requests LIMIT 1`,
        );
      } else if (mutation === 'decision_corrupt') {
        state.storage.sql.exec("UPDATE judgment_decisions SET decision_json = '{}'");
      } else if (mutation === 'decision_remove') {
        state.storage.sql.exec('DELETE FROM judgment_decisions');
      } else if (mutation === 'decision_insert') {
        state.storage.sql.exec(
          `INSERT INTO judgment_decisions (
            id, owner_id, judgment_request_id, revision, decision_json, decided_at
          ) SELECT 'judgment_decision_inserted', owner_id, 'judgment_request_inserted',
            revision, decision_json, decided_at FROM judgment_decisions LIMIT 1`,
        );
      } else if (mutation === 'grant_corrupt') {
        state.storage.sql.exec("UPDATE authority_grants SET grant_json = '{}'");
      } else if (mutation === 'grant_remove') {
        state.storage.sql.exec('DELETE FROM authority_grants');
      } else {
        state.storage.sql.exec(
          `INSERT INTO authority_grants (
            id, owner_id, judgment_request_id, judgment_decision_id, revision, grant_json,
            use_limit, uses_consumed, next_use_index, state, expires_at,
            revocation_generation, created_at, updated_at
          ) SELECT 'authority_grant_inserted', owner_id, 'judgment_request_inserted',
            'judgment_decision_inserted', revision, grant_json, use_limit, uses_consumed,
            next_use_index, state, expires_at, revocation_generation, created_at, updated_at
          FROM authority_grants LIMIT 1`,
        );
      }
      try {
        await coordinator.replayJudgmentsV05(authority.ownerId, canonicalAuthority);
        return '';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(rejection).toBe('ResponsibilityJudgmentConflictError');
  });

  it('rolls back every answer write on an injected crash and then retries cleanly', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      let failAnswer = false;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
        afterWrite: (stage) => {
          if (failAnswer && stage === 'events') throw new Error('injected answer crash');
        },
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      const input = { routedOwnerId: authority.ownerId, request: answerFor(item) };
      failAnswer = true;
      let rejection = '';
      try {
        await coordinator.answerAuthorizedJudgmentV05(input, canonicalAuthority);
      } catch (error) {
        rejection = (error as Error).message;
      }
      const afterCrash = {
        request: state.storage.sql.exec<{ revision: number; state: string }>(
          'SELECT revision, state FROM judgment_requests',
        ).one(),
        decisions: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_decisions',
        ).one().count,
        grants: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM authority_grants',
        ).one().count,
        commands: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_commands',
        ).one().count,
        highWater: state.storage.sql.exec<{ high_water_cursor: number }>(
          'SELECT high_water_cursor FROM owner_event_state WHERE root_key = 1',
        ).one().high_water_cursor,
      };
      failAnswer = false;
      const retried = await coordinator.answerAuthorizedJudgmentV05(input, canonicalAuthority);
      return { rejection, afterCrash, retried };
    });
    expect(proof.rejection).toBe('injected answer crash');
    expect(proof.afterCrash).toEqual({
      request: { revision: 1, state: 'open' },
      decisions: 0,
      grants: 0,
      commands: 0,
      highWater: 3,
    });
    expect(proof.retried).toMatchObject({
      judgmentRequest: { revision: 2 },
      authorityDisposition: 'granted',
    });
  });

  it('rejects a creation race after exact subject reread without a partial judgment write', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      let mutateOnHash = false;
      let workUnitId = '';
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex: async (value) => {
          if (mutateOnHash) {
            mutateOnHash = false;
            state.storage.sql.exec(
              `UPDATE work_units SET responsibility = 'Changed during request admission'
                WHERE id = ?`,
              workUnitId,
            );
          }
          return sha256Hex(value);
        },
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      workUnitId = captured.workUnits[0]!.id;
      mutateOnHash = true;
      let rejection = '';
      try {
        await coordinator.createTrustedJudgmentRequestV05(
          proposal(captured.workUnits[0]!), canonicalAuthority,
        );
      } catch (error) {
        rejection = (error as Error).name;
      }
      return {
        rejection,
        requests: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_requests',
        ).one().count,
        judgmentEvents: state.storage.sql.exec<{ count: number }>(
          "SELECT count(*) AS count FROM owner_domain_events WHERE schema_version = '0.5'",
        ).one().count,
        highWater: state.storage.sql.exec<{ high_water_cursor: number }>(
          'SELECT high_water_cursor FROM owner_event_state WHERE root_key = 1',
        ).one().high_water_cursor,
      };
    });
    expect(proof).toEqual({
      rejection: 'ResponsibilityDigestConflictError',
      requests: 0,
      judgmentEvents: 0,
      highWater: 2,
    });
  });

  it('strictly rejects corrupt private admission basis and stale answer revisions', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      const stale = answerFor(item);
      let staleRejection = '';
      try {
        await coordinator.answerAuthorizedJudgmentV05({
          routedOwnerId: authority.ownerId,
          request: {
            ...stale,
            aggregate: { ...stale.aggregate, expectedRevision: stale.aggregate.expectedRevision + 1 },
          },
        }, canonicalAuthority);
      } catch (error) {
        staleRejection = (error as Error).name;
      }
      const basisRow = state.storage.sql.exec<{ admission_basis_json: string }>(
        'SELECT admission_basis_json FROM judgment_requests',
      ).one();
      state.storage.sql.exec(
        'UPDATE judgment_requests SET admission_basis_json = ?',
        JSON.stringify({ ...JSON.parse(basisRow.admission_basis_json), unexpected: 'rejected' }),
      );
      let basisRejection = '';
      try {
        await coordinator.answerAuthorizedJudgmentV05(
          { routedOwnerId: authority.ownerId, request: answerFor(item) },
          canonicalAuthority,
        );
      } catch (error) {
        basisRejection = (error as Error).name;
      }
      return {
        staleRejection,
        basisRejection,
        request: state.storage.sql.exec<{ revision: number; state: string }>(
          'SELECT revision, state FROM judgment_requests',
        ).one(),
        decisions: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_decisions',
        ).one().count,
      };
    });
    expect(proof).toEqual({
      staleRejection: 'ResponsibilityJudgmentConflictError',
      basisRejection: 'ResponsibilityJudgmentConflictError',
      request: { revision: 1, state: 'open' },
      decisions: 0,
    });
  });

  it('rejects replaced snapshots and corrupt displayed-request projection digests', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      let snapshotRejection = '';
      try {
        await coordinator.readJudgmentProjectionV05({
          routedOwnerId: authority.ownerId,
          query: {
            protocolVersion: '0.5', fromExclusiveCursor: 0, limit: 25,
            snapshotId: 'snapshot_replaced_attacker',
          },
        }, canonicalAuthority);
      } catch (error) {
        snapshotRejection = `${(error as { name: string }).name}:${
          (error as { code?: string }).code ?? ''}`;
      }
      const row = state.storage.sql.exec<{ owner_cursor: number; item_json: string }>(
        'SELECT owner_cursor, item_json FROM judgment_projection',
      ).one();
      const corrupt = JSON.parse(row.item_json);
      corrupt.displayedRequestDigest = `sha256:${'f'.repeat(64)}`;
      state.storage.sql.exec(
        'UPDATE judgment_projection SET item_json = ? WHERE owner_cursor = ?',
        JSON.stringify(corrupt),
        row.owner_cursor,
      );
      let digestRejection = '';
      try {
        await coordinator.readJudgmentProjectionV05({
          routedOwnerId: authority.ownerId,
          query: { protocolVersion: '0.5', fromExclusiveCursor: 0, limit: 25 },
        }, canonicalAuthority);
      } catch (error) {
        digestRejection = (error as Error).name;
      }
      return { snapshotRejection, digestRejection };
    });
    expect(proof).toEqual({
      snapshotRejection: 'ResponsibilityProjectionCursorError:snapshot_replaced',
      digestRejection: 'ResponsibilityDigestConflictError',
    });
  });

  it.each(['{', '{}'])(
    'normalizes malformed judgment projection JSON to a judgment conflict: %s',
    async (itemJson) => {
      const rejection = await runInDurableObject(freshStub(), async (_instance, state) => {
        let id = 0;
        const coordinator = new WaldoCoordinator(state.storage, {
          now: () => '2026-08-16T10:00:00.000Z',
          newId: (kind) => `${kind}_judgment_${++id}`,
          sha256Hex,
        });
        const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
        await coordinator.createTrustedJudgmentRequestV05(
          proposal(captured.workUnits[0]!), canonicalAuthority,
        );
        state.storage.sql.exec('UPDATE judgment_projection SET item_json = ?', itemJson);
        try {
          await coordinator.readJudgmentProjectionV05({
            routedOwnerId: authority.ownerId,
            query: { protocolVersion: '0.5', fromExclusiveCursor: 0, limit: 1 },
          }, canonicalAuthority);
          return '';
        } catch (error) {
          return (error as Error).name;
        }
      });
      expect(rejection).toBe('ResponsibilityJudgmentConflictError');
    },
  );

  it.each(['event', 'decoded_byte'] as const)(
    'accepts the exact judgment replay %s limit and rolls back the next write',
    async (limitKind) => {
      const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
        let id = 0;
        const baseDependencies: CoordinatorDependencies = {
          now: () => '2026-08-16T10:00:00.000Z',
          newId: (kind) => `${kind}_judgment_${++id}`,
          sha256Hex,
        };
        const coordinator = new WaldoCoordinator(state.storage, baseDependencies);
        const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
        const item = await coordinator.createTrustedJudgmentRequestV05(
          proposal(captured.workUnits[0]!), canonicalAuthority,
        );
        const requestEventBytes = new TextEncoder().encode(
          state.storage.sql.exec<{ payload_json: string }>(
            `SELECT payload_json FROM owner_domain_events
              WHERE aggregate_kind = 'judgment_request'`,
          ).one().payload_json,
        ).byteLength;
        const limited = new WaldoCoordinator(state.storage, {
          ...baseDependencies,
          ...(limitKind === 'event'
            ? { judgmentReplayEventLimit: 1 }
            : { judgmentReplayDecodedByteLimit: requestEventBytes }),
        });
        const replay = await limited.replayJudgmentsV05(
          authority.ownerId,
          canonicalAuthority,
        );
        let rejection = '';
        try {
          await limited.answerAuthorizedJudgmentV05(
            { routedOwnerId: authority.ownerId, request: answerFor(item) },
            canonicalAuthority,
          );
        } catch (error) {
          rejection = (error as Error).name;
        }
        return {
          replayRequests: replay.requests.length,
          rejection,
          request: state.storage.sql.exec<{ revision: number; state: string }>(
            'SELECT revision, state FROM judgment_requests',
          ).one(),
          events: state.storage.sql.exec<{ count: number }>(
            `SELECT count(*) AS count FROM owner_domain_events
              WHERE schema_version = '0.5'`,
          ).one().count,
          decisions: state.storage.sql.exec<{ count: number }>(
            'SELECT count(*) AS count FROM judgment_decisions',
          ).one().count,
          grants: state.storage.sql.exec<{ count: number }>(
            'SELECT count(*) AS count FROM authority_grants',
          ).one().count,
          commands: state.storage.sql.exec<{ count: number }>(
            'SELECT count(*) AS count FROM judgment_commands',
          ).one().count,
        };
      });
      expect(proof).toEqual({
        replayRequests: 1,
        rejection: 'ResponsibilityJudgmentConflictError',
        request: { revision: 1, state: 'open' },
        events: 1,
        decisions: 0,
        grants: 0,
        commands: 0,
      });
    },
  );

  it('rejects a limit-one projection row whose JSON cursor could skip the SQL chain', async () => {
    const rejection = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      const row = state.storage.sql.exec<{ owner_cursor: number; item_json: string }>(
        'SELECT owner_cursor, item_json FROM judgment_projection',
      ).one();
      const corrupt = JSON.parse(row.item_json);
      corrupt.cursor = row.owner_cursor + 1;
      state.storage.sql.exec(
        'UPDATE judgment_projection SET item_json = ? WHERE owner_cursor = ?',
        JSON.stringify(corrupt),
        row.owner_cursor,
      );
      try {
        await coordinator.readJudgmentProjectionV05({
          routedOwnerId: authority.ownerId,
          query: { protocolVersion: '0.5', fromExclusiveCursor: 0, limit: 1 },
        }, canonicalAuthority);
        return '';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(rejection).toBe('ResponsibilityJudgmentConflictError');
  });

  it('rejects a projection SQL owner that breaks the per-owner chain', async () => {
    const rejection = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      state.storage.sql.exec(
        "UPDATE judgment_projection SET owner_id = 'owner_projection_attacker'",
      );
      try {
        await coordinator.readJudgmentProjectionV05({
          routedOwnerId: authority.ownerId,
          query: { protocolVersion: '0.5', fromExclusiveCursor: 0, limit: 1 },
        }, canonicalAuthority);
        return '';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(rejection).toBe('ResponsibilityJudgmentConflictError');
  });

  it('reads restart-safe ordered Needs You pages across owner-stream cursor gaps', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const dependencies = {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind: Parameters<CoordinatorDependencies['newId']>[0]) =>
          `${kind}_judgment_${++id}`,
        sha256Hex,
      };
      const coordinator = new WaldoCoordinator(state.storage, dependencies);
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      await coordinator.answerAuthorizedJudgmentV05(
        { routedOwnerId: authority.ownerId, request: answerFor(item) },
        canonicalAuthority,
      );
      const restarted = new WaldoCoordinator(state.storage, dependencies);
      const first = await restarted.readJudgmentProjectionV05({
        routedOwnerId: authority.ownerId,
        query: { protocolVersion: '0.5', fromExclusiveCursor: 0, limit: 1 },
      }, canonicalAuthority);
      const second = await restarted.readJudgmentProjectionV05({
        routedOwnerId: authority.ownerId,
        query: {
          protocolVersion: '0.5',
          fromExclusiveCursor: first.nextCursor,
          limit: 1,
          snapshotId: first.snapshotId,
        },
      }, canonicalAuthority);
      return {
        first: judgmentProjectionPageV05Schema.parse(first),
        second: judgmentProjectionPageV05Schema.parse(second),
      };
    });
    expect(proof.first).toMatchObject({
      fromExclusiveCursor: 0,
      highWaterCursor: 6,
      nextCursor: 3,
      hasMore: true,
      items: [{ cursor: 3, request: { state: 'open', revision: 1 } }],
    });
    expect(proof.second).toMatchObject({
      fromExclusiveCursor: 3,
      highWaterCursor: 6,
      nextCursor: 6,
      hasMore: false,
      items: [{ cursor: 6, request: { state: 'answered', revision: 2 } }],
    });
  });

  it.each([
    'malformed_json', 'stale_digest', 'foreign_owner', 'cursor_mismatch', 'unexpected_extra',
  ] as const)('repairs arbitrary derived projection corruption: %s', async (mutation) => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      await coordinator.answerAuthorizedJudgmentV05(
        { routedOwnerId: authority.ownerId, request: answerFor(item) },
        canonicalAuthority,
      );
      const original = await coordinator.readJudgmentProjectionV05({
        routedOwnerId: authority.ownerId,
        query: { protocolVersion: '0.5', fromExclusiveCursor: 0, limit: 25 },
      }, canonicalAuthority);
      const first = state.storage.sql.exec<{ owner_cursor: number; item_json: string }>(
        'SELECT owner_cursor, item_json FROM judgment_projection ORDER BY owner_cursor LIMIT 1',
      ).one();
      if (mutation === 'malformed_json') {
        state.storage.sql.exec(
          'UPDATE judgment_projection SET item_json = ? WHERE owner_cursor = ?',
          '{', first.owner_cursor,
        );
      } else if (mutation === 'stale_digest') {
        state.storage.sql.exec(
          'UPDATE judgment_projection SET item_json = ? WHERE owner_cursor = ?',
          JSON.stringify({
            ...JSON.parse(first.item_json),
            displayedRequestDigest: `sha256:${'f'.repeat(64)}`,
          }),
          first.owner_cursor,
        );
      } else if (mutation === 'foreign_owner') {
        state.storage.sql.exec(
          "UPDATE judgment_projection SET owner_id = 'owner_projection_attacker'",
        );
      } else if (mutation === 'cursor_mismatch') {
        state.storage.sql.exec(
          'UPDATE judgment_projection SET item_json = ? WHERE owner_cursor = ?',
          JSON.stringify({ ...JSON.parse(first.item_json), cursor: first.owner_cursor + 1 }),
          first.owner_cursor,
        );
      } else {
        state.storage.sql.exec(
          `INSERT INTO judgment_projection (owner_cursor, owner_id, item_json)
            VALUES (999, 'owner_projection_attacker', '{}')`,
        );
      }
      await coordinator.rebuildJudgmentProjectionV05(authority.ownerId, canonicalAuthority);
      const rebuilt = await coordinator.readJudgmentProjectionV05({
        routedOwnerId: authority.ownerId,
        query: { protocolVersion: '0.5', fromExclusiveCursor: 0, limit: 25 },
      }, canonicalAuthority);
      let oldSnapshotRejection = '';
      try {
        await coordinator.readJudgmentProjectionV05({
          routedOwnerId: authority.ownerId,
          query: {
            protocolVersion: '0.5', fromExclusiveCursor: 0, limit: 25,
            snapshotId: original.snapshotId,
          },
        }, canonicalAuthority);
      } catch (error) {
        oldSnapshotRejection = `${(error as Error).name}:${
          (error as { code?: string }).code ?? ''}`;
      }
      return { original, rebuilt, oldSnapshotRejection };
    });
    expect(proof.rebuilt.items).toEqual(proof.original.items);
    expect(proof.rebuilt.snapshotId).not.toBe(proof.original.snapshotId);
    expect(proof.oldSnapshotRejection).toBe(
      'ResponsibilityProjectionCursorError:snapshot_replaced',
    );
  });

  it('rolls back rebuilt projection replacement when post-write validation detects corruption', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      let failRebuild = false;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
        afterJudgmentProjectionRebuildWrite: () => {
          if (!failRebuild) return;
          state.storage.sql.exec("UPDATE judgment_projection SET item_json = '{'");
          state.storage.sql.exec(
            'UPDATE judgment_projection_state SET snapshot_base_cursor = 77',
          );
        },
      });
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      state.storage.sql.exec("UPDATE judgment_projection SET item_json = '{'");
      state.storage.sql.exec(
        `UPDATE judgment_projection_state
            SET snapshot_id = 'snapshot_corrupt_before_rebuild', snapshot_base_cursor = 99`,
      );
      const before = {
        projection: state.storage.sql.exec(
          'SELECT * FROM judgment_projection ORDER BY owner_cursor',
        ).toArray(),
        snapshot: state.storage.sql.exec(
          'SELECT * FROM judgment_projection_state',
        ).toArray(),
      };
      failRebuild = true;
      let rejection = '';
      try {
        await coordinator.rebuildJudgmentProjectionV05(
          authority.ownerId,
          canonicalAuthority,
        );
      } catch (error) {
        rejection = (error as Error).name;
      }
      return {
        rejection,
        before,
        after: {
          projection: state.storage.sql.exec(
            'SELECT * FROM judgment_projection ORDER BY owner_cursor',
          ).toArray(),
          snapshot: state.storage.sql.exec(
            'SELECT * FROM judgment_projection_state',
          ).toArray(),
        },
      };
    });
    expect(proof.rejection).toBe('ResponsibilityJudgmentConflictError');
    expect(proof.after).toEqual(proof.before);
  });

  it('transactionally rebuilds an exact replacement projection from the owner journal', async () => {
    const proof = await runInDurableObject(freshStub(), async (_instance, state) => {
      let id = 0;
      const dependencies: CoordinatorDependencies = {
        now: () => '2026-08-16T10:00:00.000Z',
        newId: (kind) => `${kind}_judgment_${++id}`,
        sha256Hex,
      };
      const coordinator = new WaldoCoordinator(state.storage, dependencies);
      const { captured, canonicalAuthority } = await captureWorkUnit(coordinator);
      const item = await coordinator.createTrustedJudgmentRequestV05(
        proposal(captured.workUnits[0]!), canonicalAuthority,
      );
      await coordinator.answerAuthorizedJudgmentV05(
        { routedOwnerId: authority.ownerId, request: answerFor(item) },
        canonicalAuthority,
      );
      const original = await coordinator.readJudgmentProjectionV05({
        routedOwnerId: authority.ownerId,
        query: { protocolVersion: '0.5', fromExclusiveCursor: 0, limit: 25 },
      }, canonicalAuthority);
      const canonicalBefore = {
        requests: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_requests',
        ).one().count,
        decisions: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_decisions',
        ).one().count,
        grants: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM authority_grants',
        ).one().count,
        events: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM owner_domain_events',
        ).one().count,
      };
      state.storage.sql.exec('DELETE FROM judgment_projection');
      state.storage.sql.exec(
        `UPDATE judgment_projection_state
            SET snapshot_id = 'snapshot_corrupt', snapshot_base_cursor = 5`,
      );
      await coordinator.rebuildJudgmentProjectionV05(authority.ownerId, canonicalAuthority);
      let replacedRejection = '';
      try {
        await coordinator.readJudgmentProjectionV05({
          routedOwnerId: authority.ownerId,
          query: {
            protocolVersion: '0.5', fromExclusiveCursor: 0, limit: 25,
            snapshotId: original.snapshotId,
          },
        }, canonicalAuthority);
      } catch (error) {
        replacedRejection = `${(error as { name: string }).name}:${
          (error as { code?: string }).code ?? ''}`;
      }
      const rebuilt = await coordinator.readJudgmentProjectionV05({
        routedOwnerId: authority.ownerId,
        query: { protocolVersion: '0.5', fromExclusiveCursor: 0, limit: 25 },
      }, canonicalAuthority);
      const canonicalAfter = {
        requests: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_requests',
        ).one().count,
        decisions: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM judgment_decisions',
        ).one().count,
        grants: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM authority_grants',
        ).one().count,
        events: state.storage.sql.exec<{ count: number }>(
          'SELECT count(*) AS count FROM owner_domain_events',
        ).one().count,
      };
      return { original, rebuilt, replacedRejection, canonicalBefore, canonicalAfter };
    });
    expect(proof.replacedRejection).toBe(
      'ResponsibilityProjectionCursorError:snapshot_replaced',
    );
    expect(proof.rebuilt.snapshotId).not.toBe(proof.original.snapshotId);
    expect(proof.rebuilt.snapshotBaseCursor).toBe(0);
    expect(proof.rebuilt.highWaterCursor).toBe(proof.original.highWaterCursor);
    expect(proof.rebuilt.items).toEqual(proof.original.items);
    expect(proof.canonicalAfter).toEqual(proof.canonicalBefore);
  });
});
