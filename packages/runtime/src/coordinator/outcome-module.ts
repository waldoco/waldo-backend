import {
  canonicalizeProtocolJson,
  missionRecordV01Schema,
  outcomeRecordV01Schema,
  responsibilityProjectionItemV01Schema,
  type ResponsibilityCapturePayload,
  type ResponsibilityProjectionItemV01,
  workUnitRecordV01Schema,
} from '@waldo/contracts';

export type OutcomeRecord = Readonly<{
  id: string;
  ownerId: string;
  revision: number;
  userStatement: string;
  state: 'captured';
  createdAt: string;
  updatedAt: string;
}>;

export type MissionRecord = Readonly<{
  id: string;
  ownerId: string;
  outcomeId: string;
  revision: number;
  brief: string;
  state: 'proposed';
  createdAt: string;
  updatedAt: string;
}>;

export type WorkUnitRecord = Readonly<{
  id: string;
  ownerId: string;
  outcomeId: string;
  missionId: string | null;
  position: number;
  revision: number;
  responsibility: string;
  state: 'proposed';
  createdAt: string;
  updatedAt: string;
}>;

export type CapturedResponsibility = Readonly<{
  outcome: OutcomeRecord;
  mission: MissionRecord | null;
  workUnits: readonly WorkUnitRecord[];
  finalCursor: number;
}>;

export class ResponsibilityCapacityError extends Error {
  constructor(readonly code: 'event_limit' | 'decoded_byte_limit') {
    super(`responsibility capacity exceeded: ${code}`);
    this.name = 'ResponsibilityCapacityError';
  }
}

type DomainRecord = OutcomeRecord | MissionRecord | WorkUnitRecord;
type AggregateKind = 'outcome' | 'mission' | 'work_unit';
const REPLAY_BATCH_SIZE = 256;
const MAX_REPLAY_EVENTS = 10_000;
const MAX_REPLAY_DECODED_BYTES = 8 * 1_024 * 1_024;
type StoredEventRow = {
  owner_cursor: number;
  schema_version: string;
  owner_id: string;
  aggregate_kind: AggregateKind;
  aggregate_id: string;
  revision: number;
  event_type: string;
  payload_json: string;
};

export type ResponsibilityReplay = Readonly<{
  ownerId: string;
  outcomes: readonly OutcomeRecord[];
  missions: readonly MissionRecord[];
  workUnits: readonly WorkUnitRecord[];
  items: readonly ResponsibilityProjectionItemV01[];
  highWaterCursor: number;
}>;

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function isCanonicalServerTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export class ProjectionPublisher {
  constructor(private readonly storage: DurableObjectStorage) {}

  publishInCurrentTransaction(ownerId: string, candidate: unknown): void {
    const item = responsibilityProjectionItemV01Schema.parse(candidate);
    this.storage.sql.exec(
      `INSERT INTO responsibility_projection (owner_cursor, owner_id, item_json)
       VALUES (?, ?, ?)`,
      item.cursor,
      ownerId,
      JSON.stringify(item),
    );
  }

  advanceHighWaterInCurrentTransaction(ownerId: string, cursor: number, at: string): void {
    this.storage.sql.exec(
      `INSERT INTO responsibility_projection_state (owner_id, high_water_cursor, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         high_water_cursor = excluded.high_water_cursor,
         updated_at = excluded.updated_at`,
      ownerId,
      cursor,
      at,
    );
  }
}

/** Sole writer for canonical Outcome, Mission, WorkUnit, and their domain events. */
export class OutcomeModule {
  private readonly projections: ProjectionPublisher;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly newId: (
      kind: 'outcome' | 'mission' | 'work_unit' | 'event' | 'snapshot',
    ) => string,
    private readonly replayEventLimit = MAX_REPLAY_EVENTS,
    private readonly replayDecodedByteLimit = MAX_REPLAY_DECODED_BYTES,
  ) {
    if (!Number.isSafeInteger(replayEventLimit) || replayEventLimit < 1) {
      throw new Error('OutcomeModule requires a positive replay event limit');
    }
    if (!Number.isSafeInteger(replayDecodedByteLimit) || replayDecodedByteLimit < 1) {
      throw new Error('OutcomeModule requires a positive replay byte limit');
    }
    this.projections = new ProjectionPublisher(storage);
  }

  captureInCurrentTransaction(input: {
    ownerId: string;
    payload: ResponsibilityCapturePayload;
    at: string;
    firstCursor: number;
    commandId: string;
    correlationId: string;
    afterCurrentState?: () => void;
    afterEvents?: () => void;
    afterProjection?: () => void;
  }): CapturedResponsibility {
    const outcome: OutcomeRecord = Object.freeze({
      id: this.newId('outcome'),
      ownerId: input.ownerId,
      revision: 1,
      userStatement: input.payload.userStatement,
      state: 'captured',
      createdAt: input.at,
      updatedAt: input.at,
    });
    const mission: MissionRecord | null = input.payload.mission === undefined
      ? null
      : Object.freeze({
          id: this.newId('mission'),
          ownerId: input.ownerId,
          outcomeId: outcome.id,
          revision: 1,
          brief: input.payload.mission.brief,
          state: 'proposed',
          createdAt: input.at,
          updatedAt: input.at,
        });
    const workUnits = Object.freeze(
      (input.payload.workUnits ?? []).map((proposal, position): WorkUnitRecord =>
        Object.freeze({
          id: this.newId('work_unit'),
          ownerId: input.ownerId,
          outcomeId: outcome.id,
          missionId: mission?.id ?? null,
          position,
          revision: 1,
          responsibility: proposal.responsibility,
          state: 'proposed',
          createdAt: input.at,
          updatedAt: input.at,
        }),
      ),
    );
    this.assertCaptureCapacity([outcome, ...(mission === null ? [] : [mission]), ...workUnits]);

    this.storage.sql.exec(
      `INSERT INTO outcomes (
        id, owner_id, revision, user_statement, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      outcome.id, outcome.ownerId, outcome.revision, outcome.userStatement,
      outcome.state, outcome.createdAt, outcome.updatedAt,
    );
    if (mission !== null) {
      this.storage.sql.exec(
        `INSERT INTO missions (
          id, owner_id, outcome_id, revision, brief, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        mission.id, mission.ownerId, mission.outcomeId, mission.revision,
        mission.brief, mission.state, mission.createdAt, mission.updatedAt,
      );
    }
    for (const workUnit of workUnits) {
      this.storage.sql.exec(
        `INSERT INTO work_units (
          id, owner_id, outcome_id, mission_id, position, revision, responsibility,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        workUnit.id, workUnit.ownerId, workUnit.outcomeId, workUnit.missionId,
        workUnit.position, workUnit.revision, workUnit.responsibility,
        workUnit.state, workUnit.createdAt, workUnit.updatedAt,
      );
    }
    input.afterCurrentState?.();

    let cursor = input.firstCursor;
    this.appendChange({
      cursor,
      aggregateKind: 'outcome',
      eventType: 'outcome.captured',
      record: outcome,
      commandId: input.commandId,
      correlationId: input.correlationId,
      projectionItem: {
        cursor, itemType: 'outcome', aggregateId: outcome.id, outcomeId: outcome.id,
        revision: outcome.revision, state: outcome.state,
        userStatement: outcome.userStatement, createdAt: outcome.createdAt,
      },
    });
    cursor += 1;
    if (mission !== null) {
      this.appendChange({
        cursor,
        aggregateKind: 'mission',
        eventType: 'mission.proposed',
        record: mission,
        commandId: input.commandId,
        correlationId: input.correlationId,
        projectionItem: {
          cursor, itemType: 'mission', aggregateId: mission.id, outcomeId: mission.outcomeId,
          revision: mission.revision, state: mission.state, brief: mission.brief,
          createdAt: mission.createdAt,
        },
      });
      cursor += 1;
    }
    for (const workUnit of workUnits) {
      this.appendChange({
        cursor,
        aggregateKind: 'work_unit',
        eventType: 'work_unit.proposed',
        record: workUnit,
        commandId: input.commandId,
        correlationId: input.correlationId,
        projectionItem: {
          cursor, itemType: 'work_unit', aggregateId: workUnit.id,
          outcomeId: workUnit.outcomeId, missionId: workUnit.missionId,
          position: workUnit.position, revision: workUnit.revision, state: workUnit.state,
          responsibility: workUnit.responsibility, createdAt: workUnit.createdAt,
        },
      });
      cursor += 1;
    }
    input.afterEvents?.();
    this.projections.advanceHighWaterInCurrentTransaction(input.ownerId, cursor - 1, input.at);
    input.afterProjection?.();
    return Object.freeze({ outcome, mission, workUnits, finalCursor: cursor - 1 });
  }

  private assertCaptureCapacity(records: readonly DomainRecord[]): void {
    const current = this.storage.sql.exec<{ event_count: number; decoded_bytes: number }>(
      `SELECT count(*) AS event_count,
              coalesce(sum(length(CAST(payload_json AS BLOB))), 0) AS decoded_bytes
         FROM outcome_domain_events`,
    ).one();
    if (current.event_count + records.length > this.replayEventLimit) {
      throw new ResponsibilityCapacityError('event_limit');
    }
    const proposedBytes = records.reduce(
      (total, record) => total + new TextEncoder().encode(JSON.stringify(record)).byteLength,
      0,
    );
    if (current.decoded_bytes + proposedBytes > this.replayDecodedByteLimit) {
      throw new ResponsibilityCapacityError('decoded_byte_limit');
    }
  }

  replay(ownerId: string): ResponsibilityReplay {
    const outcomes = new Map<string, OutcomeRecord>();
    const missions = new Map<string, MissionRecord>();
    const workUnits = new Map<string, WorkUnitRecord>();
    const missionByOutcome = new Set<string>();
    const workUnitCountByOutcome = new Map<string, number>();
    const items: ResponsibilityProjectionItemV01[] = [];
    let expectedCursor = 1;
    let decodedBytes = 0;
    let rows: StoredEventRow[] = [];
    do {
      rows = this.storage.sql.exec<StoredEventRow>(
        `SELECT owner_cursor, schema_version, owner_id, aggregate_kind, aggregate_id, revision,
                event_type, payload_json
           FROM outcome_domain_events
          WHERE owner_id = ? AND owner_cursor >= ?
          ORDER BY owner_cursor ASC
          LIMIT ?`,
        ownerId,
        expectedCursor,
        REPLAY_BATCH_SIZE,
      ).toArray();
      for (const row of rows) {
      if (items.length >= this.replayEventLimit) {
        throw new Error('responsibility replay event limit exceeded');
      }
      decodedBytes += new TextEncoder().encode(row.payload_json).byteLength;
      if (decodedBytes > this.replayDecodedByteLimit) {
        throw new Error('responsibility replay byte limit exceeded');
      }
      if (row.owner_cursor !== expectedCursor || row.owner_id !== ownerId) {
        throw new Error('invalid responsibility event ordering or owner');
      }
      if (row.schema_version !== '0.1') {
        throw new Error('invalid responsibility event schema version');
      }
      if (row.revision !== 1) throw new Error('invalid responsibility event revision');
      const record = this.parseEventRecord(row);
      if (record.id !== row.aggregate_id || record.ownerId !== ownerId) {
        throw new Error('invalid responsibility event aggregate binding');
      }
      if (row.aggregate_kind === 'outcome') {
        if (row.event_type !== 'outcome.captured' || outcomes.has(record.id)) {
          throw new Error('invalid outcome transition');
        }
        const outcome = record as OutcomeRecord;
        outcomes.set(outcome.id, outcome);
        items.push(responsibilityProjectionItemV01Schema.parse({
          cursor: row.owner_cursor, itemType: 'outcome', aggregateId: outcome.id,
          outcomeId: outcome.id, revision: outcome.revision, state: outcome.state,
          userStatement: outcome.userStatement, createdAt: outcome.createdAt,
        }));
      } else if (row.aggregate_kind === 'mission') {
        const mission = record as MissionRecord;
        if (row.event_type !== 'mission.proposed' || !outcomes.has(mission.outcomeId) ||
            missionByOutcome.has(mission.outcomeId)) {
          throw new Error('invalid mission relationship or transition');
        }
        missions.set(mission.id, mission);
        missionByOutcome.add(mission.outcomeId);
        items.push(responsibilityProjectionItemV01Schema.parse({
          cursor: row.owner_cursor, itemType: 'mission', aggregateId: mission.id,
          outcomeId: mission.outcomeId, revision: mission.revision, state: mission.state,
          brief: mission.brief, createdAt: mission.createdAt,
        }));
      } else {
        const workUnit = record as WorkUnitRecord;
        const outcomeWorkUnitCount = workUnitCountByOutcome.get(workUnit.outcomeId) ?? 0;
        const mission = workUnit.missionId === null ? null : missions.get(workUnit.missionId);
        if (row.event_type !== 'work_unit.proposed' || !outcomes.has(workUnit.outcomeId) ||
            (workUnit.missionId !== null && mission?.outcomeId !== workUnit.outcomeId) ||
            outcomeWorkUnitCount >= 32 || workUnit.position !== outcomeWorkUnitCount) {
          throw new Error('invalid WorkUnit relationship or transition');
        }
        workUnits.set(workUnit.id, workUnit);
        workUnitCountByOutcome.set(workUnit.outcomeId, outcomeWorkUnitCount + 1);
        items.push(responsibilityProjectionItemV01Schema.parse({
          cursor: row.owner_cursor, itemType: 'work_unit', aggregateId: workUnit.id,
          outcomeId: workUnit.outcomeId, missionId: workUnit.missionId,
          position: workUnit.position, revision: workUnit.revision, state: workUnit.state,
          responsibility: workUnit.responsibility, createdAt: workUnit.createdAt,
        }));
      }
      expectedCursor += 1;
      }
    } while (rows.length === REPLAY_BATCH_SIZE);
    const replay = Object.freeze({
      ownerId,
      outcomes: Object.freeze([...outcomes.values()]),
      missions: Object.freeze([...missions.values()]),
      workUnits: Object.freeze([...workUnits.values()]),
      items: Object.freeze(items),
      highWaterCursor: expectedCursor - 1,
    });
    this.assertMaterializationsMatch(replay);
    return replay;
  }

  private assertMaterializationsMatch(replay: ResponsibilityReplay): void {
    const limit = this.replayEventLimit + 1;
    const currentOutcomes = this.storage.sql.exec<{
      id: string; ownerId: string; revision: number; userStatement: string;
      state: string; createdAt: string; updatedAt: string;
    }>(
      `SELECT id, owner_id AS ownerId, revision, user_statement AS userStatement,
              state, created_at AS createdAt, updated_at AS updatedAt
         FROM outcomes WHERE owner_id = ? ORDER BY id LIMIT ?`,
      replay.ownerId, limit,
    ).toArray().map((row) => outcomeRecordV01Schema.parse(row));
    const currentMissions = this.storage.sql.exec<{
      id: string; ownerId: string; outcomeId: string; revision: number; brief: string;
      state: string; createdAt: string; updatedAt: string;
    }>(
      `SELECT id, owner_id AS ownerId, outcome_id AS outcomeId, revision, brief,
              state, created_at AS createdAt, updated_at AS updatedAt
         FROM missions WHERE owner_id = ? ORDER BY id LIMIT ?`,
      replay.ownerId, limit,
    ).toArray().map((row) => missionRecordV01Schema.parse(row));
    const currentWorkUnits = this.storage.sql.exec<{
      id: string; ownerId: string; outcomeId: string; missionId: string | null;
      position: number; revision: number; responsibility: string; state: string;
      createdAt: string; updatedAt: string;
    }>(
      `SELECT id, owner_id AS ownerId, outcome_id AS outcomeId, mission_id AS missionId,
              position, revision, responsibility, state,
              created_at AS createdAt, updated_at AS updatedAt
         FROM work_units WHERE owner_id = ? ORDER BY id LIMIT ?`,
      replay.ownerId, limit,
    ).toArray().map((row) => workUnitRecordV01Schema.parse(row));
    const persistedItems = this.storage.sql.exec<{ owner_cursor: number; item_json: string }>(
      `SELECT owner_cursor, item_json FROM responsibility_projection
        WHERE owner_id = ? ORDER BY owner_cursor ASC LIMIT ?`,
      replay.ownerId, limit,
    ).toArray().map((row) => {
      const item = responsibilityProjectionItemV01Schema.parse(JSON.parse(row.item_json));
      if (item.cursor !== row.owner_cursor) {
        throw new Error('responsibility replay materialization mismatch');
      }
      return item;
    });
    const persistedHighWater = this.storage.sql.exec<{ cursor: number }>(
      `SELECT high_water_cursor AS cursor FROM responsibility_projection_state
        WHERE owner_id = ?`,
      replay.ownerId,
    ).toArray()[0]?.cursor ?? 0;
    const byId = <T extends { id: string }>(values: readonly T[]) =>
      [...values].sort((left, right) => left.id.localeCompare(right.id));
    const recordListsMatch = <T extends { id: string }>(
      left: readonly T[], right: readonly T[],
    ): boolean => {
      const sortedLeft = byId(left);
      const sortedRight = byId(right);
      return sortedLeft.length === sortedRight.length && sortedLeft.every(
        (record, index) =>
          canonicalizeProtocolJson(record) === canonicalizeProtocolJson(sortedRight[index]),
      );
    };
    const projectionListsMatch = persistedItems.length === replay.items.length &&
      persistedItems.every((item, index) =>
        canonicalizeProtocolJson(item) === canonicalizeProtocolJson(replay.items[index]));
    const matches = recordListsMatch(currentOutcomes, replay.outcomes) &&
      recordListsMatch(currentMissions, replay.missions) &&
      recordListsMatch(currentWorkUnits, replay.workUnits) && projectionListsMatch &&
      persistedHighWater === replay.highWaterCursor;
    if (!matches || currentOutcomes.length > this.replayEventLimit ||
        currentMissions.length > this.replayEventLimit ||
        currentWorkUnits.length > this.replayEventLimit ||
        persistedItems.length > this.replayEventLimit) {
      throw new Error('responsibility replay materialization mismatch');
    }
  }

  private parseEventRecord(row: StoredEventRow): DomainRecord {
    const value = JSON.parse(row.payload_json) as Record<string, unknown>;
    const baseValid = typeof value.id === 'string' && typeof value.ownerId === 'string' &&
      value.revision === row.revision && isCanonicalServerTimestamp(value.createdAt) &&
      isCanonicalServerTimestamp(value.updatedAt);
    if (!baseValid) throw new Error('invalid responsibility event payload');
    if (row.aggregate_kind === 'outcome') {
      if (!hasExactKeys(value, [
        'id', 'ownerId', 'revision', 'userStatement', 'state', 'createdAt', 'updatedAt',
      ]) || value.state !== 'captured' || typeof value.userStatement !== 'string') {
        throw new Error('invalid outcome event payload');
      }
      return value as OutcomeRecord;
    }
    if (row.aggregate_kind === 'mission') {
      if (!hasExactKeys(value, [
        'id', 'ownerId', 'outcomeId', 'revision', 'brief', 'state', 'createdAt', 'updatedAt',
      ]) || value.state !== 'proposed' || typeof value.outcomeId !== 'string' ||
          typeof value.brief !== 'string') {
        throw new Error('invalid mission event payload');
      }
      return value as MissionRecord;
    }
    if (!hasExactKeys(value, [
      'id', 'ownerId', 'outcomeId', 'missionId', 'position', 'revision',
      'responsibility', 'state', 'createdAt', 'updatedAt',
    ]) || value.state !== 'proposed' || typeof value.outcomeId !== 'string' ||
        !(typeof value.missionId === 'string' || value.missionId === null) ||
        !Number.isSafeInteger(value.position) || typeof value.responsibility !== 'string') {
      throw new Error('invalid WorkUnit event payload');
    }
    return value as WorkUnitRecord;
  }

  private appendChange(input: {
    cursor: number;
    aggregateKind: AggregateKind;
    eventType: string;
    record: DomainRecord;
    commandId: string;
    correlationId: string;
    projectionItem: Record<string, unknown>;
  }): void {
    this.storage.sql.exec(
      `INSERT INTO outcome_domain_events (
        owner_cursor, schema_version, event_id, owner_id, aggregate_kind, aggregate_id, revision,
        event_type, causation_id, correlation_id, occurred_at, payload_json
      ) VALUES (?, '0.1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.cursor, this.newId('event'), input.record.ownerId, input.aggregateKind,
      input.record.id, input.record.revision, input.eventType, input.commandId,
      input.correlationId, input.record.createdAt, JSON.stringify(input.record),
    );
    this.projections.publishInCurrentTransaction(input.record.ownerId, input.projectionItem);
  }
}
