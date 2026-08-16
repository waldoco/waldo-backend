import {
  authorityGrantV05Schema,
  canonicalizeAuthorityGrantV05ForDigest,
  canonicalizeJudgmentDecisionV05ForDigest,
  canonicalizeJudgmentRequestV05ForDigest,
  judgmentAnswerResultV05Schema,
  judgmentAuthorityBindingV05Schema,
  judgmentDecisionV05Schema,
  judgmentProjectionItemV05Schema,
  judgmentProjectionPageUtf8ByteLengthV05,
  judgmentProjectionPageV05Schema,
  MAX_JUDGMENT_PROJECTION_PAGE_UTF8_BYTES_V05,
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
  type JudgmentProjectionPageV05,
} from '@waldo/contracts';
import {
  ResponsibilityJudgmentConflictError,
  ResponsibilityProjectionCursorError,
  ResponsibilityProjectionMissingError,
} from '../responsibility/errors';
import { OwnerEventLog } from './owner-event-log';

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

export type JudgmentProjectionItemV05 = ReturnType<
  typeof judgmentProjectionItemV05Schema.parse
>;

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

/** Sole writer for JudgmentRequest, Decision, AuthorityGrant and the Needs You projection. */
export class JudgmentAuthorityModule {
  private readonly events: OwnerEventLog;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly newId: (kind: 'event' | 'snapshot') => string,
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
    this.ensureProjectionSnapshotInCurrentTransaction(request.ownerId, request.createdAt);
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
      payloadJson: requestJson,
    });
    const item = judgmentProjectionItemV05Schema.parse({
      cursor,
      itemType: 'judgment_request',
      request,
      displayedRequestDigest: input.displayedRequestDigest,
    });
    this.storage.sql.exec(
      `INSERT INTO judgment_projection (owner_cursor, owner_id, item_json)
       VALUES (?, ?, ?)`,
      cursor,
      request.ownerId,
      JSON.stringify(item),
    );
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
      payloadJson: terminalJson,
    });
    const item = judgmentProjectionItemV05Schema.parse({
      cursor,
      itemType: 'judgment_request',
      request: terminal,
      displayedRequestDigest: input.terminalRequestDigest,
    });
    this.storage.sql.exec(
      `INSERT INTO judgment_projection (owner_cursor, owner_id, item_json)
       VALUES (?, ?, ?)`,
      cursor,
      terminal.ownerId,
      JSON.stringify(item),
    );
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
    this.events.appendInCurrentTransaction({
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
      this.events.appendInCurrentTransaction({
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
      payloadJson: answeredRequestJson,
    });
    const item = judgmentProjectionItemV05Schema.parse({
      cursor,
      itemType: 'judgment_request',
      request: answeredRequest,
      displayedRequestDigest: input.answeredRequestDigest,
    });
    this.storage.sql.exec(
      `INSERT INTO judgment_projection (owner_cursor, owner_id, item_json)
       VALUES (?, ?, ?)`,
      cursor,
      answeredRequest.ownerId,
      JSON.stringify(item),
    );
    const result = judgmentAnswerResultV05Schema.parse({
      protocolVersion: '0.5',
      requestId: input.answerRequestId,
      judgmentRequest: { id: answeredRequest.id, revision: answeredRequest.revision },
      judgmentDecision: { id: decision.id, revision: decision.revision },
      selectedOptionId: decision.selectedOptionId,
      projectionCursor: cursor,
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

  replayInCurrentTransaction(ownerId: string): Readonly<{
    requests: readonly JudgmentRequestV05[];
    decisions: readonly JudgmentDecisionV05[];
    grants: readonly AuthorityGrantV05[];
  }> {
    const requestMap = new Map<string, JudgmentRequestV05>();
    const decisionMap = new Map<string, JudgmentDecisionV05>();
    const grantMap = new Map<string, AuthorityGrantV05>();
    const events = this.storage.sql.exec<{
      owner_id: string; aggregate_kind: string; aggregate_id: string;
      revision: number; event_type: string; payload_json: string;
    }>(
      `SELECT owner_id, aggregate_kind, aggregate_id, revision, event_type, payload_json
         FROM owner_domain_events
        WHERE schema_version = '0.5'
        ORDER BY owner_cursor ASC`,
    ).toArray();
    for (const event of events) {
      if (event.owner_id !== ownerId) throw new ResponsibilityJudgmentConflictError();
      if (event.aggregate_kind === 'judgment_request') {
        const request = judgmentRequestV05Schema.parse(JSON.parse(event.payload_json));
        const prior = requestMap.get(request.id);
        if (
          request.id !== event.aggregate_id ||
          request.revision !== event.revision ||
          request.ownerId !== ownerId ||
          request.revision !== (prior?.revision ?? 0) + 1
        ) {
          throw new ResponsibilityJudgmentConflictError();
        }
        requestMap.set(request.id, request);
      } else if (event.aggregate_kind === 'judgment_decision') {
        const decision = judgmentDecisionV05Schema.parse(JSON.parse(event.payload_json));
        if (
          event.event_type !== 'judgment_decision.recorded' ||
          decision.id !== event.aggregate_id ||
          decision.revision !== event.revision ||
          decision.ownerId !== ownerId ||
          decisionMap.has(decision.id)
        ) {
          throw new ResponsibilityJudgmentConflictError();
        }
        decisionMap.set(decision.id, decision);
      } else if (event.aggregate_kind === 'authority_grant') {
        const grant = authorityGrantV05Schema.parse(JSON.parse(event.payload_json));
        if (
          event.event_type !== 'authority_grant.issued' ||
          grant.id !== event.aggregate_id ||
          grant.revision !== event.revision ||
          grant.ownerId !== ownerId ||
          grantMap.has(grant.id)
        ) {
          throw new ResponsibilityJudgmentConflictError();
        }
        grantMap.set(grant.id, grant);
      }
    }
    const requests = [...requestMap.values()];
    const decisions = [...decisionMap.values()];
    const grants = [...grantMap.values()];
    const currentRequests = this.storage.sql.exec<{ request_json: string }>(
      'SELECT request_json FROM judgment_requests WHERE owner_id = ? ORDER BY id',
      ownerId,
    ).toArray().map((row) => judgmentRequestV05Schema.parse(JSON.parse(row.request_json)));
    const currentDecisions = this.storage.sql.exec<{ decision_json: string }>(
      'SELECT decision_json FROM judgment_decisions WHERE owner_id = ? ORDER BY id',
      ownerId,
    ).toArray().map((row) => judgmentDecisionV05Schema.parse(JSON.parse(row.decision_json)));
    const currentGrants = this.storage.sql.exec<{ grant_json: string }>(
      'SELECT grant_json FROM authority_grants WHERE owner_id = ? ORDER BY id',
      ownerId,
    ).toArray().map((row) => authorityGrantV05Schema.parse(JSON.parse(row.grant_json)));
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

  readProjectionInCurrentTransaction(input: Readonly<{
    ownerId: string;
    fromExclusiveCursor: number;
    limit: number;
    snapshotId?: string;
    generatedAt: string;
  }>): JudgmentProjectionPageV05 {
    const snapshot = this.storage.sql.exec<{
      snapshot_id: string; snapshot_base_cursor: number;
    }>(
      `SELECT snapshot_id, snapshot_base_cursor
         FROM judgment_projection_state WHERE owner_id = ?`,
      input.ownerId,
    ).toArray()[0];
    if (snapshot === undefined) throw new ResponsibilityProjectionMissingError();
    if (input.snapshotId !== undefined && input.snapshotId !== snapshot.snapshot_id) {
      throw new ResponsibilityProjectionCursorError('snapshot_replaced');
    }
    const highWaterCursor = this.events.readHighWater(input.ownerId);
    if (
      input.fromExclusiveCursor < snapshot.snapshot_base_cursor ||
      input.fromExclusiveCursor > highWaterCursor
    ) {
      throw new ResponsibilityProjectionCursorError(
        input.fromExclusiveCursor > highWaterCursor ? 'cursor_ahead' : 'cursor_corrupt',
      );
    }
    const rows = this.storage.sql.exec<{ owner_id: string; item_json: string }>(
      `SELECT owner_id, item_json FROM judgment_projection
        WHERE owner_id = ? AND owner_cursor > ? AND owner_cursor <= ?
        ORDER BY owner_cursor ASC LIMIT ?`,
      input.ownerId,
      input.fromExclusiveCursor,
      highWaterCursor,
      input.limit,
    ).toArray();
    if (rows.some((row) => row.owner_id !== input.ownerId)) {
      throw new ResponsibilityJudgmentConflictError();
    }
    const items = rows.map((row) => judgmentProjectionItemV05Schema.parse(
      JSON.parse(row.item_json),
    ));
    let included = items.length;
    while (true) {
      const pageItems = items.slice(0, included);
      const allJudgmentRowsIncluded = included === items.length && rows.length < input.limit;
      const nextCursor = allJudgmentRowsIncluded
        ? highWaterCursor
        : pageItems.at(-1)?.cursor ?? input.fromExclusiveCursor;
      const candidate = {
        protocolVersion: '0.5' as const,
        ownerId: input.ownerId,
        projectionName: 'judgment.needs_you' as const,
        snapshotId: snapshot.snapshot_id,
        snapshotBaseCursor: snapshot.snapshot_base_cursor,
        fromExclusiveCursor: input.fromExclusiveCursor,
        highWaterCursor,
        nextCursor,
        items: pageItems,
        hasMore: nextCursor < highWaterCursor,
        generatedAt: input.generatedAt,
      };
      if (judgmentProjectionPageUtf8ByteLengthV05(candidate) <=
          MAX_JUDGMENT_PROJECTION_PAGE_UTF8_BYTES_V05) {
        return Object.freeze(judgmentProjectionPageV05Schema.parse(candidate));
      }
      if (included <= 1) throw new ResponsibilityProjectionCursorError('cursor_corrupt');
      included -= 1;
    }
  }

  private assertCreationBinding(
    request: JudgmentRequestV05,
    input: Readonly<{
      displayedRequestDigest: `sha256:${string}`;
      admissionBasis: JudgmentAdmissionBasisV05;
    }>,
  ): void {
    const basis = input.admissionBasis;
    const admission = request.authorityAdmission;
    if (
      request.state !== 'open' ||
      request.revision !== 1 ||
      request.decisionId !== null ||
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

  private ensureProjectionSnapshotInCurrentTransaction(ownerId: string, at: string): void {
    const existing = this.storage.sql.exec<{ owner_id: string }>(
      'SELECT owner_id FROM judgment_projection_state WHERE owner_id = ?',
      ownerId,
    ).toArray()[0];
    if (existing !== undefined) return;
    this.storage.sql.exec(
      `INSERT INTO judgment_projection_state (
        owner_id, snapshot_id, snapshot_base_cursor, updated_at
      ) VALUES (?, ?, 0, ?)`,
      ownerId,
      this.newId('snapshot'),
      at,
    );
  }
}
