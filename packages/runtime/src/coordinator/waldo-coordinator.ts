import {
  canonicalizeSurfaceCommandRequestForDigest,
  canonicalizeResponsibilityCaptureRequestV02ForDigest,
  responsibilityCaptureRequestSchema,
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureResultSchema,
  responsibilityCaptureTrustedEnvelopeSchema,
  responsibilityCaptureTrustedEnvelopeV02Schema,
  responsibilityProjectionItemV02Schema,
  responsibilityProjectionPageV01CompatibilitySchema,
  responsibilityProjectionPageV02Schema,
  type ResponsibilityCaptureResult as ResponsibilityCaptureResultContract,
  type ResponsibilityCaptureRequestV02,
  type ResponsibilityCaptureTrustedEnvelopeV02,
  type ResponsibilityProjectionPageV01Compatibility,
  type ResponsibilityProjectionPageV02,
} from '@waldo/contracts';
import {
  IdentityPresenceModule,
  type ResponsibilityCanonicalAuthority,
  type ResponsibilityCanonicalAuthorityRegistration,
} from './identity-presence-module';
import {
  ResponsibilityDigestConflictError,
  ResponsibilityOwnerRootMismatchError,
  ResponsibilityProjectionCursorError,
} from '../responsibility/errors';
import { OwnerEventLog } from './owner-event-log';
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

export type ResponsibilityCaptureResult = ResponsibilityCaptureResultContract;

export type ResponsibilityCaptureAdmission = Readonly<{
  routedOwnerId: string;
  request: unknown;
  trustedEnvelope: unknown;
}>;

export type ResponsibilityProjectionRead = Readonly<{
  routedOwnerId: string;
  protocolVersion?: '0.1' | '0.2';
  fromExclusiveCursor: number;
  limit: number;
  snapshotId?: string;
}>;

export type CoordinatorWriteStage =
  | 'owner_root'
  | 'current_state'
  | 'events'
  | 'projection'
  | 'idempotency';

export type CoordinatorDependencies = Readonly<{
  now: () => string;
  newId: (
    kind: 'outcome' | 'mission' | 'work_unit' | 'event' | 'snapshot',
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

  admitCanonicalAuthority(
    registration: ResponsibilityCanonicalAuthorityRegistration,
    beforeCommit?: () => void,
  ): ResponsibilityCanonicalAuthority {
    return this.#storage.transactionSync(() => {
      const authority = this.#identity
        .bootstrapOrRefreshCanonicalAuthorityInCurrentTransaction(registration);
      beforeCommit?.();
      return authority;
    });
  }

  assertCanonicalAuthority(
    authority: ResponsibilityCanonicalAuthority,
  ): ResponsibilityCanonicalAuthority {
    return this.#identity.assertCanonicalAuthorityInCurrentTransaction(
      authority,
      this.#deps.now(),
    );
  }

  async captureResponsibility(
    admission: ResponsibilityCaptureAdmission,
  ): Promise<ResponsibilityCaptureResult> {
    return this.#captureResponsibility(admission);
  }

  async captureAuthorizedResponsibility(
    admission: ResponsibilityCaptureAdmission,
    canonicalAuthority: ResponsibilityCanonicalAuthority,
  ): Promise<ResponsibilityCaptureResult> {
    return this.#captureResponsibility(admission, canonicalAuthority);
  }

  async #captureResponsibility(
    admission: ResponsibilityCaptureAdmission,
    canonicalAuthority?: ResponsibilityCanonicalAuthority,
  ): Promise<ResponsibilityCaptureResult> {
    const parsed = this.#parseAdmission(admission);
    const { request, trustedEnvelope } = parsed;
    const requestDigest = `sha256:${await this.#deps.sha256Hex(
      parsed.canonicalRequest,
    )}`;
    if (trustedEnvelope.requestDigest !== requestDigest) {
      throw new ResponsibilityDigestConflictError();
    }

    return this.#storage.transactionSync(() => {
      const at = this.#deps.now();
      if (canonicalAuthority === undefined) {
        this.#identity.bindOrAssertOwnerRootInCurrentTransaction(admission.routedOwnerId, at);
      } else {
        this.#identity.assertCanonicalAuthorityInCurrentTransaction(canonicalAuthority, at);
      }
      this.#deps.afterWrite?.('owner_root');

      const existing = this.#storage.sql.exec<StoredCommandRow>(
        `SELECT owner_id, request_digest, result_json
           FROM responsibility_commands WHERE request_id = ?`,
        request.requestId,
      ).toArray()[0];
      if (existing !== undefined) {
        if (existing.owner_id !== admission.routedOwnerId ||
            existing.request_digest !== requestDigest) {
          throw new ResponsibilityDigestConflictError();
        }
        const persisted = responsibilityCaptureResultSchema.parse(
          JSON.parse(existing.result_json),
        );
        this.#assertPersistedCaptureResult(persisted, request, parsed.responseVersion);
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
      const result = Object.freeze(responsibilityCaptureResultSchema.parse({
        protocolVersion: parsed.responseVersion,
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
  ): ResponsibilityProjectionPageV02 | ResponsibilityProjectionPageV01Compatibility {
    return this.#readResponsibilityProjection(input);
  }

  readAuthorizedResponsibilityProjection(
    input: ResponsibilityProjectionRead,
    canonicalAuthority: ResponsibilityCanonicalAuthority,
  ): ResponsibilityProjectionPageV02 | ResponsibilityProjectionPageV01Compatibility {
    return this.#readResponsibilityProjection(input, canonicalAuthority);
  }

  #readResponsibilityProjection(
    input: ResponsibilityProjectionRead,
    canonicalAuthority?: ResponsibilityCanonicalAuthority,
  ): ResponsibilityProjectionPageV02 | ResponsibilityProjectionPageV01Compatibility {
    if (!Number.isSafeInteger(input.fromExclusiveCursor) || input.fromExclusiveCursor < 0) {
      throw new Error('invalid responsibility projection cursor');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256) {
      throw new Error('invalid responsibility projection page limit');
    }
    if (canonicalAuthority === undefined) {
      this.#identity.assertOwnerRoot(input.routedOwnerId);
    } else {
      this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        this.#deps.now(),
      );
    }
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
      const candidate = {
        protocolVersion: input.protocolVersion ?? '0.2',
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
      };
      const parsed = input.protocolVersion === '0.1'
        ? responsibilityProjectionPageV01CompatibilitySchema.safeParse(candidate)
        : responsibilityProjectionPageV02Schema.safeParse(candidate);
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
    request: Readonly<{ protocolVersion: string; payload: unknown }>,
    trustedEnvelope: Readonly<{
      protocolVersion: string;
      ownerId: string;
      aggregate?: unknown;
      expectedRevision?: number;
      payload: unknown;
    }>,
  ): void {
    if (trustedEnvelope.ownerId !== routedOwnerId) {
      throw new ResponsibilityOwnerRootMismatchError();
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

  #parseAdmission(admission: ResponsibilityCaptureAdmission): Readonly<{
    request: ResponsibilityCaptureRequestV02;
    trustedEnvelope: ResponsibilityCaptureTrustedEnvelopeV02;
    canonicalRequest: string;
    responseVersion: '0.1' | '0.2';
  }> {
    const version = (admission.request as { protocolVersion?: unknown } | null)?.protocolVersion;
    if (version === '0.1') {
      const requestV01 = responsibilityCaptureRequestSchema.parse(admission.request);
      const envelopeV01 = responsibilityCaptureTrustedEnvelopeSchema.parse(
        admission.trustedEnvelope,
      );
      this.#validateTrustedAdmission(admission.routedOwnerId, requestV01, envelopeV01);
      return Object.freeze({
        request: responsibilityCaptureRequestV02Schema.parse({
          ...requestV01,
          protocolVersion: '0.2',
        }),
        trustedEnvelope: responsibilityCaptureTrustedEnvelopeV02Schema.parse({
          ...envelopeV01,
          protocolVersion: '0.2',
        }),
        canonicalRequest: canonicalizeSurfaceCommandRequestForDigest(requestV01),
        responseVersion: '0.1',
      });
    }
    const request = responsibilityCaptureRequestV02Schema.parse(admission.request);
    const trustedEnvelope = responsibilityCaptureTrustedEnvelopeV02Schema.parse(
      admission.trustedEnvelope,
    );
    this.#validateTrustedAdmission(admission.routedOwnerId, request, trustedEnvelope);
    return Object.freeze({
      request,
      trustedEnvelope,
      canonicalRequest: canonicalizeResponsibilityCaptureRequestV02ForDigest(request),
      responseVersion: '0.2',
    });
  }

  #assertPersistedCaptureResult(
    persisted: ResponsibilityCaptureResult,
    request: ResponsibilityCaptureRequestV02,
    responseVersion: '0.1' | '0.2',
  ): void {
    if (persisted.protocolVersion !== responseVersion || persisted.ownerId === '' ||
        persisted.requestId !== request.requestId ||
        persisted.outcome.userStatement !== request.payload.userStatement ||
        (persisted.mission?.brief ?? null) !== (request.payload.mission?.brief ?? null) ||
        persisted.workUnits.length !== (request.payload.workUnits?.length ?? 0) ||
        persisted.workUnits.some((workUnit, index) => {
          const admitted = request.payload.workUnits?.[index];
          return admitted === undefined || workUnit.responsibility !== admitted.responsibility ||
            JSON.stringify(workUnit.inputs) !== JSON.stringify(admitted.inputs) ||
            JSON.stringify(workUnit.expectedEvidence) !== JSON.stringify(admitted.expectedEvidence) ||
            JSON.stringify(workUnit.requiredCapabilities) !==
              JSON.stringify(admitted.requiredCapabilities) ||
            JSON.stringify(workUnit.stopConditions) !== JSON.stringify(admitted.stopConditions);
        })) {
      throw new Error('responsibility capture persisted result mismatch');
    }
    const replay = this.#outcomes.replay(persisted.ownerId);
    const outcome = replay.outcomes.find((value) => value.id === persisted.outcome.id);
    const mission = persisted.mission === null ? null
      : replay.missions.find((value) => value.id === persisted.mission!.id) ?? null;
    const workUnits = replay.workUnits.filter(
      (value) => value.outcomeId === persisted.outcome.id,
    ).sort((left, right) => left.position - right.position);
    const outcomeItems = replay.items.filter(
      (item) => item.outcomeId === persisted.outcome.id,
    );
    const finalOutcomeCursor = outcomeItems.at(-1)?.cursor;
    if (JSON.stringify(outcome) !== JSON.stringify(persisted.outcome) ||
        JSON.stringify(mission) !== JSON.stringify(persisted.mission) ||
        JSON.stringify(workUnits) !== JSON.stringify(persisted.workUnits) ||
        finalOutcomeCursor !== persisted.projectionCursor) {
      throw new Error('responsibility capture persisted result mismatch');
    }
  }
}
