import {
  canonicalizeResponsibilityCaptureRequestV02ForDigest,
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureResultV02Schema,
  responsibilityCaptureTrustedEnvelopeV02Schema,
  responsibilityProjectionItemV02Schema,
  responsibilityProjectionPageV02Schema,
  type ResponsibilityCaptureRequestV02,
  type ResponsibilityCaptureResultV02,
  type ResponsibilityCaptureTrustedEnvelopeV02,
  type ResponsibilityProjectionPageV02,
} from '@waldo/contracts';
import { IdentityPresenceModule } from './identity-presence-module';
import { OwnerEventLog } from './owner-event-log';
import {
  OutcomeModule,
  type MissionRecord,
  type OutcomeRecord,
  type ResponsibilityReplay,
  type WorkUnitProposalRecord,
} from './outcome-module';

export type {
  MissionRecord,
  OutcomeRecord,
  ResponsibilityReplay,
  WorkUnitProposalRecord,
} from './outcome-module';

export type ResponsibilityCaptureResult = ResponsibilityCaptureResultV02;

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
  constructor(readonly code: 'snapshot_replaced' | 'cursor_ahead' | 'cursor_corrupt') {
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
  newId: (
    kind: 'outcome' | 'mission' | 'work_unit_proposal' | 'event' | 'snapshot',
  ) => string;
  sha256Hex: (value: string) => Promise<string>;
  afterWrite?: (stage: CoordinatorWriteStage) => void;
}>;

type StoredCommandRow = {
  owner_id: string;
  request_digest: string;
  result_json: string;
};

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
  readonly #identity: IdentityPresenceModule;
  readonly #events: OwnerEventLog;
  readonly #outcomes: OutcomeModule;

  constructor(
    storage: DurableObjectStorage,
    dependencies: CoordinatorDependencies = defaultDependencies(),
  ) {
    this.#storage = storage;
    this.#deps = dependencies;
    this.#identity = new IdentityPresenceModule(storage);
    this.#events = new OwnerEventLog(storage);
    this.#outcomes = new OutcomeModule(storage, dependencies.newId);
  }

  async captureResponsibility(
    admission: ResponsibilityCaptureAdmission,
  ): Promise<ResponsibilityCaptureResult> {
    const request = responsibilityCaptureRequestV02Schema.parse(admission.request);
    const trustedEnvelope = responsibilityCaptureTrustedEnvelopeV02Schema.parse(
      admission.trustedEnvelope,
    );
    this.#validateTrustedAdmission(admission.routedOwnerId, request, trustedEnvelope);
    const requestDigest = `sha256:${await this.#deps.sha256Hex(
      canonicalizeResponsibilityCaptureRequestV02ForDigest(request),
    )}`;
    if (trustedEnvelope.requestDigest !== requestDigest) {
      throw new Error('responsibility capture digest conflict');
    }

    return this.#storage.transactionSync(() => {
      const at = this.#deps.now();
      this.#identity.bindOrAssertOwnerRootInCurrentTransaction(admission.routedOwnerId, at);
      this.#deps.afterWrite?.('owner_root');

      const existing = this.#storage.sql.exec<StoredCommandRow>(
        `SELECT owner_id, request_digest, result_json
           FROM responsibility_commands WHERE request_id = ?`,
        request.requestId,
      ).toArray()[0];
      if (existing !== undefined) {
        if (existing.owner_id !== admission.routedOwnerId ||
            existing.request_digest !== requestDigest) {
          throw new Error('responsibility capture digest conflict');
        }
        const persisted = responsibilityCaptureResultV02Schema.parse(
          JSON.parse(existing.result_json),
        );
        this.#assertPersistedCaptureResult(persisted, request);
        return Object.freeze(persisted);
      }

      this.#outcomes.projections.ensureSnapshotInCurrentTransaction(
        admission.routedOwnerId,
        this.#deps.newId('snapshot'),
        at,
      );

      const captured = this.#outcomes.captureInCurrentTransaction({
        ownerId: admission.routedOwnerId,
        payload: request.payload,
        at,
        commandId: trustedEnvelope.commandId,
        correlationId: trustedEnvelope.correlationId,
        afterCurrentState: () => this.#deps.afterWrite?.('current_state'),
        afterEvents: () => this.#deps.afterWrite?.('events'),
        afterProjection: () => this.#deps.afterWrite?.('projection'),
      });
      const result = Object.freeze(responsibilityCaptureResultV02Schema.parse({
        protocolVersion: '0.2',
        duplicate: false,
        ownerId: admission.routedOwnerId,
        requestId: request.requestId,
        outcome: captured.outcome,
        mission: captured.mission,
        workUnitProposals: captured.workUnitProposals,
        projectionCursor: captured.finalCursor,
      }));
      this.#storage.sql.exec(
        `INSERT INTO responsibility_commands (
          request_id, owner_id, request_digest, result_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?)`,
        request.requestId,
        result.ownerId,
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
  ): ResponsibilityProjectionPageV02 {
    if (!Number.isSafeInteger(input.fromExclusiveCursor) || input.fromExclusiveCursor < 0) {
      throw new Error('invalid responsibility projection cursor');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256) {
      throw new Error('invalid responsibility projection page limit');
    }
    this.#identity.assertOwnerRoot(input.routedOwnerId);
    const snapshot = this.#outcomes.projections.readSnapshot(input.routedOwnerId);
    if (input.fromExclusiveCursor > 0 && input.snapshotId === undefined) {
      throw new ResponsibilityProjectionCursorError('snapshot_replaced');
    }
    if (input.snapshotId !== undefined && input.snapshotId !== snapshot.snapshotId) {
      throw new ResponsibilityProjectionCursorError('snapshot_replaced');
    }
    const highWaterCursor = this.#events.readHighWater(input.routedOwnerId);
    if (input.fromExclusiveCursor > highWaterCursor) {
      throw new ResponsibilityProjectionCursorError('cursor_ahead');
    }
    const rows = this.#storage.sql.exec<{ owner_cursor: number; item_json: string }>(
      `SELECT owner_cursor, item_json
         FROM responsibility_projection
        WHERE owner_id = ? AND owner_cursor > ? AND owner_cursor <= ?
        ORDER BY owner_cursor ASC
        LIMIT ?`,
      input.routedOwnerId,
      input.fromExclusiveCursor,
      highWaterCursor,
      input.limit,
    ).toArray();
    let previous = input.fromExclusiveCursor;
    const items = rows.map((row) => {
      const item = responsibilityProjectionItemV02Schema.parse(JSON.parse(row.item_json));
      if (row.owner_cursor <= previous || row.owner_cursor !== item.cursor) {
        throw new ResponsibilityProjectionCursorError('cursor_corrupt');
      }
      previous = row.owner_cursor;
      return item;
    });
    const filledPage = rows.length === input.limit;
    const generatedAt = this.#deps.now();
    let truncatedByByteLimit = false;
    while (true) {
      const nextCursor = (filledPage || truncatedByByteLimit) && items.length > 0
        ? items.at(-1)!.cursor
        : highWaterCursor;
      const parsed = responsibilityProjectionPageV02Schema.safeParse({
        protocolVersion: '0.2',
        ownerId: input.routedOwnerId,
        projectionName: 'responsibility.summary',
        snapshotId: snapshot.snapshotId,
        snapshotBaseCursor: snapshot.snapshotBaseCursor,
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
      truncatedByByteLimit = true;
    }
  }

  replayResponsibility(routedOwnerId: string): ResponsibilityReplay {
    this.#identity.assertOwnerRoot(routedOwnerId);
    return this.#outcomes.replay(routedOwnerId);
  }

  #validateTrustedAdmission(
    routedOwnerId: string,
    request: ResponsibilityCaptureRequestV02,
    trustedEnvelope: ResponsibilityCaptureTrustedEnvelopeV02,
  ): void {
    if (trustedEnvelope.ownerId !== routedOwnerId) {
      throw new Error('owner authority root mismatch');
    }
    if (request.protocolVersion !== trustedEnvelope.protocolVersion) {
      throw new Error('responsibility protocol version mismatch');
    }
    if (trustedEnvelope.aggregate !== undefined || trustedEnvelope.expectedRevision !== undefined) {
      throw new Error('responsibility capture authority fields must be server-owned');
    }
    if (JSON.stringify(trustedEnvelope.payload) !== JSON.stringify(request.payload)) {
      throw new Error('responsibility capture payload mismatch');
    }
  }

  #assertPersistedCaptureResult(
    persisted: ResponsibilityCaptureResult,
    request: ResponsibilityCaptureRequestV02,
  ): void {
    if (persisted.ownerId === '' || persisted.requestId !== request.requestId ||
        persisted.outcome.userStatement !== request.payload.userStatement ||
        (persisted.mission?.brief ?? null) !== (request.payload.mission?.brief ?? null) ||
        persisted.workUnitProposals.length !== (request.payload.workUnitProposals?.length ?? 0) ||
        persisted.workUnitProposals.some((proposal, index) =>
          proposal.responsibility !== request.payload.workUnitProposals?.[index]?.responsibility)) {
      throw new Error('responsibility capture persisted result mismatch');
    }
    const replay = this.#outcomes.replay(persisted.ownerId);
    const outcome = replay.outcomes.find((value) => value.id === persisted.outcome.id);
    const mission = persisted.mission === null ? null
      : replay.missions.find((value) => value.id === persisted.mission!.id) ?? null;
    const proposals = replay.workUnitProposals.filter(
      (value) => value.outcomeId === persisted.outcome.id,
    ).sort((left, right) => left.position - right.position);
    const outcomeItems = replay.items.filter(
      (item) => item.outcomeId === persisted.outcome.id,
    );
    const finalOutcomeCursor = outcomeItems.at(-1)?.cursor;
    if (JSON.stringify(outcome) !== JSON.stringify(persisted.outcome) ||
        JSON.stringify(mission) !== JSON.stringify(persisted.mission) ||
        JSON.stringify(proposals) !== JSON.stringify(persisted.workUnitProposals) ||
        finalOutcomeCursor !== persisted.projectionCursor) {
      throw new Error('responsibility capture persisted result mismatch');
    }
  }
}
