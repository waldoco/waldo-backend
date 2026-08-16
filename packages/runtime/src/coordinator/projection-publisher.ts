import {
  authorityGrantV05Schema,
  judgmentDecisionV05Schema,
  judgmentProjectionItemV05Schema,
  judgmentProjectionPageUtf8ByteLengthV05,
  judgmentProjectionPageV05Schema,
  judgmentRequestV05Schema,
  MAX_JUDGMENT_PROJECTION_PAGE_UTF8_BYTES_V05,
  protocolDigestSchema,
  type JudgmentProjectionPageV05,
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
  payload_json: string;
}>;

export type JudgmentRequestEventPayloadV05 = Readonly<{
  request: JudgmentRequestV05;
  displayedRequestDigest: `sha256:${string}`;
  admissionBasis: unknown;
}>;

const REQUEST_EVENT_PAYLOAD_KEYS = [
  'request', 'displayedRequestDigest', 'admissionBasis',
] as const;

export function serializeJudgmentRequestEventPayloadV05(
  request: JudgmentRequestV05,
  displayedRequestDigest: `sha256:${string}`,
  admissionBasis: unknown,
): string {
  return JSON.stringify({
    request: judgmentRequestV05Schema.parse(request),
    displayedRequestDigest: protocolDigestSchema.parse(displayedRequestDigest),
    admissionBasis,
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
    (request.state === 'answered') !== (request.decisionId !== null)
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
  ) {
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
              revision, event_type, payload_json
         FROM owner_domain_events WHERE owner_cursor = ?`,
      input.cursor,
    ).toArray()[0];
    if (event === undefined || event.owner_id !== input.ownerId) {
      throw new ResponsibilityJudgmentConflictError();
    }
    this.ensureSnapshotInCurrentTransaction(input.ownerId, input.at);
    return this.publishEventInCurrentTransaction(event);
  }

  rebuildInCurrentTransaction(ownerId: string, at: string): Readonly<{
    snapshotId: string;
    highWaterCursor: number;
    itemCount: number;
  }> {
    const highWaterCursor = this.events.readHighWater(ownerId);
    const events = this.storage.sql.exec<StoredOwnerEventV05>(
      `SELECT owner_cursor, schema_version, owner_id, aggregate_kind, aggregate_id,
              revision, event_type, payload_json
         FROM owner_domain_events ORDER BY owner_cursor ASC`,
    ).toArray();
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
    if (priorCursor !== highWaterCursor) throw new ResponsibilityJudgmentConflictError();

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
      const item = judgmentProjectionItemV05Schema.parse(JSON.parse(row.item_json));
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
