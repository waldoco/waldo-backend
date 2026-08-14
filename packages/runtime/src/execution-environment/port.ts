import {
  exactRevisionV04Schema,
  executionEnvironmentRefV04Schema,
  iso8601Schema,
  protocolDigestSchema,
  protocolIdSchema,
  protocolNameSchema,
  protocolRevisionSchema,
  providerRefV04Schema,
} from '@waldo/contracts';

export const EXECUTION_ENVIRONMENT_ACTIONS = Object.freeze([
  'start',
  'resume',
  'steer',
  'pause',
  'cancel',
  'reconcile',
] as const);

export type ExecutionEnvironmentAction = typeof EXECUTION_ENVIRONMENT_ACTIONS[number];
export type ExecutionEnvironmentSupportMode = 'native' | 'emulated' | 'unsupported';

type ProviderRefV04 = ReturnType<typeof providerRefV04Schema.parse>;
type EnvironmentRefV04 = ReturnType<typeof executionEnvironmentRefV04Schema.parse>;

export type ExecutionEnvironmentCapability = Readonly<{
  mode: ExecutionEnvironmentSupportMode;
  version: string;
}>;

export type ExecutionEnvironmentDescriptorV1 = Readonly<{
  protocolVersion: '0.4';
  adapter: Readonly<{ id: string; version: string }>;
  environment: EnvironmentRefV04;
  capabilities: Readonly<Record<ExecutionEnvironmentAction, ExecutionEnvironmentCapability>>;
}>;

export type ExecutionEnvironmentCommandV1 = Readonly<{
  protocolVersion: '0.4';
  category: 'execution_environment_command';
  operationId: string;
  operationDigest: string;
  action: ExecutionEnvironmentAction;
  adapter: Readonly<{ id: string; version: string }>;
  capability: Readonly<{
    action: ExecutionEnvironmentAction;
    mode: Exclude<ExecutionEnvironmentSupportMode, 'unsupported'>;
    version: string;
  }>;
  executionRequestId: string;
  attemptId: string;
  sessionId: string;
  leaseId: string;
  fencingGeneration: number;
  cancellationGeneration: number;
  leaseExpiresAt: string;
  operationIntentRef: string;
  operationIntentDigest: string;
  provider: ProviderRefV04;
  environment: EnvironmentRefV04;
  contextProjectionRef: string;
  contextProjectionDigest: string;
  control: Readonly<{ payloadRef: string; payloadDigest: string }> | null;
}>;

export interface ExecutionEnvironmentPort {
  readonly descriptor: ExecutionEnvironmentDescriptorV1;
  /**
   * Adapters must durably deduplicate operation identity and reject expired,
   * lower-generation, or conflicting-lease commands before external apply.
   * Invocation is the issue linearization point: the final local check and
   * target-side fenced apply must not have an unfenced asynchronous gap.
   */
  execute(command: ExecutionEnvironmentCommandV1): Promise<unknown>;
  /** Receipt recovery is read-only and must never issue the operation. */
  recover(command: ExecutionEnvironmentCommandV1): Promise<unknown>;
}

export type RegisteredExecutionEnvironment = Readonly<{
  descriptor: ExecutionEnvironmentDescriptorV1;
  execute(command: ExecutionEnvironmentCommandV1): Promise<unknown>;
  recover(command: ExecutionEnvironmentCommandV1): Promise<unknown>;
}>;

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a strict object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} contains unrecognized or missing fields`);
  }
}

function parseSupportMode(value: unknown): ExecutionEnvironmentSupportMode {
  if (value !== 'native' && value !== 'emulated' && value !== 'unsupported') {
    throw new Error('execution environment capability mode is invalid');
  }
  return value;
}

export function parseExecutionEnvironmentDescriptorV1(
  value: unknown,
): ExecutionEnvironmentDescriptorV1 {
  const input = strictRecord(value, 'execution environment descriptor');
  requireExactKeys(
    input,
    ['protocolVersion', 'adapter', 'environment', 'capabilities'],
    'execution environment descriptor',
  );
  if (input.protocolVersion !== '0.4') {
    throw new Error('execution environment descriptor protocol version is invalid');
  }
  const adapter = strictRecord(input.adapter, 'execution environment adapter identity');
  requireExactKeys(adapter, ['id', 'version'], 'execution environment adapter identity');
  const parsedAdapter = Object.freeze({
    id: protocolIdSchema.parse(adapter.id),
    version: protocolNameSchema.parse(adapter.version),
  });
  const capabilities = strictRecord(input.capabilities, 'execution environment capabilities');
  requireExactKeys(
    capabilities,
    EXECUTION_ENVIRONMENT_ACTIONS,
    'execution environment capabilities',
  );
  const parsedCapabilities = Object.fromEntries(EXECUTION_ENVIRONMENT_ACTIONS.map((action) => {
    const capability = strictRecord(
      capabilities[action],
      `execution environment ${action} capability`,
    );
    requireExactKeys(
      capability,
      ['mode', 'version'],
      `execution environment ${action} capability`,
    );
    return [action, Object.freeze({
      mode: parseSupportMode(capability.mode),
      version: protocolNameSchema.parse(capability.version),
    })];
  })) as Record<ExecutionEnvironmentAction, ExecutionEnvironmentCapability>;
  const environment = executionEnvironmentRefV04Schema.parse(input.environment);
  return Object.freeze({
    protocolVersion: '0.4',
    adapter: parsedAdapter,
    environment: Object.freeze({
      ...environment,
      manifest: Object.freeze({ ...environment.manifest }),
    }),
    capabilities: Object.freeze(parsedCapabilities),
  });
}

export function executionEnvironmentIdentityKey(value: unknown): string {
  return JSON.stringify(executionEnvironmentRefV04Schema.parse(value));
}

export function parseOperationIdentity(value: Readonly<{
  operationId: unknown;
  operationDigest: unknown;
}>): Readonly<{ operationId: string; operationDigest: string }> {
  return Object.freeze({
    operationId: protocolIdSchema.parse(value.operationId),
    operationDigest: protocolDigestSchema.parse(value.operationDigest),
  });
}

export function parseExecutionEnvironmentCommandV1(
  value: unknown,
): ExecutionEnvironmentCommandV1 {
  const input = strictRecord(value, 'execution environment command');
  requireExactKeys(input, [
    'protocolVersion', 'category', 'action', 'adapter', 'capability',
    'executionRequestId',
    'attemptId', 'sessionId', 'leaseId', 'fencingGeneration',
    'cancellationGeneration', 'leaseExpiresAt', 'provider', 'environment',
    'operationIntentRef', 'operationIntentDigest',
    'contextProjectionRef', 'contextProjectionDigest', 'control',
    'operationId', 'operationDigest',
  ], 'execution environment command');
  if (input.protocolVersion !== '0.4' ||
      input.category !== 'execution_environment_command' ||
      !EXECUTION_ENVIRONMENT_ACTIONS.includes(input.action as ExecutionEnvironmentAction)) {
    throw new Error('execution environment command discriminator is invalid');
  }
  const adapter = strictRecord(input.adapter, 'execution environment command adapter');
  requireExactKeys(adapter, ['id', 'version'], 'execution environment command adapter');
  const capability = strictRecord(
    input.capability,
    'execution environment command capability',
  );
  requireExactKeys(
    capability,
    ['action', 'mode', 'version'],
    'execution environment command capability',
  );
  if (capability.action !== input.action ||
      (capability.mode !== 'native' && capability.mode !== 'emulated')) {
    throw new Error('execution environment command capability is invalid');
  }
  let control: ExecutionEnvironmentCommandV1['control'] = null;
  if (input.control !== null) {
    const controlInput = strictRecord(input.control, 'execution environment command control');
    requireExactKeys(
      controlInput,
      ['payloadRef', 'payloadDigest'],
      'execution environment command control',
    );
    control = Object.freeze({
      payloadRef: protocolIdSchema.parse(controlInput.payloadRef),
      payloadDigest: protocolDigestSchema.parse(controlInput.payloadDigest),
    });
  }
  if ((input.action === 'steer') !== (control !== null)) {
    throw new Error('execution environment command control does not match its action');
  }
  const provider = providerRefV04Schema.parse(input.provider);
  const environment = executionEnvironmentRefV04Schema.parse(input.environment);
  return Object.freeze({
    protocolVersion: '0.4',
    category: 'execution_environment_command',
    operationId: protocolIdSchema.parse(input.operationId),
    operationDigest: protocolDigestSchema.parse(input.operationDigest),
    action: input.action as ExecutionEnvironmentAction,
    adapter: Object.freeze({
      id: protocolIdSchema.parse(adapter.id),
      version: protocolNameSchema.parse(adapter.version),
    }),
    capability: Object.freeze({
      action: capability.action as ExecutionEnvironmentAction,
      mode: capability.mode,
      version: protocolNameSchema.parse(capability.version),
    }),
    executionRequestId: protocolIdSchema.parse(input.executionRequestId),
    attemptId: protocolIdSchema.parse(input.attemptId),
    sessionId: protocolIdSchema.parse(input.sessionId),
    leaseId: protocolIdSchema.parse(input.leaseId),
    fencingGeneration: exactRevisionV04Schema.parse(input.fencingGeneration),
    cancellationGeneration: protocolRevisionSchema.parse(input.cancellationGeneration),
    leaseExpiresAt: iso8601Schema.parse(input.leaseExpiresAt),
    operationIntentRef: protocolIdSchema.parse(input.operationIntentRef),
    operationIntentDigest: protocolDigestSchema.parse(input.operationIntentDigest),
    provider: Object.freeze({
      ...provider,
      manifest: Object.freeze({ ...provider.manifest }),
    }),
    environment: Object.freeze({
      ...environment,
      manifest: Object.freeze({ ...environment.manifest }),
    }),
    contextProjectionRef: protocolIdSchema.parse(input.contextProjectionRef),
    contextProjectionDigest: protocolDigestSchema.parse(input.contextProjectionDigest),
    control,
  });
}
