import {
  type AdapterResult,
  type DeliverySink,
  type LLMResponse,
  type SanitiseResult,
  type SinkAck,
  type SinkRequest,
} from '@waldo/contracts';
import type { HookRuntimeContext } from '../hooks/registry';
import {
  CloudflareAIGatewayAdapter,
  type GatewaySecretBinding,
} from '../llm/gateway';
import type { LLMGatewayAdapter, LLMGatewayRequest, RouteSpendState } from '../llm/provider';
import { productionDeps, type Deps } from '../seams/deps';

export const RUN_LOOP_DELIVERY_TEXT = 'Derived steady-state brief ready for delivery.';
export const RUN_LOOP_PLAN_SYSTEM_PREFIX = 'run-loop:plan';
export const RUN_LOOP_OBSERVE_SYSTEM_PREFIX = 'run-loop:observe';

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
};

export type RunLoopTestOverrides = {
  gateway?: LLMGatewayAdapter;
  sink?: DeliverySink;
  spend?: RouteSpendState | null;
  spendReader?: RunLoopSpendReader;
  providerMode?: RunLoopProviderMode;
  deliveryTextFallback?: string;
};

type ResolveRunLoopAdaptersOptions = {
  deps?: Deps;
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
    if ((request.request.system ?? '').startsWith(RUN_LOOP_OBSERVE_SYSTEM_PREFIX)) {
      return {
        ok: true,
        data: {
          model: request.request.model,
          text: RUN_LOOP_DELIVERY_TEXT,
          input_tokens: 16,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          latency_ms: 1,
        },
      };
    }

    return {
      ok: true,
      data: {
        model: request.request.model,
        text: JSON.stringify({
          tool_calls: [
            {
              id: 'call-get-crs',
              name: 'get_crs',
              arguments: { range_days: 1 },
            },
          ],
        }),
        input_tokens: 24,
        output_tokens: 12,
        cache_read_input_tokens: 0,
        latency_ms: 1,
      },
    };
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
    sanitise: ({ text }) => ({ ok: true, output: text, redactions: [] }),
    medicalGate: () => true,
  };
}

function failClosedSafety(): RunLoopSafetyCallbacks {
  const blocked = (): SanitiseResult => ({ ok: false, reason: 'untrusted_instruction' });
  return {
    rateLimitCheck: () => ({ ok: false, reason: 'rate limit check unconfigured', code: 'transient' }),
    hasApproval: () => false,
    sanitise: blocked,
    medicalGate: () => ({ ok: false, reason: 'medical gate unconfigured', code: 'transient' }),
  };
}
