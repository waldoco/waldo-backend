import {
  recallResultSchema,
  type AdapterResult,
  type DeliverySink,
  type LLMResponse,
  type SinkAck,
  type SinkRequest,
  type ToolHandler,
  type TrustedInvocationAdmission,
} from '@waldo/contracts';
import {
  createContextComposer,
  ContextSourceUnavailableError,
  type ContextComposer,
  type ContextComposerDependencies,
  type ContextSource,
} from '../context-composer';
import type { ContextFragment } from '../context-composer/types';
import type { HookRuntimeContext } from '../hooks/registry';
import {
  CloudflareAIGatewayAdapter,
  type GatewaySecretBinding,
} from '../llm/gateway';
import type {
  CircuitBreaker,
  LLMGatewayAdapter,
  LLMGatewayRequest,
  RouteSpendState,
  TrustedGatewayAdapterResult,
  TrustedGatewayExecution,
} from '../llm/provider';
import { evaluateMedicalClaim } from '../scribe/medical-gate';
import { sanitise } from '../scribe/sanitiser';
import { productionDeps, type Deps } from '../seams/deps';
import type { ResolvedSkillBudget } from '../skills/budget';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { V2ReplayArtifactSource } from './trusted-v2';

export const RUN_LOOP_DELIVERY_TEXT = 'Derived steady-state brief ready for delivery.';
export const RUN_LOOP_PLAN_SYSTEM_PREFIX = 'run-loop:plan';
export const RUN_LOOP_OBSERVE_SYSTEM_PREFIX = 'run-loop:observe';
export const RUN_LOOP_WORK_UNIT_PLAN_SYSTEM_PREFIX = 'run-loop:work-unit-plan:v0.3';

const LOCAL_TRUSTED_BRIEF_SNAPSHOT_REF = 'snp_ffffffffffffffffffffffffffffffff';
const LOCAL_TRUSTED_BRIEF_SNAPSHOT_AT = Date.parse('2026-07-16T08:00:00.000Z');
const LOCAL_TRUSTED_BRIEF_PRINCIPAL_REF = 'prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LOCAL_TRUSTED_BRIEF_TENANT_REF = 'ten_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const LOCAL_TRUSTED_BRIEF_INPUT_REF = 'inp_11111111111111111111111111111111';
const LOCAL_TRUSTED_BRIEF_INPUT_CONTENT = 'local frozen staged brief content.';
const LOCAL_TRUSTED_BRIEF_INPUT_DIGEST =
  'sha256:fc707c1e278ff99055315de4baf810f1809f8a11a23b6fbb4c799e73e51338ce';

const LOCAL_TRUSTED_BRIEF_SKILL_BUDGET: ResolvedSkillBudget = {
  countRenderedSkill: async () => ({ ok: true, tokens: 1 }),
  countRenderedBlock: async () => ({ ok: true, tokens: 1 }),
};

export type RunLoopProviderMode = 'fake' | 'gateway';

export type RunLoopEnv = {
  WALDO_ENV?: string;
  RUN_LOOP_PROVIDER_MODE?: string;
  RUN_LOOP_PROVIDER_LIVE?: string;
  RUN_LOOP_LOCAL_INGRESS_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_API_TOKEN?: GatewaySecretBinding;
};

export type RunLoopSafetyCallbacks = Pick<
  HookRuntimeContext,
  'rateLimitCheck' | 'hasApproval' | 'sanitise' | 'medicalGate'
>;

export type RunLoopSpendReader = {
  read(): Promise<AdapterResult<RouteSpendState>>;
};

export type RunLoopAdapters = {
  deps: Deps;
  gateway: LLMGatewayAdapter;
  sink: DeliverySink;
  spend?: RouteSpendState;
  spendReader?: RunLoopSpendReader;
  deliveryTextFallback: string;
  providerMode: RunLoopProviderMode;
  safety: RunLoopSafetyCallbacks;
  // Only the fixed fake/local fixture supplies V2 sources. Gateway mode remains absent and
  // therefore fail-closed until a durable production source owner exists.
  contextComposer?: ContextComposer;
  replayArtifacts?: V2ReplayArtifactSource;
  // A test-only handler override lets the Workerd receipt tests model a counted or
  // non-reconcilable effect without widening the production tool registry.
  trustedToolHandlers?: readonly ToolHandler<any, any, ToolDispatcherContext>[];
};

export type RunLoopTestOverrides = {
  gateway?: LLMGatewayAdapter;
  circuitBreaker?: CircuitBreaker;
  sink?: DeliverySink;
  spend?: RouteSpendState | null;
  spendReader?: RunLoopSpendReader;
  providerMode?: RunLoopProviderMode;
  deliveryTextFallback?: string;
  contextComposer?: ContextComposer;
  replayArtifacts?: V2ReplayArtifactSource;
  trustedToolHandlers?: readonly ToolHandler<any, any, ToolDispatcherContext>[];
  // Narrow local-test seam for proving receipt recovery cannot be blocked by a new
  // OnInvocationStart rate-limit check after eviction.
  rateLimitCheck?: RunLoopSafetyCallbacks['rateLimitCheck'];
};

type ResolveRunLoopAdaptersOptions = {
  deps?: Deps;
  toolOutputs?: () => Promise<readonly ContextFragment[]>;
};

export function resolveRunLoopAdapters(
  env: RunLoopEnv,
  options: ResolveRunLoopAdaptersOptions = {},
): RunLoopAdapters {
  const waldoEnv = env.WALDO_ENV;
  if (typeof waldoEnv !== 'string' || waldoEnv.length === 0) {
    throw new Error('run-loop adapter resolution requires WALDO_ENV');
  }
  const requestedMode = env.RUN_LOOP_PROVIDER_MODE ?? (isLocalLike(waldoEnv) ? 'fake' : null);
  if (requestedMode === null) {
    throw new Error('run-loop provider mode is required outside test or local');
  }
  if (requestedMode !== 'fake' && requestedMode !== 'gateway') {
    throw new Error(`unsupported run-loop provider mode: ${requestedMode}`);
  }
  if (requestedMode === 'fake') {
    assertFakeAllowed(waldoEnv);
    return {
      deps: options.deps ?? productionDeps(),
      gateway: new FakeRunLoopGateway(),
      sink: new RunLoopFakeSink(),
      deliveryTextFallback: RUN_LOOP_DELIVERY_TEXT,
      providerMode: 'fake',
      safety: localPermissiveSafety(),
      contextComposer: createLocalTrustedBriefContextComposer(options.toolOutputs),
      replayArtifacts: localTrustedBriefReplayArtifacts(),
    };
  }

  assertGatewayAllowed(env, waldoEnv);
  return {
    deps: options.deps ?? productionDeps(),
    gateway: new CloudflareAIGatewayAdapter({
      accountId: requiredEnv(env, 'CLOUDFLARE_ACCOUNT_ID'),
      gatewayId: requiredEnv(env, 'AI_GATEWAY_ID'),
      credential: requiredGatewaySecret(env),
    }),
    sink: new FailClosedSink(),
    deliveryTextFallback: RUN_LOOP_DELIVERY_TEXT,
    providerMode: 'gateway',
    spendReader: unavailableSpendReader(),
    safety: failClosedSafety(),
  };
}

export class FakeRunLoopGateway implements LLMGatewayAdapter {
  async complete(request: LLMGatewayRequest): Promise<AdapterResult<LLMResponse>> {
    return { ok: true, data: legacyFakeGatewayResponse(request) };
  }

  async executeOrReconcile(input: TrustedGatewayExecution): Promise<TrustedGatewayAdapterResult> {
    const { effect } = input;
    const prior = fakeGatewayReceipts.get(effect.idempotency_key);
    if (prior !== undefined) {
      fakeGatewayReceipts.set(effect.idempotency_key, {
        ...prior,
        attempts: prior.attempts + 1,
      });
      if (prior.request_digest !== effect.request_digest) {
        return {
          ok: false,
          code: 'invalid_args',
          error: 'trusted provider effect key reused with a different request digest',
        };
      }
      return { ok: true, data: { ...prior.response } };
    }
    if (input.operation === 'reconcile') {
      return {
        ok: false,
        code: 'transient',
        error: 'trusted provider effect receipt unavailable after reset',
        receipt_status: 'unavailable',
      };
    }
    if (fakeGatewayReceipts.size >= MAX_FAKE_GATEWAY_RECEIPTS) {
      return {
        ok: false,
        code: 'transient',
        error: 'fake_gateway_effect_receipt_capacity_exhausted',
      };
    }

    const response = Object.freeze({ ...trustedFakeGatewayResponse(input.request) });
    fakeGatewayReceipts.set(effect.idempotency_key, {
      request_digest: effect.request_digest,
      response,
      physical_calls: 1,
      attempts: 1,
    });
    return { ok: true, data: { ...response } };
  }
}

type FakeGatewayReceipt = Readonly<{
  request_digest: string;
  response: Readonly<LLMResponse>;
  physical_calls: number;
  attempts: number;
}>;

// The fake store intentionally outlives an individual DO resident instance. It is the local
// stand-in for an adapter-owned effect receipt service, not evidence that resident promise
// coalescing can provide exactly-once effects. It is bounded and refuses new work before I/O
// once full so local proof cannot hide an unbounded-memory behavior.
const MAX_FAKE_GATEWAY_RECEIPTS = 1_024;
const fakeGatewayReceipts = new Map<string, FakeGatewayReceipt>();

export function fakeGatewayStats(keys: readonly string[]): {
  receipts: number;
  physical_calls: number;
  attempts: number;
} {
  return {
    receipts: keys.filter((key) => fakeGatewayReceipts.has(key)).length,
    physical_calls: keys.reduce(
      (sum, key) => sum + (fakeGatewayReceipts.get(key)?.physical_calls ?? 0),
      0,
    ),
    attempts: keys.reduce((sum, key) => sum + (fakeGatewayReceipts.get(key)?.attempts ?? 0), 0),
  };
}

// This local-only fixture is intentionally a no-argument factory. The ingress route can select
// it, but no HTTP caller can select its authority, trigger, output disposition, snapshot, or
// source material. Its fixed identity also makes duplicate local admission deterministic.
export function localTrustedBriefScheduleInput(): Readonly<{
  admission: TrustedInvocationAdmission;
  snapshot_ref: string;
  snapshot_at: number;
}> {
  return {
    admission: {
      admission_source: 'trusted_scheduler',
      verified_authority: {
        principal_ref: LOCAL_TRUSTED_BRIEF_PRINCIPAL_REF,
        tenant_ref: LOCAL_TRUSTED_BRIEF_TENANT_REF,
        verification_ref: 'ver_cccccccccccccccccccccccccccccccc',
      },
      input_refs: [
        {
          input_ref: LOCAL_TRUSTED_BRIEF_INPUT_REF,
          content_digest: LOCAL_TRUSTED_BRIEF_INPUT_DIGEST,
        },
      ],
      intent: { kind: 'assemble_brief', variant: 'morning' },
      occurrence: {
        occurrence_ref: 'occ_dddddddddddddddddddddddddddddddd',
        occurred_at: LOCAL_TRUSTED_BRIEF_SNAPSHOT_AT - 1,
      },
      idempotency_ref: 'idem_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      accepted_at: LOCAL_TRUSTED_BRIEF_SNAPSHOT_AT,
    },
    snapshot_ref: LOCAL_TRUSTED_BRIEF_SNAPSHOT_REF,
    snapshot_at: LOCAL_TRUSTED_BRIEF_SNAPSHOT_AT,
  };
}

function createLocalTrustedBriefContextComposer(
  toolOutputs: () => Promise<readonly ContextFragment[]> = async () => [],
): ContextComposer {
  const dependencies: ContextComposerDependencies = {
    staged_inputs: {
      async resolve(request) {
        assertLocalTrustedBriefRequest(request);
        if (
          request.input_refs.length !== 1 ||
          request.input_refs[0]?.input_ref !== LOCAL_TRUSTED_BRIEF_INPUT_REF ||
          request.input_refs[0]?.content_digest !== LOCAL_TRUSTED_BRIEF_INPUT_DIGEST
        ) {
          throw new ContextSourceUnavailableError();
        }
        return {
          inputs: [
            {
              input_ref: LOCAL_TRUSTED_BRIEF_INPUT_REF,
              content_digest: LOCAL_TRUSTED_BRIEF_INPUT_DIGEST,
              principal_ref: request.principal_ref,
              tenant_ref: request.tenant_ref,
              text: LOCAL_TRUSTED_BRIEF_INPUT_CONTENT,
              source: localTrustedBriefSource('local-trusted-staged-input', {
                source_kind: 'invocation_input',
                scope: 'invocation',
              }),
            },
          ],
          snapshot: localTrustedBriefAttestation(request, 'rev_11111111111111111111111111111111'),
          source: localTrustedBriefSource('local-trusted-staged-snapshot', {
            scope: 'invocation',
          }),
        };
      },
    },
    materials: {
      async load(request) {
        assertLocalTrustedBriefRequest(request);
        return {
          principal_ref: request.principal_ref,
          tenant_ref: request.tenant_ref,
          snapshot: localTrustedBriefAttestation(request, 'rev_22222222222222222222222222222222'),
          identity: localTrustedBriefFragment(
            'A local trusted scheduled brief is due.',
            'local-trusted-identity',
            { scope: 'principal' },
          ),
          trigger_behaviour: localTrustedBriefFragment(
            'Summarise only verified bounded information.',
            'local-trusted-trigger',
          ),
          zone_modifier: localTrustedBriefFragment('Keep the tone practical.', 'local-trusted-zone'),
          mode_template: localTrustedBriefFragment('Produce a concise brief.', 'local-trusted-template'),
          soul_base: localTrustedBriefFragment('Be warm and direct.', 'local-trusted-soul'),
          safety_rules: localTrustedBriefFragment(
            'Never expose private source content.',
            'local-trusted-safeguards',
          ),
          health: null,
          workspace: [],
          tool_outputs: await toolOutputs(),
        };
      },
    },
    owner_binding: {
      async bind(request) {
        assertLocalTrustedBriefRequest(request);
        return {
          principal_ref: request.principal_ref,
          tenant_ref: request.tenant_ref,
          local_user_ref: 'local-trusted-brief-owner',
          snapshot: localTrustedBriefAttestation(request, 'rev_33333333333333333333333333333333'),
          source: localTrustedBriefSource('local-trusted-owner', { scope: 'principal' }),
        };
      },
    },
    system_skills: {
      async list(request) {
        assertLocalTrustedBriefSnapshot(request);
        return {
          rows: [],
          snapshot: localTrustedBriefAttestation(request, 'rev_44444444444444444444444444444444'),
          source: localTrustedBriefSource('local-trusted-system-skills'),
        };
      },
    },
    system_skill_state: {
      async load(request) {
        assertLocalTrustedBriefRequest(request);
        return {
          principal_ref: request.principal_ref,
          tenant_ref: request.tenant_ref,
          snapshot: localTrustedBriefAttestation(request, 'rev_55555555555555555555555555555555'),
          source: localTrustedBriefSource('local-trusted-skill-state', { scope: 'principal' }),
          connected_connectors: [],
          dismissed_today: [],
          provisional_reverted: [],
          identity_drift: [],
          priority_pinned: [],
        };
      },
    },
    skill_budget: LOCAL_TRUSTED_BRIEF_SKILL_BUDGET,
    recall: {
      async recall(request) {
        assertLocalTrustedBriefRequest({
          principal_ref: request.owner.principal_ref,
          tenant_ref: request.owner.tenant_ref,
          snapshot_ref: request.snapshot_ref,
          snapshot_at: request.snapshot_at,
        });
        return {
          principal_ref: request.owner.principal_ref,
          tenant_ref: request.owner.tenant_ref,
          snapshot: localTrustedBriefAttestation(request, 'rev_66666666666666666666666666666666'),
          status: 'failed' as const,
          result: recallResultSchema.parse({
            memory_hits: [],
            episode_hits: [],
            evolution_hits: [],
            query_used: 'local frozen recall unavailable',
            duration_ms: 0,
          }),
          source: null,
          capability: 'owner_bound_local_temporal_snapshot' as const,
        };
      },
    },
  };
  return createContextComposer(dependencies);
}

function localTrustedBriefReplayArtifacts(): V2ReplayArtifactSource {
  return {
    async resolvePlan(input) {
      assertLocalTrustedBriefSnapshot(input);
      if (input.iteration === 1) {
        return [{ id: 'call-get-crs-first', name: 'get_crs', args: { range_days: 1 } }];
      }
      if (input.iteration === 2) {
        return [{ id: 'call-get-crs-second', name: 'get_crs', args: { range_days: 2 } }];
      }
      throw new Error('local trusted replay plan is unavailable');
    },
    async resolveToolResult(input) {
      assertLocalTrustedBriefSnapshot(input);
      return {
        ok: true,
        tool: 'get_crs',
        data: { summary: 'derived steady', body_state: 'steady' },
        card: null,
        source_taint: null,
      };
    },
    async resolveSynthesis(input) {
      assertLocalTrustedBriefSnapshot(input);
      return RUN_LOOP_DELIVERY_TEXT;
    },
  };
}

function legacyFakeGatewayResponse(request: LLMGatewayRequest): LLMResponse {
  if ((request.request.system ?? '').startsWith(RUN_LOOP_OBSERVE_SYSTEM_PREFIX)) {
    return fakeGatewaySynthesisResponse(request);
  }
  return fakeGatewayToolPlanResponse(request, 'call-get-crs', 1);
}

function trustedFakeGatewayResponse(request: LLMGatewayRequest): LLMResponse {
  if ((request.request.system ?? '').startsWith(RUN_LOOP_WORK_UNIT_PLAN_SYSTEM_PREFIX)) {
    return fakeWorkUnitCandidatePlanResponse(request);
  }
  if (!(request.request.system ?? '').startsWith(RUN_LOOP_OBSERVE_SYSTEM_PREFIX)) {
    return fakeGatewayToolPlanResponse(request, 'call-get-crs-first', 1);
  }
  return trustedObserveToolResultCount(request) === 1
    ? fakeGatewayToolPlanResponse(request, 'call-get-crs-second', 2)
    : fakeGatewaySynthesisResponse(request);
}

function fakeWorkUnitCandidatePlanResponse(request: LLMGatewayRequest): LLMResponse {
  return {
    model: request.request.model,
    text: JSON.stringify({
      summary: 'Prepare a reviewable product update plan without publishing it.',
      proposedSteps: [
        'Review the supplied release context and identify the user-visible changes.',
        'Draft the update structure with claims tied to reviewable source material.',
        'Run an internal accuracy review and present the draft for explicit approval.',
      ],
      openQuestions: ['Which audience should the final update prioritize?'],
      constraints: ['Do not publish or perform any external effect.', 'Return a candidate plan only.'],
    }),
    input_tokens: 48,
    output_tokens: 96,
    cache_read_input_tokens: 0,
    latency_ms: 1,
  };
}

function fakeGatewayToolPlanResponse(
  request: LLMGatewayRequest,
  id: string,
  rangeDays: number,
): LLMResponse {
  return {
    model: request.request.model,
    text: JSON.stringify({
      tool_calls: [{ id, name: 'get_crs', arguments: { range_days: rangeDays } }],
    }),
    input_tokens: 24,
    output_tokens: 12,
    cache_read_input_tokens: 0,
    latency_ms: 1,
  };
}

function fakeGatewaySynthesisResponse(request: LLMGatewayRequest): LLMResponse {
  return {
    model: request.request.model,
    text: RUN_LOOP_DELIVERY_TEXT,
    input_tokens: 16,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    latency_ms: 1,
  };
}

function trustedObserveToolResultCount(request: LLMGatewayRequest): number | null {
  const content = request.request.messages[0]?.content;
  if (typeof content !== 'string') return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>).prompt !== 'string' ||
      !Array.isArray((parsed as Record<string, unknown>).tool_results)
    ) {
      return null;
    }
    return (parsed as { tool_results: unknown[] }).tool_results.length;
  } catch {
    return null;
  }
}

function localTrustedBriefSource(
  source_key: string,
  overrides: Partial<ContextSource> = {},
): ContextSource {
  return {
    source_key,
    source_kind: 'runtime_metadata',
    scope: 'system',
    source_taint: null,
    produced_at: LOCAL_TRUSTED_BRIEF_SNAPSHOT_AT,
    ...overrides,
  };
}

function localTrustedBriefFragment(
  text: string,
  sourceKey: string,
  sourceOverrides: Partial<ContextSource> = {},
): Readonly<{ text: string; source: ContextSource }> {
  return { text, source: localTrustedBriefSource(sourceKey, sourceOverrides) };
}

function localTrustedBriefAttestation(
  request: Readonly<{ snapshot_ref: string; snapshot_at: number }>,
  revision_ref: string,
): Readonly<{ snapshot_ref: string; snapshot_at: number; revision_ref: string }> {
  assertLocalTrustedBriefSnapshot(request);
  return { snapshot_ref: request.snapshot_ref, snapshot_at: request.snapshot_at, revision_ref };
}

function assertLocalTrustedBriefRequest(
  request: Readonly<{
    principal_ref: string;
    tenant_ref: string;
    snapshot_ref: string;
    snapshot_at: number;
  }>,
): void {
  if (
    request.principal_ref !== LOCAL_TRUSTED_BRIEF_PRINCIPAL_REF ||
    request.tenant_ref !== LOCAL_TRUSTED_BRIEF_TENANT_REF
  ) {
    throw new ContextSourceUnavailableError();
  }
  assertLocalTrustedBriefSnapshot(request);
}

function assertLocalTrustedBriefSnapshot(
  request: Readonly<{ snapshot_ref: string; snapshot_at: number }>,
): void {
  if (
    request.snapshot_ref !== LOCAL_TRUSTED_BRIEF_SNAPSHOT_REF ||
    request.snapshot_at !== LOCAL_TRUSTED_BRIEF_SNAPSHOT_AT
  ) {
    throw new ContextSourceUnavailableError();
  }
}

const runLoopAcks = new Map<string, SinkAck>();
const runLoopAttempts = new Map<string, number>();

export class RunLoopFakeSink implements DeliverySink {
  readonly idempotentOnKey = true;

  send(req: SinkRequest): SinkAck {
    runLoopAttempts.set(req.idempotency_key, (runLoopAttempts.get(req.idempotency_key) ?? 0) + 1);
    const prior = runLoopAcks.get(req.idempotency_key);
    if (prior !== undefined) return prior;
    const ack: SinkAck = { idempotency_key: req.idempotency_key, accepted: true };
    runLoopAcks.set(req.idempotency_key, ack);
    return ack;
  }
}

export function fakeSinkStats(keys: readonly string[]): { deliveries: number; attempts: number } {
  return {
    deliveries: keys.filter((key) => runLoopAcks.has(key)).length,
    attempts: keys.reduce((sum, key) => sum + (runLoopAttempts.get(key) ?? 0), 0),
  };
}

class FailClosedSink implements DeliverySink {
  readonly idempotentOnKey = true;

  send(_req: SinkRequest): SinkAck {
    throw new Error('run-loop live sink unconfigured');
  }
}

function assertFakeAllowed(waldoEnv: string): void {
  if (!isLocalLike(waldoEnv)) {
    throw new Error('fake run-loop adapters are only allowed in test or local');
  }
}

function assertGatewayAllowed(env: RunLoopEnv, waldoEnv: string): void {
  if (waldoEnv !== 'staging') {
    throw new Error('gateway run-loop provider mode is staging-only');
  }
  if (env.RUN_LOOP_PROVIDER_LIVE !== '1') {
    throw new Error('gateway run-loop provider mode requires RUN_LOOP_PROVIDER_LIVE=1');
  }
  requiredEnv(env, 'CLOUDFLARE_ACCOUNT_ID');
  requiredEnv(env, 'AI_GATEWAY_ID');
  requiredGatewaySecret(env);
}

function requiredEnv(
  env: RunLoopEnv,
  key: 'CLOUDFLARE_ACCOUNT_ID' | 'AI_GATEWAY_ID',
): string {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`gateway run-loop provider mode requires ${key}`);
  }
  return value;
}

export function isLocalRunLoopEnvironment(value: unknown): value is 'test' | 'local' {
  return value === 'test' || value === 'local';
}

function isLocalLike(value: string): boolean {
  return isLocalRunLoopEnvironment(value);
}

function requiredGatewaySecret(env: RunLoopEnv): GatewaySecretBinding {
  const value = env.AI_GATEWAY_API_TOKEN;
  if (!isGatewaySecretBinding(value)) {
    throw new Error('gateway run-loop provider mode requires AI_GATEWAY_API_TOKEN secret binding');
  }
  return value;
}

function isGatewaySecretBinding(value: unknown): value is GatewaySecretBinding {
  const candidate = value as { get?: unknown } | null;
  return candidate !== null && typeof candidate === 'object' && typeof candidate.get === 'function';
}

function unavailableSpendReader(): RunLoopSpendReader {
  return {
    read: async () => ({
      ok: false,
      code: 'transient',
      error: 'spend_state_unavailable',
    }),
  };
}

function localPermissiveSafety(): RunLoopSafetyCallbacks {
  return {
    rateLimitCheck: () => true,
    hasApproval: () => true,
    sanitise,
    medicalGate: evaluateMedicalClaim,
  };
}

function failClosedSafety(): RunLoopSafetyCallbacks {
  return {
    rateLimitCheck: () => ({ ok: false, reason: 'rate limit check unconfigured', code: 'transient' }),
    hasApproval: () => false,
    sanitise,
    medicalGate: evaluateMedicalClaim,
  };
}
