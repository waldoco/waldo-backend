import {
  authorityGrantV05Schema,
  canonicalizeJudgmentAnswerRequestV05ForDigest,
  canonicalizeJudgmentRequestV05ForDigest,
  iso8601Schema,
  judgmentAnswerResultV05Schema,
  judgmentAnswerRequestV05Schema,
  judgmentDecisionV05Schema,
  judgmentProjectionItemV05Schema,
  judgmentProjectionPageUtf8ByteLengthV05,
  judgmentProjectionPageV05Schema,
  judgmentRequestV05Schema,
  MAX_JUDGMENT_PROJECTION_PAGE_UTF8_BYTES_V05,
  protocolDigestSchema,
  protocolIdSchema,
  type JudgmentProjectionPageV05,
  type JudgmentAnswerResultV05,
  type JudgmentRequestV05,
} from '@waldo/contracts';
import {
  ResponsibilityJudgmentConflictError,
  ResponsibilityProjectionCursorError,
  ResponsibilityProjectionMissingError,
} from '../responsibility/errors';
import { OwnerEventLog } from './owner-event-log';

export type JudgmentProjectionItemV05 = ReturnType<
  typeof judgmentProjectionItemV05Schema.parse
>;

export type StoredOwnerEventV05 = Readonly<{
  owner_cursor: number;
  schema_version: string;
  owner_id: string;
  aggregate_kind: string;
  aggregate_id: string;
  revision: number;
  event_type: string;
  causation_id: string;
  correlation_id: string;
  occurred_at: string;
  payload_json: string;
}>;

export type JudgmentRequestDigestProofV05 = Readonly<{
  ownerCursor: number;
  canonicalRequestMaterial: string;
  digest: `sha256:${string}`;
  triggerDigest: `sha256:${string}` | null;
}>;

export const DEFAULT_JUDGMENT_REPLAY_EVENT_LIMIT = 10_000;
export const DEFAULT_JUDGMENT_REPLAY_DECODED_BYTE_LIMIT = 8 * 1_024 * 1_024;
const JUDGMENT_REPLAY_BATCH_SIZE = 256;
const KNOWN_JUDGMENT_AGGREGATE_KINDS = [
  'judgment_request', 'judgment_decision', 'authority_grant',
] as const;

export type JudgmentRequestEventPayloadV05 = Readonly<{
  request: JudgmentRequestV05;
  displayedRequestDigest: `sha256:${string}`;
  admissionBasis: unknown;
  answerProof: JudgmentAnswerCommandProofV05 | null;
  terminalTriggerProof: JudgmentTerminalTriggerProofV05 | null;
}>;

export type JudgmentAnswerCommandProofV05 = Readonly<{
  requestId: string;
  ownerId: string;
  requestMaterial: string;
  requestDigest: `sha256:${string}`;
  result: JudgmentAnswerResultV05;
  recordedAt: string;
}>;

export type JudgmentTerminalTriggerProofV05 = Readonly<{
  requestId: string;
  requestMaterial: string;
  requestDigest: `sha256:${string}`;
}>;

const REQUEST_EVENT_PAYLOAD_KEYS = [
  'request', 'displayedRequestDigest', 'admissionBasis', 'answerProof',
  'terminalTriggerProof',
] as const;

const ANSWER_PROOF_KEYS = [
  'requestId', 'ownerId', 'requestMaterial', 'requestDigest', 'result', 'recordedAt',
] as const;

const TERMINAL_TRIGGER_PROOF_KEYS = [
  'requestId', 'requestMaterial', 'requestDigest',
] as const;

function parseCanonicalJudgmentAnswerRequestMaterialV05(
  value: unknown,
): string {
  if (typeof value !== 'string') throw new ResponsibilityJudgmentConflictError();
  const request = judgmentAnswerRequestV05Schema.parse(JSON.parse(value));
  const material = canonicalizeJudgmentAnswerRequestV05ForDigest(request);
  if (material !== value) throw new ResponsibilityJudgmentConflictError();
  return material;
}

function parseJudgmentAnswerCommandProofV05(
  value: unknown,
): JudgmentAnswerCommandProofV05 | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ResponsibilityJudgmentConflictError();
  }
  const candidate = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify([...ANSWER_PROOF_KEYS].sort())) {
    throw new ResponsibilityJudgmentConflictError();
  }
  return Object.freeze({
    requestId: protocolIdSchema.parse(candidate.requestId),
    ownerId: protocolIdSchema.parse(candidate.ownerId),
    requestMaterial: parseCanonicalJudgmentAnswerRequestMaterialV05(
      candidate.requestMaterial,
    ),
    requestDigest: protocolDigestSchema.parse(candidate.requestDigest) as `sha256:${string}`,
    result: judgmentAnswerResultV05Schema.parse(candidate.result),
    recordedAt: iso8601Schema.parse(candidate.recordedAt),
  });
}

function parseJudgmentTerminalTriggerProofV05(
  value: unknown,
): JudgmentTerminalTriggerProofV05 | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ResponsibilityJudgmentConflictError();
  }
  const candidate = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify([...TERMINAL_TRIGGER_PROOF_KEYS].sort())) {
    throw new ResponsibilityJudgmentConflictError();
  }
  return Object.freeze({
    requestId: protocolIdSchema.parse(candidate.requestId),
    requestMaterial: parseCanonicalJudgmentAnswerRequestMaterialV05(
      candidate.requestMaterial,
    ),
    requestDigest: protocolDigestSchema.parse(candidate.requestDigest) as `sha256:${string}`,
  });
}

export function serializeJudgmentRequestEventPayloadV05(
  request: JudgmentRequestV05,
  displayedRequestDigest: `sha256:${string}`,
  admissionBasis: unknown,
  answerProof: JudgmentAnswerCommandProofV05 | null,
  terminalTriggerProof: JudgmentTerminalTriggerProofV05 | null,
): string {
  return JSON.stringify({
    request: judgmentRequestV05Schema.parse(request),
    displayedRequestDigest: protocolDigestSchema.parse(displayedRequestDigest),
    admissionBasis,
    answerProof,
    terminalTriggerProof,
  });
}

export function parseJudgmentRequestEventPayloadV05(
  payloadJson: string,
): JudgmentRequestEventPayloadV05 {
  try {
    const value: unknown = JSON.parse(payloadJson);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ResponsibilityJudgmentConflictError();
    }
    const candidate = value as Record<string, unknown>;
    if (JSON.stringify(Object.keys(candidate).sort()) !==
        JSON.stringify([...REQUEST_EVENT_PAYLOAD_KEYS].sort())) {
      throw new ResponsibilityJudgmentConflictError();
    }
    return Object.freeze({
      request: judgmentRequestV05Schema.parse(candidate.request),
      displayedRequestDigest: protocolDigestSchema.parse(
        candidate.displayedRequestDigest,
      ) as `sha256:${string}`,
      admissionBasis: candidate.admissionBasis,
      answerProof: parseJudgmentAnswerCommandProofV05(candidate.answerProof),
      terminalTriggerProof: parseJudgmentTerminalTriggerProofV05(
        candidate.terminalTriggerProof,
      ),
    });
  } catch (error) {
    if (error instanceof ResponsibilityJudgmentConflictError) throw error;
    throw new ResponsibilityJudgmentConflictError();
  }
}

export function validateJudgmentRequestEventV05(
  event: StoredOwnerEventV05,
): JudgmentRequestEventPayloadV05 {
  const payload = parseJudgmentRequestEventPayloadV05(event.payload_json);
  const request = payload.request;
  const expectedEventType = request.revision === 1 && request.state === 'open'
    ? 'judgment_request.opened'
    : request.revision === 2 && (
      request.state === 'answered' ||
      request.state === 'expired' ||
      request.state === 'superseded'
    )
      ? `judgment_request.${request.state}`
      : null;
  if (
    event.schema_version !== '0.5' ||
    event.aggregate_kind !== 'judgment_request' ||
    request.id !== event.aggregate_id ||
    request.ownerId !== event.owner_id ||
    request.revision !== event.revision ||
    event.event_type !== expectedEventType ||
    (request.state === 'answered') !== (request.decisionId !== null) ||
    (request.state === 'answered') !== (payload.answerProof !== null) ||
    ((request.state === 'expired' || request.state === 'superseded') !==
      (payload.terminalTriggerProof !== null)) ||
    (payload.answerProof !== null && payload.terminalTriggerProof !== null)
  ) {
    throw new ResponsibilityJudgmentConflictError();
  }
  return payload;
}

/** Sole writer, reader, and journal rebuilder for the Judgment Needs You projection. */
export class ProjectionPublisher {
  private readonly events: OwnerEventLog;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly newSnapshotId: () => string,
    private readonly replayEventLimit = DEFAULT_JUDGMENT_REPLAY_EVENT_LIMIT,
    private readonly replayDecodedByteLimit = DEFAULT_JUDGMENT_REPLAY_DECODED_BYTE_LIMIT,
  ) {
    if (!Number.isSafeInteger(replayEventLimit) || replayEventLimit < 1 ||
        !Number.isSafeInteger(replayDecodedByteLimit) || replayDecodedByteLimit < 1) {
      throw new Error('ProjectionPublisher requires positive replay capacity limits');
    }
    this.events = new OwnerEventLog(storage);
  }

  publishAppendedEventInCurrentTransaction(input: Readonly<{
    ownerId: string;
    cursor: number;
    at: string;
  }>): JudgmentProjectionItemV05 | undefined {
    if (this.events.readHighWater(input.ownerId) !== input.cursor) {
      throw new ResponsibilityJudgmentConflictError();
    }
    const event = this.storage.sql.exec<StoredOwnerEventV05>(
      `SELECT owner_cursor, schema_version, owner_id, aggregate_kind, aggregate_id,
              revision, event_type, causation_id, correlation_id, occurred_at, payload_json
         FROM owner_domain_events WHERE owner_cursor = ?`,
      input.cursor,
    ).toArray()[0];
    if (event === undefined || event.owner_id !== input.ownerId) {
      throw new ResponsibilityJudgmentConflictError();
    }
    this.readRelevantEventsInCurrentTransaction(input.ownerId);
    this.ensureSnapshotInCurrentTransaction(input.ownerId, input.at);
    return this.publishEventInCurrentTransaction(event);
  }

  readRelevantEventsInCurrentTransaction(ownerId: string): readonly StoredOwnerEventV05[] {
    const events: StoredOwnerEventV05[] = [];
    let afterCursor = 0;
    let decodedBytes = 0;
    while (true) {
      const remaining = this.replayEventLimit - events.length;
      const rows = this.storage.sql.exec<StoredOwnerEventV05>(
        `SELECT owner_cursor, schema_version, owner_id, aggregate_kind, aggregate_id,
                revision, event_type, causation_id, correlation_id, occurred_at, payload_json
           FROM owner_domain_events
          WHERE owner_cursor > ? AND (
            schema_version = '0.5' OR
            aggregate_kind IN ('judgment_request', 'judgment_decision', 'authority_grant')
          )
          ORDER BY owner_cursor ASC LIMIT ?`,
        afterCursor,
        Math.min(JUDGMENT_REPLAY_BATCH_SIZE, remaining + 1),
      ).toArray();
      if (rows.length === 0) break;
      for (const event of rows) {
        if (events.length >= this.replayEventLimit) {
          throw new ResponsibilityJudgmentConflictError();
        }
        if (
          event.owner_id !== ownerId || event.owner_cursor <= afterCursor ||
          event.schema_version !== '0.5' ||
          !KNOWN_JUDGMENT_AGGREGATE_KINDS.includes(
            event.aggregate_kind as typeof KNOWN_JUDGMENT_AGGREGATE_KINDS[number],
          )
        ) {
          throw new ResponsibilityJudgmentConflictError();
        }
        decodedBytes += new TextEncoder().encode(event.payload_json).byteLength;
        if (decodedBytes > this.replayDecodedByteLimit) {
          throw new ResponsibilityJudgmentConflictError();
        }
        events.push(event);
        afterCursor = event.owner_cursor;
      }
      if (rows.length < Math.min(JUDGMENT_REPLAY_BATCH_SIZE, remaining + 1)) break;
    }
    return Object.freeze(events);
  }

  rebuildInCurrentTransaction(ownerId: string, at: string): Readonly<{
    snapshotId: string;
    highWaterCursor: number;
    itemCount: number;
  }> {
    const highWaterCursor = this.events.readHighWater(ownerId);
    const events = this.readRelevantEventsInCurrentTransaction(ownerId);
    const items: JudgmentProjectionItemV05[] = [];
    let priorCursor = 0;
    for (const event of events) {
      if (event.owner_id !== ownerId || event.owner_cursor <= priorCursor) {
        throw new ResponsibilityJudgmentConflictError();
      }
      priorCursor = event.owner_cursor;
      const item = this.itemFromEvent(event);
      if (item !== undefined) items.push(item);
    }
    const snapshotId = this.newSnapshotId();
    this.storage.sql.exec('DELETE FROM judgment_projection');
    this.storage.sql.exec('DELETE FROM judgment_projection_state');
    this.storage.sql.exec(
      `INSERT INTO judgment_projection_state (
        owner_id, snapshot_id, snapshot_base_cursor, updated_at
      ) VALUES (?, ?, 0, ?)`,
      ownerId,
      snapshotId,
      at,
    );
    for (const item of items) {
      this.insertItemInCurrentTransaction(ownerId, item);
    }
    return Object.freeze({ snapshotId, highWaterCursor, itemCount: items.length });
  }

  assertDigestProofsInCurrentTransaction(
    ownerId: string,
    proofs: readonly JudgmentRequestDigestProofV05[],
  ): void {
    const proofByCursor = new Map(proofs.map((proof) => [proof.ownerCursor, proof]));
    const expectedItems = new Map<number, JudgmentProjectionItemV05>();
    for (const event of this.readRelevantEventsInCurrentTransaction(ownerId)) {
      if (event.aggregate_kind !== 'judgment_request') continue;
      const payload = validateJudgmentRequestEventV05(event);
      const proof = proofByCursor.get(event.owner_cursor);
      if (
        proof === undefined ||
        proof.canonicalRequestMaterial !==
          canonicalizeJudgmentRequestV05ForDigest(payload.request) ||
        proof.digest !== payload.displayedRequestDigest
      ) {
        throw new ResponsibilityJudgmentConflictError();
      }
      expectedItems.set(event.owner_cursor, judgmentProjectionItemV05Schema.parse({
        cursor: event.owner_cursor,
        itemType: 'judgment_request',
        request: payload.request,
        displayedRequestDigest: proof.digest,
      }));
    }
    if (expectedItems.size !== proofs.length) throw new ResponsibilityJudgmentConflictError();
    const rows = this.storage.sql.exec<{
      owner_cursor: number; owner_id: string; item_json: string;
    }>(
      `SELECT owner_cursor, owner_id, item_json FROM judgment_projection
        ORDER BY owner_cursor LIMIT ?`,
      expectedItems.size + 1,
    ).toArray();
    if (rows.length !== expectedItems.size) {
      throw new ResponsibilityJudgmentConflictError();
    }
    for (const row of rows) {
      const expected = expectedItems.get(row.owner_cursor);
      let item: JudgmentProjectionItemV05;
      try {
        item = judgmentProjectionItemV05Schema.parse(JSON.parse(row.item_json));
      } catch {
        throw new ResponsibilityJudgmentConflictError();
      }
      if (
        expected === undefined || row.owner_id !== ownerId ||
        JSON.stringify(item) !== JSON.stringify(expected)
      ) {
        throw new ResponsibilityJudgmentConflictError();
      }
    }
  }

  assertRebuiltProjectionInCurrentTransaction(input: Readonly<{
    ownerId: string;
    snapshotId: string;
    updatedAt: string;
    digestProofs: readonly JudgmentRequestDigestProofV05[];
  }>): void {
    const snapshots = this.storage.sql.exec<{
      owner_id: string; snapshot_id: string; snapshot_base_cursor: number; updated_at: string;
    }>(
      `SELECT owner_id, snapshot_id, snapshot_base_cursor, updated_at
         FROM judgment_projection_state LIMIT 2`,
    ).toArray();
    if (
      snapshots.length !== 1 || snapshots[0]?.owner_id !== input.ownerId ||
      snapshots[0].snapshot_id !== input.snapshotId ||
      snapshots[0].snapshot_base_cursor !== 0 ||
      snapshots[0].updated_at !== input.updatedAt
    ) {
      throw new ResponsibilityJudgmentConflictError();
    }
    this.assertDigestProofsInCurrentTransaction(
      input.ownerId,
      input.digestProofs,
    );
  }

  readInCurrentTransaction(input: Readonly<{
    ownerId: string;
    fromExclusiveCursor: number;
    limit: number;
    snapshotId?: string;
    generatedAt: string;
  }>): JudgmentProjectionPageV05 {
    const snapshot = this.storage.sql.exec<{
      owner_id: string; snapshot_id: string; snapshot_base_cursor: number;
    }>(
      `SELECT owner_id, snapshot_id, snapshot_base_cursor
         FROM judgment_projection_state WHERE owner_id = ?`,
      input.ownerId,
    ).toArray()[0];
    if (snapshot === undefined) throw new ResponsibilityProjectionMissingError();
    if (snapshot.owner_id !== input.ownerId) throw new ResponsibilityJudgmentConflictError();
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
    const rows = this.storage.sql.exec<{
      owner_cursor: number; owner_id: string; item_json: string;
    }>(
      `SELECT owner_cursor, owner_id, item_json FROM judgment_projection
        WHERE owner_cursor > ? AND owner_cursor <= ?
        ORDER BY owner_cursor ASC LIMIT ?`,
      input.fromExclusiveCursor,
      highWaterCursor,
      input.limit,
    ).toArray();
    let priorCursor = input.fromExclusiveCursor;
    const items = rows.map((row) => {
      let item: JudgmentProjectionItemV05;
      try {
        item = judgmentProjectionItemV05Schema.parse(JSON.parse(row.item_json));
      } catch {
        throw new ResponsibilityJudgmentConflictError();
      }
      if (
        row.owner_id !== input.ownerId ||
        item.request.ownerId !== input.ownerId ||
        item.cursor !== row.owner_cursor ||
        item.cursor <= priorCursor
      ) {
        throw new ResponsibilityJudgmentConflictError();
      }
      priorCursor = item.cursor;
      return item;
    });
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

  private ensureSnapshotInCurrentTransaction(ownerId: string, at: string): void {
    const existing = this.storage.sql.exec<{ owner_id: string }>(
      'SELECT owner_id FROM judgment_projection_state WHERE owner_id = ?',
      ownerId,
    ).toArray()[0];
    if (existing !== undefined) {
      if (existing.owner_id !== ownerId) throw new ResponsibilityJudgmentConflictError();
      return;
    }
    this.storage.sql.exec(
      `INSERT INTO judgment_projection_state (
        owner_id, snapshot_id, snapshot_base_cursor, updated_at
      ) VALUES (?, ?, 0, ?)`,
      ownerId,
      this.newSnapshotId(),
      at,
    );
  }

  private publishEventInCurrentTransaction(
    event: StoredOwnerEventV05,
  ): JudgmentProjectionItemV05 | undefined {
    const item = this.itemFromEvent(event);
    if (item !== undefined) this.insertItemInCurrentTransaction(event.owner_id, item);
    return item;
  }

  private itemFromEvent(event: StoredOwnerEventV05): JudgmentProjectionItemV05 | undefined {
    if (event.schema_version !== '0.5') return undefined;
    if (event.aggregate_kind === 'judgment_request') {
      const payload = validateJudgmentRequestEventV05(event);
      return judgmentProjectionItemV05Schema.parse({
        cursor: event.owner_cursor,
        itemType: 'judgment_request',
        request: payload.request,
        displayedRequestDigest: payload.displayedRequestDigest,
      });
    }
    if (
      event.aggregate_kind === 'judgment_decision' ||
      event.aggregate_kind === 'authority_grant'
    ) {
      try {
        const aggregate = event.aggregate_kind === 'judgment_decision'
          ? judgmentDecisionV05Schema.parse(JSON.parse(event.payload_json))
          : authorityGrantV05Schema.parse(JSON.parse(event.payload_json));
        const expectedType = event.aggregate_kind === 'judgment_decision'
          ? 'judgment_decision.recorded'
          : 'authority_grant.issued';
        if (
          event.event_type !== expectedType || aggregate.id !== event.aggregate_id ||
          aggregate.ownerId !== event.owner_id || aggregate.revision !== event.revision
        ) {
          throw new ResponsibilityJudgmentConflictError();
        }
        return undefined;
      } catch (error) {
        if (error instanceof ResponsibilityJudgmentConflictError) throw error;
        throw new ResponsibilityJudgmentConflictError();
      }
    }
    throw new ResponsibilityJudgmentConflictError();
  }

  private insertItemInCurrentTransaction(ownerId: string, item: JudgmentProjectionItemV05): void {
    if (item.request.ownerId !== ownerId) throw new ResponsibilityJudgmentConflictError();
    this.storage.sql.exec(
      `INSERT INTO judgment_projection (owner_cursor, owner_id, item_json)
       VALUES (?, ?, ?)`,
      item.cursor,
      ownerId,
      JSON.stringify(item),
    );
  }
}
