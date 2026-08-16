import {
  authorityGrantV05Schema,
  canonicalizeJudgmentAnswerRequestV05ForDigest,
  canonicalizeWorkUnitPlanningTurnRequestV03ForDigest,
  canonicalizeJudgmentRequestV05ForDigest,
  canonicalizeWorkUnitPlanningCancelRequestV03ForDigest,
  canonicalizeSurfaceCommandRequestForDigest,
  canonicalizeResponsibilityCaptureRequestV02ForDigest,
  createJudgmentAuthorityBindingVerifierV05,
  executionAttemptV04Schema,
  executionCancelRequestV04Schema,
  executionEnvironmentRefV04Schema,
  executionLeaseV04Schema,
  executionReconciliationV04Schema,
  executionRequestV04Schema,
  executionSessionV04Schema,
  executorObservationV04Schema,
  exactRevisionV04Schema,
  judgmentAnswerRequestV05Schema,
  judgmentDecisionV05Schema,
  judgmentProjectionQueryV05Schema,
  judgmentRequestV05Schema,
  requestedAuthorityV05Schema,
  protocolDigestSchema,
  protocolIdSchema,
  providerRefV04Schema,
  responsibilityCaptureRequestSchema,
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureResultSchema,
  responsibilityCaptureTrustedEnvelopeSchema,
  responsibilityCaptureTrustedEnvelopeV02Schema,
  responsibilityProjectionItemV02Schema,
  responsibilityProjectionPageV01CompatibilitySchema,
  responsibilityProjectionPageV02Schema,
  workUnitPlanningAuthorizationResultV03Schema,
  workUnitPlanningCancelRequestV03Schema,
  workUnitPlanningTurnRequestV03Schema,
  workUnitPlanningTurnTrustedEnvelopeV03Schema,
  type ResponsibilityCaptureResult as ResponsibilityCaptureResultContract,
  type ResponsibilityCaptureRequestV02,
  type ResponsibilityCaptureTrustedEnvelopeV02,
  type ResponsibilityProjectionPageV01Compatibility,
  type ResponsibilityProjectionPageV02,
  type WorkUnitPlanningAuthorizationResultV03,
  type WorkUnitPlanningCommandResultV03,
  type WorkUnitPlanningCancelResultV03,
  type WorkUnitPlanningTurnResultV03,
  type WorkUnitPlanningTurnRequestV03,
  type WorkUnitPlanningTurnTrustedEnvelopeV03,
  type WorkUnitPlanningProjectionPageV03,
  type JudgmentAnswerRequestV05,
  type JudgmentAnswerResultV05,
  type JudgmentDecisionV05,
  type JudgmentProjectionPageV05,
  type JudgmentProjectionQueryV05,
  type JudgmentRequestV05,
} from '@waldo/contracts';
import {
  IdentityPresenceModule,
  type ResponsibilityCanonicalAuthority,
  type ResponsibilityCanonicalAuthorityRegistration,
  type ResponsibilityCanonicalAuthorityWithAssurance,
} from './identity-presence-module';
import {
  ResponsibilityDigestConflictError,
  ResponsibilityJudgmentConflictError,
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
import {
  EXECUTION_LEASE_MAX_DURATION_MS_V04,
  PlanningExecutionModule,
  type ExecutionAdmissionBindingV04,
  type ExecutionAggregateV04,
} from './planning-execution-module';
import type { LLMGatewayRequest, TrustedProviderEffect } from '../llm/provider';
import {
  JudgmentAuthorityModule,
  type JudgmentAdmissionBasisV05,
} from './judgment-authority-module';
import {
  ProjectionPublisher as JudgmentProjectionPublisher,
  type JudgmentProjectionItemV05,
} from './projection-publisher';

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

export type JudgmentAnswerAdmissionV05 = Readonly<{
  routedOwnerId: string;
  request: unknown;
}>;

export type JudgmentProjectionReadV05 = Readonly<{
  routedOwnerId: string;
  query: JudgmentProjectionQueryV05;
}>;

export type CurrentJudgmentAdmissionV05 = Readonly<{
  grantee: Exclude<JudgmentRequestV05['authorityAdmission'], null>['grantee'] | null;
  revocationGeneration: number;
  admissionContextMaterial: string | null;
}>;

export type ResponsibilityProjectionRead = Readonly<{
  routedOwnerId: string;
  protocolVersion?: '0.1' | '0.2';
  fromExclusiveCursor: number;
  limit: number;
  snapshotId?: string;
}>;

export type WorkUnitPlanningAdmission = Readonly<{
  routedOwnerId: string;
  request: unknown;
  trustedEnvelope: unknown;
}>;

export type WorkUnitPlanningCancelAdmission = Readonly<{
  routedOwnerId: string;
  request: unknown;
}>;

export type WorkUnitPlanningProjectionRead = Readonly<{
  routedOwnerId: string;
  fromExclusiveCursor: number;
  limit: number;
  snapshotId?: string;
}>;

type RequestedAuthorityProposalV05 = Omit<
  Exclude<JudgmentRequestV05['requestedAuthority'], null>,
  'validUntil'
> & Readonly<{ validUntil: string }>;

export type TrustedJudgmentRequestProposalV05 = Readonly<{
  subject: Readonly<{
    kind: 'outcome' | 'work_unit';
    id: string;
    expectedRevision: number;
  }>;
  question: JudgmentRequestV05['question'];
  options: JudgmentRequestV05['options'];
  recommendation: JudgmentRequestV05['recommendation'];
  uncertainty: JudgmentRequestV05['uncertainty'];
  evidence: JudgmentRequestV05['evidence'];
  costOfWaiting: JudgmentRequestV05['costOfWaiting'];
  risk: JudgmentRequestV05['risk'];
  reversibility: JudgmentRequestV05['reversibility'];
  requestedAuthority: RequestedAuthorityProposalV05 | null;
  reEntryPointId: string | null;
  expiresAt: string;
}>;

type CoordinatorExecutionRequestV04 = ReturnType<typeof executionRequestV04Schema.parse>;

export type ExecutionAdmissionV04 = Readonly<{
  id: string;
  outcomeId: string;
  workUnitId: string;
}>;

export type PublicExecutionAdmissionV04 = Readonly<{
  id: string;
  commandIdPrefix: string;
  workUnitId: string;
  expectedWorkUnitRevision: number;
}>;

function parsePublicExecutionAdmissionV04(value: unknown): PublicExecutionAdmissionV04 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('public execution admission must be a strict object');
  }
  const input = value as Record<string, unknown>;
  const expectedKeys = ['id', 'commandIdPrefix', 'workUnitId', 'expectedWorkUnitRevision'];
  if (Object.keys(input).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(input, key))) {
    throw new Error('public execution admission contains unrecognized fields');
  }
  const id = protocolIdSchema.parse(input.id);
  const commandIdPrefix = protocolIdSchema.parse(input.commandIdPrefix);
  if (!/^er_[A-Za-z0-9_-]{43}_$/.test(commandIdPrefix) ||
      !new RegExp(`^${commandIdPrefix}[A-Za-z0-9_-]{43}$`).test(id)) {
    throw new Error('public execution admission command identity mismatch');
  }
  return Object.freeze({
    id,
    commandIdPrefix,
    workUnitId: protocolIdSchema.parse(input.workUnitId),
    expectedWorkUnitRevision: exactRevisionV04Schema.parse(input.expectedWorkUnitRevision),
  });
}

export type ExecutionBindingResolutionV04 = Readonly<{
  provider: CoordinatorExecutionRequestV04['provider'];
  environment: CoordinatorExecutionRequestV04['environment'];
  contextProjectionRef: string;
  contextProjectionDigest: string;
}>;

function parseExecutionAdmissionV04(value: unknown): ExecutionAdmissionV04 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('execution admission must be a strict object');
  }
  const input = value as Record<string, unknown>;
  const expectedKeys = [
    'id',
    'outcomeId',
    'workUnitId',
  ];
  if (Object.keys(input).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(input, key))) {
    throw new Error('execution admission contains unrecognized fields');
  }
  return Object.freeze({
    id: protocolIdSchema.parse(input.id),
    outcomeId: protocolIdSchema.parse(input.outcomeId),
    workUnitId: protocolIdSchema.parse(input.workUnitId),
  });
}

function parseExecutionBindingResolutionV04(value: unknown): ExecutionBindingResolutionV04 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('execution binding resolution must be a strict object');
  }
  const input = value as Record<string, unknown>;
  const expectedKeys = [
    'provider',
    'environment',
    'contextProjectionRef',
    'contextProjectionDigest',
  ];
  if (Object.keys(input).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(input, key))) {
    throw new Error('execution binding resolution contains unrecognized fields');
  }
  return Object.freeze({
    provider: providerRefV04Schema.parse(input.provider),
    environment: executionEnvironmentRefV04Schema.parse(input.environment),
    contextProjectionRef: protocolIdSchema.parse(input.contextProjectionRef),
    contextProjectionDigest: protocolDigestSchema.parse(input.contextProjectionDigest),
  });
}

function executionAdmissionMatchesRequestV04(
  admission: ExecutionAdmissionV04,
  request: CoordinatorExecutionRequestV04,
): boolean {
  return admission.id === request.id &&
    admission.outcomeId === request.outcome.id &&
    admission.workUnitId === request.workUnit.id;
}

export type ExecutionClaimV04 = Readonly<{
  executionRequestId: string;
  attemptId: string;
  leaseId: string;
  sessionId: string;
  providerSessionRef: string | null;
}>;

function parseExecutionClaimV04(value: unknown): ExecutionClaimV04 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('execution claim must be a strict object');
  }
  const input = value as Record<string, unknown>;
  const expectedKeys = [
    'executionRequestId',
    'attemptId',
    'leaseId',
    'sessionId',
    'providerSessionRef',
  ];
  if (Object.keys(input).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(input, key))) {
    throw new Error('execution claim contains unrecognized fields');
  }
  return Object.freeze({
    executionRequestId: protocolIdSchema.parse(input.executionRequestId),
    attemptId: protocolIdSchema.parse(input.attemptId),
    leaseId: protocolIdSchema.parse(input.leaseId),
    sessionId: protocolIdSchema.parse(input.sessionId),
    providerSessionRef: input.providerSessionRef === null
      ? null
      : protocolIdSchema.parse(input.providerSessionRef),
  });
}

export type CoordinatorWriteStage =
  | 'owner_root'
  | 'current_state'
  | 'events'
  | 'projection'
  | 'idempotency'
  | 'work_unit_authority'
  | 'execution_request'
  | 'execution_attempt'
  | 'execution_observation'
  | 'execution_cancellation'
  | 'execution_reconciliation'
  | 'planning_projection'
  | 'provider_intent'
  | 'provider_result';

export type CoordinatorDependencies = Readonly<{
  now: () => string;
  newId: (
    kind: 'outcome' | 'mission' | 'work_unit' | 'event' | 'snapshot' |
      'execution_request' | 'agent_session' | 'judgment_request' |
      'judgment_decision' | 'authority_grant',
  ) => string;
  sha256Hex: (value: string) => Promise<string>;
  resolveJudgmentAdmissionV05?: (input: Readonly<{
    ownerId: string;
    subject: JudgmentRequestV05['subject'];
    affectedDigest: `sha256:${string}`;
    requestedAuthority: JudgmentRequestV05['requestedAuthority'];
    ownerPolicyRevision: number;
  }>) => CurrentJudgmentAdmissionV05;
  resolveExecutionBindingV04?: (input: Readonly<{
    ownerId: string;
    outcomeId: string;
    workUnitId: string;
  }>) => Promise<unknown>;
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

function defaultResolveJudgmentAdmissionV05(input: Readonly<{
  ownerId: string;
  subject: JudgmentRequestV05['subject'];
  affectedDigest: `sha256:${string}`;
  requestedAuthority: JudgmentRequestV05['requestedAuthority'];
  ownerPolicyRevision: number;
}>): CurrentJudgmentAdmissionV05 {
  if (input.requestedAuthority === null) {
    return Object.freeze({
      grantee: null,
      revocationGeneration: 0,
      admissionContextMaterial: null,
    });
  }
  const grantee = Object.freeze({ kind: 'service' as const, id: 'effect_engine' });
  return Object.freeze({
    grantee,
    revocationGeneration: 0,
    admissionContextMaterial: JSON.stringify([
      'judgment-authority-admission-v0.5',
      input.ownerId,
      input.subject,
      input.affectedDigest,
      grantee,
      input.ownerPolicyRevision,
      0,
    ]),
  });
}

export class WaldoCoordinator {
  readonly #storage: DurableObjectStorage;
  readonly #deps: CoordinatorDependencies;
  readonly #identity: IdentityPresenceModule;
  readonly #events: OwnerEventLog;
  readonly #outcomes: OutcomeModule;
  readonly #planning: PlanningExecutionModule;
  readonly #judgmentProjections: JudgmentProjectionPublisher;
  readonly #judgments: JudgmentAuthorityModule;

  constructor(
    storage: DurableObjectStorage,
    dependencies: CoordinatorDependencies = defaultDependencies(),
  ) {
    this.#storage = storage;
    this.#deps = dependencies;
    this.#identity = new IdentityPresenceModule(storage);
    this.#events = new OwnerEventLog(storage);
    this.#outcomes = new OutcomeModule(storage, dependencies.newId);
    this.#planning = new PlanningExecutionModule(storage, dependencies.newId);
    this.#judgmentProjections = new JudgmentProjectionPublisher(
      storage,
      () => dependencies.newId('snapshot'),
    );
    this.#judgments = new JudgmentAuthorityModule(
      storage,
      dependencies.newId,
      this.#judgmentProjections,
    );
  }

  admitCanonicalAuthority(
    registration: ResponsibilityCanonicalAuthorityRegistration,
    beforeCommit?: () => void,
  ): ResponsibilityCanonicalAuthorityWithAssurance {
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

  async createTrustedJudgmentRequestV05(
    proposal: TrustedJudgmentRequestProposalV05,
    canonicalAuthority: ResponsibilityCanonicalAuthorityWithAssurance,
  ): Promise<JudgmentProjectionItemV05> {
    const preflightAt = this.#deps.now();
    const authority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
      canonicalAuthority,
      preflightAt,
    );
    if (authority.authAssurance === 'legacy_unverified') {
      throw new ResponsibilityOwnerRootMismatchError();
    }
    const material = this.#outcomes.readExactJudgmentSubjectMaterialInCurrentTransaction({
      ownerId: authority.ownerId,
      ...proposal.subject,
      expectedRevision: proposal.subject.expectedRevision,
    });
    const affectedDigest = `sha256:${await this.#deps.sha256Hex(material.canonicalMaterial)}` as const;
    const requestedAuthority = proposal.requestedAuthority === null
      ? null
      : requestedAuthorityV05Schema.parse(proposal.requestedAuthority);
    const currentAdmission = (this.#deps.resolveJudgmentAdmissionV05 ??
      defaultResolveJudgmentAdmissionV05)({
      ownerId: authority.ownerId,
      subject: material.subject,
      affectedDigest,
      requestedAuthority,
      ownerPolicyRevision: authority.ownerPolicyRevision,
    });
    const { grantee, revocationGeneration } = currentAdmission;
    const admissionContextDigest = currentAdmission.admissionContextMaterial === null
      ? null
      : `sha256:${await this.#deps.sha256Hex(
        currentAdmission.admissionContextMaterial,
      )}` as const;
    const request = judgmentRequestV05Schema.parse({
      ...proposal,
      requestedAuthority,
      protocolVersion: '0.5',
      id: this.#deps.newId('judgment_request'),
      ownerId: authority.ownerId,
      revision: 1,
      subject: material.subject,
      affectedDigest,
      authorityAdmission: grantee === null ? null : {
        grantee,
        ownerPolicyRevision: authority.ownerPolicyRevision,
        admissionContextDigest,
      },
      decisionId: null,
      state: 'open',
      createdAt: preflightAt,
      updatedAt: preflightAt,
    });
    const displayedRequestDigest = `sha256:${await this.#deps.sha256Hex(
      canonicalizeJudgmentRequestV05ForDigest(request),
    )}` as const;

    return this.#storage.transactionSync(() => {
      const commitAt = this.#deps.now();
      const currentAuthority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        commitAt,
      );
      if (currentAuthority.authAssurance !== authority.authAssurance ||
          Date.parse(commitAt) >= Date.parse(request.expiresAt)) {
        throw new ResponsibilityOwnerRootMismatchError();
      }
      if (request.requestedAuthority !== null &&
          Date.parse(commitAt) >= Date.parse(request.requestedAuthority.validUntil)) {
        throw new ResponsibilityJudgmentConflictError();
      }
      const currentMaterial = this.#outcomes.readExactJudgmentSubjectMaterialInCurrentTransaction({
        ownerId: currentAuthority.ownerId,
        ...proposal.subject,
        expectedRevision: proposal.subject.expectedRevision,
      });
      if (currentMaterial.canonicalMaterial !== material.canonicalMaterial) {
        throw new ResponsibilityDigestConflictError();
      }
      const commitAdmission = (this.#deps.resolveJudgmentAdmissionV05 ??
        defaultResolveJudgmentAdmissionV05)({
        ownerId: currentAuthority.ownerId,
        subject: request.subject,
        affectedDigest,
        requestedAuthority,
        ownerPolicyRevision: currentAuthority.ownerPolicyRevision,
      });
      if (JSON.stringify(commitAdmission) !== JSON.stringify(currentAdmission)) {
        throw new ResponsibilityJudgmentConflictError();
      }
      const item = this.#judgments.persistRequestInCurrentTransaction({
        request,
        displayedRequestDigest,
        admissionBasis: {
          ownerId: currentAuthority.ownerId,
          subject: request.subject,
          affectedDigest,
          grantee,
          ownerPolicyRevision: currentAuthority.ownerPolicyRevision,
          admissionContextDigest,
          revocationGeneration,
        },
      });
      this.#deps.afterWrite?.('current_state');
      this.#deps.afterWrite?.('events');
      this.#deps.afterWrite?.('projection');
      return item;
    });
  }

  async answerAuthorizedJudgmentV05(
    admission: JudgmentAnswerAdmissionV05,
    canonicalAuthority: ResponsibilityCanonicalAuthorityWithAssurance,
  ): Promise<JudgmentAnswerResultV05> {
    const answer = judgmentAnswerRequestV05Schema.parse(admission.request);
    const answerRequestDigest = `sha256:${await this.#deps.sha256Hex(
      canonicalizeJudgmentAnswerRequestV05ForDigest(answer),
    )}` as const;

    const duplicate = this.#storage.transactionSync(() => {
      const authority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        this.#deps.now(),
      );
      this.#assertJudgmentAnswerAuthority(admission, answer, authority);
      return this.#judgments.readCommandResultInCurrentTransaction({
        ownerId: authority.ownerId,
        requestId: answer.requestId,
        requestDigest: answerRequestDigest,
      });
    });
    if (duplicate !== undefined) return duplicate;

    const decidedAt = this.#deps.now();
    const authority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
      canonicalAuthority,
      decidedAt,
    );
    this.#assertJudgmentAnswerAuthority(admission, answer, authority);
    const stored = this.#judgments.readRequestInCurrentTransaction(
      authority.ownerId,
      answer.aggregate.id,
    );
    const request = stored.request;
    if (
      request.state !== 'open' ||
      request.revision !== answer.aggregate.expectedRevision ||
      request.decisionId !== null ||
      stored.displayedRequestDigest !== answer.payload.displayedRequestDigest
    ) {
      throw new ResponsibilityJudgmentConflictError();
    }
    if (Date.parse(decidedAt) >= Date.parse(request.expiresAt)) {
      await this.#terminalizeJudgmentRequestV05(
        request,
        'expired',
        answer.requestId,
        canonicalAuthority,
      );
      throw new ResponsibilityJudgmentConflictError();
    }
    const requestHashHex = await this.#deps.sha256Hex(
      canonicalizeJudgmentRequestV05ForDigest(request),
    );
    if (stored.displayedRequestDigest !== `sha256:${requestHashHex}`) {
      throw new ResponsibilityDigestConflictError();
    }
    const selectedOption = request.options.find(
      (option) => option.id === answer.payload.selectedOptionId,
    );
    if (selectedOption === undefined) throw new ResponsibilityJudgmentConflictError();
    let material;
    try {
      material = this.#outcomes.readExactJudgmentSubjectMaterialInCurrentTransaction({
        ownerId: authority.ownerId,
        kind: request.subject.kind,
        id: request.subject.id,
        expectedRevision: request.subject.revision,
      });
    } catch (error) {
      if (!(error instanceof ResponsibilityJudgmentConflictError)) throw error;
      await this.#terminalizeJudgmentRequestV05(
        request,
        'superseded',
        answer.requestId,
        canonicalAuthority,
      );
      throw new ResponsibilityJudgmentConflictError();
    }
    const affectedDigest = `sha256:${await this.#deps.sha256Hex(
      material.canonicalMaterial,
    )}` as const;
    if (affectedDigest !== request.affectedDigest ||
        affectedDigest !== stored.admissionBasis.affectedDigest) {
      await this.#terminalizeJudgmentRequestV05(
        request,
        'superseded',
        answer.requestId,
        canonicalAuthority,
      );
      throw new ResponsibilityJudgmentConflictError();
    }
    const currentAdmission = (this.#deps.resolveJudgmentAdmissionV05 ??
      defaultResolveJudgmentAdmissionV05)({
      ownerId: authority.ownerId,
      subject: request.subject,
      affectedDigest,
      requestedAuthority: request.requestedAuthority,
      ownerPolicyRevision: authority.ownerPolicyRevision,
    });
    const currentAdmissionDigest = currentAdmission.admissionContextMaterial === null
      ? null
      : `sha256:${await this.#deps.sha256Hex(currentAdmission.admissionContextMaterial)}`;
    if (!this.#isCurrentJudgmentAdmission(
      request,
      stored.admissionBasis,
      authority,
      currentAdmission,
      currentAdmissionDigest,
    )) {
      await this.#terminalizeJudgmentRequestV05(
        request,
        'superseded',
        answer.requestId,
        canonicalAuthority,
      );
      throw new ResponsibilityJudgmentConflictError();
    }

    const decision = judgmentDecisionV05Schema.parse({
      protocolVersion: '0.5',
      id: this.#deps.newId('judgment_decision'),
      ownerId: authority.ownerId,
      revision: 1,
      judgmentRequestId: request.id,
      judgmentRequestRevision: request.revision,
      subject: request.subject,
      selectedOptionId: selectedOption.id,
      displayedRequestDigest: stored.displayedRequestDigest,
      actor: { kind: 'owner', id: authority.ownerId },
      presenceId: authority.presenceId,
      authenticatedSessionId: authority.authenticatedSessionId,
      ownerPolicyRevision: authority.ownerPolicyRevision,
      authAssurance: authority.authAssurance,
      state: 'recorded',
      decidedAt,
    });
    const grant = selectedOption.authorityDisposition === 'grant'
      ? this.#buildAuthorityGrantV05(request, decision, stored.admissionBasis, decidedAt)
      : undefined;
    const binding = createJudgmentAuthorityBindingVerifierV05(() => requestHashHex)({
      requestDigest: stored.displayedRequestDigest,
      request,
      answer,
      decision,
      authorityDisposition: grant === undefined ? 'refused' : 'granted',
      ...(grant === undefined ? {} : { grant }),
    });
    const answeredRequest = judgmentRequestV05Schema.parse({
      ...request,
      revision: request.revision + 1,
      decisionId: decision.id,
      state: 'answered',
      updatedAt: decidedAt,
    });
    const answeredRequestDigest = `sha256:${await this.#deps.sha256Hex(
      canonicalizeJudgmentRequestV05ForDigest(answeredRequest),
    )}` as const;

    const committed = this.#storage.transactionSync(():
      JudgmentAnswerResultV05 | Readonly<{ terminalState: 'expired' | 'superseded' }> => {
      const commitAt = this.#deps.now();
      const currentAuthority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        commitAt,
      );
      this.#assertJudgmentAnswerAuthority(admission, answer, currentAuthority);
      const racedDuplicate = this.#judgments.readCommandResultInCurrentTransaction({
        ownerId: currentAuthority.ownerId,
        requestId: answer.requestId,
        requestDigest: answerRequestDigest,
      });
      if (racedDuplicate !== undefined) return racedDuplicate;
      if (Date.parse(commitAt) >= Date.parse(request.expiresAt)) {
        return Object.freeze({ terminalState: 'expired' as const });
      }
      if (grant !== undefined && request.requestedAuthority !== null &&
          Date.parse(commitAt) >= Date.parse(request.requestedAuthority.validUntil)) {
        return Object.freeze({ terminalState: 'superseded' as const });
      }
      if (JSON.stringify(currentAuthority) !== JSON.stringify(authority)) {
        return Object.freeze({ terminalState: 'superseded' as const });
      }
      const currentStored = this.#judgments.readRequestInCurrentTransaction(
        currentAuthority.ownerId,
        request.id,
      );
      if (
        canonicalizeJudgmentRequestV05ForDigest(currentStored.request) !==
          canonicalizeJudgmentRequestV05ForDigest(request) ||
        currentStored.displayedRequestDigest !== stored.displayedRequestDigest ||
        JSON.stringify(currentStored.admissionBasis) !== JSON.stringify(stored.admissionBasis)
      ) {
        if (currentStored.request.state !== 'open') {
          throw new ResponsibilityJudgmentConflictError();
        }
        return Object.freeze({ terminalState: 'superseded' as const });
      }
      let currentMaterial;
      try {
        currentMaterial = this.#outcomes.readExactJudgmentSubjectMaterialInCurrentTransaction({
          ownerId: currentAuthority.ownerId,
          kind: request.subject.kind,
          id: request.subject.id,
          expectedRevision: request.subject.revision,
        });
      } catch (error) {
        if (!(error instanceof ResponsibilityJudgmentConflictError)) throw error;
        return Object.freeze({ terminalState: 'superseded' as const });
      }
      if (currentMaterial.canonicalMaterial !== material.canonicalMaterial) {
        return Object.freeze({ terminalState: 'superseded' as const });
      }
      const commitAdmission = (this.#deps.resolveJudgmentAdmissionV05 ??
        defaultResolveJudgmentAdmissionV05)({
        ownerId: currentAuthority.ownerId,
        subject: request.subject,
        affectedDigest,
        requestedAuthority: request.requestedAuthority,
        ownerPolicyRevision: currentAuthority.ownerPolicyRevision,
      });
      if (JSON.stringify(commitAdmission) !== JSON.stringify(currentAdmission)) {
        return Object.freeze({ terminalState: 'superseded' as const });
      }
      const result = this.#judgments.persistAnswerInCurrentTransaction({
        binding,
        answeredRequest,
        answeredRequestDigest,
        answerRequestId: answer.requestId,
        answerRequestDigest,
      });
      this.#deps.afterWrite?.('current_state');
      this.#deps.afterWrite?.('events');
      this.#deps.afterWrite?.('projection');
      this.#deps.afterWrite?.('idempotency');
      return result;
    });
    if ('terminalState' in committed) {
      await this.#terminalizeJudgmentRequestV05(
        request,
        committed.terminalState,
        answer.requestId,
        canonicalAuthority,
      );
      throw new ResponsibilityJudgmentConflictError();
    }
    return committed;
  }

  replayJudgmentsV05(
    routedOwnerId: string,
    canonicalAuthority: ResponsibilityCanonicalAuthorityWithAssurance,
  ) {
    return this.#storage.transactionSync(() => {
      const authority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        this.#deps.now(),
      );
      if (authority.ownerId !== routedOwnerId) {
        throw new ResponsibilityOwnerRootMismatchError();
      }
      return this.#judgments.replayInCurrentTransaction(authority.ownerId);
    });
  }

  rebuildJudgmentProjectionV05(
    routedOwnerId: string,
    canonicalAuthority: ResponsibilityCanonicalAuthorityWithAssurance,
  ) {
    return this.#storage.transactionSync(() => {
      const at = this.#deps.now();
      const authority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        at,
      );
      if (authority.ownerId !== routedOwnerId ||
          authority.authAssurance === 'legacy_unverified') {
        throw new ResponsibilityOwnerRootMismatchError();
      }
      this.#judgments.replayInCurrentTransaction(authority.ownerId);
      return this.#judgmentProjections.rebuildInCurrentTransaction(authority.ownerId, at);
    });
  }

  async readJudgmentProjectionV05(
    input: JudgmentProjectionReadV05,
    canonicalAuthority: ResponsibilityCanonicalAuthorityWithAssurance,
  ): Promise<JudgmentProjectionPageV05> {
    const query = judgmentProjectionQueryV05Schema.parse(input.query);
    const page = this.#storage.transactionSync(() => {
      const authority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        this.#deps.now(),
      );
      if (authority.ownerId !== input.routedOwnerId ||
          authority.authAssurance === 'legacy_unverified') {
        throw new ResponsibilityOwnerRootMismatchError();
      }
      return this.#judgmentProjections.readInCurrentTransaction({
        ownerId: authority.ownerId,
        fromExclusiveCursor: query.fromExclusiveCursor,
        limit: query.limit,
        ...(query.snapshotId === undefined ? {} : { snapshotId: query.snapshotId }),
        generatedAt: this.#deps.now(),
      });
    });
    for (const item of page.items) {
      const digest = `sha256:${await this.#deps.sha256Hex(
        canonicalizeJudgmentRequestV05ForDigest(item.request),
      )}`;
      if (digest !== item.displayedRequestDigest) {
        throw new ResponsibilityDigestConflictError();
      }
    }
    return page;
  }

  async authorizePlanningTurn(
    admission: WorkUnitPlanningAdmission,
    canonicalAuthority: ResponsibilityCanonicalAuthority,
  ): Promise<WorkUnitPlanningAuthorizationResultV03> {
    const request = workUnitPlanningTurnRequestV03Schema.parse(admission.request);
    const envelope = workUnitPlanningTurnTrustedEnvelopeV03Schema.parse(
      admission.trustedEnvelope,
    );
    this.#validatePlanningAdmission(admission.routedOwnerId, request, envelope);
    const requestDigest = `sha256:${await this.#deps.sha256Hex(
      canonicalizeWorkUnitPlanningTurnRequestV03ForDigest(request),
    )}`;
    if (envelope.requestDigest !== requestDigest) throw new ResponsibilityDigestConflictError();
    for (const governedInput of request.payload.governedInputs) {
      const contentDigest = `sha256:${await this.#deps.sha256Hex(governedInput.content)}`;
      if (contentDigest !== governedInput.digest) throw new ResponsibilityDigestConflictError();
    }

    return this.#storage.transactionSync(() => {
      this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        this.#deps.now(),
      );
      this.#assertEnvelopeAuthority(canonicalAuthority, request, envelope);
      const existing = this.#planning.readIdempotentAuthorization(
        admission.routedOwnerId,
        request.requestId,
        requestDigest,
      );
      if (existing !== null) return Object.freeze(
        workUnitPlanningAuthorizationResultV03Schema.parse(existing),
      );

      const at = this.#deps.now();
      const executionRequestId = this.#deps.newId('execution_request');
      const agentSessionId = this.#deps.newId('agent_session');
      const authorized = this.#outcomes.authorizePlanningInCurrentTransaction({
        ownerId: admission.routedOwnerId,
        workUnitId: request.aggregate.id,
        expectedRevision: request.aggregate.expectedRevision,
        agentSessionId,
        executorId: envelope.executor.executorId,
        at,
        commandId: envelope.commandId,
        correlationId: envelope.correlationId,
        authorityCeiling: envelope.authorityCeiling,
        maxDurationMs: 120_000,
      });
      this.#deps.afterWrite?.('work_unit_authority');
      const result = this.#planning.persistAuthorizationInCurrentTransaction({
        ownerId: admission.routedOwnerId,
        requestId: request.requestId,
        requestDigest,
        outcomeId: authorized.workUnit.outcomeId,
        workUnitId: authorized.workUnit.id,
        workUnitRevision: authorized.workUnit.revision,
        executionRequestId,
        agentSessionId,
        cursor: authorized.cursor,
        at,
        envelope,
      });
      this.#deps.afterWrite?.('execution_request');
      this.#deps.afterWrite?.('planning_projection');
      this.#deps.afterWrite?.('idempotency');
      return result;
    });
  }

  async readPlanningCommandResult(
    ownerId: string,
    request: WorkUnitPlanningTurnRequestV03,
  ): Promise<WorkUnitPlanningCommandResultV03 | null> {
    const requestDigest = `sha256:${await this.#deps.sha256Hex(
      canonicalizeWorkUnitPlanningTurnRequestV03ForDigest(request),
    )}`;
    return this.#planning.readIdempotentResult(ownerId, request.requestId, requestDigest);
  }

  async admitExecutionRequestV04(
    admissionValue: unknown,
    canonicalAuthority: ResponsibilityCanonicalAuthority,
    publicCommandScope?: Readonly<{ commandIdPrefix: string }>,
  ): Promise<ExecutionAggregateV04> {
    const admission = parseExecutionAdmissionV04(admissionValue);
    const admittedAt = this.#deps.now();
    const preflightAuthority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
      canonicalAuthority,
      admittedAt,
    );
    const existing = this.#planning.readExecutionAggregateByRequestIdV04IfExists(admission.id);
    if (existing !== null) {
      if (existing.request.ownerId !== preflightAuthority.ownerId ||
          !executionAdmissionMatchesRequestV04(admission, existing.request)) {
        throw new ResponsibilityDigestConflictError();
      }
      return this.#storage.transactionSync(() => {
        const authority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
          canonicalAuthority,
          this.#deps.now(),
        );
        if (authority.ownerId !== existing.request.ownerId) {
          throw new ResponsibilityOwnerRootMismatchError();
        }
        return this.#planning.readExecutionAggregateV04(
          existing.request.ownerId,
          existing.request.id,
        );
      });
    }
    this.#assertPublicExecutionIdentityAvailableV04(
      preflightAuthority.ownerId,
      admission,
      publicCommandScope,
    );
    const resolveExecutionBindingV04 = this.#deps.resolveExecutionBindingV04;
    if (resolveExecutionBindingV04 === undefined) {
      throw new Error('execution binding authority unavailable');
    }
    const resolvedBinding = parseExecutionBindingResolutionV04(
      await resolveExecutionBindingV04({
        ownerId: preflightAuthority.ownerId,
        outcomeId: admission.outcomeId,
        workUnitId: admission.workUnitId,
      }),
    );
    const requestedAt = admittedAt;
    const productMaterial = this.#planning.readExecutionProductDigestMaterialV04(
      preflightAuthority.ownerId,
      admission.outcomeId,
      admission.workUnitId,
    );
    const [outcomeDigestHex, workUnitDigestHex] = await Promise.all([
      this.#deps.sha256Hex(productMaterial.outcomeMaterial),
      this.#deps.sha256Hex(productMaterial.workUnitMaterial),
    ]);
    const request = executionRequestV04Schema.parse({
      protocolVersion: '0.4',
      id: admission.id,
      ownerId: preflightAuthority.ownerId,
      outcome: { ...productMaterial.outcome, digest: `sha256:${outcomeDigestHex}` },
      workUnit: { ...productMaterial.workUnit, digest: `sha256:${workUnitDigestHex}` },
      provider: resolvedBinding.provider,
      environment: resolvedBinding.environment,
      authorityCeiling: productMaterial.authorityCeiling,
      contextProjectionRef: resolvedBinding.contextProjectionRef,
      contextProjectionDigest: resolvedBinding.contextProjectionDigest,
      cancellationGeneration: 1,
      requestedAt,
    });
    const requestDigest = `sha256:${await this.#deps.sha256Hex(JSON.stringify(request))}`;
    const productDigestProof = Object.freeze({
      outcomeMaterial: productMaterial.outcomeMaterial,
      workUnitMaterial: productMaterial.workUnitMaterial,
      outcomeDigest: `sha256:${outcomeDigestHex}`,
      workUnitDigest: `sha256:${workUnitDigestHex}`,
    });
    const trustedBinding: ExecutionAdmissionBindingV04 = Object.freeze({
      routedOwnerId: preflightAuthority.ownerId,
      outcome: request.outcome,
      workUnit: request.workUnit,
      provider: request.provider,
      environment: request.environment,
      authorityCeiling: request.authorityCeiling,
      contextProjectionRef: request.contextProjectionRef,
      contextProjectionDigest: request.contextProjectionDigest,
    });
    return this.#storage.transactionSync(() => {
      const authority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        this.#deps.now(),
      );
      if (authority.ownerId !== request.ownerId) {
        throw new ResponsibilityOwnerRootMismatchError();
      }
      const concurrent = this.#planning.readExecutionAggregateByRequestIdV04IfExists(request.id);
      if (concurrent !== null) {
        if (concurrent.request.ownerId !== authority.ownerId ||
            !executionAdmissionMatchesRequestV04(admission, concurrent.request)) {
          throw new ResponsibilityDigestConflictError();
        }
        return concurrent;
      }
      this.#assertPublicExecutionIdentityAvailableV04(
        authority.ownerId,
        admission,
        publicCommandScope,
      );
      this.#planning.admitExecutionRequestV04InCurrentTransaction({
        request,
        trustedBinding,
        requestDigest,
        productDigestProof,
      });
      this.#deps.afterWrite?.('execution_request');
      return this.#planning.readExecutionAggregateV04(request.ownerId, request.id);
    });
  }

  async admitPublicExecutionRequestV04(
    admissionValue: unknown,
    canonicalAuthority: ResponsibilityCanonicalAuthority,
  ): Promise<ExecutionAggregateV04> {
    const admission = parsePublicExecutionAdmissionV04(admissionValue);
    const authority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
      canonicalAuthority,
      this.#deps.now(),
    );
    const productMaterial = this.#planning.readExecutionProductDigestMaterialForWorkUnitV04(
      authority.ownerId,
      admission.workUnitId,
    );
    if (productMaterial.workUnit.revision !== admission.expectedWorkUnitRevision) {
      throw new ResponsibilityDigestConflictError();
    }
    const existing = this.#planning.readExecutionAggregateByRequestIdV04IfExists(admission.id);
    if (existing !== null && (
      existing.request.ownerId !== authority.ownerId ||
      existing.request.workUnit.id !== admission.workUnitId ||
      existing.request.workUnit.revision !== admission.expectedWorkUnitRevision ||
      existing.request.outcome.id !== productMaterial.outcome.id
    )) {
      throw new ResponsibilityDigestConflictError();
    }
    return this.admitExecutionRequestV04({
      id: admission.id,
      outcomeId: productMaterial.outcome.id,
      workUnitId: admission.workUnitId,
    }, canonicalAuthority, { commandIdPrefix: admission.commandIdPrefix });
  }

  #assertPublicExecutionIdentityAvailableV04(
    ownerId: string,
    admission: ExecutionAdmissionV04,
    scope: Readonly<{ commandIdPrefix: string }> | undefined,
  ): void {
    if (scope === undefined) return;
    const commandIdentity = this.#planning.readExecutionRequestIdentityByIdPrefixIfExists(
      ownerId,
      scope.commandIdPrefix,
    );
    const workUnitIdentity = this.#planning.readExecutionRequestIdentityForWorkUnitIfExists(
      ownerId,
      admission.workUnitId,
    );
    if ((commandIdentity !== null && commandIdentity.id !== admission.id) ||
        (workUnitIdentity !== null && workUnitIdentity.id !== admission.id)) {
      throw new ResponsibilityDigestConflictError();
    }
  }

  async resolveExecutionStartIntentV04(
    ownerId: string,
    executionRequestId: string,
  ): Promise<Readonly<{ ref: string; digest: string }>> {
    const material = this.#planning.readExecutionRequestIntentMaterialV04(
      ownerId,
      executionRequestId,
    );
    const recomputed = `sha256:${await this.#deps.sha256Hex(JSON.stringify(material.request))}`;
    if (recomputed !== material.requestDigest) {
      throw new Error('execution start intent digest mismatch');
    }
    return Object.freeze({
      ref: protocolIdSchema.parse(
        `execution_start_intent_${material.requestDigest.slice('sha256:'.length)}`,
      ),
      digest: protocolDigestSchema.parse(material.requestDigest),
    });
  }

  claimExecutionAttemptV04(claimValue: unknown): ExecutionAggregateV04 {
    const claim = parseExecutionClaimV04(claimValue);
    return this.#storage.transactionSync(() => {
      const aggregate = this.#planning.readExecutionAggregateByRequestIdV04(
        claim.executionRequestId,
      );
      const matchingIndex = aggregate.attempts.findIndex(
        (value) => value.id === claim.attemptId,
      );
      if (matchingIndex >= 0) {
        const existingLease = aggregate.leases[matchingIndex];
        const existingSession = aggregate.sessions[matchingIndex];
        if (existingLease?.id !== claim.leaseId ||
            existingSession?.id !== claim.sessionId ||
            existingSession.providerSessionRef !== claim.providerSessionRef) {
          throw new Error('execution claim digest conflict');
        }
        return aggregate;
      }
      const claimedAt = this.#deps.now();
      const previousAttempt = aggregate.attempts.at(-1);
      const previousLease = aggregate.leases.at(-1);
      const attemptNumber = previousAttempt === undefined
        ? 1
        : previousAttempt.attemptNumber + 1;
      const fencingGeneration = previousLease === undefined
        ? 1
        : previousLease.fencingGeneration + 1;
      const attempt = executionAttemptV04Schema.parse({
        protocolVersion: '0.4',
        id: claim.attemptId,
        ownerId: aggregate.request.ownerId,
        executionRequestId: aggregate.request.id,
        workUnit: aggregate.request.workUnit,
        attemptNumber,
        provider: aggregate.request.provider,
        environment: aggregate.request.environment,
        leaseId: claim.leaseId,
        fencingGeneration,
        cancellationGeneration: aggregate.currentCancellationGeneration,
        state: 'running',
        createdAt: claimedAt,
        updatedAt: claimedAt,
      });
      const lease = executionLeaseV04Schema.parse({
        protocolVersion: '0.4',
        id: claim.leaseId,
        ownerId: aggregate.request.ownerId,
        executionRequestId: aggregate.request.id,
        attemptId: claim.attemptId,
        holder: aggregate.request.environment,
        fencingGeneration,
        cancellationGeneration: aggregate.currentCancellationGeneration,
        acquiredAt: claimedAt,
        expiresAt: new Date(
          Date.parse(claimedAt) + EXECUTION_LEASE_MAX_DURATION_MS_V04,
        ).toISOString(),
      });
      const session = executionSessionV04Schema.parse({
        protocolVersion: '0.4',
        id: claim.sessionId,
        ownerId: aggregate.request.ownerId,
        attemptId: claim.attemptId,
        provider: aggregate.request.provider,
        environment: aggregate.request.environment,
        providerSessionRef: claim.providerSessionRef,
        state: 'active',
        lastObservationSequence: 0,
      });
      this.#planning.claimExecutionAttemptV04InCurrentTransaction({
        attempt,
        lease,
        session,
        claimedAt,
      });
      this.#deps.afterWrite?.('execution_attempt');
      return this.#planning.readExecutionAggregateV04(
        attempt.ownerId,
        attempt.executionRequestId,
      );
    });
  }

  async admitExecutorObservationV04(
    observationValue: unknown,
  ): Promise<ExecutionAggregateV04> {
    const observation = executorObservationV04Schema.parse(observationValue);
    const observationDigest = `sha256:${await this.#deps.sha256Hex(
      JSON.stringify(observation),
    )}`;
    return this.#storage.transactionSync(() => {
      const receivedAt = this.#deps.now();
      this.#planning.admitExecutorObservationV04InCurrentTransaction({
        observation,
        observationDigest,
        receivedAt,
      });
      this.#deps.afterWrite?.('execution_observation');
      return this.#planning.readExecutionAggregateForAttemptV04(
        observation.ownerId,
        observation.attemptId,
      );
    });
  }

  async cancelExecutionV04(input: Readonly<{
    request: unknown;
    canonicalAuthority: ResponsibilityCanonicalAuthority;
  }>): Promise<ExecutionAggregateV04> {
    const request = executionCancelRequestV04Schema.parse(input.request);
    const requestDigest = `sha256:${await this.#deps.sha256Hex(JSON.stringify(request))}`;
    return this.#storage.transactionSync(() => {
      const at = this.#deps.now();
      const authority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        input.canonicalAuthority,
        at,
      );
      if (authority.presenceRegistrationId !== request.presenceRegistrationId) {
        throw new Error('execution cancellation authority mismatch');
      }
      this.#planning.cancelExecutionV04InCurrentTransaction({
        ownerId: authority.ownerId,
        request,
        requestDigest,
        at,
      });
      this.#deps.afterWrite?.('execution_cancellation');
      return this.#planning.readExecutionAggregateV04(
        authority.ownerId,
        request.executionRequestId,
      );
    });
  }

  async reconcileExecutionAttemptV04(
    reconciliationValue: unknown,
  ): Promise<ExecutionAggregateV04> {
    const reconciliation = executionReconciliationV04Schema.parse(reconciliationValue);
    const reconciliationDigest = `sha256:${await this.#deps.sha256Hex(
      JSON.stringify(reconciliation),
    )}`;
    return this.#storage.transactionSync(() => {
      this.#planning.reconcileExecutionAttemptV04InCurrentTransaction({
        reconciliation,
        reconciliationDigest,
        receivedAt: this.#deps.now(),
      });
      this.#deps.afterWrite?.('execution_reconciliation');
      return this.#planning.readExecutionAggregateForAttemptV04(
        reconciliation.ownerId,
        reconciliation.attemptId,
      );
    });
  }

  readExecutionAggregateV04(
    ownerId: string,
    executionRequestId: string,
  ): ExecutionAggregateV04 {
    return this.#planning.readExecutionAggregateV04(ownerId, executionRequestId);
  }

  async readCurrentExecutionAggregateV04(
    ownerId: string,
    executionRequestId: string,
  ): Promise<ExecutionAggregateV04> {
    const aggregate = this.#planning.readExecutionAggregateV04(ownerId, executionRequestId);
    const productMaterial = this.#planning.readExecutionProductDigestMaterialV04(
      ownerId,
      aggregate.request.outcome.id,
      aggregate.request.workUnit.id,
    );
    const [outcomeDigestHex, workUnitDigestHex] = await Promise.all([
      this.#deps.sha256Hex(productMaterial.outcomeMaterial),
      this.#deps.sha256Hex(productMaterial.workUnitMaterial),
    ]);
    return this.#storage.transactionSync(() => {
      const currentAggregate = this.#planning.readExecutionAggregateV04(
        ownerId,
        executionRequestId,
      );
      const currentProduct = this.#planning.readExecutionProductDigestMaterialV04(
        ownerId,
        currentAggregate.request.outcome.id,
        currentAggregate.request.workUnit.id,
      );
      const currentMatches = JSON.stringify(currentProduct) === JSON.stringify(productMaterial) &&
        currentAggregate.request.outcome.revision === currentProduct.outcome.revision &&
        currentAggregate.request.outcome.digest === `sha256:${outcomeDigestHex}` &&
        currentAggregate.request.workUnit.revision === currentProduct.workUnit.revision &&
        currentAggregate.request.workUnit.digest === `sha256:${workUnitDigestHex}` &&
        JSON.stringify(currentAggregate.request.authorityCeiling) ===
          JSON.stringify(currentProduct.authorityCeiling);
      if (!currentMatches) throw new ResponsibilityDigestConflictError();
      return currentAggregate;
    });
  }

  readPlanningPromptMaterial(ownerId: string, executionRequestId: string) {
    return this.#planning.readPromptMaterial(ownerId, executionRequestId);
  }

  readPendingPlanningProviderEffect(
    ownerId: string,
    executionRequestId: string,
  ) {
    const at = this.#deps.now();
    const renewedExpiresAt = new Date(Date.parse(at) + 120_000).toISOString();
    return this.#storage.transactionSync(() =>
      this.#planning.recoverPendingProviderEffectInCurrentTransaction(
        ownerId, executionRequestId, at, renewedExpiresAt,
      ));
  }

  async preparePlanningProviderEffect(input: {
    ownerId: string;
    executionRequestId: string;
    holderId: string;
    request: LLMGatewayRequest;
  }): Promise<Readonly<{
    effect: TrustedProviderEffect;
    fence: number;
    cancellationGeneration: number;
  }>> {
    const requestDigest = await this.#deps.sha256Hex(JSON.stringify(input.request));
    const identityDigest = await this.#deps.sha256Hex(JSON.stringify({
      executionRequestId: input.executionRequestId,
      requestDigest,
      execution: {
        step: input.request.step,
        context: input.request.context,
        fallback_step: input.request.fallback_step,
      },
    }));
    const at = this.#deps.now();
    const expiresAt = new Date(Date.parse(at) + 120_000).toISOString();
    return this.#storage.transactionSync(() => {
      const prepared = this.#planning.prepareProviderEffectInCurrentTransaction({
        ...input,
        at,
        expiresAt,
        requestDigest,
        effectRef: `planning_effect_${identityDigest.slice(0, 64)}`,
        invocationKey: `sha256:${identityDigest}`,
      });
      this.#deps.afterWrite?.('provider_intent');
      return prepared;
    });
  }

  async settlePlanningCandidatePlan(input: {
    ownerId: string;
    requestId: string;
    executionRequestId: string;
    holderId: string;
    fence: number;
    cancellationGeneration: number;
    candidatePlan: unknown;
  }): Promise<WorkUnitPlanningTurnResultV03> {
    const resultDigest = `sha256:${await this.#deps.sha256Hex(
      JSON.stringify(input.candidatePlan),
    )}`;
    return this.#storage.transactionSync(() => {
      const result = this.#planning.settleCandidatePlanInCurrentTransaction({
        ...input,
        resultDigest,
        at: this.#deps.now(),
      });
      this.#deps.afterWrite?.('provider_result');
      return result;
    });
  }

  markPlanningProviderAmbiguous(ownerId: string, executionRequestId: string): void {
    this.#storage.transactionSync(() => {
      this.#planning.markProviderAmbiguousInCurrentTransaction({
        ownerId, executionRequestId, at: this.#deps.now(),
      });
    });
  }

  async rejectPlanningProviderOutput(input: {
    ownerId: string;
    executionRequestId: string;
    holderId: string;
    fence: number;
    cancellationGeneration: number;
    providerOutput: string;
  }): Promise<void> {
    const resultDigest = `sha256:${await this.#deps.sha256Hex(input.providerOutput)}`;
    this.#storage.transactionSync(() => {
      this.#planning.rejectInvalidProviderOutputInCurrentTransaction({
        ownerId: input.ownerId,
        executionRequestId: input.executionRequestId,
        holderId: input.holderId,
        fence: input.fence,
        cancellationGeneration: input.cancellationGeneration,
        resultDigest,
        at: this.#deps.now(),
      });
      this.#deps.afterWrite?.('provider_result');
    });
  }

  async cancelAuthorizedPlanningExecution(
    admission: WorkUnitPlanningCancelAdmission,
    canonicalAuthority: ResponsibilityCanonicalAuthority,
  ): Promise<WorkUnitPlanningCancelResultV03> {
    const request = workUnitPlanningCancelRequestV03Schema.parse(admission.request);
    if (request.presenceRegistrationId !== canonicalAuthority.presenceRegistrationId) {
      throw new Error('planning cancellation presence mismatch');
    }
    const requestDigest = `sha256:${await this.#deps.sha256Hex(
      canonicalizeWorkUnitPlanningCancelRequestV03ForDigest(request),
    )}`;
    return this.#storage.transactionSync(() => {
      this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        this.#deps.now(),
      );
      return this.#planning.cancelInCurrentTransaction({
        ownerId: admission.routedOwnerId,
        requestId: request.requestId,
        requestDigest,
        executionRequestId: request.executionRequestId,
        expectedCancellationGeneration: request.expectedCancellationGeneration,
        at: this.#deps.now(),
      });
    });
  }

  readAuthorizedPlanningProjection(
    input: WorkUnitPlanningProjectionRead,
    canonicalAuthority: ResponsibilityCanonicalAuthority,
  ): WorkUnitPlanningProjectionPageV03 {
    this.#identity.assertCanonicalAuthorityInCurrentTransaction(
      canonicalAuthority,
      this.#deps.now(),
    );
    const snapshot = this.#outcomes.projections.readSnapshot(input.routedOwnerId);
    return this.#planning.readProjection({
      ownerId: input.routedOwnerId,
      fromExclusiveCursor: input.fromExclusiveCursor,
      limit: input.limit,
      ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
      currentSnapshotId: snapshot.snapshotId,
      snapshotBaseCursor: snapshot.snapshotBaseCursor,
      generatedAt: this.#deps.now(),
    });
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

  #validatePlanningAdmission(
    routedOwnerId: string,
    request: WorkUnitPlanningTurnRequestV03,
    envelope: WorkUnitPlanningTurnTrustedEnvelopeV03,
  ): void {
    if (envelope.ownerId !== routedOwnerId) throw new ResponsibilityOwnerRootMismatchError();
    if (request.protocolVersion !== envelope.protocolVersion ||
        request.commandType !== envelope.commandType ||
        request.aggregate.kind !== envelope.aggregate.kind ||
        request.aggregate.id !== envelope.aggregate.id ||
        request.aggregate.expectedRevision !== envelope.aggregate.expectedRevision) {
      throw new Error('planning protocol or aggregate mismatch');
    }
    const admittedRefs = request.payload.governedInputs.map(({ ref, digest }) => ({ ref, digest }));
    if (JSON.stringify(admittedRefs) !== JSON.stringify(envelope.payload.governedInputs)) {
      throw new Error('planning governed input reference mismatch');
    }
  }

  #assertEnvelopeAuthority(
    authority: ResponsibilityCanonicalAuthority,
    request: WorkUnitPlanningTurnRequestV03,
    envelope: WorkUnitPlanningTurnTrustedEnvelopeV03,
  ): void {
    if (authority.ownerId !== envelope.ownerId ||
        authority.presenceRegistrationId !== request.presenceRegistrationId ||
        authority.presenceId !== envelope.presenceId ||
        authority.authenticatedSessionId !== envelope.authenticatedSessionId ||
        authority.ownerPolicyRevision !== envelope.ownerPolicyRevision ||
        authority.ownerRootRoutingVersion !== envelope.ownerRootRoutingVersion ||
        envelope.actor.kind !== 'presence' || envelope.actor.id !== authority.presenceId) {
      throw new ResponsibilityOwnerRootMismatchError();
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

  #assertJudgmentAnswerAuthority(
    admission: JudgmentAnswerAdmissionV05,
    answer: JudgmentAnswerRequestV05,
    authority: ResponsibilityCanonicalAuthorityWithAssurance,
  ): void {
    if (
      admission.routedOwnerId !== authority.ownerId ||
      answer.presenceRegistrationId !== authority.presenceRegistrationId ||
      authority.authAssurance === 'legacy_unverified'
    ) {
      throw new ResponsibilityOwnerRootMismatchError();
    }
  }

  #isCurrentJudgmentAdmission(
    request: JudgmentRequestV05,
    basis: JudgmentAdmissionBasisV05,
    authority: ResponsibilityCanonicalAuthorityWithAssurance,
    current: CurrentJudgmentAdmissionV05,
    currentAdmissionDigest: string | null,
  ): boolean {
    const admission = request.authorityAdmission;
    return !(
      basis.ownerId !== authority.ownerId ||
      basis.ownerPolicyRevision !== authority.ownerPolicyRevision ||
      basis.revocationGeneration !== current.revocationGeneration ||
      JSON.stringify(basis.subject) !== JSON.stringify(request.subject) ||
      JSON.stringify(basis.grantee) !== JSON.stringify(current.grantee) ||
      basis.admissionContextDigest !== currentAdmissionDigest ||
      ((admission === null) !== (current.grantee === null)) ||
      (admission !== null && (
        admission.ownerPolicyRevision !== authority.ownerPolicyRevision ||
        JSON.stringify(admission.grantee) !== JSON.stringify(current.grantee) ||
        admission.admissionContextDigest !== currentAdmissionDigest
      ))
    );
  }

  async #terminalizeJudgmentRequestV05(
    openRequest: JudgmentRequestV05,
    state: 'expired' | 'superseded',
    causationId: string,
    canonicalAuthority: ResponsibilityCanonicalAuthorityWithAssurance,
  ): Promise<void> {
    const at = this.#deps.now();
    const terminalRequest = judgmentRequestV05Schema.parse({
      ...openRequest,
      revision: openRequest.revision + 1,
      state,
      decisionId: null,
      updatedAt: at,
    });
    const terminalRequestDigest = `sha256:${await this.#deps.sha256Hex(
      canonicalizeJudgmentRequestV05ForDigest(terminalRequest),
    )}` as const;
    this.#storage.transactionSync(() => {
      const commitAt = this.#deps.now();
      const authority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        commitAt,
      );
      if (authority.ownerId !== openRequest.ownerId) {
        throw new ResponsibilityOwnerRootMismatchError();
      }
      this.#judgments.terminalizeRequestInCurrentTransaction({
        openRequest,
        terminalRequest,
        terminalRequestDigest,
        causationId,
      });
      this.#deps.afterWrite?.('current_state');
      this.#deps.afterWrite?.('events');
      this.#deps.afterWrite?.('projection');
    });
  }

  #buildAuthorityGrantV05(
    request: JudgmentRequestV05,
    decision: JudgmentDecisionV05,
    basis: JudgmentAdmissionBasisV05,
    at: string,
  ) {
    const requested = request.requestedAuthority;
    const admission = request.authorityAdmission;
    if (
      request.subject.kind !== 'work_unit' ||
      requested === null ||
      admission === null ||
      Date.parse(at) >= Date.parse(requested.validUntil)
    ) {
      throw new ResponsibilityJudgmentConflictError();
    }
    return authorityGrantV05Schema.parse({
      protocolVersion: '0.5',
      id: this.#deps.newId('authority_grant'),
      ownerId: request.ownerId,
      revision: 1,
      judgmentRequestId: request.id,
      judgmentRequestRevision: request.revision,
      judgmentDecisionId: decision.id,
      grantor: { kind: 'owner', id: request.ownerId },
      grantee: admission.grantee,
      subject: request.subject,
      purpose: requested.purpose,
      effectFamily: requested.effectFamily,
      resources: requested.resources,
      scopes: requested.scopes,
      audiences: requested.audiences,
      argumentDigest: requested.argumentDigest,
      contextDigest: requested.contextDigest,
      artifactDigest: requested.artifactDigest,
      useLimit: 1,
      usesConsumed: 0,
      nextUseIndex: 1,
      validFrom: at,
      expiresAt: requested.validUntil,
      revocationGeneration: basis.revocationGeneration,
      state: 'active',
      createdAt: at,
      updatedAt: at,
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
