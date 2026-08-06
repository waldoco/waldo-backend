import {
  canonicalizeProtocolJson,
  canonicalizeSurfaceCommandRequestForDigest,
  responsibilityCaptureRequestSchema,
  responsibilityCaptureResultV01Schema,
  responsibilityCaptureTrustedEnvelopeSchema,
  responsibilityProjectionItemV01Schema,
  responsibilityProjectionPageSchema,
  type ResponsibilityCaptureRequest,
  type ResponsibilityCaptureTrustedEnvelope,
  type ResponsibilityProjectionPage,
} from '@waldo/contracts';
import {
  OutcomeModule,
  type MissionRecord,
  type OutcomeRecord,
  type ResponsibilityReplay,
  type WorkUnitRecord,
} from './outcome-module';
export type {
  MissionRecord,
  OutcomeRecord,
  ResponsibilityReplay,
  WorkUnitRecord,
} from './outcome-module';

export type ResponsibilityCaptureResult = Readonly<{
  duplicate: boolean;
  ownerId: string;
  requestId: string;
  outcome: OutcomeRecord;
  mission: MissionRecord | null;
  workUnits: readonly WorkUnitRecord[];
  projectionCursor: number;
}>;

export type ResponsibilityCaptureAdmission = Readonly<{
  routedOwnerId: string;
  request: unknown;
  trustedEnvelope: unknown;
}>;

export type ResponsibilityProjectionRead = Readonly<{
  routedOwnerId: string;
  fromExclusiveCursor: number;
  limit: number;
  snapshotId?: string;
}>;

export class ResponsibilityProjectionCursorError extends Error {
  constructor(readonly code: 'snapshot_replaced' | 'cursor_ahead' | 'cursor_gap') {
    super(`responsibility projection cursor rejected: ${code}`);
    this.name = 'ResponsibilityProjectionCursorError';
  }
}

export type CoordinatorWriteStage =
  | 'owner_root'
  | 'current_state'
  | 'events'
  | 'projection'
  | 'idempotency';

export type CoordinatorDependencies = Readonly<{
  now: () => string;
  newId: (kind: 'outcome' | 'mission' | 'work_unit' | 'event' | 'snapshot') => string;
  sha256Hex: (value: string) => Promise<string>;
  afterWrite?: (stage: CoordinatorWriteStage) => void;
}>;

type StoredCommandRow = {
  owner_id: string;
  request_digest: string;
  result_json: string;
};

type OwnerRootRow = { owner_id: string; snapshot_id: string };

function defaultDependencies(): CoordinatorDependencies {
  return {
    now: () => new Date().toISOString(),
    newId: (kind) => `${kind}_${crypto.randomUUID()}`,
    async sha256Hex(value) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
    },
  };
}

export class WaldoCoordinator {
  readonly #storage: DurableObjectStorage;
  readonly #deps: CoordinatorDependencies;
  readonly #outcomes: OutcomeModule;

  constructor(
    storage: DurableObjectStorage,
    dependencies: CoordinatorDependencies = defaultDependencies(),
  ) {
    this.#storage = storage;
    this.#deps = dependencies;
    this.#outcomes = new OutcomeModule(storage, dependencies.newId);
  }

  async captureResponsibility(
    admission: ResponsibilityCaptureAdmission,
  ): Promise<ResponsibilityCaptureResult> {
    const request = responsibilityCaptureRequestSchema.parse(admission.request);
    const trustedEnvelope = responsibilityCaptureTrustedEnvelopeSchema.parse(
      admission.trustedEnvelope,
    );
    this.#validateTrustedAdmission(admission.routedOwnerId, request, trustedEnvelope);

    const requestDigest = `sha256:${await this.#deps.sha256Hex(
      canonicalizeSurfaceCommandRequestForDigest(request),
    )}`;
    if (trustedEnvelope.requestDigest !== requestDigest) {
      throw new Error('responsibility capture digest conflict');
    }

    return this.#storage.transactionSync(() => {
      const at = this.#deps.now();
      this.#bindOrAssertOwnerRoot(admission.routedOwnerId, at);
      this.#deps.afterWrite?.('owner_root');

      const existing = this.#storage.sql
        .exec<StoredCommandRow>(
          `SELECT owner_id, request_digest, result_json
             FROM responsibility_commands
            WHERE request_id = ?`,
          request.requestId,
        )
        .toArray()[0];
      if (existing !== undefined) {
        if (
          existing.owner_id !== admission.routedOwnerId ||
          existing.request_digest !== requestDigest
        ) {
          throw new Error('responsibility capture digest conflict');
        }
        const persisted = responsibilityCaptureResultV01Schema.parse(
          JSON.parse(existing.result_json),
        );
        if (
          persisted.ownerId !== admission.routedOwnerId ||
          persisted.requestId !== request.requestId
        ) {
          throw new Error('responsibility capture persisted result mismatch');
        }
        this.#assertPersistedCaptureResult(persisted, request);
        this.#outcomes.replay(admission.routedOwnerId);
        return Object.freeze(persisted);
      }

      const captured = this.#outcomes.captureInCurrentTransaction({
        ownerId: admission.routedOwnerId,
        payload: request.payload,
        at,
        firstCursor: this.#nextOwnerCursor(admission.routedOwnerId),
        commandId: trustedEnvelope.commandId,
        correlationId: trustedEnvelope.correlationId,
        afterCurrentState: () => this.#deps.afterWrite?.('current_state'),
        afterEvents: () => this.#deps.afterWrite?.('events'),
        afterProjection: () => this.#deps.afterWrite?.('projection'),
      });
      const result = Object.freeze(responsibilityCaptureResultV01Schema.parse({
        duplicate: false,
        ownerId: admission.routedOwnerId,
        requestId: request.requestId,
        outcome: captured.outcome,
        mission: captured.mission,
        workUnits: captured.workUnits,
        projectionCursor: captured.finalCursor,
      }));
      this.#storage.sql.exec(
        `INSERT INTO responsibility_commands (
          request_id, owner_id, request_digest, result_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?)`,
        request.requestId,
        captured.outcome.ownerId,
        requestDigest,
        JSON.stringify(result),
        at,
      );
      this.#deps.afterWrite?.('idempotency');
      return result;
    });
  }

  readResponsibilityProjection(
    input: ResponsibilityProjectionRead,
  ): ResponsibilityProjectionPage {
    if (!Number.isSafeInteger(input.fromExclusiveCursor) || input.fromExclusiveCursor < 0) {
      throw new Error('invalid responsibility projection cursor');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256) {
      throw new Error('invalid responsibility projection page limit');
    }
    const root = this.#assertOwnerRoot(input.routedOwnerId);
    if (input.fromExclusiveCursor > 0 && input.snapshotId === undefined) {
      throw new ResponsibilityProjectionCursorError('snapshot_replaced');
    }
    if (input.snapshotId !== undefined && input.snapshotId !== root.snapshot_id) {
      throw new ResponsibilityProjectionCursorError('snapshot_replaced');
    }
    const highWaterCursor = this.#storage.sql
      .exec<{ high_water_cursor: number }>(
        'SELECT high_water_cursor FROM responsibility_projection_state WHERE owner_id = ?',
        input.routedOwnerId,
      )
      .toArray()[0]?.high_water_cursor ?? 0;
    if (input.fromExclusiveCursor > highWaterCursor) {
      throw new ResponsibilityProjectionCursorError('cursor_ahead');
    }
    const projectionRows = this.#storage.sql
      .exec<{ owner_cursor: number; item_json: string }>(
        `SELECT owner_cursor, item_json
           FROM responsibility_projection
          WHERE owner_id = ? AND owner_cursor > ? AND owner_cursor <= ?
          ORDER BY owner_cursor ASC
          LIMIT ?`,
        input.routedOwnerId,
        input.fromExclusiveCursor,
        highWaterCursor,
        input.limit,
      )
      .toArray();
    let expectedItemCursor = input.fromExclusiveCursor + 1;
    const items = projectionRows.map((row) => {
      const item = responsibilityProjectionItemV01Schema.parse(JSON.parse(row.item_json));
      if (row.owner_cursor !== expectedItemCursor || item.cursor !== row.owner_cursor) {
        throw new ResponsibilityProjectionCursorError('cursor_gap');
      }
      expectedItemCursor += 1;
      return item;
    });
    if (items.length === 0 && input.fromExclusiveCursor < highWaterCursor) {
      throw new ResponsibilityProjectionCursorError('cursor_gap');
    }
    const generatedAt = this.#deps.now();
    while (true) {
      const nextCursor = items.at(-1)?.cursor ?? input.fromExclusiveCursor;
      const parsed = responsibilityProjectionPageSchema.safeParse({
        protocolVersion: '0.1',
        ownerId: input.routedOwnerId,
        projectionName: 'responsibility.summary',
        snapshotId: root.snapshot_id,
        snapshotBaseCursor: 0,
        fromExclusiveCursor: input.fromExclusiveCursor,
        highWaterCursor,
        nextCursor,
        items,
        hasMore: nextCursor < highWaterCursor,
        generatedAt,
      });
      if (parsed.success) return parsed.data;
      if (items.length === 0) throw parsed.error;
      items.pop();
    }
  }

  replayResponsibility(routedOwnerId: string): ResponsibilityReplay {
    this.#assertOwnerRoot(routedOwnerId);
    return this.#outcomes.replay(routedOwnerId);
  }

  #validateTrustedAdmission(
    routedOwnerId: string,
    request: ResponsibilityCaptureRequest,
    trustedEnvelope: ResponsibilityCaptureTrustedEnvelope,
  ): void {
    if (trustedEnvelope.ownerId !== routedOwnerId) {
      throw new Error('owner authority root mismatch');
    }
    if (request.aggregate !== undefined || trustedEnvelope.aggregate !== undefined) {
      throw new Error('responsibility capture aggregate must be server-owned');
    }
    if (trustedEnvelope.expectedRevision !== undefined) {
      throw new Error('responsibility capture revision must be server-owned');
    }
    if (
      canonicalizeProtocolJson(trustedEnvelope.payload) !==
      canonicalizeProtocolJson(request.payload)
    ) {
      throw new Error('responsibility capture payload mismatch');
    }
  }

  #assertPersistedCaptureResult(
    persisted: ResponsibilityCaptureResult,
    request: ResponsibilityCaptureRequest,
  ): void {
    const proposalMatches =
      persisted.outcome.userStatement === request.payload.userStatement &&
      (persisted.mission?.brief ?? null) === (request.payload.mission?.brief ?? null) &&
      persisted.workUnits.length === (request.payload.workUnits?.length ?? 0) &&
      persisted.workUnits.every(
        (workUnit, index) =>
          workUnit.responsibility === request.payload.workUnits?.[index]?.responsibility,
      );
    if (!proposalMatches) throw new Error('responsibility capture persisted result mismatch');

    const sql = this.#storage.sql;
    const outcome = sql.exec<{
      id: string; ownerId: string; revision: number; userStatement: string;
      state: string; createdAt: string; updatedAt: string;
    }>(
      `SELECT id, owner_id AS ownerId, revision, user_statement AS userStatement,
              state, created_at AS createdAt, updated_at AS updatedAt
         FROM outcomes WHERE owner_id = ? AND id = ?`,
      persisted.ownerId, persisted.outcome.id,
    ).toArray()[0];
    const mission = persisted.mission === null ? null : sql.exec<{
      id: string; ownerId: string; outcomeId: string; revision: number; brief: string;
      state: string; createdAt: string; updatedAt: string;
    }>(
      `SELECT id, owner_id AS ownerId, outcome_id AS outcomeId, revision, brief,
              state, created_at AS createdAt, updated_at AS updatedAt
         FROM missions WHERE owner_id = ? AND id = ?`,
      persisted.ownerId, persisted.mission.id,
    ).toArray()[0];
    const workUnits = sql.exec<{
      id: string; ownerId: string; outcomeId: string; missionId: string | null;
      position: number; revision: number; responsibility: string; state: string;
      createdAt: string; updatedAt: string;
    }>(
      `SELECT id, owner_id AS ownerId, outcome_id AS outcomeId, mission_id AS missionId,
              position, revision, responsibility, state,
              created_at AS createdAt, updated_at AS updatedAt
         FROM work_units WHERE owner_id = ? AND outcome_id = ? ORDER BY position ASC`,
      persisted.ownerId, persisted.outcome.id,
    ).toArray();
    const current = responsibilityCaptureResultV01Schema.safeParse({
      ...persisted,
      outcome,
      mission,
      workUnits,
    });
    if (!current.success ||
        canonicalizeProtocolJson(current.data) !== canonicalizeProtocolJson(persisted)) {
      throw new Error('responsibility capture persisted result mismatch');
    }

    const itemCount = 1 + (persisted.mission === null ? 0 : 1) + persisted.workUnits.length;
    const firstCursor = persisted.projectionCursor - itemCount + 1;
    if (firstCursor < 1) throw new Error('responsibility capture persisted result mismatch');
    const projectionItems = sql.exec<{ owner_cursor: number; item_json: string }>(
      `SELECT owner_cursor, item_json FROM responsibility_projection
        WHERE owner_id = ? AND owner_cursor BETWEEN ? AND ?
        ORDER BY owner_cursor ASC`,
      persisted.ownerId, firstCursor, persisted.projectionCursor,
    ).toArray().map((row) => {
      const item = responsibilityProjectionItemV01Schema.parse(JSON.parse(row.item_json));
      if (item.cursor !== row.owner_cursor) {
        throw new Error('responsibility capture persisted result mismatch');
      }
      return item;
    });
    const expectedItems = [
      responsibilityProjectionItemV01Schema.parse({
        cursor: firstCursor,
        itemType: 'outcome',
        aggregateId: persisted.outcome.id,
        outcomeId: persisted.outcome.id,
        revision: persisted.outcome.revision,
        state: persisted.outcome.state,
        userStatement: persisted.outcome.userStatement,
        createdAt: persisted.outcome.createdAt,
      }),
      ...(persisted.mission === null ? [] : [responsibilityProjectionItemV01Schema.parse({
        cursor: firstCursor + 1,
        itemType: 'mission',
        aggregateId: persisted.mission.id,
        outcomeId: persisted.mission.outcomeId,
        revision: persisted.mission.revision,
        state: persisted.mission.state,
        brief: persisted.mission.brief,
        createdAt: persisted.mission.createdAt,
      })]),
      ...persisted.workUnits.map((workUnit, index) =>
        responsibilityProjectionItemV01Schema.parse({
          cursor: firstCursor + 1 + (persisted.mission === null ? 0 : 1) + index,
          itemType: 'work_unit',
          aggregateId: workUnit.id,
          outcomeId: workUnit.outcomeId,
          missionId: workUnit.missionId,
          position: workUnit.position,
          revision: workUnit.revision,
          state: workUnit.state,
          responsibility: workUnit.responsibility,
          createdAt: workUnit.createdAt,
        })),
    ];
    if (projectionItems.length !== expectedItems.length || projectionItems.some(
      (item, index) =>
        canonicalizeProtocolJson(item) !== canonicalizeProtocolJson(expectedItems[index]),
    )) {
      throw new Error('responsibility capture persisted result mismatch');
    }
  }

  #bindOrAssertOwnerRoot(ownerId: string, at: string): OwnerRootRow {
    const root = this.#storage.sql
      .exec<OwnerRootRow>('SELECT owner_id, snapshot_id FROM owner_roots WHERE root_key = 1')
      .toArray()[0];
    if (root !== undefined) {
      if (root.owner_id !== ownerId) throw new Error('owner authority root mismatch');
      return root;
    }
    const snapshotId = this.#deps.newId('snapshot');
    this.#storage.sql.exec(
      'INSERT INTO owner_roots (root_key, owner_id, snapshot_id, created_at) VALUES (1, ?, ?, ?)',
      ownerId,
      snapshotId,
      at,
    );
    return { owner_id: ownerId, snapshot_id: snapshotId };
  }

  #assertOwnerRoot(ownerId: string): OwnerRootRow {
    const root = this.#storage.sql
      .exec<OwnerRootRow>('SELECT owner_id, snapshot_id FROM owner_roots WHERE root_key = 1')
      .toArray()[0];
    if (root === undefined || root.owner_id !== ownerId) {
      throw new Error('owner authority root mismatch');
    }
    return root;
  }

  #nextOwnerCursor(ownerId: string): number {
    const row = this.#storage.sql
      .exec<{ high_water_cursor: number }>(
        `SELECT high_water_cursor
           FROM responsibility_projection_state
          WHERE owner_id = ?`,
        ownerId,
      )
      .toArray()[0];
    return (row?.high_water_cursor ?? 0) + 1;
  }
}
