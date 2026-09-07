import { ResponsibilityOwnerRootMismatchError } from '../responsibility/errors';

export type OwnerDomainEventDraft = Readonly<{
  schemaVersion: '0.2' | '0.3' | '0.5' | '0.6';
  eventId: string;
  ownerId: string;
  aggregateKind: string;
  aggregateId: string;
  revision: number;
  eventType: string;
  causationId: string;
  correlationId: string;
  occurredAt: string;
  payloadJson: string;
}>;

/** Sole allocator and append owner for the canonical per-owner domain event stream. */
export class OwnerEventLog {
  constructor(private readonly storage: DurableObjectStorage) {}

  appendInCurrentTransaction(draft: OwnerDomainEventDraft): number {
    const root = this.storage.sql.exec<{ owner_id: string }>(
      'SELECT owner_id FROM owner_roots WHERE root_key = 1',
    ).toArray()[0];
    if (root === undefined || root.owner_id !== draft.ownerId) {
      throw new ResponsibilityOwnerRootMismatchError();
    }
    const highWater = this.readHighWater(draft.ownerId);
    let cursor: number;
    if (highWater === 0) {
      cursor = 1;
      this.storage.sql.exec(
        'INSERT INTO owner_event_state (root_key, owner_id, high_water_cursor) VALUES (1, ?, ?)',
        draft.ownerId,
        cursor,
      );
    } else {
      if (highWater >= Number.MAX_SAFE_INTEGER) {
        throw new Error('owner event cursor exhausted');
      }
      cursor = highWater + 1;
      this.storage.sql.exec(
        'UPDATE owner_event_state SET high_water_cursor = ? WHERE root_key = 1',
        cursor,
      );
    }
    this.storage.sql.exec(
      `INSERT INTO owner_domain_events (
        owner_cursor, schema_version, event_id, owner_id, aggregate_kind, aggregate_id,
        revision, event_type, causation_id, correlation_id, occurred_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cursor,
      draft.schemaVersion,
      draft.eventId,
      draft.ownerId,
      draft.aggregateKind,
      draft.aggregateId,
      draft.revision,
      draft.eventType,
      draft.causationId,
      draft.correlationId,
      draft.occurredAt,
      draft.payloadJson,
    );
    return cursor;
  }

  readHighWater(ownerId: string): number {
    const row = this.storage.sql.exec<{ owner_id: string; high_water_cursor: number }>(
      'SELECT owner_id, high_water_cursor FROM owner_event_state WHERE root_key = 1',
    ).toArray()[0];
    const stream = this.storage.sql.exec<{
      event_count: number;
      max_cursor: number | null;
      foreign_owner_count: number;
    }>(
      `SELECT count(*) AS event_count,
              max(owner_cursor) AS max_cursor,
              coalesce(sum(CASE WHEN owner_id <> ? THEN 1 ELSE 0 END), 0) AS foreign_owner_count
         FROM owner_domain_events`,
      ownerId,
    ).one();
    if (stream.foreign_owner_count !== 0) throw new Error('owner event state mismatch');
    if (row === undefined) {
      if (stream.event_count !== 0) throw new Error('owner event state mismatch');
      return 0;
    }
    if (row.owner_id !== ownerId) throw new ResponsibilityOwnerRootMismatchError();
    if (!Number.isSafeInteger(row.high_water_cursor) || row.high_water_cursor < 1) {
      throw new Error('owner event state mismatch');
    }
    if (stream.event_count === 0 || stream.max_cursor !== row.high_water_cursor ||
        stream.event_count !== row.high_water_cursor) {
      throw new Error('owner event state mismatch');
    }
    return row.high_water_cursor;
  }
}