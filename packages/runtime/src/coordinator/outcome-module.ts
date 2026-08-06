import {
  missionRecordV02Schema,
  outcomeRecordV02Schema,
  responsibilityProjectionItemV02Schema,
  workUnitProposalRecordV02Schema,
  type MissionRecordV02,
  type OutcomeRecordV02,
  type ResponsibilityCapturePayloadV02,
  type ResponsibilityProjectionItemV02,
  type WorkUnitProposalRecordV02,
} from '@waldo/contracts';
import { OwnerEventLog } from './owner-event-log';

export type OutcomeRecord = OutcomeRecordV02;
export type MissionRecord = MissionRecordV02;
export type WorkUnitProposalRecord = WorkUnitProposalRecordV02;

export type CapturedResponsibility = Readonly<{
  outcome: OutcomeRecord;
  mission: MissionRecord | null;
  workUnitProposals: readonly WorkUnitProposalRecord[];
  finalCursor: number;
}>;

export type ResponsibilityReplay = Readonly<{
  ownerId: string;
  outcomes: readonly OutcomeRecord[];
  missions: readonly MissionRecord[];
  workUnitProposals: readonly WorkUnitProposalRecord[];
  items: readonly ResponsibilityProjectionItemV02[];
  highWaterCursor: number;
}>;

export class ResponsibilityCapacityError extends Error {
  constructor(readonly code: 'event_limit' | 'decoded_byte_limit') {
    super(`responsibility replay capacity exceeded: ${code}`);
    this.name = 'ResponsibilityCapacityError';
  }
}

type DomainRecord = OutcomeRecord | MissionRecord | WorkUnitProposalRecord;
type ResponsibilityAggregateKind = 'outcome' | 'mission' | 'work_unit_proposal';
type StoredEventRow = {
  owner_cursor: number;
  schema_version: string;
  owner_id: string;
  aggregate_kind: ResponsibilityAggregateKind;
  aggregate_id: string;
  revision: number;
  event_type: string;
  payload_json: string;
};

const REPLAY_BATCH_SIZE = 256;
const MAX_REPLAY_EVENTS = 10_000;
const MAX_REPLAY_DECODED_BYTES = 8 * 1_024 * 1_024;

export class ProjectionPublisher {
  constructor(private readonly storage: DurableObjectStorage) {}

  ensureSnapshotInCurrentTransaction(ownerId: string, snapshotId: string, at: string): string {
    const row = this.storage.sql.exec<{ snapshot_id: string }>(
      'SELECT snapshot_id FROM responsibility_projection_state WHERE owner_id = ?',
      ownerId,
    ).toArray()[0];
    if (row !== undefined) return row.snapshot_id;
    this.storage.sql.exec(
      `INSERT INTO responsibility_projection_state (
        owner_id, snapshot_id, snapshot_base_cursor, updated_at
      ) VALUES (?, ?, 0, ?)`,
      ownerId,
      snapshotId,
      at,
    );
    return snapshotId;
  }

  readSnapshot(ownerId: string): Readonly<{ snapshotId: string; snapshotBaseCursor: number }> {
    const row = this.storage.sql.exec<{
      snapshot_id: string;
      snapshot_base_cursor: number;
    }>(
      `SELECT snapshot_id, snapshot_base_cursor
         FROM responsibility_projection_state WHERE owner_id = ?`,
      ownerId,
    ).toArray()[0];
    if (row === undefined) throw new Error('responsibility projection snapshot missing');
    return Object.freeze({
      snapshotId: row.snapshot_id,
      snapshotBaseCursor: row.snapshot_base_cursor,
    });
  }

  publishInCurrentTransaction(ownerId: string, candidate: unknown): void {
    const item = responsibilityProjectionItemV02Schema.parse(candidate);
    this.storage.sql.exec(
      `INSERT INTO responsibility_projection (owner_cursor, owner_id, item_json)
       VALUES (?, ?, ?)`,
      item.cursor,
      ownerId,
      JSON.stringify(item),
    );
  }
}

/** Sole writer and reducer owner for captured Outcome, Mission, and WorkUnitProposal state. */
export class OutcomeModule {
  readonly projections: ProjectionPublisher;
  private readonly events: OwnerEventLog;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly newId: (
      kind: 'outcome' | 'mission' | 'work_unit_proposal' | 'event' | 'snapshot',
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
    this.events = new OwnerEventLog(storage);
    this.projections = new ProjectionPublisher(storage);
  }

  captureInCurrentTransaction(input: {
    ownerId: string;
    payload: ResponsibilityCapturePayloadV02;
    at: string;
    commandId: string;
    correlationId: string;
    afterCurrentState?: () => void;
    afterEvents?: () => void;
    afterProjection?: () => void;
  }): CapturedResponsibility {
    const outcome = Object.freeze(outcomeRecordV02Schema.parse({
      id: this.newId('outcome'),
      ownerId: input.ownerId,
      revision: 1,
      userStatement: input.payload.userStatement,
      state: 'captured',
      createdAt: input.at,
      updatedAt: input.at,
    }));
    const mission = input.payload.mission === undefined ? null : Object.freeze(
      missionRecordV02Schema.parse({
        id: this.newId('mission'),
        ownerId: input.ownerId,
        outcomeId: outcome.id,
        revision: 1,
        brief: input.payload.mission.brief,
        state: 'proposed',
        createdAt: input.at,
        updatedAt: input.at,
      }),
    );
    const workUnitProposals = Object.freeze((input.payload.workUnitProposals ?? []).map(
      (proposal, position) => Object.freeze(workUnitProposalRecordV02Schema.parse({
        id: this.newId('work_unit_proposal'),
        ownerId: input.ownerId,
        outcomeId: outcome.id,
        missionId: mission?.id ?? null,
        position,
        revision: 1,
        responsibility: proposal.responsibility,
        state: 'proposed',
        createdAt: input.at,
        updatedAt: input.at,
      })),
    ));
    this.assertCaptureCapacity([
      outcome,
      ...(mission === null ? [] : [mission]),
      ...workUnitProposals,
    ]);

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
    for (const proposal of workUnitProposals) {
      this.storage.sql.exec(
        `INSERT INTO work_unit_proposals (
          id, owner_id, outcome_id, mission_id, position, revision, responsibility,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        proposal.id, proposal.ownerId, proposal.outcomeId, proposal.missionId,
        proposal.position, proposal.revision, proposal.responsibility,
        proposal.state, proposal.createdAt, proposal.updatedAt,
      );
    }
    input.afterCurrentState?.();

    const projectionItems: ResponsibilityProjectionItemV02[] = [];
    let appended = this.appendChange({
      aggregateKind: 'outcome',
      eventType: 'outcome.captured',
      record: outcome,
      commandId: input.commandId,
      correlationId: input.correlationId,
      projectionItem: (cursor) => ({
        cursor, itemType: 'outcome', aggregateId: outcome.id, outcomeId: outcome.id,
        revision: outcome.revision, state: outcome.state,
        userStatement: outcome.userStatement, createdAt: outcome.createdAt,
      }),
    });
    let finalCursor = appended.cursor;
    projectionItems.push(appended.item);
    if (mission !== null) {
      appended = this.appendChange({
        aggregateKind: 'mission',
        eventType: 'mission.proposed',
        record: mission,
        commandId: input.commandId,
        correlationId: input.correlationId,
        projectionItem: (cursor) => ({
          cursor, itemType: 'mission', aggregateId: mission.id,
          outcomeId: mission.outcomeId, revision: mission.revision, state: mission.state,
          brief: mission.brief, createdAt: mission.createdAt,
        }),
      });
      finalCursor = appended.cursor;
      projectionItems.push(appended.item);
    }
    for (const proposal of workUnitProposals) {
      appended = this.appendChange({
        aggregateKind: 'work_unit_proposal',
        eventType: 'work_unit_proposal.recorded',
        record: proposal,
        commandId: input.commandId,
        correlationId: input.correlationId,
        projectionItem: (cursor) => ({
          cursor, itemType: 'work_unit_proposal', aggregateId: proposal.id,
          outcomeId: proposal.outcomeId, missionId: proposal.missionId,
          position: proposal.position, revision: proposal.revision, state: proposal.state,
          responsibility: proposal.responsibility, createdAt: proposal.createdAt,
        }),
      });
      finalCursor = appended.cursor;
      projectionItems.push(appended.item);
    }
    input.afterEvents?.();
    for (const item of projectionItems) {
      this.projections.publishInCurrentTransaction(input.ownerId, item);
    }
    input.afterProjection?.();
    return Object.freeze({ outcome, mission, workUnitProposals, finalCursor });
  }

  replay(ownerId: string): ResponsibilityReplay {
    const highWaterCursor = this.events.readHighWater(ownerId);
    const outcomes = new Map<string, OutcomeRecord>();
    const missions = new Map<string, MissionRecord>();
    const proposals = new Map<string, WorkUnitProposalRecord>();
    const missionByOutcome = new Set<string>();
    const proposalCountByOutcome = new Map<string, number>();
    const items: ResponsibilityProjectionItemV02[] = [];
    let lastCursor = 0;
    let decodedBytes = 0;
    let rows: StoredEventRow[];
    do {
      rows = this.storage.sql.exec<StoredEventRow>(
        `SELECT owner_cursor, schema_version, owner_id, aggregate_kind, aggregate_id,
                revision, event_type, payload_json
           FROM owner_domain_events
          WHERE owner_id = ? AND owner_cursor > ?
            AND aggregate_kind IN ('outcome', 'mission', 'work_unit_proposal')
          ORDER BY owner_cursor ASC
          LIMIT ?`,
        ownerId,
        lastCursor,
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
        if (row.owner_cursor <= lastCursor || row.owner_id !== ownerId) {
          throw new Error('invalid responsibility event ordering or owner');
        }
        if (row.schema_version !== '0.2') {
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
          items.push(responsibilityProjectionItemV02Schema.parse({
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
          items.push(responsibilityProjectionItemV02Schema.parse({
            cursor: row.owner_cursor, itemType: 'mission', aggregateId: mission.id,
            outcomeId: mission.outcomeId, revision: mission.revision, state: mission.state,
            brief: mission.brief, createdAt: mission.createdAt,
          }));
        } else {
          const proposal = record as WorkUnitProposalRecord;
          const count = proposalCountByOutcome.get(proposal.outcomeId) ?? 0;
          const mission = proposal.missionId === null ? null : missions.get(proposal.missionId);
          if (row.event_type !== 'work_unit_proposal.recorded' ||
              !outcomes.has(proposal.outcomeId) ||
              (proposal.missionId !== null && mission?.outcomeId !== proposal.outcomeId) ||
              count >= 32 || proposal.position !== count) {
            throw new Error('invalid WorkUnitProposal relationship or transition');
          }
          proposals.set(proposal.id, proposal);
          proposalCountByOutcome.set(proposal.outcomeId, count + 1);
          items.push(responsibilityProjectionItemV02Schema.parse({
            cursor: row.owner_cursor, itemType: 'work_unit_proposal', aggregateId: proposal.id,
            outcomeId: proposal.outcomeId, missionId: proposal.missionId,
            position: proposal.position, revision: proposal.revision, state: proposal.state,
            responsibility: proposal.responsibility, createdAt: proposal.createdAt,
          }));
        }
        lastCursor = row.owner_cursor;
      }
    } while (rows.length === REPLAY_BATCH_SIZE);

    const replay = Object.freeze({
      ownerId,
      outcomes: Object.freeze([...outcomes.values()]),
      missions: Object.freeze([...missions.values()]),
      workUnitProposals: Object.freeze([...proposals.values()]),
      items: Object.freeze(items),
      highWaterCursor,
    });
    this.assertMaterializationsMatch(replay);
    return replay;
  }

  private assertCaptureCapacity(records: readonly DomainRecord[]): void {
    const current = this.storage.sql.exec<{ event_count: number; decoded_bytes: number }>(
      `SELECT count(*) AS event_count,
              coalesce(sum(length(CAST(payload_json AS BLOB))), 0) AS decoded_bytes
         FROM owner_domain_events
        WHERE aggregate_kind IN ('outcome', 'mission', 'work_unit_proposal')`,
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

  private assertMaterializationsMatch(replay: ResponsibilityReplay): void {
    const limit = this.replayEventLimit + 1;
    const outcomes = this.storage.sql.exec<{
      id: string; ownerId: string; revision: number; userStatement: string; state: string;
      createdAt: string; updatedAt: string;
    }>(
      `SELECT id, owner_id AS ownerId, revision, user_statement AS userStatement,
              state, created_at AS createdAt, updated_at AS updatedAt
         FROM outcomes WHERE owner_id = ? ORDER BY id LIMIT ?`,
      replay.ownerId, limit,
    ).toArray().map((row) => outcomeRecordV02Schema.parse(row));
    const missions = this.storage.sql.exec<{
      id: string; ownerId: string; outcomeId: string; revision: number; brief: string;
      state: string; createdAt: string; updatedAt: string;
    }>(
      `SELECT id, owner_id AS ownerId, outcome_id AS outcomeId, revision, brief,
              state, created_at AS createdAt, updated_at AS updatedAt
         FROM missions WHERE owner_id = ? ORDER BY id LIMIT ?`,
      replay.ownerId, limit,
    ).toArray().map((row) => missionRecordV02Schema.parse(row));
    const proposals = this.storage.sql.exec<{
      id: string; ownerId: string; outcomeId: string; missionId: string | null;
      position: number; revision: number; responsibility: string; state: string;
      createdAt: string; updatedAt: string;
    }>(
      `SELECT id, owner_id AS ownerId, outcome_id AS outcomeId, mission_id AS missionId,
              position, revision, responsibility, state,
              created_at AS createdAt, updated_at AS updatedAt
         FROM work_unit_proposals WHERE owner_id = ? ORDER BY id LIMIT ?`,
      replay.ownerId, limit,
    ).toArray().map((row) => workUnitProposalRecordV02Schema.parse(row));
    const items = this.storage.sql.exec<{ owner_cursor: number; item_json: string }>(
      `SELECT owner_cursor, item_json FROM responsibility_projection
        WHERE owner_id = ? ORDER BY owner_cursor ASC LIMIT ?`,
      replay.ownerId, limit,
    ).toArray().map((row) => {
      let item: ResponsibilityProjectionItemV02;
      try {
        item = responsibilityProjectionItemV02Schema.parse(JSON.parse(row.item_json));
      } catch {
        throw new Error('responsibility replay materialization mismatch');
      }
      if (item.cursor !== row.owner_cursor) {
        throw new Error('responsibility replay materialization mismatch');
      }
      return item;
    });
    const byId = <T extends { id: string }>(values: readonly T[]) =>
      [...values].sort((left, right) => left.id.localeCompare(right.id));
    const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    const recordsEqual = <T extends { id: string }>(left: readonly T[], right: readonly T[]) => {
      const a = byId(left);
      const b = byId(right);
      return a.length === b.length && a.every((value, index) => equal(value, b[index]));
    };
    if (!recordsEqual(outcomes, replay.outcomes) ||
        !recordsEqual(missions, replay.missions) ||
        !recordsEqual(proposals, replay.workUnitProposals) ||
        items.length !== replay.items.length ||
        items.some((item, index) => !equal(item, replay.items[index])) ||
        outcomes.length > this.replayEventLimit || missions.length > this.replayEventLimit ||
        proposals.length > this.replayEventLimit || items.length > this.replayEventLimit) {
      throw new Error('responsibility replay materialization mismatch');
    }
  }

  private parseEventRecord(row: StoredEventRow): DomainRecord {
    let value: unknown;
    try {
      value = JSON.parse(row.payload_json);
    } catch {
      throw new Error('invalid responsibility event payload');
    }
    const parsed = row.aggregate_kind === 'outcome'
      ? outcomeRecordV02Schema.safeParse(value)
      : row.aggregate_kind === 'mission'
        ? missionRecordV02Schema.safeParse(value)
        : workUnitProposalRecordV02Schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`invalid ${row.aggregate_kind} event payload`);
    }
    if (parsed.data.revision !== row.revision) {
      throw new Error('invalid responsibility event revision');
    }
    return parsed.data;
  }

  private appendChange(input: {
    aggregateKind: ResponsibilityAggregateKind;
    eventType: string;
    record: DomainRecord;
    commandId: string;
    correlationId: string;
    projectionItem: (cursor: number) => unknown;
  }): Readonly<{ cursor: number; item: ResponsibilityProjectionItemV02 }> {
    const cursor = this.events.appendInCurrentTransaction({
      schemaVersion: '0.2',
      eventId: this.newId('event'),
      ownerId: input.record.ownerId,
      aggregateKind: input.aggregateKind,
      aggregateId: input.record.id,
      revision: input.record.revision,
      eventType: input.eventType,
      causationId: input.commandId,
      correlationId: input.correlationId,
      occurredAt: input.record.createdAt,
      payloadJson: JSON.stringify(input.record),
    });
    const item = responsibilityProjectionItemV02Schema.parse(input.projectionItem(cursor));
    return Object.freeze({ cursor, item });
  }
}
