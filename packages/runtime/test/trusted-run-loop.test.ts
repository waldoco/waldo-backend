import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import {
  recallResultSchema,
  ROSTER,
  TOOL_PERMISSIONS,
  getCrsArgsSchema,
  type LLMResponse,
  type ToolHandler,
  type TriggerType,
  type RuntimeContextCheckpoint,
  type RuntimeToolCheckpoint,
  type TrustedToolExecutionResult,
  type TrustedInvocationAdmission,
} from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import {
  createContextComposer,
  type ContextComposer,
  type ContextComposerDependencies,
  type ContextSource,
} from '../src/context-composer';
import type {
  CircuitBreaker,
  LLMGatewayAdapter,
  LLMGatewayRequest,
  TrustedGatewayExecution,
  TrustedProviderEffect,
} from '../src/llm/provider';
import type { ResolvedSkillBudget } from '../src/skills/budget';

const SNAPSHOT_AT = Date.parse('2026-07-16T08:00:00.000Z');
const PRIVATE_STAGED_INPUT = 'private-staged-brief-payload-must-not-persist';
const PRIVATE_RECALL = 'private-recall-payload-must-not-persist';
const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'] as const;
const LOCAL_RUN_TOKEN = (env as unknown as { RUN_LOOP_LOCAL_INGRESS_TOKEN: string })
  .RUN_LOOP_LOCAL_INGRESS_TOKEN;
const THROW_AFTER_RECEIPT_LATENCY_SENTINEL = 77_777;

type TrustedRunLoopProof = {
  fsm: string[];
  trace: { event: string; detail: Record<string, unknown> }[];
  outbox: { kind: string; status: string; attempts: number }[];
  sink: { deliveries: number; attempts: number };
  delivery_journal: { state: string; verdict: string | null };
  current: { state: string; failure_reason: string | null };
  v2: {
    canonical_identity_hash: string;
    snapshot: { snapshot_ref: string; snapshot_at: number };
    invocation: {
      admission_source: string;
      output: { disposition: string };
      runtime_binding: { trigger: string; variant: string | null };
    };
    context: RuntimeContextCheckpoint;
    tool_checkpoints: RuntimeToolCheckpoint[];
    evidence: {
      prompt_digest: string;
      tool_acl: string[];
      provider_calls: number;
      total_tokens: number;
    };
  };
};

type TrustedRunLoopStub = DurableObjectStub & {
  __runLoopScheduleTrustedRunForTest(input: {
    admission: TrustedInvocationAdmission;
    snapshot_ref: string;
    snapshot_at: number;
  }): Promise<string>;
  readTrustedRunProof(runId: string): Promise<TrustedRunLoopProof>;
  readRunProof(runId: string): Promise<{
    fsm: string[];
    trace: { event: string; detail: Record<string, unknown> }[];
    outbox: { kind: string; status: string; attempts: number }[];
    sink: { deliveries: number; attempts: number };
    delivery_journal: { state: string; verdict: string | null };
    current: { state: string; failure_reason: string | null };
  }>;
  readRunEvidence(runId: string): Promise<{
    evidence_flavor: 'historical_v1' | 'trusted_v2';
    eval: { result: string };
  }>;
};

type V2ReplayArtifacts = {
  resolvePlan(input: Readonly<{
    iteration: number;
    plan_ref: string;
    plan_digest: string;
    snapshot_ref: string;
    snapshot_at: number;
  }>): Promise<unknown>;
  resolveToolResult(input: Readonly<{
    result_ref: string;
    result_hash: string;
    snapshot_ref: string;
    snapshot_at: number;
  }>): Promise<unknown>;
  resolveSynthesis(input: Readonly<{
    result_ref: string;
    result_digest: string;
    snapshot_ref: string;
    snapshot_at: number;
  }>): Promise<unknown>;
};

type TestRunLoopInstance = {
  __runLoopCrashAfter?: string;
  __runLoopOutboxCrashPoint?: 'post_ack_pre_return';
  __runLoopCrashAfterTrustedAdmission?: boolean;
  __runLoopCrashAfterTrustedGateCommit?: boolean;
  __runLoopCrashAfterTrustedGateTerminal?: boolean;
  __runLoopCrashAfterTrustedGovernorDeny?: boolean;
  __runLoopCrashAfterTrustedProviderEffect?: 'provider_plan' | 'provider_observe';
  __runLoopCrashAfterTrustedToolEffect?: boolean;
  __runLoopCrashAfterTrustedToolCheckpoint?: boolean;
  __runLoopCrashAfterTrustedSynthesisReceipt?: boolean;
  __runLoopSetKillFlag(input: {
    scope: 'global' | 'loop';
    loopType: 'brief' | null;
    active: boolean;
  }): void;
  __runLoopSetTestOverrides(input: {
    gateway?: LLMGatewayAdapter;
    providerMode?: 'fake' | 'gateway';
    contextComposer?: ContextComposer;
    replayArtifacts?: V2ReplayArtifacts;
    trustedToolHandlers?: readonly ToolHandler<any, any, any>[];
    circuitBreaker?: CircuitBreaker;
    rateLimitCheck?: (input: {
      event: 'OnInvocationStart';
      trigger: TriggerType;
      tool?: never;
    }) => Promise<{ ok: true } | { ok: false; reason: string; code?: 'rate_limited' | 'transient' }>;
  }): void;
  __runLoopOpenTrustedRunForTest(input: {
    admission: TrustedInvocationAdmission;
    snapshot_ref: string;
    snapshot_at: number;
  }): Promise<string>;
  __runLoopDriveRunForTest(runId: string): Promise<void>;
  __runLoopAuditTrustedV2ForTest(): void;
  readRunEvidence(runId: string): Promise<unknown>;
  readRunProof(runId: string): Promise<unknown>;
  readTrustedRunProof(runId: string): Promise<unknown>;
  replayFixture(runId: string): Promise<unknown>;
  scoreRun(traceId: string): Promise<unknown>;
  alarm(): Promise<void>;
};

let sequence = 0;

function freshStub(): TrustedRunLoopStub {
  sequence += 1;
  const namespace = (env as unknown as { RUN_LOOP_DO: DurableObjectNamespace }).RUN_LOOP_DO;
  return namespace.get(namespace.idFromName(`trusted-run-loop-${sequence}`)) as TrustedRunLoopStub;
}

async function withNonLocalRunLoopEnvironment<T>(
  instance: object,
  operation: () => Promise<T>,
): Promise<T> {
  const bindings = Reflect.get(instance, 'envBindings');
  if (bindings === null || typeof bindings !== 'object') {
    throw new Error('test setup: run-loop bindings unavailable');
  }
  const nonLocalBindings = { ...bindings, WALDO_ENV: 'production' };
  if (!Reflect.set(instance, 'envBindings', nonLocalBindings)) {
    throw new Error('test setup: unable to set non-local run-loop bindings');
  }
  try {
    return await operation();
  } finally {
    if (!Reflect.set(instance, 'envBindings', bindings)) {
      throw new Error('test cleanup: unable to restore run-loop bindings');
    }
  }
}

function source(source_key: string, overrides: Partial<ContextSource> = {}): ContextSource {
  return {
    source_key,
    source_kind: 'runtime_metadata',
    scope: 'system',
    source_taint: null,
    produced_at: SNAPSHOT_AT,
    ...overrides,
  };
}

function attestation(
  request: Readonly<{ snapshot_ref: string; snapshot_at: number }>,
  revision_ref: string,
) {
  return { snapshot_ref: request.snapshot_ref, snapshot_at: request.snapshot_at, revision_ref };
}

const skillBudget: ResolvedSkillBudget = {
  countRenderedSkill: async () => ({ ok: true as const, tokens: 1 }),
  countRenderedBlock: async () => ({ ok: true as const, tokens: 1 }),
};

function frozenComposer(): { composer: ContextComposer; calls: () => number } {
  let calls = 0;
  const dependencies: ContextComposerDependencies = {
    staged_inputs: {
      async resolve(request) {
        return {
          inputs: [
            {
              input_ref: 'inp_11111111111111111111111111111111',
              content_digest:
                'sha256:43a30b1513a3b5761dc1c6a3540e421ff9714717bfda00c71d3432d7736c3f4e',
              principal_ref: request.principal_ref,
              tenant_ref: request.tenant_ref,
              text: PRIVATE_STAGED_INPUT,
              source: source('trusted-staged-input', {
                source_kind: 'invocation_input',
                scope: 'invocation',
              }),
            },
          ],
          snapshot: attestation(request, 'rev_11111111111111111111111111111111'),
          source: source('trusted-staged-snapshot', {
            source_kind: 'runtime_metadata',
            scope: 'invocation',
          }),
        };
      },
    },
    materials: {
      async load(request) {
        return {
          principal_ref: request.principal_ref,
          tenant_ref: request.tenant_ref,
          snapshot: attestation(request, 'rev_22222222222222222222222222222222'),
          identity: {
            text: 'A trusted scheduled brief is due.',
            source: source('trusted-identity', { scope: 'principal' }),
          },
          trigger_behaviour: {
            text: 'Summarise only verified, bounded information.',
            source: source('trusted-trigger'),
          },
          zone_modifier: {
            text: 'Keep the tone practical.',
            source: source('trusted-zone'),
          },
          mode_template: {
            text: 'Produce a concise brief.',
            source: source('trusted-template'),
          },
          soul_base: {
            text: 'Be warm and direct.',
            source: source('trusted-soul'),
          },
          safety_rules: {
            text: 'Never expose private source content.',
            source: source('trusted-safeguards'),
          },
          health: null,
          workspace: [],
        };
      },
    },
    owner_binding: {
      async bind(request) {
        return {
          principal_ref: request.principal_ref,
          tenant_ref: request.tenant_ref,
          local_user_ref: 'local-trusted-brief-owner',
          snapshot: attestation(request, 'rev_33333333333333333333333333333333'),
          source: source('trusted-owner', { scope: 'principal' }),
        };
      },
    },
    system_skills: {
      async list(request) {
        return {
          rows: [],
          snapshot: attestation(request, 'rev_44444444444444444444444444444444'),
          source: source('trusted-system-skills'),
        };
      },
    },
    system_skill_state: {
      async load(request) {
        return {
          principal_ref: request.principal_ref,
          tenant_ref: request.tenant_ref,
          snapshot: attestation(request, 'rev_55555555555555555555555555555555'),
          source: source('trusted-skill-state', { scope: 'principal' }),
          connected_connectors: [],
          dismissed_today: [],
          provisional_reverted: [],
          identity_drift: [],
          priority_pinned: [],
        };
      },
    },
    skill_budget: skillBudget,
    recall: {
      async recall(request) {
        return {
          principal_ref: request.owner.principal_ref,
          tenant_ref: request.owner.tenant_ref,
          snapshot: attestation(request, 'rev_66666666666666666666666666666666'),
          status: 'partial' as const,
          result: recallResultSchema.parse({
            memory_hits: [
              {
                hall_type: 'preferences',
                content: PRIVATE_RECALL,
                confidence: 0.9,
                valid_from: '2026-07-15T00:00:00.000Z',
                source_trust: 'user_stated',
              },
            ],
            episode_hits: [],
            evolution_hits: [],
            query_used: 'trusted scheduled brief',
            duration_ms: 1,
          }),
          source: source('trusted-recall', { source_kind: 'recall', scope: 'principal' }),
          capability: 'owner_bound_local_temporal_snapshot' as const,
        };
      },
    },
  };
  const base = createContextComposer(dependencies);
  return {
    composer: {
      async compose(invocation, inputs) {
        calls += 1;
        return base.compose(invocation, inputs);
      },
    },
    calls: () => calls,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function oversizedSynthesisComposer(): ContextComposer {
  const base = frozenComposer().composer;
  const prompt = '😀'.repeat(8_192);
  return {
    async compose(invocation, inputs) {
      const composed = await base.compose(invocation, inputs);
      if (!composed.ok) return composed;
      return {
        ...composed,
        prompt,
        evidence: {
          ...composed.evidence,
          prompt_digest: `sha256:${await sha256Hex(prompt)}`,
        },
      };
    },
  };
}

function stableJsonStringifyForTest(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringifyForTest(entry)).join(',')}]`;
  }
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringifyForTest(entry)}`)
    .join(',')}}`;
}

function hostileCheckpointComposer(hostile: unknown): ContextComposer {
  const base = frozenComposer().composer;
  return {
    async compose(invocation, inputs) {
      const composed = await base.compose(invocation, inputs);
      if (!composed.ok) return composed;
      return {
        ...composed,
        checkpoint: {
          ...composed.checkpoint,
          hostile,
        },
      } as unknown as typeof composed;
    },
  };
}

function uniqueBinaryTree(depth: number): unknown {
  if (depth === 0) return null;
  return {
    left: uniqueBinaryTree(depth - 1),
    right: uniqueBinaryTree(depth - 1),
  };
}

function sharedDag(): unknown {
  const shared = { marker: 'private-shared-dag-checkpoint-canary' };
  return { left: shared, right: shared };
}

class ScriptedGateway implements LLMGatewayAdapter {
  readonly requests: LLMGatewayRequest[] = [];
  readonly operations: Array<TrustedProviderEffect['operation']> = [];
  private reconciliationCount = 0;
  private readonly receipts = new Map<
    string,
    Readonly<{ request_digest: string; response: LLMResponse }>
  >();
  constructor(private readonly responses: readonly LLMResponse[]) {}

  async complete(request: LLMGatewayRequest) {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined) throw new Error('unexpected provider call');
    return { ok: true as const, data: response };
  }

  async executeOrReconcile(input: TrustedGatewayExecution) {
    const { effect } = input;
    this.operations.push(input.operation);
    if (input.operation === 'reconcile') {
      this.reconciliationCount += 1;
      if ('request' in input || !('execution_witness' in input)) {
        throw new Error('trusted provider recovery received a fresh request');
      }
    }
    const prior = this.receipts.get(effect.idempotency_key);
    if (prior !== undefined) {
      return prior.request_digest === effect.request_digest
        ? { ok: true as const, data: prior.response }
        : { ok: false as const, error: 'trusted effect request mismatch', code: 'invalid_args' as const };
    }
    if (input.operation === 'reconcile') {
      return {
        ok: false as const,
        error: 'trusted provider effect receipt unavailable after reset',
        code: 'transient' as const,
        receipt_status: 'unavailable' as const,
      };
    }
    const result = await this.complete(input.request);
    if (result.ok) {
      this.receipts.set(effect.idempotency_key, {
        request_digest: effect.request_digest,
        response: result.data,
      });
      // A test-only adapter fault after it has retained its keyed receipt. The response remains
      // otherwise valid so RunLoopDO must leave its intent pending rather than terminalising it.
      if (
        effect.operation === 'issue' &&
        result.data.latency_ms === 77_777
      ) {
        throw new Error('trusted provider reconciler storage sentinel');
      }
    }
    return result;
  }

  clearReceipts(): void {
    this.receipts.clear();
  }

  reconciliations(): number {
    return this.reconciliationCount;
  }
}

class DeferredFirstGateway implements LLMGatewayAdapter {
  readonly requests: LLMGatewayRequest[] = [];
  private reconciliationCount = 0;
  private readonly receipts = new Map<
    string,
    Readonly<{ request_digest: string; response: LLMResponse }>
  >();
  private readonly firstRequestEntered: Promise<void>;
  private readonly firstRequestReleased: Promise<void>;
  private resolveFirstRequestEntered!: () => void;
  private resolveFirstRequestReleased!: () => void;

  constructor(private readonly responses: readonly LLMResponse[]) {
    this.firstRequestEntered = new Promise((resolve) => {
      this.resolveFirstRequestEntered = resolve;
    });
    this.firstRequestReleased = new Promise((resolve) => {
      this.resolveFirstRequestReleased = resolve;
    });
  }

  async complete(request: LLMGatewayRequest) {
    this.requests.push(request);
    const index = this.requests.length - 1;
    if (index === 0) {
      this.resolveFirstRequestEntered();
      await this.firstRequestReleased;
    }
    const response = this.responses[index];
    if (response === undefined) throw new Error('unexpected provider call');
    return { ok: true as const, data: response };
  }

  async executeOrReconcile(input: TrustedGatewayExecution) {
    const { effect } = input;
    if (input.operation === 'reconcile') {
      this.reconciliationCount += 1;
      if ('request' in input || !('execution_witness' in input)) {
        throw new Error('trusted provider recovery received a fresh request');
      }
    }
    const prior = this.receipts.get(effect.idempotency_key);
    if (prior !== undefined) {
      return prior.request_digest === effect.request_digest
        ? { ok: true as const, data: prior.response }
        : { ok: false as const, error: 'trusted effect request mismatch', code: 'invalid_args' as const };
    }
    if (input.operation === 'reconcile') {
      return {
        ok: false as const,
        error: 'trusted provider effect receipt unavailable after reset',
        code: 'transient' as const,
        receipt_status: 'unavailable' as const,
      };
    }
    const result = await this.complete(input.request);
    if (result.ok) {
      this.receipts.set(effect.idempotency_key, {
        request_digest: effect.request_digest,
        response: result.data,
      });
    }
    return result;
  }

  async waitForFirstRequest(): Promise<void> {
    await this.firstRequestEntered;
  }

  releaseFirstRequest(): void {
    this.resolveFirstRequestReleased();
  }

  reconciliations(): number {
    return this.reconciliationCount;
  }
}

function response(model: LLMResponse['model'], text: string): LLMResponse {
  return {
    model,
    text,
    input_tokens: 20,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    latency_ms: 1,
  };
}

function toolCall(id: string, rangeDays: number): string {
  return toolCalls([{ id, rangeDays }]);
}

function toolCalls(calls: readonly { id: string; rangeDays: number }[]): string {
  return JSON.stringify({
    tool_calls: calls.map(({ id, rangeDays }) => ({
      id,
      name: 'get_crs',
      arguments: { range_days: rangeDays },
    })),
  });
}

function countingReconciledGetCrsHandler(options: {
  rejectedError?: string;
  onReconcile?: () => void;
} = {}): {
  handler: ToolHandler<any, any, any>;
  physicalCalls: () => number;
  reconciliations: () => number;
  clearReceipts: () => void;
} {
  let physical = 0;
  let reconciliations = 0;
  const receipts = new Map<
    string,
    Readonly<{ request_digest: string; result: TrustedToolExecutionResult<any> }>
  >();
  const handler: ToolHandler<any, any, any> = {
    name: 'get_crs',
    description: 'Counted trusted-tool receipt fixture.',
    schema: getCrsArgsSchema,
    trigger_allowlist: (Object.keys(TOOL_PERMISSIONS) as TriggerType[]).filter((trigger) =>
      TOOL_PERMISSIONS[trigger].includes('get_crs'),
    ),
    autonomy_gated: false,
    idempotentOnKey: true,
    async handle() {
      throw new Error('trusted dispatch must use executeOrReconcile');
    },
    async executeOrReconcile(_args, _ctx, effect) {
      const prior = receipts.get(effect.idempotency_key);
      if (prior !== undefined) {
        return prior.request_digest === effect.request_digest
          ? prior.result
          : { ok: false as const, error: 'trusted tool effect request mismatch', code: 'invalid_args' as const };
      }
      if (effect.operation === 'reconcile') {
        return {
          ok: false as const,
          error: 'trusted tool effect receipt unavailable after reset',
          code: 'transient' as const,
          receipt_status: 'unavailable' as const,
        };
      }
      physical += 1;
      const result: TrustedToolExecutionResult<any> =
        options.rejectedError === undefined
          ? {
              ok: true as const,
              // Match the frozen replay artifact exactly: the receipt protocol verifies a physical
              // tool result against the runtime-owned replay witness after the checkpoint commits.
              data: { summary: 'derived steady', body_state: 'steady' },
              source_taint: null,
            }
          : {
              ok: false as const,
              error: options.rejectedError,
              code: 'forbidden' as const,
            };
      receipts.set(effect.idempotency_key, { request_digest: effect.request_digest, result });
      return result;
    },
    async reconcileTrustedEffect(...args) {
      if (args.length !== 1) {
        throw new Error('trusted tool recovery received arguments or invocation context');
      }
      const [effect] = args;
      reconciliations += 1;
      options.onReconcile?.();
      const prior = receipts.get(effect.idempotency_key);
      if (prior === undefined) {
        return {
          ok: false as const,
          error: 'trusted tool effect receipt unavailable after reset',
          code: 'transient' as const,
          receipt_status: 'unavailable' as const,
        };
      }
      return prior.request_digest === effect.request_digest
        ? prior.result
        : { ok: false as const, error: 'trusted tool effect request mismatch', code: 'invalid_args' as const };
    },
  };
  return {
    handler,
    physicalCalls: () => physical,
    reconciliations: () => reconciliations,
    clearReceipts: () => receipts.clear(),
  };
}

function trustedScheduledAdmission(): TrustedInvocationAdmission {
  return {
    admission_source: 'trusted_scheduler',
    verified_authority: {
      principal_ref: 'prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      tenant_ref: 'ten_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      verification_ref: 'ver_cccccccccccccccccccccccccccccccc',
    },
    input_refs: [
      {
        input_ref: 'inp_11111111111111111111111111111111',
      content_digest: 'sha256:43a30b1513a3b5761dc1c6a3540e421ff9714717bfda00c71d3432d7736c3f4e',
      },
    ],
    intent: { kind: 'assemble_brief', variant: 'morning' },
    occurrence: {
      occurrence_ref: 'occ_dddddddddddddddddddddddddddddddd',
      occurred_at: SNAPSHOT_AT - 1,
    },
    idempotency_ref: 'idem_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    accepted_at: SNAPSHOT_AT,
  };
}

function trustedInternalAdmission(): TrustedInvocationAdmission {
  return {
    ...trustedScheduledAdmission(),
    admission_source: 'trusted_internal',
    intent: { kind: 'run_patrol' },
    idempotency_ref: 'idem_ffffffffffffffffffffffffffffffff',
  };
}

function solicitedAdmission(): TrustedInvocationAdmission {
  return {
    ...trustedScheduledAdmission(),
    admission_source: 'authenticated_ingress',
    intent: { kind: 'respond_to_user' },
    idempotency_ref: 'idem_99999999999999999999999999999999',
  };
}

function trustedInput(admission: TrustedInvocationAdmission) {
  return {
    admission,
    snapshot_ref: 'snp_ffffffffffffffffffffffffffffffff',
    snapshot_at: SNAPSHOT_AT,
  };
}

function replayArtifacts(): V2ReplayArtifacts {
  return {
    async resolvePlan(input) {
      if (input.iteration === 1) {
        return [{ id: 'call-v2-first', name: 'get_crs', args: { range_days: 1 } }];
      }
      if (input.iteration === 2) {
        return [{ id: 'call-v2-second', name: 'get_crs', args: { range_days: 2 } }];
      }
      throw new Error('unknown trusted V2 plan receipt');
    },
    async resolveToolResult() {
      return {
        ok: true,
        tool: 'get_crs',
        data: { summary: 'derived steady', body_state: 'steady' },
        card: null,
        source_taint: null,
      };
    },
    async resolveSynthesis() {
      return 'safe ephemeral synthesis';
    },
  };
}

describe('RunLoopDO trusted invocation convergence', () => {
  it('runs a trusted scheduled brief through V2 provenance, two governed tools, and the existing outbox', async () => {
    const stub = freshStub();
    const composer = frozenComposer();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);

    const runId = await stub.__runLoopScheduleTrustedRunForTest({
      admission: trustedScheduledAdmission(),
      snapshot_ref: 'snp_ffffffffffffffffffffffffffffffff',
      snapshot_at: SNAPSHOT_AT,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as TestRunLoopInstance).__runLoopSetTestOverrides({
        gateway,
        contextComposer: composer.composer,
        replayArtifacts: replayArtifacts(),
      });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.fsm).toEqual([
      'PENDING',
      'CONTEXT_BUILT',
      'LLM_CALLED',
      'TOOLS_DONE',
      'LLM_CALLED',
      'TOOLS_DONE',
      'GATED',
      'DELIVERED',
      'DONE',
    ]);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.v2.invocation).toMatchObject({
      admission_source: 'trusted_scheduler',
      output: { disposition: 'proactive_delivery' },
      runtime_binding: { trigger: 'brief', variant: 'morning' },
    });
    expect(proof.v2.snapshot).toEqual({
      snapshot_ref: 'snp_ffffffffffffffffffffffffffffffff',
      snapshot_at: SNAPSHOT_AT,
    });
    expect(proof.v2.canonical_identity_hash).toBe(
      'd1293702ce01ad4145ee21497acf6a4dc3d3444ea3cdc8f17646f6f44b5cbcab',
    );
    expect(proof.v2.context).toMatchObject({
      context_version: 2,
      principal_ref: 'prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      tenant_ref: 'ten_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      invocation_idempotency_ref: 'idem_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      sanitisation: 'passed',
    });
    expect(proof.v2.context.sources.length).toBeGreaterThan(0);
    expect(proof.v2.tool_checkpoints).toHaveLength(2);
    expect(proof.v2.tool_checkpoints.every((checkpoint) => checkpoint.status === 'completed')).toBe(true);
    expect(proof.v2.evidence.tool_acl).toEqual(TOOL_PERMISSIONS.brief);
    expect(proof.trace.map((event) => event.event)).toEqual([
      'scheduled_wake',
      'governor_admitted',
      'session_reset',
      'context_built',
      'llm_called',
      'tool_dispatched',
      'llm_observed',
      'tool_dispatched',
      'llm_observed',
      'gated',
      'delivered',
      'done',
    ]);
    expect(proof.trace.find((event) => event.event === 'context_built')?.detail).toMatchObject({
      source: 'context-composer-v2',
      context_ref: proof.v2.context.context_ref,
    });
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
    expect(proof.delivery_journal).toEqual({ state: 'DONE', verdict: 'send' });

    // Deterministic hot-path budgets: V2 recomposes only at state boundaries, performs three
    // provider calls (plan, continuation, synthesis), and stays well below the brief policy cap.
    expect(composer.calls()).toBeLessThanOrEqual(4);
    expect(gateway.requests).toHaveLength(3);
    expect(proof.v2.evidence.provider_calls).toBe(3);
    expect(proof.v2.evidence.total_tokens).toBeLessThanOrEqual(96);
    expect(
      gateway.requests.every(
        (request) =>
          new TextEncoder().encode(request.request.messages[0]?.content ?? '').byteLength <= 32_768,
      ),
    ).toBe(true);
    expect(gateway.requests[0]?.request.messages[0]?.content).toContain(PRIVATE_STAGED_INPUT);

    const persisted = await runInDurableObject(stub, (_instance, state) => {
      const tables = [
        'runtime_runs',
        'runtime_invocation_v2',
        'runtime_invocation_v2_scribe_audit',
        'runtime_journal',
        'runtime_trace',
        'journal',
        'run_candidates',
        'loop_governor_runs',
        'loop_observations',
        'loop_progress',
        'loop_progress_params',
        'outbox',
        'class_state',
        'event_cooldowns',
        'subkind_state',
        'daily_push_budget',
        'held_candidates',
        'schedule',
      ] as const;
      return {
        rows: Object.fromEntries(
          tables.map((table) => [table, state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()]),
        ),
        v2_state_bytes: state.storage.sql
          .exec<{ n: number }>(
            'SELECT length(state_json) AS n FROM runtime_invocation_v2 WHERE run_id = ?',
            runId,
          )
          .one().n,
      };
    });
    const persistedText = JSON.stringify(persisted);
    expect(persistedText).not.toContain(PRIVATE_STAGED_INPUT);
    expect(persistedText).not.toContain(PRIVATE_RECALL);
    expect(persistedText).not.toContain('safe ephemeral synthesis');
    expect(persistedText).not.toContain('derived steady');
    expect(persistedText).not.toContain('fake-derived');
    expect(persisted.v2_state_bytes).toBeLessThanOrEqual(16_384);
  });

  it('isolates trusted proactive journal, Governor, and brief class-cap state by tenant and principal', async () => {
    const stub = freshStub();
    const tenantA = trustedScheduledAdmission();
    const tenantB: TrustedInvocationAdmission = {
      ...tenantA,
      verified_authority: {
        ...tenantA.verified_authority,
        tenant_ref: 'ten_ffffffffffffffffffffffffffffffff',
      },
    };
    const [runA, runB] = await Promise.all([
      stub.__runLoopScheduleTrustedRunForTest(trustedInput(tenantA)),
      stub.__runLoopScheduleTrustedRunForTest(trustedInput(tenantB)),
    ]);
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);

    const initialScopes = await runInDurableObject(stub, (instance, state) => {
      const rows = state.storage.sql
        .exec<{ run_id: string; user_id: string }>(
          'SELECT run_id, user_id FROM journal WHERE run_id IN (?, ?) ORDER BY run_id',
          runA,
          runB,
        )
        .toArray();
      const scopes = new Map(rows.map((row) => [row.run_id, row.user_id]));
      const ownerA = scopes.get(runA);
      const ownerB = scopes.get(runB);
      if (ownerA === undefined || ownerB === undefined) {
        throw new Error('expected both trusted journal owner scopes');
      }
      const governorRows = state.storage.sql
        .exec<{ run_id: string; user_id: string }>(
          'SELECT run_id, user_id FROM loop_governor_runs WHERE run_id IN (?, ?) ORDER BY run_id',
          runA,
          runB,
        )
        .toArray();
      const runtimeRows = state.storage.sql
        .exec<{ run_id: string; user_id: string }>(
          'SELECT run_id, user_id FROM runtime_runs WHERE run_id IN (?, ?) ORDER BY run_id',
          runA,
          runB,
        )
        .toArray();
      state.storage.sql.exec(
        `INSERT INTO class_state (user_id, local_date, push_class, count, last_sent_at)
         VALUES (?, '2026-07-16', 'brief', 3, ?)`,
        ownerA,
        SNAPSHOT_AT - 1,
      );
      state.storage.sql.exec(
        `INSERT INTO loop_progress
           (user_id, loop_type, occurrence_id, call_count, unique_param_hashes, successes, updated_at)
         VALUES (?, 'brief', ?, 10, 1, 0, ?)`,
        ownerA,
        tenantA.occurrence.occurrence_ref,
        SNAPSHOT_AT,
      );
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      return { ownerA, ownerB, governorRows, runtimeRows };
    });

    expect(initialScopes.ownerA).toMatch(/^own_[a-f0-9]{32}$/);
    expect(initialScopes.ownerB).toMatch(/^own_[a-f0-9]{32}$/);
    expect(initialScopes.ownerA).not.toBe(initialScopes.ownerB);
    expect(initialScopes.ownerA).not.toBe(tenantA.verified_authority.principal_ref);
    expect(initialScopes.governorRows).toEqual(
      expect.arrayContaining([
        { run_id: runA, user_id: initialScopes.ownerA },
        { run_id: runB, user_id: initialScopes.ownerB },
      ]),
    );
    expect(initialScopes.runtimeRows).toEqual(
      expect.arrayContaining([
        { run_id: runA, user_id: tenantA.verified_authority.principal_ref },
        { run_id: runB, user_id: tenantA.verified_authority.principal_ref },
      ]),
    );

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as TestRunLoopInstance).__runLoopDriveRunForTest(runB);
    });
    const proof = await stub.readTrustedRunProof(runB);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.delivery_journal).toEqual({ state: 'DONE', verdict: 'send' });
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });

    const policyRows = await runInDurableObject(stub, (_instance, state) => ({
      classState: state.storage.sql
        .exec<{ user_id: string; count: number }>(
          "SELECT user_id, count FROM class_state WHERE push_class = 'brief' ORDER BY user_id",
        )
        .toArray(),
      progress: state.storage.sql
        .exec<{
          user_id: string;
          call_count: number;
          unique_param_hashes: number;
          successes: number;
        }>(
          `SELECT user_id, call_count, unique_param_hashes, successes
             FROM loop_progress
            WHERE loop_type = 'brief' AND occurrence_id = ?
            ORDER BY user_id`,
          tenantA.occurrence.occurrence_ref,
        )
        .toArray(),
    }));
    expect(policyRows.classState).toHaveLength(2);
    expect(policyRows.classState).toEqual(
      expect.arrayContaining([
        { user_id: initialScopes.ownerA, count: 3 },
        { user_id: initialScopes.ownerB, count: 1 },
      ]),
    );
    expect(policyRows.progress).toHaveLength(2);
    expect(policyRows.progress).toEqual(
      expect.arrayContaining([
        {
          user_id: initialScopes.ownerA,
          call_count: 10,
          unique_param_hashes: 1,
          successes: 0,
        },
        {
          user_id: initialScopes.ownerB,
          call_count: 2,
          unique_param_hashes: 2,
          successes: 2,
        },
      ]),
    );
  });

  it.each(['journal', 'loop_governor_runs'] as const)(
    'fails closed when the trusted %s owner scope no longer matches the accepted authority',
    async (table) => {
      const stub = freshStub();
      const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
      await runInDurableObject(stub, async (instance, state) => {
        state.storage.sql.exec(
          `UPDATE ${table} SET user_id = 'own_ffffffffffffffffffffffffffffffff' WHERE run_id = ?`,
          runId,
        );
        await (instance as unknown as TestRunLoopInstance).__runLoopDriveRunForTest(runId);
      });
      const proof = await stub.readRunProof(runId);
      expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'replay:artifact_invalid' });
      expect(proof.outbox).toEqual([]);
      expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    },
  );

  it('runs the guarded local HTTP fixture through trusted V2 admission and the existing durable loop', async () => {
    const stub = freshStub();
    const headers = {
      'content-type': 'application/json',
      'x-waldo-local-run-token': LOCAL_RUN_TOKEN,
    };

    // The authenticated caller cannot turn this route into a caller-shaped trusted envelope.
    const hostile = await stub.fetch('https://run-loop.local/local/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        trigger: 'user_message',
        tenant_ref: 'ten_ffffffffffffffffffffffffffffffff',
        output_disposition: 'solicited_reply',
      }),
    });
    expect(hostile.status).toBe(400);

    const admitted = await stub.fetch('https://run-loop.local/local/runs', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(admitted.status).toBe(202);
    const first = (await admitted.json()) as { run_id: string };

    // The fixed local schedule identity preserves duplicate admission, rather than opening an
    // alternate loop or accepting caller-selectable idempotency input.
    const duplicate = await stub.fetch('https://run-loop.local/local/runs', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect((await duplicate.json()) as { run_id: string }).toEqual(first);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const inspection = await stub.fetch(
      `https://run-loop.local/local/runs/${encodeURIComponent(first.run_id)}`,
      { headers: { 'x-waldo-local-run-token': LOCAL_RUN_TOKEN } },
    );
    expect(inspection.status).toBe(200);
    const proof = (await inspection.json()) as TrustedRunLoopProof;
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.fsm).toEqual([
      'PENDING',
      'CONTEXT_BUILT',
      'LLM_CALLED',
      'TOOLS_DONE',
      'LLM_CALLED',
      'TOOLS_DONE',
      'GATED',
      'DELIVERED',
      'DONE',
    ]);
    expect(proof.v2.invocation).toMatchObject({
      admission_source: 'trusted_scheduler',
      output: { disposition: 'proactive_delivery' },
      runtime_binding: { trigger: 'brief', variant: 'morning' },
    });
    expect(proof.v2.context).toMatchObject({
      context_version: 2,
      principal_ref: 'prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      tenant_ref: 'ten_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sanitisation: 'passed',
    });
    expect(proof.v2.tool_checkpoints).toHaveLength(2);
    expect(proof.v2.evidence.tool_acl).toEqual(TOOL_PERMISSIONS.brief);
    expect(proof.v2.evidence.provider_calls).toBe(3);
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
    expect(proof.delivery_journal).toEqual({ state: 'DONE', verdict: 'send' });
    expect((await stub.readRunEvidence(first.run_id)).evidence_flavor).toBe('trusted_v2');
    expect(proof.trace.map((event) => event.event)).toEqual([
      'scheduled_wake',
      'governor_admitted',
      'session_reset',
      'context_built',
      'llm_called',
      'tool_dispatched',
      'llm_observed',
      'tool_dispatched',
      'llm_observed',
      'gated',
      'delivered',
      'done',
    ]);
  });

  it('exposes only lifecycle and locally guarded controls on the RunLoopDO RPC prototype', async () => {
    const stub = freshStub();

    // Workerd exposes every prototype method as an RPC. Keep this exact allowlist narrow: internal
    // mechanics, trusted admission parsing/opening, fake context construction, and effect intent
    // persistence must stay ECMAScript-private rather than TypeScript-private.
    await runInDurableObject(stub, (instance) => {
      const prototype = Object.getPrototypeOf(instance);
      expect(Object.getOwnPropertyNames(prototype).sort()).toEqual(
        [
          '__runLoopAuditTrustedV2ForTest',
          '__runLoopDriveRunForTest',
          '__runLoopIngestExternalToolResultForTest',
          '__runLoopOpenTrustedRunForTest',
          '__runLoopProbePrivilegedToolForTest',
          '__runLoopScheduleTrustedRunForTest',
          '__runLoopSetKillFlag',
          '__runLoopSetTestOverrides',
          'alarm',
          'constructor',
          'fetch',
          'readRunEvidence',
          'readRunProof',
          'readTrustedRunProof',
          'replayFixture',
          'scheduleFakeRun',
          'scoreRun',
        ].sort(),
      );
    });
  });

  it('guards every prototype-exposed proof and replay RPC outside local/test mode', async () => {
    const stub = freshStub();

    // Workerd exposes prototype methods as RPCs even when fetch() returns 404. Run the guard on
    // the real DO instance because the pool intentionally reports expected thrown RPC errors as
    // global unhandled rejections; prototype eligibility plus these pre-read rejections lock the
    // same externally callable surface without suppressing a runner error.
    await runInDurableObject(stub, async (instance) => {
      const loop = instance as unknown as TestRunLoopInstance;
      const prototype = Object.getPrototypeOf(instance);
      for (const method of [
        'readRunProof',
        'readTrustedRunProof',
        'readRunEvidence',
        'replayFixture',
        'scoreRun',
      ]) {
        expect(Reflect.has(prototype, method)).toBe(true);
      }
      await withNonLocalRunLoopEnvironment(instance, async () => {
        await expect(loop.readRunProof('run_nonlocal_proof')).rejects.toThrow(
          'run-loop test seam is local-only',
        );
        await expect(loop.readTrustedRunProof('run_nonlocal_trusted_proof')).rejects.toThrow(
          'run-loop test seam is local-only',
        );
        await expect(loop.readRunEvidence('run_nonlocal_evidence')).rejects.toThrow(
          'run-loop test seam is local-only',
        );
        await expect(loop.replayFixture('run_nonlocal_replay')).rejects.toThrow(
          'run-loop test seam is local-only',
        );
        await expect(loop.scoreRun('run_nonlocal_score')).rejects.toThrow(
          'run-loop test seam is local-only',
        );
      });
    });
  });

  it('does not downgrade a marker-backed V2 evidence read when explicit V2 trace witnesses are damaged', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as TestRunLoopInstance).__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.readRunEvidence(runId)).evidence_flavor).toBe('trusted_v2');

    await runInDurableObject(stub, (_instance, state) => {
      // This is deliberately a legacy-shaped terminal trace: deleting the V2 ContextComposer
      // witness and disposition field must not make the immutable V2 runtime marker disappear.
      state.storage.sql.exec(
        'DELETE FROM runtime_trace WHERE run_id = ? AND event = ?',
        runId,
        'context_built',
      );
      state.storage.sql.exec(
        'UPDATE runtime_trace SET detail_json = ? WHERE run_id = ? AND event = ?',
        JSON.stringify({
          verdict: 'hold',
          reason: 'cooldown_active',
          delivery_text_source: 'fallback',
        }),
        runId,
        'gated',
      );
      state.storage.sql.exec(
        'UPDATE runtime_trace SET detail_json = ? WHERE run_id = ? AND event = ?',
        JSON.stringify({ terminal: true }),
        runId,
        'done',
      );
    });

    await expect(
      runInDurableObject(stub, async (instance) =>
        (instance as unknown as TestRunLoopInstance).readRunEvidence(runId),
      ),
    ).rejects.toThrow('terminal fixtures require disposition-consistent journal and delivery evidence');
  });

  it.each(['provider_plan', 'provider_observe'] as const)(
    'reconciles the %s effect after eviction before its durable receipt without a duplicate provider call',
    async (phase) => {
      const stub = freshStub();
      const gateway = new ScriptedGateway([
        response(ROSTER.primary, toolCall('call-v2-first', 1)),
        response(ROSTER.primary, toolCall('call-v2-second', 2)),
        response(ROSTER.primary, 'safe ephemeral synthesis'),
      ]);
      const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
      await runInDurableObject(stub, (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
        });
        runLoop.__runLoopCrashAfterTrustedProviderEffect = phase;
      });

      await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
        `crash-injection:TRUSTED_${phase.toUpperCase()}_EFFECT`,
      );
      const beforeReset = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ state_json: string }>(
            'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
            runId,
          )
          .one().state_json,
      );
      expect(beforeReset).toContain('pending_effect');
      expect(beforeReset).not.toContain(PRIVATE_STAGED_INPUT);
      expect(beforeReset).not.toContain('safe ephemeral synthesis');

      await evictDurableObject(stub);
      await runInDurableObject(stub, async (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
        });
        await runLoop.__runLoopDriveRunForTest(runId);
      });

      const proof = await stub.readTrustedRunProof(runId);
      expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
      expect(proof.v2.evidence.provider_calls).toBe(3);
      // The replayed keyed provider response did not become a second physical request.
      expect(gateway.requests).toHaveLength(3);
      expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
      expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
    },
  );

  it.each([
    {
      phase: 'provider_plan' as const,
      responses: [response(ROSTER.primary, toolCall('call-v2-first', 1))],
      providerCalls: 1,
      physicalToolsBeforeRecovery: 0,
      providerRequests: 1,
      operations: ['issue', 'reconcile'],
    },
    {
      phase: 'provider_observe' as const,
      responses: [
        response(ROSTER.primary, toolCall('call-v2-first', 1)),
        response(ROSTER.primary, toolCall('call-v2-second', 2)),
      ],
      providerCalls: 2,
      physicalToolsBeforeRecovery: 1,
      providerRequests: 2,
      operations: ['issue', 'issue', 'reconcile'],
    },
  ])(
    'settles a pending $phase receipt before recomposition can issue the next tool',
    async ({
      phase,
      responses,
      providerCalls,
      physicalToolsBeforeRecovery,
      providerRequests,
      operations,
    }) => {
      const stub = freshStub();
      const gateway = new ScriptedGateway(responses);
      const countedTool = countingReconciledGetCrsHandler();
      const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
      await runInDurableObject(stub, (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
          trustedToolHandlers: [countedTool.handler],
        });
        runLoop.__runLoopCrashAfterTrustedProviderEffect = phase;
      });

      await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
        `crash-injection:TRUSTED_${phase.toUpperCase()}_EFFECT`,
      );
      expect(countedTool.physicalCalls()).toBe(physicalToolsBeforeRecovery);

      await evictDurableObject(stub);
      await runInDurableObject(stub, async (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: {
            async compose() {
              return { ok: false, failure: { code: 'materials_unavailable' } };
            },
          },
          replayArtifacts: replayArtifacts(),
          trustedToolHandlers: [countedTool.handler],
        });
        await runLoop.__runLoopDriveRunForTest(runId);
      });

      const proof = await stub.readTrustedRunProof(runId);
      expect(proof.current).toEqual({
        state: 'FAILED',
        failure_reason: 'context:materials_unavailable',
      });
      expect(proof.v2.evidence.provider_calls).toBe(providerCalls);
      expect(proof.v2.tool_checkpoints).toHaveLength(physicalToolsBeforeRecovery);
      expect(countedTool.physicalCalls()).toBe(physicalToolsBeforeRecovery);
      expect(gateway.operations).toEqual(operations);
      expect(gateway.requests).toHaveLength(providerRequests);
      expect(proof.outbox).toEqual([]);
      expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });

      const durable = await runInDurableObject(stub, (_instance, state) => ({
        pending: JSON.parse(
          state.storage.sql
            .exec<{ state_json: string }>(
              'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
              runId,
            )
            .one().state_json,
        ) as { pending_effect: unknown },
        observations: state.storage.sql
          .exec<{ n: number }>('SELECT count(*) AS n FROM loop_observations WHERE run_id = ?', runId)
          .one().n,
      }));
      expect(durable.pending.pending_effect).toBeNull();
      expect(durable.observations).toBe(physicalToolsBeforeRecovery);
    },
  );

  it.each(['provider_plan', 'provider_observe'] as const)(
    'settles the pending %s receipt before applying a later Governor kill',
    async (phase) => {
      const stub = freshStub();
      const gateway = new ScriptedGateway([
        response(ROSTER.primary, toolCall('call-v2-first', 1)),
        response(ROSTER.primary, toolCall('call-v2-second', 2)),
        response(ROSTER.primary, 'safe ephemeral synthesis'),
      ]);
      const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
      await runInDurableObject(stub, (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
        });
        runLoop.__runLoopCrashAfterTrustedProviderEffect = phase;
      });

      await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
        `crash-injection:TRUSTED_${phase.toUpperCase()}_EFFECT`,
      );
      await evictDurableObject(stub);
      await runInDurableObject(stub, async (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
        });
        runLoop.__runLoopSetKillFlag({ scope: 'loop', loopType: 'brief', active: true });
        await runLoop.__runLoopDriveRunForTest(runId);
      });

      const proof = await stub.readTrustedRunProof(runId);
      expect(proof.current).toEqual({
        state: 'FAILED',
        failure_reason: 'governor:kill_flag_active',
      });
      expect(proof.v2.evidence.provider_calls).toBe(phase === 'provider_plan' ? 1 : 2);
      expect(gateway.operations).toEqual(
        phase === 'provider_plan'
          ? ['issue', 'reconcile']
          : ['issue', 'issue', 'reconcile'],
      );
      expect(gateway.requests).toHaveLength(phase === 'provider_plan' ? 1 : 2);
      const sidecar = await runInDurableObject(stub, (_instance, state) =>
        JSON.parse(
          state.storage.sql
            .exec<{ state_json: string }>(
              'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
              runId,
            )
            .one().state_json,
        ) as { pending_effect: unknown },
      );
      expect(sidecar.pending_effect).toBeNull();
    },
  );

  it.each(['provider_plan', 'provider_observe'] as const)(
    'reconciles the pending %s receipt despite an open provider circuit',
    async (phase) => {
      const stub = freshStub();
      const gateway = new ScriptedGateway([
        response(ROSTER.primary, toolCall('call-v2-first', 1)),
        response(ROSTER.primary, toolCall('call-v2-second', 2)),
        response(ROSTER.primary, 'safe ephemeral synthesis'),
      ]);
      const circuit: CircuitBreaker = {
        isOpen: () => true,
        recordSuccess: () => undefined,
        recordFailure: () => undefined,
      };
      const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
      await runInDurableObject(stub, (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
        });
        runLoop.__runLoopCrashAfterTrustedProviderEffect = phase;
      });

      await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
        `crash-injection:TRUSTED_${phase.toUpperCase()}_EFFECT`,
      );
      await evictDurableObject(stub);
      await runInDurableObject(stub, async (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
          circuitBreaker: circuit,
        });
        await runLoop.__runLoopDriveRunForTest(runId);
      });

      const proof = await stub.readTrustedRunProof(runId);
      // Recovery ignores the open circuit only for the already-issued keyed receipt. The next
      // fresh provider boundary remains circuit-gated and fails closed.
      expect(proof.current).toEqual({
        state: 'FAILED',
        failure_reason: 'llm_observe:template_unavailable',
      });
      expect(proof.v2.evidence.provider_calls).toBe(phase === 'provider_plan' ? 1 : 2);
      expect(gateway.operations).toEqual(
        phase === 'provider_plan'
          ? ['issue', 'reconcile']
          : ['issue', 'issue', 'reconcile'],
      );
      expect(gateway.requests).toHaveLength(phase === 'provider_plan' ? 1 : 2);
      const sidecar = await runInDurableObject(stub, (_instance, state) =>
        JSON.parse(
          state.storage.sql
            .exec<{ state_json: string }>(
              'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
              runId,
            )
            .one().state_json,
        ) as { pending_effect: unknown },
      );
      expect(sidecar.pending_effect).toBeNull();
    },
  );

  it('rethrows an unexpected provider reconciler cause and resumes the pending receipt by key', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
        {
          ...response(ROSTER.primary, toolCall('call-v2-first', 1)),
          latency_ms: THROW_AFTER_RECEIPT_LATENCY_SENTINEL,
        },
        response(ROSTER.primary, toolCall('call-v2-second', 2)),
        response(ROSTER.primary, 'safe ephemeral synthesis'),
      ]);
    const cause = new Error('trusted provider reconciler storage sentinel');
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as TestRunLoopInstance).__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
    });

    await expect(
      runInDurableObject(stub, async (instance) =>
        (instance as unknown as TestRunLoopInstance).__runLoopDriveRunForTest(runId),
      ),
    ).rejects.toThrow(cause.message);
    expect(gateway.operations).toEqual(['issue']);
    expect(gateway.requests).toHaveLength(1);
    const afterThrow = await stub.readTrustedRunProof(runId);
    expect(afterThrow.current).toEqual({ state: 'CONTEXT_BUILT', failure_reason: null });
    expect(afterThrow.v2.evidence.provider_calls).toBe(0);
    const pending = await runInDurableObject(stub, (_instance, state) =>
      JSON.parse(
        state.storage.sql
          .exec<{ state_json: string }>(
            'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
            runId,
          )
          .one().state_json,
      ) as { pending_effect: { kind: string } | null },
    );
    expect(pending.pending_effect).toMatchObject({ kind: 'provider_plan' });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(gateway.operations).toEqual(['issue', 'reconcile', 'issue', 'issue']);
    // Reconciliation returned the adapter-held receipt; only the three logical provider effects
    // crossed the physical gateway boundary.
    expect(gateway.requests).toHaveLength(3);
  });

  it('fails closed with a typed unresolved provider intent when reconciliation has no receipt', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfterTrustedProviderEffect = 'provider_plan';
    });

    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_PROVIDER_PLAN_EFFECT',
    );
    expect(gateway.requests).toHaveLength(1);
    gateway.clearReceipts();

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'llm:effect_receipt_unavailable',
    });
    expect(proof.v2.evidence).toMatchObject({ provider_calls: 0, total_tokens: 0 });
    expect(gateway.requests).toHaveLength(1);
    const sidecar = await runInDurableObject(stub, (_instance, state) =>
      JSON.parse(
        state.storage.sql
          .exec<{ state_json: string }>(
            'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
            runId,
          )
          .one().state_json,
      ) as { pending_effect: { kind: string } | null; plan: unknown },
    );
    expect(sidecar.pending_effect).toMatchObject({ kind: 'provider_plan' });
    expect(sidecar.plan).toBeNull();
  });

  it('reconciles a tool effect after eviction before its checkpoint and Governor observation', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const countedTool = countingReconciledGetCrsHandler();
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
        trustedToolHandlers: [countedTool.handler],
      });
      runLoop.__runLoopCrashAfterTrustedToolEffect = true;
    });

    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_TOOL_EFFECT',
    );
    expect(countedTool.physicalCalls()).toBe(1);
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
        trustedToolHandlers: [countedTool.handler],
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.v2.tool_checkpoints).toHaveLength(2);
    // There are two logical tools; a reset did not turn the first one into a third physical call.
    expect(countedTool.physicalCalls()).toBe(2);
    const observations = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM loop_observations WHERE run_id = ?', runId)
        .one().n,
    );
    expect(observations).toBe(2);
  });

  it('settles a post-effect tool receipt before a reset-time Governor kill without issuing another tool', async () => {
    const events: string[] = [];
    const stub = freshStub();
    const gateway = new ScriptedGateway([response(ROSTER.primary, toolCall('call-v2-first', 1))]);
    const countedTool = countingReconciledGetCrsHandler({
      onReconcile: () => events.push('tool-reconcile'),
    });
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
        trustedToolHandlers: [countedTool.handler],
      });
      runLoop.__runLoopCrashAfterTrustedToolEffect = true;
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_TOOL_EFFECT',
    );
    expect(countedTool.physicalCalls()).toBe(1);

    events.length = 0;
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: {
          async compose(invocation, inputs) {
            events.push('compose');
            return frozenComposer().composer.compose(invocation, inputs);
          },
        },
        replayArtifacts: replayArtifacts(),
        trustedToolHandlers: [countedTool.handler],
      });
      runLoop.__runLoopSetKillFlag({ scope: 'loop', loopType: 'brief', active: true });
      await runLoop.__runLoopDriveRunForTest(runId);
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'governor:kill_flag_active',
    });
    expect(events).toEqual(['tool-reconcile']);
    expect(countedTool.physicalCalls()).toBe(1);
    expect(countedTool.reconciliations()).toBe(1);
    expect(gateway.requests).toHaveLength(1);
    expect(proof.v2.tool_checkpoints).toHaveLength(1);
    expect(proof.v2.tool_checkpoints[0]).toMatchObject({ status: 'completed', tool: 'get_crs' });
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    const durable = await runInDurableObject(stub, (_instance, state) => ({
      sidecar: JSON.parse(
        state.storage.sql
          .exec<{ state_json: string }>(
            'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
            runId,
          )
          .one().state_json,
      ) as { pending_effect: unknown; tool_effect_witnesses: unknown[] },
      observations: state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM loop_observations WHERE run_id = ?', runId)
        .one().n,
    }));
    expect(durable.sidecar.pending_effect).toBeNull();
    expect(durable.sidecar.tool_effect_witnesses).toHaveLength(1);
    expect(durable.observations).toBe(1);
  });

  it('reconciles a rejected post-effect tool receipt exactly once and persists only bounded evidence', async () => {
    const privateToolReceipt = 'private-rejected-tool-receipt-must-not-persist';
    const stub = freshStub();
    const gateway = new ScriptedGateway([response(ROSTER.primary, toolCall('call-v2-first', 1))]);
    const countedTool = countingReconciledGetCrsHandler({ rejectedError: privateToolReceipt });
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
        trustedToolHandlers: [countedTool.handler],
      });
      runLoop.__runLoopCrashAfterTrustedToolEffect = true;
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_TOOL_EFFECT',
    );
    expect(countedTool.physicalCalls()).toBe(1);

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
        trustedToolHandlers: [countedTool.handler],
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'tool_dispatch:tool_result_error',
    });
    expect(countedTool.physicalCalls()).toBe(1);
    expect(countedTool.reconciliations()).toBe(1);
    expect(proof.v2.tool_checkpoints).toHaveLength(1);
    expect(proof.v2.tool_checkpoints[0]).toMatchObject({
      status: 'blocked',
      tool: 'get_crs',
      reason: 'tool_result_error',
      effect_receipt: { outcome: 'rejected', argument_taint: null },
    });
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    const durable = await runInDurableObject(stub, (_instance, state) => ({
      rows: [
        state.storage.sql.exec('SELECT * FROM runtime_invocation_v2 WHERE run_id = ?', runId).toArray(),
        state.storage.sql.exec('SELECT * FROM runtime_trace WHERE run_id = ?', runId).toArray(),
        state.storage.sql.exec('SELECT * FROM loop_observations WHERE run_id = ?', runId).toArray(),
        state.storage.sql.exec('SELECT * FROM outbox WHERE run_id = ?', runId).toArray(),
      ],
      progress: state.storage.sql
        .exec<{ call_count: number; successes: number }>(
          `SELECT call_count, successes
             FROM loop_progress
            WHERE loop_type = 'brief' AND occurrence_id = ?`,
          trustedScheduledAdmission().occurrence.occurrence_ref,
        )
        .one(),
    }));
    expect(durable.progress).toEqual({ call_count: 1, successes: 0 });
    expect(JSON.stringify(durable.rows)).not.toContain(privateToolReceipt);
  });

  it('reconciles a pending tool before any normal hook, ContextComposer, or replay source after reset', async () => {
    const events: string[] = [];
    const stub = freshStub();
    const gateway = new ScriptedGateway([response(ROSTER.primary, toolCall('call-v2-first', 1))]);
    const countedTool = countingReconciledGetCrsHandler({
      onReconcile: () => events.push('tool-reconcile'),
    });
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
        trustedToolHandlers: [countedTool.handler],
      });
      runLoop.__runLoopCrashAfterTrustedToolEffect = true;
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_TOOL_EFFECT',
    );

    events.length = 0;
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        rateLimitCheck: async () => {
          events.push('rate-limit');
          return { ok: true };
        },
        contextComposer: {
          async compose() {
            events.push('compose');
            return { ok: false, failure: { code: 'materials_unavailable' } };
          },
        },
        replayArtifacts: {
          async resolvePlan() {
            events.push('replay-plan');
            throw new Error('replay must not run before the source failure');
          },
          async resolveToolResult() {
            events.push('replay-tool');
            throw new Error('replay must not run before the source failure');
          },
          async resolveSynthesis() {
            events.push('replay-synthesis');
            throw new Error('replay must not run before the source failure');
          },
        },
        trustedToolHandlers: [countedTool.handler],
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'context:materials_unavailable',
    });
    expect(events).toEqual(['tool-reconcile', 'rate-limit', 'compose']);
    expect(countedTool.physicalCalls()).toBe(1);
    expect(countedTool.reconciliations()).toBe(1);
    expect(gateway.requests).toHaveLength(1);
    expect(proof.v2.tool_checkpoints).toHaveLength(1);
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
  });

  it('fails closed with an unresolved tool intent when reconciliation has no receipt', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
    ]);
    const countedTool = countingReconciledGetCrsHandler();
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
        trustedToolHandlers: [countedTool.handler],
      });
      runLoop.__runLoopCrashAfterTrustedToolEffect = true;
    });

    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_TOOL_EFFECT',
    );
    expect(countedTool.physicalCalls()).toBe(1);
    countedTool.clearReceipts();

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
        trustedToolHandlers: [countedTool.handler],
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'tool_dispatch:effect_receipt_unavailable',
    });
    expect(proof.v2.tool_checkpoints).toEqual([]);
    expect(countedTool.physicalCalls()).toBe(1);
    const sidecar = await runInDurableObject(stub, (_instance, state) =>
      JSON.parse(
        state.storage.sql
          .exec<{ state_json: string }>(
            'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
            runId,
          )
          .one().state_json,
      ) as {
        pending_effect: { kind: string } | null;
        tool_effect_witnesses: unknown[];
      },
    );
    expect(sidecar.pending_effect).toMatchObject({ kind: 'tool' });
    expect(sidecar.tool_effect_witnesses).toEqual([]);
  });

  it('fails closed only for a recognized mismatched pending effect, before provider I/O', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfter = 'CONTEXT_BUILT';
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:CONTEXT_BUILT');
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one();
      const trusted = JSON.parse(row.state_json) as Record<string, unknown>;
      trusted.pending_effect = {
        kind: 'provider_plan',
        effect_ref: 'eff_ffffffffffffffffffffffffffffffff',
        idempotency_key: 'idk_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        request_digest: 'f'.repeat(64),
        iteration: 1,
      };
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify(trusted),
        runId,
      );
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });
    expect((await stub.readRunProof(runId)).current).toEqual({
      state: 'FAILED',
      failure_reason: 'replay:artifact_invalid',
    });
    expect(gateway.requests).toHaveLength(0);
  });

  it('rethrows an unexpected durable-write cause after a physical tool effect', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const countedTool = countingReconciledGetCrsHandler();
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
        trustedToolHandlers: [countedTool.handler],
      });
      runLoop.__runLoopCrashAfter = 'LLM_CALLED';
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:LLM_CALLED');

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER trusted_v2_unexpected_checkpoint_write
           BEFORE UPDATE ON runtime_invocation_v2
           WHEN NEW.state_json LIKE '%"pending_effect":null%'
           BEGIN SELECT RAISE(ABORT, 'unexpected-storage-fault'); END`,
      );
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
        trustedToolHandlers: [countedTool.handler],
      });
      await expect(runLoop.__runLoopDriveRunForTest(runId)).rejects.toThrow(
        'unexpected-storage-fault',
      );
    });

    expect(countedTool.physicalCalls()).toBe(1);
    expect((await stub.readRunProof(runId)).current).toEqual({
      state: 'LLM_CALLED',
      failure_reason: null,
    });
  });

  it('fails closed for a historical pre-receipt V2 tool sidecar without falling back to V1', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfter = 'TOOLS_DONE';
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:TOOLS_DONE');

    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one();
      const legacy = JSON.parse(row.state_json) as Record<string, unknown>;
      const plan = legacy.plan as Record<string, unknown> | null;
      if (plan !== null) throw new Error('expected a settled-tool historical fixture');
      delete legacy.receipt_protocol;
      delete legacy.pending_effect;
      delete legacy.tool_effect_witnesses;
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify(legacy),
        runId,
      );
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2_scribe_audit SET version = 1 WHERE run_id = ?',
        runId,
      );
    });

    const callsBeforeResume = gateway.requests.length;
    await evictDurableObject(stub);

    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });
    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'replay:artifact_invalid' });
    expect(proof.trace.find((event) => event.event === 'context_built')?.detail).toMatchObject({
      source: 'context-composer-v2',
    });
    expect(JSON.stringify(proof)).not.toContain('fake-derived');
    expect(gateway.requests).toHaveLength(callsBeforeResume);
    const persisted = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ invocation_format: string; state_json: string }>(
          `SELECT invocation_format, (SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?) AS state_json
             FROM runtime_runs
            WHERE run_id = ?`,
          runId,
          runId,
        )
        .one(),
    );
    expect(persisted.invocation_format).toBe('invocation_contract_v2');
    expect(persisted.state_json).toBe('{"format":"corrupt_v2_state"}');
  });

  it('fails closed for a historical provider-plan V2 receipt without fabricating an effect witness', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfter = 'LLM_CALLED';
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:LLM_CALLED');
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one();
      const legacy = JSON.parse(row.state_json) as Record<string, unknown>;
      const plan = legacy.plan as Record<string, unknown> | null;
      if (plan === null) throw new Error('expected a provider-plan historical fixture');
      delete plan.effect;
      delete legacy.receipt_protocol;
      delete legacy.pending_effect;
      delete legacy.tool_effect_witnesses;
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify(legacy),
        runId,
      );
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2_scribe_audit SET version = 1 WHERE run_id = ?',
        runId,
      );
    });

    const callsBeforeResume = gateway.requests.length;
    await evictDurableObject(stub);

    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });
    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'replay:artifact_invalid' });
    expect(gateway.requests).toHaveLength(callsBeforeResume);
    const persisted = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ invocation_format: string; state_json: string }>(
          `SELECT invocation_format, (SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?) AS state_json
             FROM runtime_runs
            WHERE run_id = ?`,
          runId,
          runId,
        )
        .one(),
    );
    expect(persisted.invocation_format).toBe('invocation_contract_v2');
    expect(persisted.state_json).toBe('{"format":"corrupt_v2_state"}');
  });

  it('preserves a valid V2 sidecar when an audit write has an unexpected storage fault', async () => {
    const stub = freshStub();
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));

    await runInDurableObject(stub, (instance, state) => {
      const before = state.storage.sql
        .exec<{ canonical_identity_hash: string; state_json: string }>(
          `SELECT canonical_identity_hash, state_json
             FROM runtime_invocation_v2
            WHERE run_id = ?`,
          runId,
        )
        .one();
      state.storage.sql.exec('DELETE FROM runtime_invocation_v2_scribe_audit WHERE run_id = ?', runId);
      state.storage.sql.exec(
        `CREATE TRIGGER trusted_v2_audit_write_sentinel
           BEFORE UPDATE OF state_json ON runtime_invocation_v2
           WHEN NEW.state_json != '{"format":"corrupt_v2_state"}'
           BEGIN SELECT RAISE(ABORT, 'unexpected-audit-write-sentinel'); END`,
      );

      const runLoop = instance as unknown as TestRunLoopInstance;
      expect(() => runLoop.__runLoopAuditTrustedV2ForTest()).toThrow(
        'unexpected-audit-write-sentinel',
      );

      const after = state.storage.sql
        .exec<{ canonical_identity_hash: string; state_json: string }>(
          `SELECT canonical_identity_hash, state_json
             FROM runtime_invocation_v2
            WHERE run_id = ?`,
          runId,
        )
        .one();
      expect(after).toEqual(before);
      expect(
        state.storage.sql
          .exec<{ n: number }>(
            'SELECT count(*) AS n FROM runtime_invocation_v2_scribe_audit WHERE run_id = ?',
            runId,
          )
          .one().n,
      ).toBe(0);
      expect(
        state.storage.sql
          .exec<{ state: string; failure_reason: string | null }>(
            'SELECT state, failure_reason FROM runtime_runs WHERE run_id = ?',
            runId,
          )
          .one(),
      ).toEqual({ state: 'PENDING', failure_reason: null });
    });
  });

  it('coalesces concurrent trusted drives before an awaited provider can duplicate an effect', async () => {
    const stub = freshStub();
    const gateway = new DeferredFirstGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));

    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      const firstDrive = runLoop.__runLoopDriveRunForTest(runId);
      await gateway.waitForFirstRequest();
      const secondDrive = runLoop.__runLoopDriveRunForTest(runId);
      await Promise.resolve();
      expect(gateway.requests).toHaveLength(1);
      gateway.releaseFirstRequest();
      await expect(Promise.all([firstDrive, secondDrive])).resolves.toEqual([undefined, undefined]);
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.fsm).toEqual([
      'PENDING',
      'CONTEXT_BUILT',
      'LLM_CALLED',
      'TOOLS_DONE',
      'GATED',
      'DELIVERED',
      'DONE',
    ]);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.v2.tool_checkpoints).toHaveLength(1);
    expect(proof.v2.evidence.provider_calls).toBe(2);
    expect(gateway.requests).toHaveLength(2);
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
    const observations = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM loop_observations WHERE run_id = ?', runId)
        .one().n,
    );
    expect(observations).toBe(1);
  });

  it('bounds the exact multibyte V2 synthesis envelope before a second provider effect', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
    ]);
    const oversizedPrompt = '😀'.repeat(8_192);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as TestRunLoopInstance).__runLoopSetTestOverrides({
        gateway,
        contextComposer: oversizedSynthesisComposer(),
        replayArtifacts: replayArtifacts(),
      });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'llm_observe:request_oversize' });
    expect(proof.v2.evidence.provider_calls).toBe(1);
    expect(gateway.requests).toHaveLength(1);
    expect(proof.trace.map((event) => event.event)).not.toContain('llm_observed');
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });

    const persisted = await runInDurableObject(stub, (_instance, state) => [
      state.storage.sql.exec('SELECT * FROM runtime_invocation_v2 WHERE run_id = ?', runId).toArray(),
      state.storage.sql.exec('SELECT * FROM runtime_trace WHERE run_id = ?', runId).toArray(),
      state.storage.sql.exec('SELECT * FROM loop_observations WHERE run_id = ?', runId).toArray(),
      state.storage.sql.exec('SELECT * FROM journal WHERE run_id = ?', runId).toArray(),
      state.storage.sql.exec('SELECT * FROM outbox WHERE run_id = ?', runId).toArray(),
    ]);
    expect(JSON.stringify(persisted)).not.toContain(oversizedPrompt);
  });

  it('atomically records and terminalizes hostile provider receipts without replaying them', async () => {
    const providerCanary = `private-hostile-provider-response-canary-${'😀'.repeat(9_000)}`;
    const cases = [
      {
        name: 'initial plan',
        responses: [response(ROSTER.primary, providerCanary)],
        provider_calls: 1,
        gateway_requests: 1,
      },
      {
        name: 'synthesis',
        responses: [
          response(ROSTER.primary, toolCall('call-v2-first', 1)),
          response(ROSTER.primary, providerCanary),
        ],
        provider_calls: 2,
        gateway_requests: 2,
      },
    ] as const;

    for (const testCase of cases) {
      const stub = freshStub();
      const gateway = new ScriptedGateway(testCase.responses);
      const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
      await runInDurableObject(stub, (instance) => {
        (instance as unknown as TestRunLoopInstance).__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
        });
      });

      expect(await runDurableObjectAlarm(stub), testCase.name).toBe(true);
      const proof = await stub.readTrustedRunProof(runId);
      expect(proof.current, testCase.name).toEqual({
        state: 'FAILED',
        failure_reason: 'governor:token_budget_exhausted',
      });
      expect(proof.v2.evidence.provider_calls, testCase.name).toBe(testCase.provider_calls);
      expect(proof.v2.evidence.total_tokens, testCase.name).toBe(100_000);
      expect(gateway.requests, testCase.name).toHaveLength(testCase.gateway_requests);
      expect(proof.trace.map((event) => event.event).slice(-3), testCase.name).toEqual([
        'provider_effect_rejected',
        'governor_denied',
        'failed',
      ]);
      expect(
        proof.trace.find((event) => event.event === 'provider_effect_rejected')?.detail,
        testCase.name,
      ).toMatchObject({
        phase: testCase.name === 'initial plan' ? 'provider_plan' : 'provider_observe',
        outcome: 'invalid_response',
      });
      expect(proof.outbox, testCase.name).toEqual([]);
      expect(proof.sink, testCase.name).toEqual({ deliveries: 0, attempts: 0 });
      const persisted = await runInDurableObject(stub, (_instance, state) => [
        state.storage.sql.exec('SELECT * FROM runtime_invocation_v2 WHERE run_id = ?', runId).toArray(),
        state.storage.sql.exec('SELECT * FROM runtime_trace WHERE run_id = ?', runId).toArray(),
        state.storage.sql.exec('SELECT * FROM loop_observations WHERE run_id = ?', runId).toArray(),
        state.storage.sql.exec('SELECT * FROM journal WHERE run_id = ?', runId).toArray(),
        state.storage.sql.exec('SELECT * FROM outbox WHERE run_id = ?', runId).toArray(),
      ]);
      expect(JSON.stringify(persisted), testCase.name).not.toContain(
        'private-hostile-provider-response-canary',
      );

      await evictDurableObject(stub);
      await runInDurableObject(stub, async (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
        });
        await runLoop.__runLoopDriveRunForTest(runId);
      });
      expect(gateway.requests, `${testCase.name} restart`).toHaveLength(testCase.gateway_requests);
      expect((await stub.readTrustedRunProof(runId)).current, `${testCase.name} restart`).toEqual({
        state: 'FAILED',
        failure_reason: 'governor:token_budget_exhausted',
      });
    }
  });

  it.each([
    {
      phase: 'provider_plan' as const,
      responses: (providerCanary: string) => [response(ROSTER.primary, providerCanary)],
      physicalCalls: 1,
      providerCalls: 1,
      operations: ['issue', 'reconcile'],
    },
    {
      phase: 'provider_observe' as const,
      responses: (providerCanary: string) => [
        response(ROSTER.primary, toolCall('call-v2-first', 1)),
        response(ROSTER.primary, providerCanary),
      ],
      physicalCalls: 2,
      providerCalls: 2,
      operations: ['issue', 'issue', 'reconcile'],
    },
  ])(
    'reconciles a rejected %s provider receipt after reset without a second physical effect',
    async ({ phase, responses, physicalCalls, providerCalls, operations }) => {
      const providerCanary = `private-crash-window-provider-receipt-${'😀'.repeat(9_000)}`;
      const stub = freshStub();
      const gateway = new ScriptedGateway(responses(providerCanary));
      const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
      await runInDurableObject(stub, (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
        });
        runLoop.__runLoopCrashAfterTrustedProviderEffect = phase;
      });

      await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
        `crash-injection:TRUSTED_${phase.toUpperCase()}_EFFECT`,
      );
      expect(gateway.requests).toHaveLength(physicalCalls);
      const pendingAtCrash = await runInDurableObject(stub, (_instance, state) =>
        JSON.parse(
          state.storage.sql
            .exec<{ state_json: string }>(
              'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
              runId,
            )
            .one().state_json,
        ) as { pending_effect: { kind: string } | null },
      );
      expect(pendingAtCrash.pending_effect).toMatchObject({ kind: phase });

      await evictDurableObject(stub);
      await runInDurableObject(stub, async (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
        });
        await runLoop.__runLoopDriveRunForTest(runId);
      });

      const proof = await stub.readTrustedRunProof(runId);
      expect(proof.current).toEqual({
        state: 'FAILED',
        failure_reason: 'governor:token_budget_exhausted',
      });
      expect(proof.v2.evidence).toMatchObject({
        provider_calls: providerCalls,
        total_tokens: 100_000,
      });
      expect(gateway.operations).toEqual(operations);
      expect(gateway.reconciliations()).toBe(1);
      expect(gateway.requests).toHaveLength(physicalCalls);
      expect(proof.trace.filter((event) => event.event === 'provider_effect_rejected')).toHaveLength(1);
      expect(proof.outbox).toEqual([]);
      expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
      const persisted = await runInDurableObject(stub, (_instance, state) => [
        state.storage.sql.exec('SELECT * FROM runtime_invocation_v2 WHERE run_id = ?', runId).toArray(),
        state.storage.sql.exec('SELECT * FROM runtime_trace WHERE run_id = ?', runId).toArray(),
        state.storage.sql.exec('SELECT * FROM journal WHERE run_id = ?', runId).toArray(),
        state.storage.sql.exec('SELECT * FROM outbox WHERE run_id = ?', runId).toArray(),
      ]);
      expect(JSON.stringify(persisted)).not.toContain('private-crash-window-provider-receipt');
    },
  );

  it('settles a pending terminal provider receipt before failing a changed frozen context, without gate or sink effects', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfterTrustedProviderEffect = 'provider_observe';
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_PROVIDER_OBSERVE_EFFECT',
    );
    expect(gateway.requests).toHaveLength(2);

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: {
          async compose() {
            return { ok: false, failure: { code: 'materials_unavailable' } };
          },
        },
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'context:materials_unavailable',
    });
    expect(proof.v2.evidence.provider_calls).toBe(2);
    expect(gateway.operations).toEqual(['issue', 'issue', 'reconcile']);
    expect(gateway.requests).toHaveLength(2);
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(proof.trace.map((event) => event.event)).not.toContain('gated');
    expect(proof.trace.map((event) => event.event)).not.toContain('delivered');
  });

  it('rejects a bounded multibyte replay result when its exact synthesis envelope exceeds budget', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
    ]);
    const replayResult = {
      card: null,
      data: { body: '😀'.repeat(8_000) },
      ok: true,
      source_taint: null,
      tool: 'get_crs',
    };
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfter = 'TOOLS_DONE';
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:TOOLS_DONE');

    const checkpoint = await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one();
      const trusted = JSON.parse(row.state_json) as {
        record: {
          tool_checkpoints: Array<{
            call_ref: string;
            result_hash: string;
            result_ref: string;
            audit_ref: string;
          }>;
        };
      };
      const current = trusted.record.tool_checkpoints[0];
      if (current === undefined) throw new Error('expected completed trusted tool checkpoint');
      return current;
    });
    const resultHash = await sha256Hex(stableJsonStringifyForTest(replayResult));
    const [resultRefDigest, auditRefDigest] = await Promise.all([
      sha256Hex(stableJsonStringifyForTest({ result_hash: resultHash, run_id: runId })),
      sha256Hex(
        stableJsonStringifyForTest({
          call_ref: checkpoint.call_ref,
          result_hash: resultHash,
          run_id: runId,
        }),
      ),
    ]);
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one();
      const trusted = JSON.parse(row.state_json) as {
        record: {
          tool_checkpoints: Array<{
            result_hash: string;
            result_ref: string;
            audit_ref: string;
          }>;
        };
      };
      const current = trusted.record.tool_checkpoints[0];
      if (current === undefined) throw new Error('expected completed trusted tool checkpoint');
      current.result_hash = resultHash;
      current.result_ref = `res_${resultRefDigest.slice(0, 32)}`;
      current.audit_ref = `aud_${auditRefDigest.slice(0, 32)}`;
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify(trusted),
        runId,
      );
      state.storage.sql.exec(
        'UPDATE loop_observations SET result_hash = ? WHERE run_id = ?',
        resultHash,
        runId,
      );
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: {
          ...replayArtifacts(),
          async resolveToolResult() {
            return replayResult;
          },
        },
      });
      await runLoop.alarm();
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'llm_observe:request_oversize' });
    expect(proof.v2.evidence.provider_calls).toBe(1);
    expect(gateway.requests).toHaveLength(1);
    expect(proof.trace.map((event) => event.event)).not.toContain('llm_observed');
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    const persisted = await runInDurableObject(stub, (_instance, state) => [
      state.storage.sql.exec('SELECT * FROM runtime_invocation_v2 WHERE run_id = ?', runId).toArray(),
      state.storage.sql.exec('SELECT * FROM runtime_trace WHERE run_id = ?', runId).toArray(),
      state.storage.sql.exec('SELECT * FROM loop_observations WHERE run_id = ?', runId).toArray(),
      state.storage.sql.exec('SELECT * FROM journal WHERE run_id = ?', runId).toArray(),
      state.storage.sql.exec('SELECT * FROM outbox WHERE run_id = ?', runId).toArray(),
    ]);
    expect(JSON.stringify(persisted)).not.toContain(replayResult.data.body);
  });

  it('rejects structural replay artifacts before context persistence or provider work', async () => {
    const cases = [
      {
        name: 'global node budget',
        hostile: { marker: 'private-node-budget-checkpoint-canary', tree: uniqueBinaryTree(10) },
        canary: 'private-node-budget-checkpoint-canary',
      },
      {
        name: 'shared DAG',
        hostile: sharedDag(),
        canary: 'private-shared-dag-checkpoint-canary',
      },
      {
        name: 'oversized UTF-8 value before allocation',
        hostile: { marker: `private-oversized-value-canary${'x'.repeat(40_000)}` },
        canary: 'private-oversized-value-canary',
      },
      {
        name: 'oversized UTF-8 key before allocation',
        hostile: { [`private-oversized-key-canary${'k'.repeat(40_000)}`]: 'bounded-value' },
        canary: 'private-oversized-key-canary',
      },
    ];
    for (const testCase of cases) {
      const stub = freshStub();
      const gateway = new ScriptedGateway([]);
      const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
      await runInDurableObject(stub, (instance) => {
        (instance as unknown as TestRunLoopInstance).__runLoopSetTestOverrides({
          gateway,
          contextComposer: hostileCheckpointComposer(testCase.hostile),
          replayArtifacts: replayArtifacts(),
        });
      });

      expect(await runDurableObjectAlarm(stub), testCase.name).toBe(true);
      const proof = await stub.readRunProof(runId);
      expect(proof.current, testCase.name).toEqual({
        state: 'FAILED',
        failure_reason: 'context:assembly_failed',
      });
      expect(proof.outbox, testCase.name).toEqual([]);
      expect(proof.sink, testCase.name).toEqual({ deliveries: 0, attempts: 0 });
      expect(gateway.requests, testCase.name).toHaveLength(0);
      const persisted = await runInDurableObject(stub, (_instance, state) => ({
        sidecar: state.storage.sql
          .exec<{ state_json: string }>(
            'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
            runId,
          )
          .one(),
        trace: state.storage.sql
          .exec('SELECT * FROM runtime_trace WHERE run_id = ?', runId)
          .toArray(),
      }));
      expect(JSON.stringify(persisted), testCase.name).not.toContain(testCase.canary);
      expect(
        (JSON.parse(persisted.sidecar.state_json) as { record: { context: unknown } }).record.context,
        testCase.name,
      ).toBeNull();
    }
  });

  it('uses the trusted disposition truth table without fabricating proactive effects', async () => {
    const internalStub = freshStub();
    const internalComposer = frozenComposer();
    const internalGateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    let internalRunId = '';
    await runInDurableObject(internalStub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway: internalGateway,
        contextComposer: internalComposer.composer,
        replayArtifacts: replayArtifacts(),
      });
      internalRunId = await runLoop.__runLoopOpenTrustedRunForTest(
        trustedInput(trustedInternalAdmission()),
      );
      await runLoop.__runLoopDriveRunForTest(internalRunId);
    });

    const internal = await internalStub.readTrustedRunProof(internalRunId);
    expect(internal.v2.invocation.output.disposition).toBe('internal_no_output');
    expect(internal.fsm).toEqual([
      'PENDING',
      'CONTEXT_BUILT',
      'LLM_CALLED',
      'TOOLS_DONE',
      'LLM_CALLED',
      'TOOLS_DONE',
      'DONE',
    ]);
    expect(internal.trace.map((event) => event.event)).not.toContain('gated');
    expect(internal.trace.map((event) => event.event)).not.toContain('delivered');
    expect(internal.outbox).toEqual([]);
    expect(internal.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(internal.delivery_journal).toEqual({ state: 'DONE', verdict: null });
    expect((await internalStub.readRunEvidence(internalRunId)).eval.result).toBe('pass');
    const internalJournal = await runInDurableObject(internalStub, (_instance, state) =>
      state.storage.sql
        .exec<{ completion_mode: string | null }>(
          'SELECT completion_mode FROM journal WHERE run_id = ?',
          internalRunId,
        )
        .one(),
    );
    expect(internalJournal).toEqual({ completion_mode: 'trusted_internal_no_output' });

    // `user_message` is admitted through the bounded chat policy. The missing reply transport
    // still fails closed, but only after the normal V2/context/provider/tool/safety/egress path.
    const solicitedStub = freshStub();
    const solicitedComposer = frozenComposer();
    const solicitedGateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    let solicitedRunId = '';
    await runInDurableObject(solicitedStub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway: solicitedGateway,
        contextComposer: solicitedComposer.composer,
        replayArtifacts: replayArtifacts(),
      });
      solicitedRunId = await runLoop.__runLoopOpenTrustedRunForTest(
        trustedInput(solicitedAdmission()),
      );
      await runLoop.__runLoopDriveRunForTest(solicitedRunId);
    });
    const solicited = await solicitedStub.readTrustedRunProof(solicitedRunId);
    expect(solicited.v2.invocation.output.disposition).toBe('solicited_reply');
    expect(solicited.current).toEqual({
      state: 'FAILED',
      failure_reason: 'output:transport_unconfigured',
    });
    expect(solicited.trace.map((event) => event.event)).toContain('egress_checked');
    expect(solicited.trace.find((event) => event.event === 'egress_checked')?.detail).toEqual({
      disposition: 'solicited_reply',
      verdict: 'admit',
      reason: 'policy_admitted',
    });
    expect(solicited.trace.map((event) => event.event)).not.toContain('gated');
    expect(solicited.trace.map((event) => event.event)).not.toContain('delivered');
    expect(solicited.outbox).toEqual([]);
    expect(solicited.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(solicited.delivery_journal).toEqual({ state: 'FAILED', verdict: null });
    expect(solicitedComposer.calls()).toBeGreaterThan(0);
    expect(solicitedGateway.requests).toHaveLength(3);
    expect((await solicitedStub.readRunEvidence(solicitedRunId)).eval.result).toBe('pass');
    const replyBudgetRows = await runInDurableObject(solicitedStub, (_instance, state) => ({
      candidates: state.storage.sql
        .exec('SELECT candidate_json FROM run_candidates WHERE run_id = ?', solicitedRunId)
        .toArray(),
      outbox: state.storage.sql
        .exec('SELECT run_id FROM outbox WHERE run_id = ?', solicitedRunId)
        .toArray(),
      classState: state.storage.sql.exec('SELECT * FROM class_state').toArray(),
      dailyBudget: state.storage.sql.exec('SELECT * FROM daily_push_budget').toArray(),
      governor: state.storage.sql
        .exec<{ loop_type: string; tokens_used: number; iterations: number; verdict: string; reason: string }>(
          'SELECT loop_type, tokens_used, iterations, verdict, reason FROM loop_governor_runs WHERE run_id = ?',
          solicitedRunId,
        )
        .one(),
    }));
    expect(replyBudgetRows).toEqual({
      candidates: [],
      outbox: [],
      classState: [],
      dailyBudget: [],
      governor: {
        loop_type: 'chat',
        tokens_used: 90,
        iterations: 3,
        verdict: 'admit',
        reason: 'policy_admitted',
      },
    });
  });

  it('rejects a corrupted internal terminal journal on evidence read and terminal resume', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    let runId = '';
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runId = await runLoop.__runLoopOpenTrustedRunForTest(
        trustedInput(trustedInternalAdmission()),
      );
      await runLoop.__runLoopDriveRunForTest(runId);
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE journal SET completion_mode = NULL WHERE run_id = ?', runId);
    });

    await expect(
      runInDurableObject(stub, async (instance) => {
        await (instance as unknown as TestRunLoopInstance).__runLoopDriveRunForTest(runId);
      }),
    ).rejects.toThrow('completion_mode');
  });

  it('commits the trusted wake trace with admission and lets a duplicate restore scheduling', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const input = trustedInput(trustedScheduledAdmission());
    let admittedRunId = '';
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      // This guarded test seam executes the exact admission transaction but deliberately has no
      // scheduler registration. It models a process loss after the atomic admission commit.
      admittedRunId = await runLoop.__runLoopOpenTrustedRunForTest(input);
    });
    const atCrash = await stub.readTrustedRunProof(admittedRunId);
    expect(atCrash.current).toEqual({ state: 'PENDING', failure_reason: null });
    expect(atCrash.trace.map((event) => event.event)).toEqual(['scheduled_wake']);

    expect(await stub.__runLoopScheduleTrustedRunForTest(input)).toBe(admittedRunId);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const proof = await stub.readTrustedRunProof(admittedRunId);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.trace.filter((event) => event.event === 'scheduled_wake')).toHaveLength(1);
    expect(gateway.requests).toHaveLength(3);
  });

  it.each(['CONTEXT_BUILT', 'LLM_CALLED', 'TOOLS_DONE', 'GATED', 'DELIVERED'] as const)(
    'restarts the V2 durable loop from %s without repeating provider or delivery effects',
    async (crashAfter) => {
      const stub = freshStub();
      const composer = frozenComposer();
      const gateway = new ScriptedGateway([
        response(ROSTER.primary, toolCall('call-v2-first', 1)),
        response(ROSTER.primary, toolCall('call-v2-second', 2)),
        response(ROSTER.primary, 'safe ephemeral synthesis'),
      ]);
      const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
      await runInDurableObject(stub, (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: composer.composer,
          replayArtifacts: replayArtifacts(),
        });
        runLoop.__runLoopCrashAfter = crashAfter;
      });

      await expect(runDurableObjectAlarm(stub)).rejects.toThrow(`crash-injection:${crashAfter}`);
      const atCrash = await stub.readTrustedRunProof(runId);
      expect(atCrash.fsm.at(-1)).toBe(crashAfter);
      expect(atCrash.trace.at(-1)?.event).toBe(
        {
          CONTEXT_BUILT: 'context_built',
          LLM_CALLED: 'llm_called',
          TOOLS_DONE: 'tool_dispatched',
          GATED: 'gated',
          DELIVERED: 'delivered',
        }[crashAfter],
      );
      await evictDurableObject(stub);

      await runInDurableObject(stub, async (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
        });
        await runLoop.alarm();
      });

      const proof = await stub.readTrustedRunProof(runId);
      expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
      expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
      expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
      expect(gateway.requests).toHaveLength(3);
    },
  );

  it('resumes a committed trusted admission before CONTEXT_BUILT without a second admission', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfterTrustedAdmission = true;
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:TRUSTED_ADMISSION');
    expect((await stub.readRunProof(runId)).current).toEqual({ state: 'PENDING', failure_reason: null });
    expect((await stub.readRunProof(runId)).delivery_journal).toEqual({
      state: 'GOVERNOR_ADMITTED',
      verdict: null,
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.alarm();
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.trace.filter((event) => event.event === 'governor_admitted')).toHaveLength(1);
    expect(gateway.requests).toHaveLength(3);
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
  });

  it('reconciles a committed DeliveryGate before the V2 GATED transition without replaying effects', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfterTrustedGateCommit = true;
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:TRUSTED_GATE_COMMIT');
    const atCrash = await stub.readRunProof(runId);
    expect(atCrash.current).toEqual({ state: 'TOOLS_DONE', failure_reason: null });
    expect(atCrash.delivery_journal).toEqual({ state: 'GATED', verdict: 'send' });
    expect(atCrash.outbox).toEqual([{ kind: 'brief', status: 'pending', attempts: 0 }]);

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.alarm();
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.trace.filter((event) => event.event === 'gated')).toHaveLength(1);
    expect(gateway.requests).toHaveLength(3);
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
  });

  it('reconciles a terminal DeliveryGate hold after its journal commit without replaying effects', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance, state) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      const ownerScope = state.storage.sql
        .exec<{ user_id: string }>('SELECT user_id FROM journal WHERE run_id = ?', runId)
        .one().user_id;
      state.storage.sql.exec(
        `INSERT INTO class_state (user_id, local_date, push_class, count, last_sent_at)
         VALUES (?, ?, 'brief', 3, ?)`,
        ownerScope,
        '2026-07-16',
        SNAPSHOT_AT - 1,
      );
      runLoop.__runLoopCrashAfterTrustedGateTerminal = true;
    });

    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_GATE_TERMINAL',
    );
    const atCrash = await stub.readTrustedRunProof(runId);
    expect(atCrash.current).toEqual({ state: 'TOOLS_DONE', failure_reason: null });
    expect(atCrash.delivery_journal).toEqual({ state: 'FAILED', verdict: 'hold' });
    expect(atCrash.trace.map((event) => event.event)).not.toContain('gated');

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.alarm();
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'delivery_gate:class_cap_exhausted',
    });
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(gateway.requests).toHaveLength(3);
    const events = proof.trace.map((event) => event.event);
    expect(events.filter((event) => event === 'gated')).toHaveLength(1);
    expect(events.filter((event) => event === 'failed')).toHaveLength(1);
    expect(events.indexOf('gated')).toBe(events.indexOf('failed') - 1);
  });

  it('reconciles a terminal egress Governor denial after its journal commit without replaying effects', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfterTrustedSynthesisReceipt = true;
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_SYNTHESIS_RECEIPT',
    );

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopSetKillFlag({ scope: 'global', loopType: null, active: true });
      runLoop.__runLoopCrashAfterTrustedGovernorDeny = true;
      await expect(runLoop.alarm()).rejects.toThrow('crash-injection:TRUSTED_GOVERNOR_DENY');
    });

    const atCrash = await stub.readTrustedRunProof(runId);
    expect(atCrash.current).toEqual({ state: 'TOOLS_DONE', failure_reason: null });
    expect(atCrash.delivery_journal).toEqual({ state: 'FAILED', verdict: null });
    expect(atCrash.trace.map((event) => event.event)).not.toContain('governor_denied');
    expect(gateway.requests).toHaveLength(3);

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.alarm();
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'governor:kill_flag_active' });
    expect(proof.trace.map((event) => event.event)).not.toContain('gated');
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(gateway.requests).toHaveLength(3);
    const events = proof.trace.map((event) => event.event);
    expect(events.filter((event) => event === 'governor_denied')).toHaveLength(1);
    expect(events.filter((event) => event === 'failed')).toHaveLength(1);
    expect(events.indexOf('governor_denied')).toBe(events.indexOf('failed') - 1);
  });

  it('commits each trusted tool checkpoint with its Governor observation before a restart', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfterTrustedToolCheckpoint = true;
    });

    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_TOOL_CHECKPOINT',
    );
    const atCrash = await stub.readTrustedRunProof(runId);
    expect(atCrash.current).toEqual({ state: 'LLM_CALLED', failure_reason: null });
    expect(atCrash.v2.tool_checkpoints).toHaveLength(1);
    const observationsAtCrash = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM loop_observations WHERE run_id = ?', runId)
        .one().n,
    );
    expect(observationsAtCrash).toBe(1);

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.alarm();
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.v2.tool_checkpoints).toHaveLength(2);
    expect(gateway.requests).toHaveLength(3);
    const observations = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM loop_observations WHERE run_id = ?', runId)
        .one().n,
    );
    expect(observations).toBe(2);
  });

  it('fails before a second plan tool when a resumed first-result witness is unavailable', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(
        ROSTER.primary,
        toolCalls([
          { id: 'call-v2-first', rangeDays: 1 },
          { id: 'call-v2-second', rangeDays: 2 },
        ]),
      ),
    ]);
    const unavailableArtifacts: V2ReplayArtifacts = {
      async resolvePlan() {
        return [
          { id: 'call-v2-first', name: 'get_crs', args: { range_days: 1 } },
          { id: 'call-v2-second', name: 'get_crs', args: { range_days: 2 } },
        ];
      },
      async resolveToolResult() {
        throw new Error(PRIVATE_STAGED_INPUT);
      },
      async resolveSynthesis() {
        return 'safe ephemeral synthesis';
      },
    };
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: unavailableArtifacts,
      });
      runLoop.__runLoopCrashAfterTrustedToolCheckpoint = true;
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_TOOL_CHECKPOINT',
    );

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: unavailableArtifacts,
      });
      await runLoop.alarm();
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'replay:artifact_unavailable',
    });
    expect(proof.v2.tool_checkpoints).toHaveLength(1);
    expect(gateway.requests).toHaveLength(1);
    const observations = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM loop_observations WHERE run_id = ?', runId)
        .one().n,
    );
    expect(observations).toBe(1);
  });

  it('rejects a result-taint mutation before a resumed tool can execute', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfterTrustedToolCheckpoint = true;
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_TOOL_CHECKPOINT',
    );
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one();
      const persisted = JSON.parse(row.state_json) as {
        record: { tool_checkpoints: Array<{ guards: { result_taint: string | null } }> };
      };
      persisted.record.tool_checkpoints[0]!.guards.result_taint = 'external';
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify(persisted),
        runId,
      );
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.alarm();
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'replay:artifact_mismatch',
    });
    expect(gateway.requests).toHaveLength(1);
    const observations = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM loop_observations WHERE run_id = ?', runId)
        .one().n,
    );
    expect(observations).toBe(1);
  });

  it('fails closed before a fresh tool effect when a kill is already active', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfter = 'LLM_CALLED';
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:LLM_CALLED');

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO loop_kill_flags (flag_key, scope, loop_type, active, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        'global',
        'global',
        null,
        1,
        SNAPSHOT_AT,
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.readRunProof(runId)).delivery_journal).toEqual({
      state: 'FAILED',
      verdict: null,
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.alarm();
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'governor:kill_flag_active' });
    expect(proof.v2.tool_checkpoints).toEqual([]);
    expect(proof.trace.filter((event) => event.event === 'governor_denied')).toHaveLength(1);
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(gateway.requests).toHaveLength(1);
  });

  it('reuses the durable synthesis receipt after a crash without a fourth provider call', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfterTrustedSynthesisReceipt = true;
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_SYNTHESIS_RECEIPT',
    );
    expect((await stub.readRunProof(runId)).current).toEqual({
      state: 'TOOLS_DONE',
      failure_reason: null,
    });
    expect((await stub.readRunProof(runId)).trace.at(-1)?.event).toBe('llm_observed');
    expect(gateway.requests).toHaveLength(3);

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.alarm();
    });

    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
    expect(gateway.requests).toHaveLength(3);
  });

  it('fails closed at resumed tool and persisted-synthesis boundaries when the frozen context witness is unavailable', async () => {
    const failures: Array<{
      crash: 'tool_checkpoint' | 'synthesis_receipt';
      expected: 'context:provenance_invalid' | 'context:materials_unavailable';
      providerCalls: number;
    }> = [
      {
        crash: 'tool_checkpoint',
        expected: 'context:provenance_invalid',
        providerCalls: 1,
      },
      {
        crash: 'synthesis_receipt',
        expected: 'context:materials_unavailable',
        providerCalls: 3,
      },
    ];

    for (const failure of failures) {
      const stub = freshStub();
      const gateway = new ScriptedGateway([
        response(ROSTER.primary, toolCall('call-v2-first', 1)),
        response(ROSTER.primary, toolCall('call-v2-second', 2)),
        response(ROSTER.primary, 'safe ephemeral synthesis'),
      ]);
      const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
      await runInDurableObject(stub, (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
        });
        if (failure.crash === 'tool_checkpoint') {
          runLoop.__runLoopCrashAfterTrustedToolCheckpoint = true;
        } else {
          runLoop.__runLoopCrashAfterTrustedSynthesisReceipt = true;
        }
      });
      await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
        failure.crash === 'tool_checkpoint'
          ? 'crash-injection:TRUSTED_TOOL_CHECKPOINT'
          : 'crash-injection:TRUSTED_SYNTHESIS_RECEIPT',
      );
      await evictDurableObject(stub);

      await runInDurableObject(stub, async (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: {
            async compose() {
              return {
                ok: false,
                failure: {
                  code:
                    failure.expected === 'context:provenance_invalid'
                      ? 'provenance_invalid'
                      : 'materials_unavailable',
                },
              };
            },
          },
          replayArtifacts: replayArtifacts(),
        });
        await runLoop.alarm();
      });

      const proof = await stub.readRunProof(runId);
      expect(proof.current).toEqual({ state: 'FAILED', failure_reason: failure.expected });
      expect(proof.outbox).toEqual([]);
      expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
      expect(proof.delivery_journal).toEqual({ state: 'FAILED', verdict: null });
      expect(gateway.requests).toHaveLength(failure.providerCalls);
    }
  });

  it('fails closed before a resumed GATED run can flush its outbox when ContextComposer no longer matches', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfter = 'GATED';
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:GATED');
    expect((await stub.readRunProof(runId)).outbox).toEqual([{ kind: 'brief', status: 'pending', attempts: 0 }]);

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: {
          async compose() {
            return { ok: false, failure: { code: 'materials_unavailable' } };
          },
        },
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.alarm();
    });
    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'context:materials_unavailable' });
    expect(proof.delivery_journal).toEqual({ state: 'FAILED', verdict: 'send' });
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'pending', attempts: 0 }]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(gateway.requests).toHaveLength(3);
  });

  it('does not execute resumed tools when a locally-started V2 run is reconstructed in gateway mode', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfter = 'LLM_CALLED';
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:LLM_CALLED');
    expect(gateway.requests).toHaveLength(1);

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        providerMode: 'gateway',
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.alarm();
    });
    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'llm:spend_state_unavailable' });
    expect(proof.delivery_journal).toEqual({ state: 'FAILED', verdict: null });
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(gateway.requests).toHaveLength(1);
    const observations = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM loop_observations WHERE run_id = ?', runId)
        .one().n,
    );
    expect(observations).toBe(0);
  });

  it('rejects schema-valid plan and synthesis receipt identity mutations before replay', async () => {
    const mutations = [
      {
        field: 'plan_ref' as const,
        crash: 'LLM_CALLED' as const,
        crashError: 'crash-injection:LLM_CALLED',
        providerCalls: 1,
        failureReason: 'replay:artifact_mismatch',
      },
      {
        field: 'plan_effect_key' as const,
        crash: 'LLM_CALLED' as const,
        crashError: 'crash-injection:LLM_CALLED',
        providerCalls: 1,
        failureReason: 'replay:artifact_invalid',
      },
      {
        field: 'synthesis_ref' as const,
        crash: 'synthesis_receipt' as const,
        crashError: 'crash-injection:TRUSTED_SYNTHESIS_RECEIPT',
        providerCalls: 3,
        failureReason: 'replay:artifact_mismatch',
      },
      {
        field: 'synthesis_effect_digest' as const,
        crash: 'synthesis_receipt' as const,
        crashError: 'crash-injection:TRUSTED_SYNTHESIS_RECEIPT',
        providerCalls: 3,
        failureReason: 'replay:artifact_invalid',
      },
    ];
    for (const mutation of mutations) {
      const stub = freshStub();
      const gateway = new ScriptedGateway([
        response(ROSTER.primary, toolCall('call-v2-first', 1)),
        response(ROSTER.primary, toolCall('call-v2-second', 2)),
        response(ROSTER.primary, 'safe ephemeral synthesis'),
      ]);
      const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
      await runInDurableObject(stub, (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
        });
        if (mutation.crash === 'LLM_CALLED') {
          runLoop.__runLoopCrashAfter = 'LLM_CALLED';
        } else {
          runLoop.__runLoopCrashAfterTrustedSynthesisReceipt = true;
        }
      });
      await expect(runDurableObjectAlarm(stub)).rejects.toThrow(mutation.crashError);
      await runInDurableObject(stub, (_instance, state) => {
        const row = state.storage.sql
          .exec<{ state_json: string }>(
            'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
            runId,
          )
          .one();
        const trusted = JSON.parse(row.state_json) as {
          plan: { plan_ref: string; effect: { idempotency_key: string } } | null;
          synthesis: { result_ref: string; effect: { request_digest: string } } | null;
        };
        if (mutation.field === 'plan_ref') {
          if (trusted.plan === null) throw new Error('expected plan receipt');
          trusted.plan.plan_ref = 'pln_ffffffffffffffffffffffffffffffff';
        } else if (mutation.field === 'plan_effect_key') {
          if (trusted.plan === null) throw new Error('expected plan receipt');
          trusted.plan.effect.idempotency_key = 'idk_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
        } else if (mutation.field === 'synthesis_ref') {
          if (trusted.synthesis === null) throw new Error('expected synthesis receipt');
          trusted.synthesis.result_ref = 'syn_ffffffffffffffffffffffffffffffff';
        } else {
          if (trusted.synthesis === null) throw new Error('expected synthesis receipt');
          trusted.synthesis.effect.request_digest = 'f'.repeat(64);
        }
        state.storage.sql.exec(
          'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
          JSON.stringify(trusted),
          runId,
        );
      });
      await evictDurableObject(stub);
      await runInDurableObject(stub, async (instance) => {
        const runLoop = instance as unknown as TestRunLoopInstance;
        runLoop.__runLoopSetTestOverrides({
          gateway,
          contextComposer: frozenComposer().composer,
          replayArtifacts: replayArtifacts(),
        });
        await runLoop.alarm();
      });
      const proof = await stub.readRunProof(runId);
      // Key mutations fail at the V2 state boundary. Artifact-reference mutations preserve the
      // more precise replay mismatch diagnosis after their deterministic witness check.
      expect(proof.current).toEqual({ state: 'FAILED', failure_reason: mutation.failureReason });
      expect(proof.outbox).toEqual([]);
      expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
      expect(gateway.requests).toHaveLength(mutation.providerCalls);
    }
  });

  it('fails closed before a forged unresolved provider intent can cross the proactive gate', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfterTrustedSynthesisReceipt = true;
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_SYNTHESIS_RECEIPT',
    );

    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one();
      const trusted = JSON.parse(row.state_json) as { pending_effect: unknown };
      // This was formerly schema-valid: TOOLS_DONE could use the settled synthesis fast path
      // while silently retaining an unrelated unresolved provider intent.
      trusted.pending_effect = {
        kind: 'provider_observe',
        effect_ref: 'eff_ffffffffffffffffffffffffffffffff',
        idempotency_key: 'idk_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        request_digest: 'f'.repeat(64),
        iteration: 4,
      };
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify(trusted),
        runId,
      );
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'replay:artifact_invalid' });
    expect(proof.trace.map((event) => event.event)).not.toContain('gated');
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(gateway.requests).toHaveLength(3);
  });

  it('fails closed before a stale pending tool intent can bypass its settled call', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(
        ROSTER.primary,
        toolCalls([
          { id: 'call-v2-first', rangeDays: 1 },
          { id: 'call-v2-second', rangeDays: 2 },
        ]),
      ),
    ]);
    const countedTool = countingReconciledGetCrsHandler();
    const multiCallArtifacts: V2ReplayArtifacts = {
      async resolvePlan() {
        return [
          { id: 'call-v2-first', name: 'get_crs', args: { range_days: 1 } },
          { id: 'call-v2-second', name: 'get_crs', args: { range_days: 2 } },
        ];
      },
      async resolveToolResult() {
        return {
          ok: true,
          tool: 'get_crs',
          data: { summary: 'derived steady', body_state: 'steady' },
          card: null,
          source_taint: null,
        };
      },
      async resolveSynthesis() {
        return 'safe ephemeral synthesis';
      },
    };
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: multiCallArtifacts,
        trustedToolHandlers: [countedTool.handler],
      });
      runLoop.__runLoopCrashAfterTrustedToolCheckpoint = true;
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_TOOL_CHECKPOINT',
    );
    expect(countedTool.physicalCalls()).toBe(1);

    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one();
      const trusted = JSON.parse(row.state_json) as {
        pending_effect: unknown;
        record: {
          tool_checkpoints: Array<Extract<RuntimeToolCheckpoint, { status: 'completed' }>>;
        };
      };
      const settled = trusted.record.tool_checkpoints[0];
      if (settled === undefined) throw new Error('expected first settled tool checkpoint');
      // Use fresh opaque refs so the only contradiction is the attempted reuse of a completed
      // call as an unresolved intent. The second planned tool must never reach its handler.
      trusted.pending_effect = {
        kind: 'tool',
        effect_ref: 'eff_ffffffffffffffffffffffffffffffff',
        idempotency_key: 'idk_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        request_digest: 'f'.repeat(64),
        call_ref: settled.call_ref,
        tool: settled.tool,
        args_hash: settled.args_hash,
        argument_taint: settled.guards.argument_taint,
      };
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify(trusted),
        runId,
      );
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: multiCallArtifacts,
        trustedToolHandlers: [countedTool.handler],
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'replay:artifact_invalid' });
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(countedTool.physicalCalls()).toBe(1);
    expect(gateway.requests).toHaveLength(1);
  });

  it('rejects an extra schema-valid V2 tool checkpoint that lacks a Governor observation', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfter = 'TOOLS_DONE';
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:TOOLS_DONE');
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one();
      const trusted = JSON.parse(row.state_json) as {
        record: { tool_checkpoints: Array<Record<string, unknown>> };
        tool_effect_witnesses: Array<Record<string, unknown>>;
      };
      const checkpoint = trusted.record.tool_checkpoints[0];
      if (checkpoint === undefined) throw new Error('expected durable first tool checkpoint');
      const argsHash = checkpoint.args_hash;
      if (typeof argsHash !== 'string') throw new Error('expected durable checkpoint args hash');
      trusted.record.tool_checkpoints.push({
        ...checkpoint,
        call_ref: 'call_ffffffffffffffffffffffffffffffff',
      });
      // Keep the forged sidecar structurally valid under the receipt contract; the independent
      // Governor observation remains absent, which is the integrity condition under test.
      trusted.tool_effect_witnesses.push({
        kind: 'tool',
        effect_ref: 'eff_ffffffffffffffffffffffffffffffff',
        idempotency_key: 'idk_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        request_digest: 'f'.repeat(64),
        call_ref: 'call_ffffffffffffffffffffffffffffffff',
        tool: 'get_crs',
        args_hash: argsHash,
        argument_taint: null,
      });
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify(trusted),
        runId,
      );
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.alarm();
    });
    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'replay:artifact_invalid' });
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(gateway.requests).toHaveLength(1);
  });

  it('does not replay a failed artifact through a completed V2 tool checkpoint', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfterTrustedToolCheckpoint = true;
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_TOOL_CHECKPOINT',
    );
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: {
          ...replayArtifacts(),
          async resolveToolResult() {
            return {
              ok: false,
              tool: 'get_crs',
              code: 'transient',
              reason: 'handler_failed',
              error: 'redacted failure',
              source_taint: null,
            };
          },
        },
      });
      await runLoop.alarm();
    });
    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'replay:artifact_invalid' });
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(gateway.requests).toHaveLength(1);
  });

  it('bounds a hostile provider plan before any governed tool side effect while retaining Governor usage', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(
        ROSTER.primary,
        toolCalls(
          Array.from({ length: 17 }, (_value, index) => ({
            id: `call-over-budget-${index}`,
            rangeDays: index + 1,
          })),
        ),
      ),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as TestRunLoopInstance).__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'tool_parse:invalid_args' });
    expect(proof.trace.map((event) => event.event)).toContain('tool_parse_failed');
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(gateway.requests).toHaveLength(1);
    const durableBounds = await runInDurableObject(stub, (_instance, state) => ({
      observations: state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM loop_observations WHERE run_id = ?', runId)
        .one().n,
      usage: state.storage.sql
        .exec<{ tokens_used: number; iterations: number }>(
          'SELECT tokens_used, iterations FROM loop_governor_runs WHERE run_id = ?',
          runId,
        )
        .one(),
    }));
    expect(durableBounds).toEqual({ observations: 0, usage: { tokens_used: 30, iterations: 1 } });
  });

  it('resumes a valid 16-call plan after its first committed checkpoint without double-counting capacity', async () => {
    const sixteenCalls = Array.from({ length: 16 }, (_value, index) => ({
      id: `call-capacity-${index}`,
      rangeDays: index + 1,
    }));
    const sixteenReplayArtifacts = (): V2ReplayArtifacts => ({
      ...replayArtifacts(),
      async resolvePlan(input) {
        if (input.iteration !== 1) throw new Error('unexpected continuation for capacity fixture');
        return sixteenCalls.map(({ id, rangeDays }) => ({
          id,
          name: 'get_crs',
          args: { range_days: rangeDays },
        }));
      },
    });
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCalls(sixteenCalls)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: sixteenReplayArtifacts(),
      });
      runLoop.__runLoopCrashAfterTrustedToolCheckpoint = true;
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      'crash-injection:TRUSTED_TOOL_CHECKPOINT',
    );
    expect(gateway.requests).toHaveLength(1);

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: sixteenReplayArtifacts(),
      });
      await runLoop.alarm();
    });
    const proof = await stub.readTrustedRunProof(runId);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.v2.tool_checkpoints).toHaveLength(16);
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
    expect(gateway.requests).toHaveLength(2);
  });

  it('fails closed on a replay-witness failure, hostile artifact, missing sidecar, and gateway mode', async () => {
    const failures: Array<{
      input: (stub: TrustedRunLoopStub) => Promise<string>;
      configure: (runLoop: TestRunLoopInstance, gateway: ScriptedGateway) => void;
      expected: string;
      providerCalls: number;
    }> = [
      {
        input: async (stub) => stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission())),
        configure: (runLoop, gateway) => {
          const frozen = frozenComposer();
          runLoop.__runLoopSetTestOverrides({
            gateway,
            contextComposer: {
              async compose(invocation, inputs) {
                if (inputs.replay_context_ref !== null) {
                  return { ok: false, failure: { code: 'provenance_invalid' } };
                }
                return frozen.composer.compose(invocation, inputs);
              },
            },
            replayArtifacts: replayArtifacts(),
          });
        },
        expected: 'context:provenance_invalid',
        providerCalls: 0,
      },
      {
        input: async (stub) => stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission())),
        configure: (runLoop, gateway) => {
          const frozen = frozenComposer();
          runLoop.__runLoopSetTestOverrides({
            gateway,
            contextComposer: {
              async compose(invocation, inputs) {
                const composed = await frozen.composer.compose(invocation, inputs);
                if (!composed.ok) return composed;
                return {
                  ...composed,
                  checkpoint: {
                    ...composed.checkpoint,
                    tenant_ref: 'ten_ffffffffffffffffffffffffffffffff',
                  },
                };
              },
            },
            replayArtifacts: replayArtifacts(),
          });
        },
        expected: 'context:provenance_invalid',
        providerCalls: 0,
      },
      {
        input: async (stub) => stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission())),
        configure: (runLoop, gateway) => {
          const frozen = frozenComposer();
          runLoop.__runLoopSetTestOverrides({
            gateway,
            contextComposer: {
              async compose(invocation, inputs) {
                const composed = await frozen.composer.compose(invocation, inputs);
                if (!composed.ok || inputs.replay_context_ref === null) return composed;
                return {
                  ...composed,
                  checkpoint: {
                    ...composed.checkpoint,
                    context_ref: 'ctx_ffffffffffffffffffffffffffffffff',
                  },
                };
              },
            },
            replayArtifacts: replayArtifacts(),
          });
        },
        expected: 'context:provenance_invalid',
        providerCalls: 0,
      },
      {
        input: async (stub) => stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission())),
        configure: (runLoop, gateway) => {
          runLoop.__runLoopSetTestOverrides({
            gateway,
            contextComposer: {
              async compose() {
                throw new Error(PRIVATE_STAGED_INPUT);
              },
            },
            replayArtifacts: replayArtifacts(),
          });
        },
        expected: 'context:assembly_failed',
        providerCalls: 0,
      },
      {
        input: async (stub) => stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission())),
        configure: (runLoop, gateway) => {
          runLoop.__runLoopSetTestOverrides({
            gateway,
            contextComposer: {
              async compose() {
                return {
                  ok: true,
                  prompt: 'not-a-valid-composition',
                  checkpoint: {},
                  evidence: {},
                } as never;
              },
            },
            replayArtifacts: replayArtifacts(),
          });
        },
        expected: 'context:assembly_failed',
        providerCalls: 0,
      },
      {
        input: async (stub) => stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission())),
        configure: (runLoop, gateway) => {
          runLoop.__runLoopSetTestOverrides({
            gateway,
            contextComposer: {
              async compose() {
                return null as never;
              },
            },
            replayArtifacts: replayArtifacts(),
          });
        },
        expected: 'context:assembly_failed',
        providerCalls: 0,
      },
      {
        input: async (stub) => stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission())),
        configure: (runLoop, gateway) => {
          runLoop.__runLoopSetTestOverrides({
            gateway,
            contextComposer: {
              async compose() {
                return { ok: false, failure: { code: PRIVATE_STAGED_INPUT } } as never;
              },
            },
            replayArtifacts: replayArtifacts(),
          });
        },
        expected: 'context:assembly_failed',
        providerCalls: 0,
      },
      {
        input: async (stub) => stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission())),
        configure: (runLoop, gateway) => {
          runLoop.__runLoopSetTestOverrides({
            gateway,
            contextComposer: frozenComposer().composer,
            replayArtifacts: {
              ...replayArtifacts(),
              async resolvePlan() {
                throw new Error(PRIVATE_STAGED_INPUT);
              },
            },
          });
        },
        expected: 'replay:artifact_unavailable',
        providerCalls: 1,
      },
      {
        input: async (stub) => stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission())),
        configure: (runLoop, gateway) => {
          runLoop.__runLoopSetTestOverrides({
            gateway,
            providerMode: 'gateway',
            contextComposer: frozenComposer().composer,
            replayArtifacts: replayArtifacts(),
          });
        },
        expected: 'llm:spend_state_unavailable',
        providerCalls: 0,
      },
    ];

    for (const failure of failures) {
      const stub = freshStub();
      const gateway = new ScriptedGateway([
        response(ROSTER.primary, toolCall('call-failure', 1)),
      ]);
      const runId = await failure.input(stub);
      await runInDurableObject(stub, (instance) => {
        failure.configure(instance as unknown as TestRunLoopInstance, gateway);
      });
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      const proof = await stub.readRunProof(runId);
      expect(proof.current).toEqual({ state: 'FAILED', failure_reason: failure.expected });
      expect(proof.outbox).toEqual([]);
      expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
      expect(gateway.requests).toHaveLength(failure.providerCalls);
      expect(JSON.stringify(proof)).not.toContain(PRIVATE_STAGED_INPUT);
    }

    const missingStub = freshStub();
    const missingRunId = await missingStub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(missingStub, async (instance, state) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway: new ScriptedGateway([]),
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      state.storage.sql.exec('DELETE FROM runtime_invocation_v2 WHERE run_id = ?', missingRunId);
      await runLoop.__runLoopDriveRunForTest(missingRunId);
    });
    expect((await missingStub.readRunProof(missingRunId)).current).toEqual({
      state: 'FAILED',
      failure_reason: 'replay:artifact_invalid',
    });

    const tamperedStub = freshStub();
    const tamperedRunId = await tamperedStub.__runLoopScheduleTrustedRunForTest(
      trustedInput(trustedScheduledAdmission()),
    );
    const tamperedState = JSON.stringify({ prompt: PRIVATE_STAGED_INPUT });
    await runInDurableObject(tamperedStub, async (instance, state) => {
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        tamperedState,
        tamperedRunId,
      );
      await (instance as unknown as TestRunLoopInstance).__runLoopDriveRunForTest(tamperedRunId);
    });
    const tampered = await runInDurableObject(tamperedStub, (_instance, state) =>
      state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          tamperedRunId,
        )
        .one(),
    );
    expect((await tamperedStub.readRunProof(tamperedRunId)).current).toEqual({
      state: 'FAILED',
      failure_reason: 'replay:artifact_invalid',
    });
    expect(tampered.state_json).toBe('{"format":"corrupt_v2_state"}');
    expect(tampered.state_json).not.toContain(PRIVATE_STAGED_INPUT);
    expect(
      await tamperedStub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission())),
    ).toBe(tamperedRunId);

    const canonicalStub = freshStub();
    const canonicalRunId = await canonicalStub.__runLoopScheduleTrustedRunForTest(
      trustedInput(trustedScheduledAdmission()),
    );
    const canonicalGateway = new ScriptedGateway([]);
    await runInDurableObject(canonicalStub, async (instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          canonicalRunId,
        )
        .one();
      const stateJson = JSON.parse(row.state_json) as {
        record: { invocation: { verified_authority: { tenant_ref: string } } };
      };
      stateJson.record.invocation.verified_authority.tenant_ref =
        'ten_ffffffffffffffffffffffffffffffff';
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify(stateJson),
        canonicalRunId,
      );
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway: canonicalGateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.__runLoopDriveRunForTest(canonicalRunId);
    });
    expect((await canonicalStub.readRunProof(canonicalRunId)).current).toEqual({
      state: 'FAILED',
      failure_reason: 'replay:artifact_invalid',
    });
    expect(canonicalGateway.requests).toHaveLength(0);

    const markerStub = freshStub();
    const markerRunId = await markerStub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(markerStub, async (instance, state) => {
      state.storage.sql.exec(
        'UPDATE runtime_runs SET invocation_format = NULL WHERE run_id = ?',
        markerRunId,
      );
      await (instance as unknown as TestRunLoopInstance).__runLoopDriveRunForTest(markerRunId);
    });
    expect((await markerStub.readRunProof(markerRunId)).current).toEqual({
      state: 'FAILED',
      failure_reason: 'replay:artifact_invalid',
    });

    const gatedStub = freshStub();
    const gatedComposer = frozenComposer();
    const gatedGateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const gatedRunId = await gatedStub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(gatedStub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway: gatedGateway,
        contextComposer: gatedComposer.composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfter = 'GATED';
    });
    await expect(runDurableObjectAlarm(gatedStub)).rejects.toThrow('crash-injection:GATED');
    await runInDurableObject(gatedStub, async (instance, state) => {
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        tamperedState,
        gatedRunId,
      );
      await (instance as unknown as TestRunLoopInstance).__runLoopDriveRunForTest(gatedRunId);
    });
    const gated = await gatedStub.readRunProof(gatedRunId);
    expect(gated.current).toEqual({ state: 'FAILED', failure_reason: 'replay:artifact_invalid' });
    expect(gated.delivery_journal).toEqual({ state: 'FAILED', verdict: 'send' });
    expect(gated.outbox).toEqual([{ kind: 'brief', status: 'pending', attempts: 0 }]);
    expect(gated.sink).toEqual({ deliveries: 0, attempts: 0 });
  });

  it('preserves one acknowledged delivery while terminalizing an ACK-window sidecar corruption', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopOutboxCrashPoint = 'post_ack_pre_return';
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:post_ack_pre_return');
    const ackWindow = await stub.readRunProof(runId);
    expect(ackWindow.current).toEqual({ state: 'GATED', failure_reason: null });
    expect(ackWindow.delivery_journal).toEqual({ state: 'ACK_RECORDED', verdict: 'send' });
    expect(ackWindow.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(ackWindow.sink).toEqual({ deliveries: 1, attempts: 1 });

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify({ raw: PRIVATE_STAGED_INPUT }),
        runId,
      );
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });
    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'replay:artifact_invalid' });
    expect(proof.delivery_journal).toEqual({ state: 'DONE', verdict: 'send' });
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
    expect((await stub.readRunEvidence(runId)).eval.result).toBe('pass');
    const sidecar = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one(),
    );
    expect(sidecar.state_json).toBe('{"format":"corrupt_v2_state"}');
    expect(sidecar.state_json).not.toContain(PRIVATE_STAGED_INPUT);
  });

  it('records a terminal post-delivery V2 corruption without duplicating the acknowledged effect', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfter = 'DELIVERED';
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:DELIVERED');
    expect((await stub.readRunProof(runId)).current).toEqual({ state: 'DELIVERED', failure_reason: null });

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify({ raw: PRIVATE_RECALL }),
        runId,
      );
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });
    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'replay:artifact_invalid' });
    expect(proof.delivery_journal).toEqual({ state: 'DONE', verdict: 'send' });
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
    expect((await stub.readRunEvidence(runId)).eval.result).toBe('pass');
    const sidecar = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one(),
    );
    expect(sidecar.state_json).toBe('{"format":"corrupt_v2_state"}');
    expect(sidecar.state_json).not.toContain(PRIVATE_RECALL);
  });

  it('records a typed integrity failure for a corrupted V2 sidecar discovered after DONE', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as TestRunLoopInstance).__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.readRunProof(runId)).current).toEqual({ state: 'DONE', failure_reason: null });

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify({ raw: PRIVATE_STAGED_INPUT }),
        runId,
      );
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'replay:artifact_invalid' });
    // A completed delivery remains durable truth; terminal integrity reporting does not rewrite
    // the acknowledged effect or issue a replacement provider/delivery call.
    expect(proof.delivery_journal).toEqual({ state: 'DONE', verdict: 'send' });
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
    expect(gateway.requests).toHaveLength(3);
    expect((await stub.readRunEvidence(runId)).eval.result).toBe('pass');
    const sidecar = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one(),
    );
    expect(sidecar.state_json).toBe('{"format":"corrupt_v2_state"}');
    expect(sidecar.state_json).not.toContain(PRIVATE_STAGED_INPUT);
  });

  it('recomposes at a DELIVERED restart and preserves the acknowledged ledger on typed source failure', async () => {
    const stub = freshStub();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: frozenComposer().composer,
        replayArtifacts: replayArtifacts(),
      });
      runLoop.__runLoopCrashAfter = 'DELIVERED';
    });
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:DELIVERED');
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: {
          async compose() {
            return { ok: false, failure: { code: 'materials_unavailable' } };
          },
        },
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.alarm();
    });
    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'context:materials_unavailable' });
    expect(proof.delivery_journal).toEqual({ state: 'DONE', verdict: 'send' });
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
    expect(gateway.requests).toHaveLength(3);
    expect((await stub.readRunEvidence(runId)).eval.result).toBe('pass');
  });

  it('fails closed when a mutable sidecar tries to replace the frozen admission snapshot', async () => {
    const stub = freshStub();
    const composer = frozenComposer();
    const gateway = new ScriptedGateway([
      response(ROSTER.primary, toolCall('call-v2-first', 1)),
      response(ROSTER.primary, toolCall('call-v2-second', 2)),
      response(ROSTER.primary, 'safe ephemeral synthesis'),
    ]);
    const input = trustedInput(trustedScheduledAdmission());
    const runId = await stub.__runLoopScheduleTrustedRunForTest(input);
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one();
      const trusted = JSON.parse(row.state_json) as {
        snapshot: { snapshot_ref: string; snapshot_at: number };
      };
      // This remains structurally valid and deliberately does not alter canonical duplicate
      // identity. It must still fail before ContextComposer sees the substitute snapshot.
      trusted.snapshot = {
        snapshot_ref: 'snp_00000000000000000000000000000000',
        snapshot_at: SNAPSHOT_AT + 1,
      };
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify(trusted),
        runId,
      );
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: composer.composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'replay:artifact_invalid' });
    expect(composer.calls()).toBe(0);
    expect(gateway.requests).toHaveLength(0);
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    const sidecar = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one(),
    );
    expect(sidecar.state_json).toBe('{"format":"corrupt_v2_state"}');
    expect(await stub.__runLoopScheduleTrustedRunForTest(input)).toBe(runId);
  });

  it('fails closed before a V2 disposition mutation can confuse solicited and proactive branches', async () => {
    const stub = freshStub();
    const composer = frozenComposer();
    const gateway = new ScriptedGateway([]);
    const runId = await stub.__runLoopScheduleTrustedRunForTest(trustedInput(trustedScheduledAdmission()));
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          'SELECT state_json FROM runtime_invocation_v2 WHERE run_id = ?',
          runId,
        )
        .one();
      const trusted = JSON.parse(row.state_json) as {
        record: { invocation: { output: unknown } };
      };
      // Keep the shape valid for a reply while contradicting the scheduler-derived disposition.
      // No caller or sidecar mutation may spend the proactive gate or invent a reply branch.
      trusted.record.invocation.output = {
        disposition: 'solicited_reply',
        correlation_ref: 'occ_dddddddddddddddddddddddddddddddd',
      };
      state.storage.sql.exec(
        'UPDATE runtime_invocation_v2 SET state_json = ? WHERE run_id = ?',
        JSON.stringify(trusted),
        runId,
      );
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as TestRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({
        gateway,
        contextComposer: composer.composer,
        replayArtifacts: replayArtifacts(),
      });
      await runLoop.__runLoopDriveRunForTest(runId);
    });

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'FAILED', failure_reason: 'replay:artifact_invalid' });
    expect(composer.calls()).toBe(0);
    expect(gateway.requests).toHaveLength(0);
    expect(proof.trace.map((event) => event.event)).not.toContain('gated');
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
  });

  it('returns one run for concurrent duplicate trusted admissions', async () => {
    const stub = freshStub();
    const input = trustedInput(trustedScheduledAdmission());
    const alternateFrozenSnapshot = {
      ...input,
      snapshot_ref: 'snp_00000000000000000000000000000000',
      snapshot_at: SNAPSHOT_AT + 1,
    };
    const runIds = await Promise.all([
      stub.__runLoopScheduleTrustedRunForTest(input),
      stub.__runLoopScheduleTrustedRunForTest(input),
      stub.__runLoopScheduleTrustedRunForTest(input),
      stub.__runLoopScheduleTrustedRunForTest(alternateFrozenSnapshot),
    ]);
    expect(new Set(runIds).size).toBe(1);
    expect((await stub.readTrustedRunProof(runIds[0]!)).v2.snapshot).toEqual({
      snapshot_ref: input.snapshot_ref,
      snapshot_at: input.snapshot_at,
    });
    const rows = await runInDurableObject(stub, (_instance, state) => [
      state.storage.sql.exec('SELECT run_id FROM runtime_runs').toArray(),
      state.storage.sql.exec('SELECT run_id FROM runtime_invocation_v2').toArray(),
      state.storage.sql.exec('SELECT run_id FROM journal').toArray(),
    ]);
    expect(rows.map((table) => table)).toEqual([[{ run_id: runIds[0] }], [{ run_id: runIds[0] }], [{ run_id: runIds[0] }]]);
  });
});
