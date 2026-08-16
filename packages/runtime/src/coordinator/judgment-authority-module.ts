import {
  authorityGrantV05Schema,
  canonicalizeAuthorityGrantV05ForDigest,
  canonicalizeJudgmentDecisionV05ForDigest,
  canonicalizeJudgmentRequestV05ForDigest,
  judgmentAnswerResultV05Schema,
  judgmentAuthorityBindingV05Schema,
  judgmentDecisionV05Schema,
  judgmentRequestV05Schema,
  authorityGranteeV05Schema,
  judgmentSubjectV05Schema,
  protocolDigestSchema,
  protocolIdSchema,
  protocolRevisionSchema,
  type JudgmentAnswerResultV05,
  type JudgmentAuthorityBindingV05,
  type JudgmentDecisionV05,
  type AuthorityGrantV05,
  type JudgmentRequestV05,
} from '@waldo/contracts';
import { ResponsibilityJudgmentConflictError } from '../responsibility/errors';
import { OwnerEventLog } from './owner-event-log';
import {
  ProjectionPublisher,
  serializeJudgmentRequestEventPayloadV05,
  validateJudgmentRequestEventV05,
  type JudgmentProjectionItemV05,
  type JudgmentAnswerCommandProofV05,
  type JudgmentRequestDigestProofV05,
} from './projection-publisher';

export type JudgmentAdmissionBasisV05 = Readonly<{
  ownerId: string;
  subject: JudgmentRequestV05['subject'];
  affectedDigest: `sha256:${string}`;
  grantee: Exclude<JudgmentRequestV05['authorityAdmission'], null>['grantee'] | null;
  ownerPolicyRevision: number;
  admissionContextDigest: `sha256:${string}` | null;
  revocationGeneration: number;
}>;

const ADMISSION_BASIS_KEYS = [
  'ownerId', 'subject', 'affectedDigest', 'grantee', 'ownerPolicyRevision',
  'admissionContextDigest', 'revocationGeneration',
] as const;

function parseJudgmentAdmissionBasisV05(value: unknown): JudgmentAdmissionBasisV05 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ResponsibilityJudgmentConflictError();
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...ADMISSION_BASIS_KEYS].sort())) {
    throw new ResponsibilityJudgmentConflictError();
  }
  const grantee = candidate.grantee === null
    ? null
    : authorityGranteeV05Schema.parse(candidate.grantee);
  const admissionContextDigest = candidate.admissionContextDigest === null
    ? null
    : protocolDigestSchema.parse(candidate.admissionContextDigest);
  if ((grantee === null) !== (admissionContextDigest === null)) {
    throw new ResponsibilityJudgmentConflictError();
  }
  return Object.freeze({
    ownerId: protocolIdSchema.parse(candidate.ownerId),
    subject: judgmentSubjectV05Schema.parse(candidate.subject),
    affectedDigest: protocolDigestSchema.parse(candidate.affectedDigest) as `sha256:${string}`,
    grantee,
    ownerPolicyRevision: protocolRevisionSchema.parse(candidate.ownerPolicyRevision),
    admissionContextDigest: admissionContextDigest as `sha256:${string}` | null,
    revocationGeneration: protocolRevisionSchema.parse(candidate.revocationGeneration),
  });
}

type StoredRequestRow = Readonly<{
  owner_id: string;
  revision: number;
  displayed_request_digest: string;
  request_json: string;
  admission_basis_json: string;
  state: string;
}>;

export type StoredJudgmentRequestV05 = Readonly<{
  request: JudgmentRequestV05;
  displayedRequestDigest: `sha256:${string}`;
  admissionBasis: JudgmentAdmissionBasisV05;
}>;

/** Sole writer for JudgmentRequest, Decision, and AuthorityGrant. */
export class JudgmentAuthorityModule {
  private readonly events: OwnerEventLog;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly newId: (kind: 'event' | 'snapshot') => string,
    private readonly projections: ProjectionPublisher,
  ) {
    this.events = new OwnerEventLog(storage);
  }

  persistRequestInCurrentTransaction(input: Readonly<{
    request: JudgmentRequestV05;
    displayedRequestDigest: `sha256:${string}`;
    admissionBasis: JudgmentAdmissionBasisV05;
  }>): JudgmentProjectionItemV05 {
    const request = judgmentRequestV05Schema.parse(input.request);
    const admissionBasis = parseJudgmentAdmissionBasisV05(input.admissionBasis);
    this.assertCreationBinding(request, {
      displayedRequestDigest: input.displayedRequestDigest,
      admissionBasis,
    });
    const existing = this.storage.sql.exec<StoredRequestRow>(
      `SELECT owner_id, revision, displayed_request_digest, request_json,
              admission_basis_json, state
         FROM judgment_requests WHERE id = ?`,
      request.id,
    ).toArray()[0];
    if (existing !== undefined) throw new ResponsibilityJudgmentConflictError();

    const requestJson = canonicalizeJudgmentRequestV05ForDigest(request);
    const admissionBasisJson = JSON.stringify(admissionBasis);
    this.storage.sql.exec(
      `INSERT INTO judgment_requests (
        id, owner_id, revision, subject_kind, subject_id, subject_revision,
        affected_digest, displayed_request_digest, request_json, admission_basis_json,
        state, decision_id, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      request.id,
      request.ownerId,
      request.revision,
      request.subject.kind,
      request.subject.id,
      request.subject.revision,
      request.affectedDigest,
      input.displayedRequestDigest,
      requestJson,
      admissionBasisJson,
      request.state,
      request.expiresAt,
      request.createdAt,
      request.updatedAt,
    );
    const cursor = this.events.appendInCurrentTransaction({
      schemaVersion: '0.5',
      eventId: this.newId('event'),
      ownerId: request.ownerId,
      aggregateKind: 'judgment_request',
      aggregateId: request.id,
      revision: request.revision,
      eventType: 'judgment_request.opened',
      causationId: request.id,
      correlationId: request.id,
      occurredAt: request.createdAt,
      payloadJson: serializeJudgmentRequestEventPayloadV05(
        request,
        input.displayedRequestDigest,
        admissionBasis,
        null,
      ),
    });
    const item = this.projections.publishAppendedEventInCurrentTransaction({
      ownerId: request.ownerId,
      cursor,
      at: request.createdAt,
    });
    if (item === undefined) throw new ResponsibilityJudgmentConflictError();
    return Object.freeze(item);
  }

  readRequestInCurrentTransaction(
    ownerId: string,
    requestId: string,
  ): StoredJudgmentRequestV05 {
    const row = this.storage.sql.exec<StoredRequestRow>(
      `SELECT owner_id, revision, displayed_request_digest, request_json,
              admission_basis_json, state
         FROM judgment_requests WHERE id = ?`,
      requestId,
    ).toArray()[0];
    if (row === undefined || row.owner_id !== ownerId) {
      throw new ResponsibilityJudgmentConflictError();
    }
    const request = judgmentRequestV05Schema.parse(JSON.parse(row.request_json));
    const admissionBasis = parseJudgmentAdmissionBasisV05(JSON.parse(row.admission_basis_json));
    if (
      request.ownerId !== row.owner_id ||
      request.revision !== row.revision ||
      request.state !== row.state
    ) {
      throw new ResponsibilityJudgmentConflictError();
    }
    return Object.freeze({
      request,
      displayedRequestDigest: row.displayed_request_digest as `sha256:${string}`,
      admissionBasis,
    });
  }

  readCommandResultInCurrentTransaction(input: Readonly<{
    ownerId: string;
    requestId: string;
    requestDigest: `sha256:${string}`;
  }>): JudgmentAnswerResultV05 | undefined {
    const row = this.storage.sql.exec<{
      owner_id: string; request_digest: string; result_json: string;
    }>(
      `SELECT owner_id, request_digest, result_json
         FROM judgment_commands WHERE request_id = ?`,
      input.requestId,
    ).toArray()[0];
    if (row === undefined) return undefined;
    if (row.owner_id !== input.ownerId || row.request_digest !== input.requestDigest) {
      throw new ResponsibilityJudgmentConflictError();
    }
    return Object.freeze(judgmentAnswerResultV05Schema.parse(JSON.parse(row.result_json)));
  }

  terminalizeRequestInCurrentTransaction(input: Readonly<{
    openRequest: JudgmentRequestV05;
    terminalRequest: JudgmentRequestV05;
    terminalRequestDigest: `sha256:${string}`;
    causationId: string;
  }>): JudgmentProjectionItemV05 {
    const current = this.readRequestInCurrentTransaction(
      input.openRequest.ownerId,
      input.openRequest.id,
    );
    if (
      canonicalizeJudgmentRequestV05ForDigest(current.request) !==
        canonicalizeJudgmentRequestV05ForDigest(input.openRequest) ||
      current.request.state !== 'open'
    ) {
      throw new ResponsibilityJudgmentConflictError();
    }
    const terminal = judgmentRequestV05Schema.parse(input.terminalRequest);
    if (
      terminal.id !== current.request.id ||
      terminal.ownerId !== current.request.ownerId ||
      terminal.revision !== current.request.revision + 1 ||
      terminal.decisionId !== null ||
      (terminal.state !== 'expired' && terminal.state !== 'superseded')
    ) {
      throw new ResponsibilityJudgmentConflictError();
    }
    const terminalJson = canonicalizeJudgmentRequestV05ForDigest(terminal);
    this.storage.sql.exec(
      `UPDATE judgment_requests
          SET revision = ?, displayed_request_digest = ?, request_json = ?, state = ?,
              updated_at = ?
        WHERE id = ? AND owner_id = ? AND revision = ? AND state = 'open'`,
      terminal.revision,
      input.terminalRequestDigest,
      terminalJson,
      terminal.state,
      terminal.updatedAt,
      terminal.id,
      terminal.ownerId,
      current.request.revision,
    );
    const persisted = this.readRequestInCurrentTransaction(terminal.ownerId, terminal.id);
    if (canonicalizeJudgmentRequestV05ForDigest(persisted.request) !== terminalJson) {
      throw new ResponsibilityJudgmentConflictError();
    }
    const cursor = this.events.appendInCurrentTransaction({
      schemaVersion: '0.5',
      eventId: this.newId('event'),
      ownerId: terminal.ownerId,
      aggregateKind: 'judgment_request',
      aggregateId: terminal.id,
      revision: terminal.revision,
      eventType: `judgment_request.${terminal.state}`,
      causationId: input.causationId,
      correlationId: input.causationId,
      occurredAt: terminal.updatedAt,
      payloadJson: serializeJudgmentRequestEventPayloadV05(
        terminal,
        input.terminalRequestDigest,
        current.admissionBasis,
        null,
      ),
    });
    const item = this.projections.publishAppendedEventInCurrentTransaction({
      ownerId: terminal.ownerId,
      cursor,
      at: terminal.updatedAt,
    });
    if (item === undefined) throw new ResponsibilityJudgmentConflictError();
    return Object.freeze(item);
  }

  persistAnswerInCurrentTransaction(input: Readonly<{
    binding: JudgmentAuthorityBindingV05;
    answeredRequest: JudgmentRequestV05;
    answeredRequestDigest: `sha256:${string}`;
    answerRequestId: string;
    answerRequestDigest: `sha256:${string}`;
  }>): JudgmentAnswerResultV05 {
    const binding = judgmentAuthorityBindingV05Schema.parse(input.binding);
    const decision = judgmentDecisionV05Schema.parse(binding.decision);
    const current = this.readRequestInCurrentTransaction(
      binding.request.ownerId,
      binding.request.id,
    );
    if (
      canonicalizeJudgmentRequestV05ForDigest(current.request) !==
        canonicalizeJudgmentRequestV05ForDigest(binding.request) ||
      current.displayedRequestDigest !== binding.requestDigest ||
      current.request.state !== 'open'
    ) {
      throw new ResponsibilityJudgmentConflictError();
    }

    const answeredRequest = judgmentRequestV05Schema.parse(input.answeredRequest);
    if (
      answeredRequest.ownerId !== current.request.ownerId ||
      answeredRequest.id !== current.request.id ||
      answeredRequest.revision !== current.request.revision + 1 ||
      answeredRequest.state !== 'answered' ||
      answeredRequest.decisionId !== decision.id
    ) {
      throw new ResponsibilityJudgmentConflictError();
    }
    this.storage.sql.exec(
      `INSERT INTO judgment_decisions (
        id, owner_id, judgment_request_id, revision, decision_json, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      decision.id,
      decision.ownerId,
      decision.judgmentRequestId,
      decision.revision,
      canonicalizeJudgmentDecisionV05ForDigest(decision),
      decision.decidedAt,
    );
    const decisionCursor = this.events.appendInCurrentTransaction({
      schemaVersion: '0.5',
      eventId: this.newId('event'),
      ownerId: decision.ownerId,
      aggregateKind: 'judgment_decision',
      aggregateId: decision.id,
      revision: decision.revision,
      eventType: 'judgment_decision.recorded',
      causationId: input.answerRequestId,
      correlationId: binding.answer.correlationId ?? input.answerRequestId,
      occurredAt: decision.decidedAt,
      payloadJson: canonicalizeJudgmentDecisionV05ForDigest(decision),
    });
    this.projections.publishAppendedEventInCurrentTransaction({
      ownerId: decision.ownerId,
      cursor: decisionCursor,
      at: decision.decidedAt,
    });
    if (binding.authorityDisposition === 'granted') {
      const grant = authorityGrantV05Schema.parse(binding.grant);
      this.storage.sql.exec(
        `INSERT INTO authority_grants (
          id, owner_id, judgment_request_id, judgment_decision_id, revision, grant_json,
          use_limit, uses_consumed, next_use_index, state, expires_at,
          revocation_generation, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        grant.id,
        grant.ownerId,
        grant.judgmentRequestId,
        grant.judgmentDecisionId,
        grant.revision,
        canonicalizeAuthorityGrantV05ForDigest(grant),
        grant.useLimit,
        grant.usesConsumed,
        grant.nextUseIndex,
        grant.state,
        grant.expiresAt,
        grant.revocationGeneration,
        grant.createdAt,
        grant.updatedAt,
      );
      const grantCursor = this.events.appendInCurrentTransaction({
        schemaVersion: '0.5',
        eventId: this.newId('event'),
        ownerId: grant.ownerId,
        aggregateKind: 'authority_grant',
        aggregateId: grant.id,
        revision: grant.revision,
        eventType: 'authority_grant.issued',
        causationId: decision.id,
        correlationId: binding.answer.correlationId ?? input.answerRequestId,
        occurredAt: grant.createdAt,
        payloadJson: canonicalizeAuthorityGrantV05ForDigest(grant),
      });
      this.projections.publishAppendedEventInCurrentTransaction({
        ownerId: grant.ownerId,
        cursor: grantCursor,
        at: grant.createdAt,
      });
    }
    const answeredRequestJson = canonicalizeJudgmentRequestV05ForDigest(answeredRequest);
    this.storage.sql.exec(
      `UPDATE judgment_requests
          SET revision = ?, displayed_request_digest = ?, request_json = ?, state = 'answered',
              decision_id = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND revision = ? AND state = 'open'`,
      answeredRequest.revision,
      input.answeredRequestDigest,
      answeredRequestJson,
      decision.id,
      answeredRequest.updatedAt,
      answeredRequest.id,
      answeredRequest.ownerId,
      current.request.revision,
    );
    const persisted = this.readRequestInCurrentTransaction(
      answeredRequest.ownerId,
      answeredRequest.id,
    );
    if (canonicalizeJudgmentRequestV05ForDigest(persisted.request) !== answeredRequestJson) {
      throw new ResponsibilityJudgmentConflictError();
    }
    const predictedCursor = this.events.readHighWater(answeredRequest.ownerId) + 1;
    const result = judgmentAnswerResultV05Schema.parse({
      protocolVersion: '0.5',
      requestId: input.answerRequestId,
      judgmentRequest: { id: answeredRequest.id, revision: answeredRequest.revision },
      judgmentDecision: { id: decision.id, revision: decision.revision },
      selectedOptionId: decision.selectedOptionId,
      projectionCursor: predictedCursor,
      authorityDisposition: binding.authorityDisposition === 'granted' ? 'granted' : 'refused',
      ...(binding.authorityDisposition === 'granted' ? {
        grant: {
          id: binding.grant.id,
          revision: binding.grant.revision,
          grantee: binding.grant.grantee,
          state: 'active' as const,
          expiresAt: binding.grant.expiresAt,
          revocationGeneration: binding.grant.revocationGeneration,
        },
      } : {}),
    });
    const cursor = this.events.appendInCurrentTransaction({
      schemaVersion: '0.5',
      eventId: this.newId('event'),
      ownerId: answeredRequest.ownerId,
      aggregateKind: 'judgment_request',
      aggregateId: answeredRequest.id,
      revision: answeredRequest.revision,
      eventType: 'judgment_request.answered',
      causationId: input.answerRequestId,
      correlationId: binding.answer.correlationId ?? input.answerRequestId,
      occurredAt: decision.decidedAt,
      payloadJson: serializeJudgmentRequestEventPayloadV05(
        answeredRequest,
        input.answeredRequestDigest,
        current.admissionBasis,
        Object.freeze({
          requestId: input.answerRequestId,
          ownerId: answeredRequest.ownerId,
          requestDigest: input.answerRequestDigest,
          result,
          recordedAt: decision.decidedAt,
        }),
      ),
    });
    if (cursor !== predictedCursor) throw new ResponsibilityJudgmentConflictError();
    const item = this.projections.publishAppendedEventInCurrentTransaction({
      ownerId: answeredRequest.ownerId,
      cursor,
      at: answeredRequest.updatedAt,
    });
    if (item === undefined) throw new ResponsibilityJudgmentConflictError();
    this.storage.sql.exec(
      `INSERT INTO judgment_commands (
        request_id, owner_id, request_digest, result_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?)`,
      input.answerRequestId,
      answeredRequest.ownerId,
      input.answerRequestDigest,
      JSON.stringify(result),
      decision.decidedAt,
    );
    return Object.freeze(result);
  }

  collectRequestDigestInputsInCurrentTransaction(ownerId: string): readonly Readonly<{
    ownerCursor: number;
    canonicalRequestMaterial: string;
  }>[] {
    return Object.freeze(this.projections.readRelevantEventsInCurrentTransaction(ownerId)
      .filter((event) => event.aggregate_kind === 'judgment_request')
      .map((event) => Object.freeze({
        ownerCursor: event.owner_cursor,
        canonicalRequestMaterial: canonicalizeJudgmentRequestV05ForDigest(
          validateJudgmentRequestEventV05(event).request,
        ),
      })));
  }

  replayInCurrentTransaction(
    ownerId: string,
    digestProofs: readonly JudgmentRequestDigestProofV05[],
  ): Readonly<{
    requests: readonly JudgmentRequestV05[];
    decisions: readonly JudgmentDecisionV05[];
    grants: readonly AuthorityGrantV05[];
  }> {
    const requestMap = new Map<string, JudgmentRequestV05>();
    const requestDigestMap = new Map<string, `sha256:${string}`>();
    const requestBasisMap = new Map<string, JudgmentAdmissionBasisV05>();
    const answerProofMap = new Map<string, Readonly<{
      proof: JudgmentAnswerCommandProofV05;
      ownerCursor: number;
    }>>();
    const decisionMap = new Map<string, JudgmentDecisionV05>();
    const grantMap = new Map<string, AuthorityGrantV05>();
    const events = this.projections.readRelevantEventsInCurrentTransaction(ownerId);
    const digestProofByCursor = new Map(digestProofs.map((proof) => [proof.ownerCursor, proof]));
    let requestEventCount = 0;
    for (const event of events) {
      if (event.owner_id !== ownerId) throw new ResponsibilityJudgmentConflictError();
      if (event.aggregate_kind === 'judgment_request') {
        const payload = validateJudgmentRequestEventV05(event);
        const request = payload.request;
        const digestProof = digestProofByCursor.get(event.owner_cursor);
        if (
          digestProof === undefined ||
          digestProof.canonicalRequestMaterial !==
            canonicalizeJudgmentRequestV05ForDigest(request) ||
          digestProof.digest !== payload.displayedRequestDigest
        ) {
          throw new ResponsibilityJudgmentConflictError();
        }
        if (event.occurred_at !== (
          request.revision === 1 ? request.createdAt : request.updatedAt
        )) {
          throw new ResponsibilityJudgmentConflictError();
        }
        requestEventCount += 1;
        const basis = parseJudgmentAdmissionBasisV05(payload.admissionBasis);
        this.assertAdmissionBinding(request, basis);
        const prior = requestMap.get(request.id);
        const priorBasis = requestBasisMap.get(request.id);
        const stableRequest = (value: JudgmentRequestV05) => {
          const { revision: _revision, state: _state, decisionId: _decisionId,
            updatedAt: _updatedAt, ...stable } = value;
          return stable;
        };
        if (
          request.id !== event.aggregate_id ||
          request.revision !== event.revision ||
          request.ownerId !== ownerId ||
          request.revision !== (prior?.revision ?? 0) + 1 ||
          (prior === undefined && (
            request.revision !== 1 || request.state !== 'open' || request.decisionId !== null
          )) ||
          (prior !== undefined && (
            prior.revision !== 1 || prior.state !== 'open' ||
            JSON.stringify(stableRequest(prior)) !== JSON.stringify(stableRequest(request)) ||
            JSON.stringify(priorBasis) !== JSON.stringify(basis)
          ))
        ) {
          throw new ResponsibilityJudgmentConflictError();
        }
        requestMap.set(request.id, request);
        requestDigestMap.set(request.id, payload.displayedRequestDigest);
        requestBasisMap.set(request.id, basis);
        if (payload.answerProof !== null) {
          if (answerProofMap.has(request.id)) {
            throw new ResponsibilityJudgmentConflictError();
          }
          answerProofMap.set(request.id, Object.freeze({
            proof: payload.answerProof,
            ownerCursor: event.owner_cursor,
          }));
        }
      } else if (event.aggregate_kind === 'judgment_decision') {
        let decision: JudgmentDecisionV05;
        try {
          decision = judgmentDecisionV05Schema.parse(JSON.parse(event.payload_json));
        } catch {
          throw new ResponsibilityJudgmentConflictError();
        }
        const request = requestMap.get(decision.judgmentRequestId);
        const selectedOption = request?.options.find(
          (option) => option.id === decision.selectedOptionId,
        );
        const basis = request === undefined ? undefined : requestBasisMap.get(request.id);
        if (
          event.event_type !== 'judgment_decision.recorded' ||
          decision.id !== event.aggregate_id ||
          decision.revision !== event.revision ||
          decision.revision !== 1 ||
          decision.ownerId !== ownerId ||
          decisionMap.has(decision.id) ||
          request === undefined || request.state !== 'open' || request.revision !== 1 ||
          decision.judgmentRequestRevision !== request.revision ||
          JSON.stringify(decision.subject) !== JSON.stringify(request.subject) ||
          decision.displayedRequestDigest !== requestDigestMap.get(request.id) ||
          basis === undefined || decision.ownerPolicyRevision !== basis.ownerPolicyRevision ||
          decision.authAssurance === 'legacy_unverified' ||
          Date.parse(decision.decidedAt) < Date.parse(request.createdAt) ||
          Date.parse(decision.decidedAt) < Date.parse(request.updatedAt) ||
          Date.parse(decision.decidedAt) >= Date.parse(request.expiresAt) ||
          event.occurred_at !== decision.decidedAt ||
          selectedOption === undefined
        ) {
          throw new ResponsibilityJudgmentConflictError();
        }
        decisionMap.set(decision.id, decision);
      } else if (event.aggregate_kind === 'authority_grant') {
        let grant: AuthorityGrantV05;
        try {
          grant = authorityGrantV05Schema.parse(JSON.parse(event.payload_json));
        } catch {
          throw new ResponsibilityJudgmentConflictError();
        }
        const request = requestMap.get(grant.judgmentRequestId);
        const decision = decisionMap.get(grant.judgmentDecisionId);
        const selectedOption = request?.options.find(
          (option) => option.id === decision?.selectedOptionId,
        );
        const requested = request?.requestedAuthority;
        const admission = request?.authorityAdmission;
        const basis = request === undefined ? undefined : requestBasisMap.get(request.id);
        if (
          event.event_type !== 'authority_grant.issued' ||
          grant.id !== event.aggregate_id ||
          grant.revision !== event.revision ||
          grant.revision !== 1 ||
          grant.ownerId !== ownerId ||
          grantMap.has(grant.id) ||
          request === undefined || request.state !== 'open' || request.revision !== 1 ||
          decision === undefined || selectedOption?.authorityDisposition !== 'grant' ||
          requested === null || requested === undefined ||
          admission === null || admission === undefined ||
          basis === undefined ||
          grant.judgmentRequestRevision !== request.revision ||
          JSON.stringify(grant.subject) !== JSON.stringify(request.subject) ||
          JSON.stringify(grant.grantee) !== JSON.stringify(admission.grantee) ||
          grant.purpose !== requested.purpose ||
          grant.effectFamily !== requested.effectFamily ||
          JSON.stringify(grant.resources) !== JSON.stringify(requested.resources) ||
          JSON.stringify(grant.scopes) !== JSON.stringify(requested.scopes) ||
          JSON.stringify(grant.audiences) !== JSON.stringify(requested.audiences) ||
          grant.argumentDigest !== requested.argumentDigest ||
          grant.contextDigest !== requested.contextDigest ||
          grant.artifactDigest !== requested.artifactDigest ||
          grant.expiresAt !== requested.validUntil ||
          grant.validFrom !== decision.decidedAt ||
          grant.createdAt !== decision.decidedAt ||
          grant.updatedAt !== decision.decidedAt ||
          grant.state !== 'active' ||
          grant.useLimit !== 1 ||
          grant.usesConsumed !== 0 ||
          grant.nextUseIndex !== 1 ||
          event.occurred_at !== decision.decidedAt ||
          grant.revocationGeneration !== basis.revocationGeneration ||
          decision.ownerPolicyRevision !== basis.ownerPolicyRevision ||
          decision.judgmentRequestId !== request.id ||
          [...grantMap.values()].some((existing) =>
            existing.judgmentRequestId === grant.judgmentRequestId ||
            existing.judgmentDecisionId === grant.judgmentDecisionId)
        ) {
          throw new ResponsibilityJudgmentConflictError();
        }
        grantMap.set(grant.id, grant);
      } else {
        throw new ResponsibilityJudgmentConflictError();
      }
    }
    if (requestEventCount !== digestProofs.length) {
      throw new ResponsibilityJudgmentConflictError();
    }

    for (const request of requestMap.values()) {
      const decision = request.decisionId === null
        ? undefined
        : decisionMap.get(request.decisionId);
      if (request.state === 'answered') {
        const option = request.options.find((candidate) =>
          candidate.id === decision?.selectedOptionId,
        );
        const matchingGrants = [...grantMap.values()].filter(
          (grant) => grant.judgmentRequestId === request.id,
        );
        if (
          decision === undefined || option === undefined ||
          (option.authorityDisposition === 'grant' && matchingGrants.length !== 1) ||
          (option.authorityDisposition === 'refuse' && matchingGrants.length !== 0)
        ) {
          throw new ResponsibilityJudgmentConflictError();
        }
        const command = answerProofMap.get(request.id);
        const grant = matchingGrants[0];
        let expectedResult: JudgmentAnswerResultV05;
        try {
          expectedResult = judgmentAnswerResultV05Schema.parse({
            protocolVersion: '0.5',
            requestId: command?.proof.requestId,
            judgmentRequest: { id: request.id, revision: request.revision },
            judgmentDecision: { id: decision.id, revision: decision.revision },
            selectedOptionId: decision.selectedOptionId,
            projectionCursor: command?.ownerCursor,
            authorityDisposition: option.authorityDisposition === 'grant' ? 'granted' : 'refused',
            ...(grant === undefined ? {} : {
              grant: {
                id: grant.id,
                revision: grant.revision,
                grantee: grant.grantee,
                state: grant.state,
                expiresAt: grant.expiresAt,
                revocationGeneration: grant.revocationGeneration,
              },
            }),
          });
        } catch {
          throw new ResponsibilityJudgmentConflictError();
        }
        if (
          command === undefined || command.proof.ownerId !== ownerId ||
          command.proof.result.requestId !== command.proof.requestId ||
          command.proof.recordedAt !== decision.decidedAt ||
          request.updatedAt !== decision.decidedAt ||
          JSON.stringify(command.proof.result) !== JSON.stringify(expectedResult)
        ) {
          throw new ResponsibilityJudgmentConflictError();
        }
      } else if (request.state !== 'open' || decision !== undefined) {
        if (request.state !== 'expired' && request.state !== 'superseded') {
          throw new ResponsibilityJudgmentConflictError();
        }
        if (decision !== undefined || [...grantMap.values()].some(
          (grant) => grant.judgmentRequestId === request.id,
        ) || answerProofMap.has(request.id)) {
          throw new ResponsibilityJudgmentConflictError();
        }
        if (request.state === 'expired' &&
            Date.parse(request.updatedAt) < Date.parse(request.expiresAt)) {
          throw new ResponsibilityJudgmentConflictError();
        }
      }
    }
    for (const decision of decisionMap.values()) {
      if (requestMap.get(decision.judgmentRequestId)?.decisionId !== decision.id) {
        throw new ResponsibilityJudgmentConflictError();
      }
    }

    const answerProofByCommandId = new Map<string, Readonly<{
      proof: JudgmentAnswerCommandProofV05;
      ownerCursor: number;
    }>>();
    for (const entry of answerProofMap.values()) {
      if (answerProofByCommandId.has(entry.proof.requestId)) {
        throw new ResponsibilityJudgmentConflictError();
      }
      answerProofByCommandId.set(entry.proof.requestId, entry);
    }
    const commandRows = this.storage.sql.exec<{
      request_id: string; owner_id: string; request_digest: string;
      result_json: string; recorded_at: string;
    }>(
      `SELECT request_id, owner_id, request_digest, result_json, recorded_at
         FROM judgment_commands ORDER BY request_id LIMIT ?`,
      answerProofByCommandId.size + 1,
    ).toArray();
    if (commandRows.length !== answerProofByCommandId.size) {
      throw new ResponsibilityJudgmentConflictError();
    }
    const seenCommandIds = new Set<string>();
    for (const row of commandRows) {
      const entry = answerProofByCommandId.get(row.request_id);
      if (
        entry === undefined || seenCommandIds.has(row.request_id) ||
        row.owner_id !== entry.proof.ownerId ||
        row.request_digest !== entry.proof.requestDigest ||
        row.result_json !== JSON.stringify(entry.proof.result) ||
        row.recorded_at !== entry.proof.recordedAt
      ) {
        throw new ResponsibilityJudgmentConflictError();
      }
      seenCommandIds.add(row.request_id);
    }

    const requests = [...requestMap.values()];
    const decisions = [...decisionMap.values()];
    const grants = [...grantMap.values()];
    const currentRequests = this.storage.sql.exec<{
      id: string; owner_id: string; revision: number; subject_kind: string;
      subject_id: string; subject_revision: number; affected_digest: string;
      displayed_request_digest: string; request_json: string; admission_basis_json: string;
      state: string; decision_id: string | null; expires_at: string;
      created_at: string; updated_at: string;
    }>(
      `SELECT id, owner_id, revision, subject_kind, subject_id, subject_revision,
              affected_digest, displayed_request_digest, request_json, admission_basis_json,
              state, decision_id, expires_at, created_at, updated_at
         FROM judgment_requests ORDER BY id LIMIT ?`,
      requestMap.size + 1,
    ).toArray().map((row) => {
      let request: JudgmentRequestV05;
      let basis: JudgmentAdmissionBasisV05;
      try {
        request = judgmentRequestV05Schema.parse(JSON.parse(row.request_json));
        basis = parseJudgmentAdmissionBasisV05(JSON.parse(row.admission_basis_json));
      } catch (error) {
        if (error instanceof ResponsibilityJudgmentConflictError) throw error;
        throw new ResponsibilityJudgmentConflictError();
      }
      this.assertAdmissionBinding(request, basis);
      if (
        row.id !== request.id || row.owner_id !== request.ownerId ||
        row.revision !== request.revision || row.subject_kind !== request.subject.kind ||
        row.subject_id !== request.subject.id || row.subject_revision !== request.subject.revision ||
        row.affected_digest !== request.affectedDigest || row.state !== request.state ||
        row.decision_id !== request.decisionId || row.expires_at !== request.expiresAt ||
        row.created_at !== request.createdAt || row.updated_at !== request.updatedAt ||
        row.request_json !== canonicalizeJudgmentRequestV05ForDigest(request) ||
        row.displayed_request_digest !== requestDigestMap.get(request.id) ||
        JSON.stringify(basis) !== JSON.stringify(requestBasisMap.get(request.id))
      ) {
        throw new ResponsibilityJudgmentConflictError();
      }
      return request;
    });
    const currentDecisions = this.storage.sql.exec<{
      id: string; owner_id: string; judgment_request_id: string; revision: number;
      decision_json: string; decided_at: string;
    }>(
      `SELECT id, owner_id, judgment_request_id, revision, decision_json, decided_at
         FROM judgment_decisions ORDER BY id LIMIT ?`,
      decisionMap.size + 1,
    ).toArray().map((row) => {
      let decision: JudgmentDecisionV05;
      try {
        decision = judgmentDecisionV05Schema.parse(JSON.parse(row.decision_json));
      } catch {
        throw new ResponsibilityJudgmentConflictError();
      }
      if (
        row.id !== decision.id || row.owner_id !== decision.ownerId ||
        row.judgment_request_id !== decision.judgmentRequestId ||
        row.revision !== decision.revision || row.decided_at !== decision.decidedAt ||
        row.decision_json !== canonicalizeJudgmentDecisionV05ForDigest(decision)
      ) {
        throw new ResponsibilityJudgmentConflictError();
      }
      return decision;
    });
    const currentGrants = this.storage.sql.exec<{
      id: string; owner_id: string; judgment_request_id: string;
      judgment_decision_id: string; revision: number; grant_json: string;
      use_limit: number; uses_consumed: number; next_use_index: number;
      state: string; expires_at: string; revocation_generation: number;
      created_at: string; updated_at: string;
    }>(
      `SELECT id, owner_id, judgment_request_id, judgment_decision_id, revision, grant_json,
              use_limit, uses_consumed, next_use_index, state, expires_at,
              revocation_generation, created_at, updated_at
         FROM authority_grants ORDER BY id LIMIT ?`,
      grantMap.size + 1,
    ).toArray().map((row) => {
      let grant: AuthorityGrantV05;
      try {
        grant = authorityGrantV05Schema.parse(JSON.parse(row.grant_json));
      } catch {
        throw new ResponsibilityJudgmentConflictError();
      }
      if (
        row.id !== grant.id || row.owner_id !== grant.ownerId ||
        row.judgment_request_id !== grant.judgmentRequestId ||
        row.judgment_decision_id !== grant.judgmentDecisionId ||
        row.revision !== grant.revision || row.use_limit !== grant.useLimit ||
        row.uses_consumed !== grant.usesConsumed || row.next_use_index !== grant.nextUseIndex ||
        row.state !== grant.state || row.expires_at !== grant.expiresAt ||
        row.revocation_generation !== grant.revocationGeneration ||
        row.created_at !== grant.createdAt || row.updated_at !== grant.updatedAt ||
        row.grant_json !== canonicalizeAuthorityGrantV05ForDigest(grant)
      ) {
        throw new ResponsibilityJudgmentConflictError();
      }
      return grant;
    });
    const byId = <Value extends { id: string }>(values: readonly Value[]) =>
      [...values].sort((left, right) => left.id.localeCompare(right.id));
    if (
      JSON.stringify(byId(requests)) !== JSON.stringify(byId(currentRequests)) ||
      JSON.stringify(byId(decisions)) !== JSON.stringify(byId(currentDecisions)) ||
      JSON.stringify(byId(grants)) !== JSON.stringify(byId(currentGrants))
    ) {
      throw new ResponsibilityJudgmentConflictError();
    }
    return Object.freeze({
      requests: Object.freeze(requests),
      decisions: Object.freeze(decisions),
      grants: Object.freeze(grants),
    });
  }

  private assertCreationBinding(
    request: JudgmentRequestV05,
    input: Readonly<{
      displayedRequestDigest: `sha256:${string}`;
      admissionBasis: JudgmentAdmissionBasisV05;
    }>,
  ): void {
    if (
      request.state !== 'open' ||
      request.revision !== 1 ||
      request.decisionId !== null
    ) {
      throw new ResponsibilityJudgmentConflictError();
    }
    this.assertAdmissionBinding(request, input.admissionBasis);
  }

  private assertAdmissionBinding(
    request: JudgmentRequestV05,
    basis: JudgmentAdmissionBasisV05,
  ): void {
    const admission = request.authorityAdmission;
    if (
      request.ownerId !== basis.ownerId ||
      request.affectedDigest !== basis.affectedDigest ||
      JSON.stringify(request.subject) !== JSON.stringify(basis.subject) ||
      ((admission === null) !== (basis.grantee === null)) ||
      (admission !== null && (
        JSON.stringify(admission.grantee) !== JSON.stringify(basis.grantee) ||
        admission.ownerPolicyRevision !== basis.ownerPolicyRevision ||
        admission.admissionContextDigest !== basis.admissionContextDigest
      ))
    ) {
      throw new ResponsibilityJudgmentConflictError();
    }
  }

}
