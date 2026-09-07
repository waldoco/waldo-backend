import {
  MAX_CLOSURE_PROJECTION_PAGE_UTF8_BYTES_V06,
  acceptanceCheckV06Schema,
  acceptanceV06Schema,
  canonicalizeClosureProjectionPageV06ForDigest,
  canonicalizeProtocolJson,
  closureDomainEventV06Schema,
  closureProjectionItemV06Schema,
  closureProjectionPageV06Schema,
  evidenceV06Schema,
  protocolDigestSchema,
  verificationV06Schema,
  type ClosureProjectionPageV06,
} from '@waldo/contracts';
import {
  ResponsibilityProjectionCursorError,
  ResponsibilityProjectionMissingError,
} from '../responsibility/errors';
import { OwnerEventLog } from './owner-event-log';

type ProtocolDigest = `sha256:${string}`;
type ClosureProjectionItem = ReturnType<typeof closureProjectionItemV06Schema.parse>;

type StoredClosureEvent = Readonly<{
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

type StoredProjectionRow = Readonly<{
  owner_cursor: number;
  owner_id: string;
  item_json: string;
}>;

const REPLAY_BATCH_SIZE = 256;
const DEFAULT_REPLAY_EVENT_LIMIT = 10_000;
const DEFAULT_REPLAY_DECODED_BYTE_LIMIT = 8 * 1_024 * 1_024;
const KNOWN_CLOSURE_AGGREGATES = [
  'acceptance_check',
  'evidence',
  'verification',
  'acceptance',
] as const;

type KnownClosureAggregate = typeof KNOWN_CLOSURE_AGGREGATES[number];

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function asDigest(hex: string): ProtocolDigest {
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw new ResponsibilityProjectionCursorError('cursor_corrupt');
  }
  return `sha256:${hex}`;
}

function parseEventPayload(event: StoredClosureEvent): ClosureProjectionItem {
  let payload: unknown;
  try {
    payload = JSON.parse(event.payload_json);
  } catch {
    throw new ResponsibilityProjectionCursorError('cursor_corrupt');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ResponsibilityProjectionCursorError('cursor_corrupt');
  }
  const candidate = payload as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(candidate, 'record') ||
    !Object.prototype.hasOwnProperty.call(candidate, 'recordDigest')
  ) {
    throw new ResponsibilityProjectionCursorError('cursor_corrupt');
  }
  const recordDigest = protocolDigestSchema.parse(candidate.recordDigest) as ProtocolDigest;
  const aggregateKind = event.aggregate_kind as KnownClosureAggregate;
  if (!KNOWN_CLOSURE_AGGREGATES.includes(aggregateKind)) {
    throw new ResponsibilityProjectionCursorError('cursor_corrupt');
  }
  const record = aggregateKind === 'acceptance_check'
    ? acceptanceCheckV06Schema.parse(candidate.record)
    : aggregateKind === 'evidence'
      ? evidenceV06Schema.parse(candidate.record)
      : aggregateKind === 'verification'
        ? verificationV06Schema.parse(candidate.record)
        : acceptanceV06Schema.parse(candidate.record);
  if (
    event.schema_version !== '0.6' ||
    record.ownerId !== event.owner_id ||
    record.id !== event.aggregate_id ||
    record.revision !== event.revision
  ) {
    throw new ResponsibilityProjectionCursorError('cursor_corrupt');
  }
  closureDomainEventV06Schema.parse({
    schemaVersion: '0.6',
    eventId: event.causation_id === '' ? 'invalid' : event.causation_id,
    ownerId: event.owner_id,
    aggregate: {
      kind: aggregateKind,
      id: event.aggregate_id,
      revision: event.revision,
    },
    eventType: event.event_type,
    payloadDigest: recordDigest,
    cursor: event.owner_cursor,
    occurredAt: event.occurred_at,
  });
  return closureProjectionItemV06Schema.parse({
    cursor: event.owner_cursor,
    itemType: aggregateKind,
    record,
    recordDigest,
  });
}

export class ClosureProjectionPublisher {
  private readonly events: OwnerEventLog;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly newSnapshotId: () => string,
    private readonly sha256Hex: (value: string) => Promise<string>,
    private readonly replayEventLimit = DEFAULT_REPLAY_EVENT_LIMIT,
    private readonly replayDecodedByteLimit = DEFAULT_REPLAY_DECODED_BYTE_LIMIT,
  ) {
    if (
      !Number.isSafeInteger(replayEventLimit) || replayEventLimit < 1 ||
      !Number.isSafeInteger(replayDecodedByteLimit) || replayDecodedByteLimit < 1
    ) {
      throw new Error('ClosureProjectionPublisher requires positive replay capacity limits');
    }
    this.events = new OwnerEventLog(storage);
  }

  readRelevantEventsInCurrentTransaction(ownerId: string): readonly StoredClosureEvent[] {
    const events: StoredClosureEvent[] = [];
    let afterCursor = 0;
    let decodedBytes = 0;
    while (true) {
      const remaining = this.replayEventLimit - events.length;
      const batchLimit = Math.min(REPLAY_BATCH_SIZE, remaining + 1);
      const rows = this.storage.sql.exec<StoredClosureEvent>(
        `SELECT owner_cursor, schema_version, owner_id, aggregate_kind, aggregate_id,
                revision, event_type, causation_id, correlation_id, occurred_at, payload_json
           FROM owner_domain_events
          WHERE owner_cursor > ? AND (
            schema_version = '0.6' OR
            aggregate_kind IN ('acceptance_check', 'evidence', 'verification', 'acceptance')
          )
          ORDER BY owner_cursor ASC LIMIT ?`,
        afterCursor,
        batchLimit,
      ).toArray();
      if (rows.length === 0) break;
      for (const event of rows) {
        if (events.length >= this.replayEventLimit) {
          throw new ResponsibilityProjectionCursorError('cursor_corrupt');
        }
        const aggregateKind = event.aggregate_kind as KnownClosureAggregate;
        if (
          event.owner_id !== ownerId ||
          event.owner_cursor <= afterCursor ||
          event.schema_version !== '0.6' ||
          !KNOWN_CLOSURE_AGGREGATES.includes(aggregateKind)
        ) {
          throw new ResponsibilityProjectionCursorError('cursor_corrupt');
        }
        decodedBytes += utf8Bytes(event.payload_json);
        if (decodedBytes > this.replayDecodedByteLimit) {
          throw new ResponsibilityProjectionCursorError('cursor_corrupt');
        }
        parseEventPayload(event);
        events.push(event);
        afterCursor = event.owner_cursor;
      }
      if (rows.length < batchLimit) break;
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
    const items = events.map(parseEventPayload);
    const snapshotId = this.newSnapshotId();

    this.storage.sql.exec('DELETE FROM closure_projection WHERE owner_id = ?', ownerId);
    this.storage.sql.exec('DELETE FROM closure_projection_state WHERE owner_id = ?', ownerId);
    this.storage.sql.exec(
      `INSERT INTO closure_projection_state (
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

  async read(input: Readonly<{
    ownerId: string;
    fromExclusiveCursor: number;
    limit: number;
    snapshotId?: string;
    generatedAt: string;
  }>): Promise<ClosureProjectionPageV06> {
    const snapshot = this.storage.sql.exec<{
      owner_id: string;
      snapshot_id: string;
      snapshot_base_cursor: number;
    }>(
      `SELECT owner_id, snapshot_id, snapshot_base_cursor
         FROM closure_projection_state WHERE owner_id = ?`,
      input.ownerId,
    ).toArray()[0];
    if (snapshot === undefined) throw new ResponsibilityProjectionMissingError();
    if (snapshot.owner_id !== input.ownerId) {
      throw new ResponsibilityProjectionCursorError('cursor_corrupt');
    }
    if (input.snapshotId !== undefined && input.snapshotId !== snapshot.snapshot_id) {
      throw new ResponsibilityProjectionCursorError('snapshot_replaced');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256) {
      throw new ResponsibilityProjectionCursorError('cursor_corrupt');
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
    const rows = this.storage.sql.exec<StoredProjectionRow>(
      `SELECT owner_cursor, owner_id, item_json
         FROM closure_projection
        WHERE owner_id = ? AND owner_cursor > ? AND owner_cursor <= ?
        ORDER BY owner_cursor ASC LIMIT ?`,
      input.ownerId,
      input.fromExclusiveCursor,
      highWaterCursor,
      input.limit + 1,
    ).toArray();
    const hasAnotherClosureItem = rows.length > input.limit;
    const visibleRows = rows.slice(0, input.limit);
    let priorCursor = input.fromExclusiveCursor;
    const items: ClosureProjectionItem[] = [];
    for (const row of visibleRows) {
      let item: ClosureProjectionItem;
      try {
        item = closureProjectionItemV06Schema.parse(JSON.parse(row.item_json));
      } catch {
        throw new ResponsibilityProjectionCursorError('cursor_corrupt');
      }
      if (
        row.owner_id !== input.ownerId ||
        item.record.ownerId !== input.ownerId ||
        item.cursor !== row.owner_cursor ||
        item.cursor <= priorCursor
      ) {
        throw new ResponsibilityProjectionCursorError('cursor_corrupt');
      }
      const digest = asDigest(await this.sha256Hex(canonicalizeProtocolJson(item.record)));
      if (item.recordDigest !== digest) {
        throw new ResponsibilityProjectionCursorError('cursor_corrupt');
      }
      priorCursor = item.cursor;
      items.push(item);
    }

    let included = items.length;
    while (true) {
      const pageItems = items.slice(0, included);
      const allClosureItemsIncluded = !hasAnotherClosureItem && included === items.length;
      const nextCursor = allClosureItemsIncluded
        ? highWaterCursor
        : pageItems.at(-1)?.cursor ?? input.fromExclusiveCursor;
      const withoutDigest = {
        protocolVersion: '0.6' as const,
        ownerId: input.ownerId,
        projectionName: 'responsibility.closure' as const,
        snapshotId: snapshot.snapshot_id,
        snapshotBaseCursor: snapshot.snapshot_base_cursor,
        fromExclusiveCursor: input.fromExclusiveCursor,
        highWaterCursor,
        nextCursor,
        items: pageItems,
        hasMore: nextCursor < highWaterCursor,
        generatedAt: input.generatedAt,
      };
      const placeholder = {
        ...withoutDigest,
        pageDigest: `sha256:${'0'.repeat(64)}` as const,
      };
      if (utf8Bytes(JSON.stringify(placeholder)) <= MAX_CLOSURE_PROJECTION_PAGE_UTF8_BYTES_V06) {
        const pageDigest = asDigest(await this.sha256Hex(
          canonicalizeClosureProjectionPageV06ForDigest(placeholder),
        ));
        return Object.freeze(closureProjectionPageV06Schema.parse({
          ...withoutDigest,
          pageDigest,
        }));
      }
      if (included <= 1) throw new ResponsibilityProjectionCursorError('cursor_corrupt');
      included -= 1;
    }
  }

  private insertItemInCurrentTransaction(ownerId: string, item: ClosureProjectionItem): void {
    if (item.record.ownerId !== ownerId) {
      throw new ResponsibilityProjectionCursorError('cursor_corrupt');
    }
    this.storage.sql.exec(
      `INSERT INTO closure_projection (owner_cursor, owner_id, item_json)
       VALUES (?, ?, ?)`,
      item.cursor,
      ownerId,
      JSON.stringify(item),
    );
  }
}