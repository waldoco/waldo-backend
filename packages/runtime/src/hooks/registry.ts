import type {
  CanaryTokens,
  ErrorCode,
  HookEvent,
  HookHandler,
  HookPayload,
  HookResult,
  SanitiseFailureReason,
  SanitiseDestination,
  SanitiseResult,
  SessionState,
  SourceTaint,
  ToolName,
  TriggerType,
} from '@waldo/contracts';
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  POST_TOOL_USE_PRIORITIES,
  PRE_TOOL_USE_PRIORITIES,
  PRIVILEGED_ACTION_TOOLS,
  buildSessionState,
  callMcpToolArgsSchema,
  canaryTokensSchema,
  createThreadArgsSchema,
  deleteMessageArgsSchema,
  draftDocumentArgsSchema,
  draftEmailArgsSchema,
  executeActionArgsSchema,
  executeCodeArgsSchema,
  getCommunicationArgsSchema,
  getContextArgsSchema,
  getCrsArgsSchema,
  getHealthArgsSchema,
  getMasterMetricsArgsSchema,
  getTasksArgsSchema,
  hookEventSchema,
  hookPayloadSchema,
  hookResultSchema,
  proposeActionArgsSchema,
  proposeScheduleArgsSchema,
  queryCalendarArgsSchema,
  readDocumentArgsSchema,
  readMemoryArgsSchema,
  restoreMessageArgsSchema,
  sanitiseResultSchema,
  searchEpisodesArgsSchema,
  searchToolsArgsSchema,
  sendMessageArgsSchema,
  sessionStateSchema,
  sessionToolAllowed,
  sourceTaintSchema,
  taintGateBlocksDirectExecution,
  toolNameSchema,
  triggerTypeSchema,
  updateMemoryArgsSchema,
  updateTaskArgsSchema,
  updateThreadTopicsArgsSchema,
  webSearchArgsSchema,
  writeSheetCellArgsSchema,
  writeTaskArgsSchema,
  archiveThreadArgsSchema,
} from '@waldo/contracts';

export type HookRegistry<Ctx> = readonly HookHandler<Ctx>[];

type MaybePromise<T> = T | Promise<T>;

type HookDecision =
  | boolean
  | { ok: true }
  | { ok: false; reason: string; code?: ErrorCode };

type ToolArgSchema = {
  safeParse(input: unknown): { success: boolean };
};

export type HookRuntimeContext = {
  authenticatedUserId?: string | null;
  trigger: TriggerType;
  canaryTokens?: CanaryTokens;
  now?: () => number;
  session?: SessionState;
  rateLimitCheck?: (input: {
    event: HookEvent;
    trigger: TriggerType;
    tool?: ToolName;
  }) => MaybePromise<HookDecision>;
  hasApproval?: (input: {
    tool: ToolName;
    args: unknown;
    session: SessionState | null;
  }) => MaybePromise<boolean>;
  toolArgSourceTaint?: SourceTaint;
  egressAllowlist?: readonly string[];
  sanitise?: (input: {
    text: string;
    destination: SanitiseDestination;
  }) => MaybePromise<SanitiseResult>;
  medicalGate?: (input: { text: string }) => MaybePromise<HookDecision>;
};

const ok = (): HookResult => ({ ok: true });

const halt = (reason: string, code: ErrorCode): HookResult => ({
  ok: false,
  halt: true,
  reason,
  code,
});

const TOOL_ARG_SCHEMAS: Partial<Record<ToolName, ToolArgSchema>> = Object.freeze({
  get_crs: getCrsArgsSchema,
  get_health: getHealthArgsSchema,
  query_calendar: queryCalendarArgsSchema,
  get_communication: getCommunicationArgsSchema,
  get_tasks: getTasksArgsSchema,
  get_master_metrics: getMasterMetricsArgsSchema,
  get_context: getContextArgsSchema,
  read_memory: readMemoryArgsSchema,
  update_memory: updateMemoryArgsSchema,
  search_episodes: searchEpisodesArgsSchema,
  propose_action: proposeActionArgsSchema,
  execute_action: executeActionArgsSchema,
  send_message: sendMessageArgsSchema,
  web_search: webSearchArgsSchema,
  read_document: readDocumentArgsSchema,
  call_mcp_tool: callMcpToolArgsSchema,
  write_task: writeTaskArgsSchema,
  update_task: updateTaskArgsSchema,
  draft_document: draftDocumentArgsSchema,
  draft_email: draftEmailArgsSchema,
  propose_schedule: proposeScheduleArgsSchema,
  write_sheet_cell: writeSheetCellArgsSchema,
  execute_code: executeCodeArgsSchema,
  create_thread: createThreadArgsSchema,
  delete_message: deleteMessageArgsSchema,
  restore_message: restoreMessageArgsSchema,
  archive_thread: archiveThreadArgsSchema,
  update_thread_topics: updateThreadTopicsArgsSchema,
  search_tools: searchToolsArgsSchema,
});

export const jwtValidateHook: HookHandler<HookRuntimeContext> = {
  name: 'jwt_validate',
  event: 'OnInvocationStart',
  priority: 100,
  async handle(_payload, ctx) {
    if (typeof ctx.authenticatedUserId !== 'string' || ctx.authenticatedUserId.length === 0) {
      return halt('authenticated user missing', 'auth_failed');
    }

    return ok();
  },
};

export const rateLimitCheckHook: HookHandler<HookRuntimeContext> = {
  name: 'rate_limit_check',
  event: 'OnInvocationStart',
  priority: 200,
  async handle(payload, ctx) {
    const trigger = parseTrigger(ctx);
    if (!trigger.parsed) {
      return trigger.result;
    }

    if (ctx.rateLimitCheck === undefined) {
      return halt('rate limit check unavailable', 'transient');
    }

    try {
      return decisionToHookResult(
        await ctx.rateLimitCheck({ event: payload.event, trigger: trigger.data }),
        'rate limit denied',
        'rate_limited',
      );
    } catch {
      return halt('rate limit check failed', 'transient');
    }
  },
};

export const sessionResetHook: HookHandler<HookRuntimeContext> = {
  name: 'session_reset',
  event: 'OnInvocationStart',
  priority: 400,
  async handle(_payload, ctx) {
    const trigger = parseTrigger(ctx);
    if (!trigger.parsed) {
      return trigger.result;
    }

    const canaryTokens = canaryTokensSchema.safeParse(ctx.canaryTokens);
    if (!canaryTokens.success) {
      return halt('canary tokens unavailable', 'transient');
    }

    if (ctx.now === undefined) {
      return halt('runtime clock unavailable', 'transient');
    }

    const startedAt = ctx.now();
    if (!Number.isInteger(startedAt) || startedAt < 0) {
      return halt('runtime clock invalid', 'transient');
    }

    ctx.session = buildSessionState({
      trigger: trigger.data,
      canary_tokens: canaryTokens.data,
      started_at: startedAt,
    });

    return ok();
  },
};

export const aclCheckHook: HookHandler<HookRuntimeContext> = {
  name: 'acl_check',
  event: 'PreToolUse',
  priority: PRE_TOOL_USE_PRIORITIES.tool_in_acl_check,
  async handle(payload, ctx) {
    if (payload.event !== 'PreToolUse') {
      return ok();
    }

    const tool = parseToolName(payload.tool);
    if (!tool.parsed) {
      return tool.result;
    }

    const session = parseSession(ctx);
    if (!session.parsed) {
      return session.result;
    }

    if (!sessionToolAllowed(session.data, tool.data)) {
      return halt('tool outside trigger ACL', 'forbidden');
    }

    return ok();
  },
};

export const toolArgZodValidateHook: HookHandler<HookRuntimeContext> = {
  name: 'tool_arg_zod_validate',
  event: 'PreToolUse',
  priority: PRE_TOOL_USE_PRIORITIES.tool_arg_zod_validate,
  async handle(payload) {
    if (payload.event !== 'PreToolUse') {
      return ok();
    }

    const tool = parseToolName(payload.tool);
    if (!tool.parsed) {
      return tool.result;
    }

    const schema = TOOL_ARG_SCHEMAS[tool.data];
    if (schema === undefined) {
      return halt('tool args schema unavailable', 'invalid_args');
    }

    if (!schema.safeParse(payload.args).success) {
      return halt('tool args failed schema validation', 'invalid_args');
    }

    return ok();
  },
};

export const autonomyGateCheckHook: HookHandler<HookRuntimeContext> = {
  name: 'autonomy_gate_check',
  event: 'PreToolUse',
  priority: PRE_TOOL_USE_PRIORITIES.autonomy_gate_check,
  async handle(payload, ctx) {
    if (payload.event !== 'PreToolUse') {
      return ok();
    }

    const tool = parseToolName(payload.tool);
    if (!tool.parsed) {
      return tool.result;
    }

    if (!PRIVILEGED_ACTION_TOOLS.includes(tool.data)) {
      return ok();
    }

    const sourceTaint = sourceTaintSchema.safeParse(ctx.toolArgSourceTaint ?? null);
    if (!sourceTaint.success) {
      return halt('tool argument taint invalid', 'invalid_args');
    }

    if (taintGateBlocksDirectExecution(tool.data, sourceTaint.data)) {
      return halt('external-tainted privileged action blocked', 'forbidden');
    }

    if (ctx.hasApproval === undefined) {
      return halt('approval check unavailable', 'forbidden');
    }

    try {
      const approved = await ctx.hasApproval({
        tool: tool.data,
        args: payload.args,
        session: ctx.session ?? null,
      });
      return approved ? ok() : halt('privileged action lacks approval', 'forbidden');
    } catch {
      return halt('approval check failed', 'transient');
    }
  },
};

export const egressAllowlistHook: HookHandler<HookRuntimeContext> = {
  name: 'egress_allowlist_check',
  event: 'PreToolUse',
  priority: PRE_TOOL_USE_PRIORITIES.egress_allowlist_check,
  async handle(payload, ctx) {
    if (payload.event !== 'PreToolUse') {
      return ok();
    }

    for (const host of collectEgressHosts(payload.args)) {
      if (isBlockedEgressHost(host)) {
        return halt('blocked egress host', 'forbidden');
      }

      if (
        ctx.egressAllowlist !== undefined &&
        !ctx.egressAllowlist.some((allowed) => hostMatchesAllowlist(host, allowed))
      ) {
        return halt('host outside egress allowlist', 'forbidden');
      }
    }

    return ok();
  },
};

export const scribeSanitisePostToolUseHook: HookHandler<HookRuntimeContext> = {
  name: 'scribe_sanitise',
  event: 'PostToolUse',
  priority: POST_TOOL_USE_PRIORITIES.tool_result_sanitise,
  async handle(payload, ctx) {
    if (payload.event !== 'PostToolUse') {
      return ok();
    }

    return sanitiseHookText(payload, ctx, postToolUseDestination(payload.tool));
  },
};

export const canaryLeakCheckHook: HookHandler<HookRuntimeContext> = {
  name: 'canary_leak_check',
  event: 'PostLLMCall',
  priority: 100,
  async handle(payload, ctx) {
    if (payload.event !== 'PostLLMCall') {
      return ok();
    }

    const canaryTokens = canaryTokensSchema.safeParse(ctx.session?.canary_tokens ?? ctx.canaryTokens);
    if (!canaryTokens.success) {
      return halt('canary tokens unavailable', 'transient');
    }

    const text = collectText(payload.response).join('\n').toLowerCase();
    const leaked = canaryTokens.data.some((token) => text.includes(token.toLowerCase()));
    return leaked ? halt('canary token leaked', 'forbidden') : ok();
  },
};

export const scribeSanitisePostLlmCallHook: HookHandler<HookRuntimeContext> = {
  name: 'scribe_sanitise',
  event: 'PostLLMCall',
  priority: 100,
  async handle(payload, ctx) {
    if (payload.event !== 'PostLLMCall') {
      return ok();
    }

    return sanitiseHookText(payload, ctx, 'send_message');
  },
};

export const medicalGateHook: HookHandler<HookRuntimeContext> = {
  name: 'medical_gate',
  event: 'PostLLMCall',
  priority: 200,
  async handle(payload, ctx) {
    if (payload.event !== 'PostLLMCall') {
      return ok();
    }

    const text = collectText(payload.response).join('\n');
    if (text.length === 0) {
      return ok();
    }

    if (ctx.medicalGate === undefined) {
      return halt('medical gate unavailable', 'transient');
    }

    try {
      return decisionToHookResult(
        await ctx.medicalGate({ text }),
        'medical gate denied output',
        'forbidden',
      );
    } catch {
      return halt('medical gate failed', 'transient');
    }
  },
};

export const HOOK_REGISTRY: HookRegistry<HookRuntimeContext> = Object.freeze([
  jwtValidateHook,
  rateLimitCheckHook,
  sessionResetHook,
  aclCheckHook,
  toolArgZodValidateHook,
  autonomyGateCheckHook,
  egressAllowlistHook,
  scribeSanitisePostToolUseHook,
  canaryLeakCheckHook,
  scribeSanitisePostLlmCallHook,
  medicalGateHook,
]);

export type RunHooksOptions<Ctx> = {
  registry?: HookRegistry<Ctx>;
};

export class HookHaltError extends Error {
  readonly clientMessage = 'hook halted';
  readonly onErrorPayload: HookPayload;

  constructor(
    readonly hook: string,
    readonly reason: string,
    readonly code: ErrorCode,
  ) {
    super(`hook ${hook} halted: ${reason}`);
    this.name = 'HookHaltError';
    this.onErrorPayload = {
      event: 'OnError',
      error: this.clientMessage,
      code,
    };
  }
}

export function registerHook<Ctx>(
  handler: HookHandler<Ctx>,
  registry: HookRegistry<Ctx> = [],
): HookRegistry<Ctx> {
  return Object.freeze([...registry, handler]);
}

export async function runHooks<Ctx>(
  event: HookEvent,
  payload: HookPayload,
  ctx: Ctx,
  options: RunHooksOptions<Ctx> = {},
): Promise<HookPayload> {
  const parsedEvent = hookEventSchema.parse(event);
  let currentPayload = hookPayloadSchema.parse(payload);
  if (currentPayload.event !== parsedEvent) {
    throw new Error('hook payload event must match runner event');
  }

  const registry = options.registry ?? (HOOK_REGISTRY as unknown as HookRegistry<Ctx>);
  const matching = [...registry]
    .filter((hook) => hook.event === parsedEvent)
    .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));

  for (const hook of matching) {
    const hookCtx = cloneHookContext(ctx);
    const hookPayload = cloneHookValue(currentPayload);
    let result: HookResult;
    try {
      result = hookResultSchema.parse(
        await withHookTimeout(hook.handle(hookPayload, hookCtx), hook.timeout_ms),
      );
    } catch {
      throw new HookHaltError(hook.name, 'hook threw', 'transient');
    }

    if (!result.ok) {
      throw new HookHaltError(hook.name, result.reason, result.code);
    }

    let nextPayload = currentPayload;
    if (result.payload !== undefined) {
      try {
        nextPayload = hookPayloadSchema.parse(result.payload);
      } catch {
        throw new HookHaltError(hook.name, 'hook returned invalid payload', 'transient');
      }

      if (nextPayload.event !== parsedEvent) {
        throw new HookHaltError(hook.name, 'hook returned mismatched event', 'transient');
      }
    }

    commitHookContext(ctx, hookCtx);
    currentPayload = nextPayload;
  }

  return currentPayload;
}

async function withHookTimeout(
  result: Promise<HookResult>,
  timeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
): Promise<HookResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<HookResult>((resolve) => {
    timeout = setTimeout(() => {
      resolve({ ok: false, halt: true, reason: 'hook timed out', code: 'transient' });
    }, timeoutMs);
  });

  try {
    return await Promise.race([result, timedOut]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function cloneHookContext<Ctx>(ctx: Ctx): Ctx {
  return cloneHookValue(ctx);
}

function commitHookContext<Ctx>(target: Ctx, source: Ctx): void {
  if (target !== null && typeof target === 'object' && source !== null && typeof source === 'object') {
    const snapshot = cloneHookValue(source);
    syncObject(target as Record<PropertyKey, unknown>, snapshot as Record<PropertyKey, unknown>);
  }
}

function cloneHookValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const source = value as object;
  const existing = seen.get(source);
  if (existing !== undefined) {
    return existing as T;
  }

  const clone = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(source, clone);

  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) {
      continue;
    }

    if ('value' in descriptor) {
      descriptor.value = cloneHookValue(descriptor.value, seen);
    }

    Object.defineProperty(clone, key, descriptor);
  }

  return clone as T;
}

function syncObject(target: Record<PropertyKey, unknown>, source: Record<PropertyKey, unknown>): void {
  for (const key of Reflect.ownKeys(target)) {
    if (!Object.prototype.propertyIsEnumerable.call(target, key)) {
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      delete target[key];
    }
  }

  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      continue;
    }

    Object.defineProperty(target, key, descriptor);
  }
}

type Parsed<T> = { parsed: true; data: T } | { parsed: false; result: HookResult };

function parseTrigger(ctx: HookRuntimeContext): Parsed<TriggerType> {
  const parsed = triggerTypeSchema.safeParse(ctx.trigger);
  return parsed.success
    ? { parsed: true, data: parsed.data }
    : { parsed: false, result: halt('runtime trigger invalid', 'transient') };
}

function parseToolName(tool: string): Parsed<ToolName> {
  const parsed = toolNameSchema.safeParse(tool);
  return parsed.success
    ? { parsed: true, data: parsed.data }
    : { parsed: false, result: halt('unknown tool', 'invalid_args') };
}

function parseSession(ctx: HookRuntimeContext): Parsed<SessionState> {
  const parsed = sessionStateSchema.safeParse(ctx.session);
  return parsed.success
    ? { parsed: true, data: parsed.data }
    : { parsed: false, result: halt('session unavailable', 'auth_failed') };
}

function decisionToHookResult(
  decision: HookDecision,
  defaultReason: string,
  defaultCode: ErrorCode,
): HookResult {
  if (decision === true) {
    return ok();
  }

  if (decision === false) {
    return halt(defaultReason, defaultCode);
  }

  if (decision.ok) {
    return ok();
  }

  return halt(decision.reason, decision.code ?? defaultCode);
}

function collectEgressHosts(value: unknown, key = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectEgressHosts(item, key));
  }

  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && isEgressKey(key) ? hostCandidatesFromString(value) : [];
  }

  return Object.entries(value).flatMap(([entryKey, entryValue]) =>
    collectEgressHosts(entryValue, entryKey),
  );
}

function isEgressKey(key: string): boolean {
  return /^(url|uri|host|hostname|endpoint|allow_hosts?)$/i.test(key);
}

function hostCandidatesFromString(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }

  try {
    return [normaliseHost(new URL(trimmed).hostname)];
  } catch {
    const withoutPort = trimmed.replace(/^\[/, '').replace(/\]$/, '').split(':')[0] ?? '';
    if (/^[a-z0-9.-]+$/i.test(withoutPort) || withoutPort === '::1') {
      return [normaliseHost(withoutPort)];
    }
    return [];
  }
}

function normaliseHost(host: string): string {
  const withoutTrailingDot = host.toLowerCase().replace(/\.$/, '');
  if (withoutTrailingDot.startsWith('[') && withoutTrailingDot.endsWith(']')) {
    return withoutTrailingDot.slice(1, -1);
  }

  return withoutTrailingDot;
}

function isBlockedEgressHost(host: string): boolean {
  const normalised = normaliseHost(host);
  if (
    normalised === 'localhost' ||
    normalised.endsWith('.localhost') ||
    normalised === '::1' ||
    normalised.startsWith('fe80:') ||
    normalised.startsWith('fc') ||
    normalised.startsWith('fd') ||
    normalised === '0.0.0.0' ||
    normalised === '169.254.169.254' ||
    normalised === 'metadata.google.internal'
  ) {
    return true;
  }

  const mappedIpv4 = ipv4FromMappedIpv6(normalised);
  if (mappedIpv4 !== null) {
    return isBlockedEgressHost(mappedIpv4);
  }

  const parts = normalised.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const first = parts[0] ?? Number.NaN;
  const second = parts[1] ?? Number.NaN;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function ipv4FromMappedIpv6(host: string): string | null {
  if (!host.startsWith('::ffff:')) {
    return null;
  }

  const tail = host.slice('::ffff:'.length);
  if (tail.includes('.')) {
    return tail;
  }

  const groups = tail.split(':');
  if (groups.length === 0 || groups.length > 2) {
    return null;
  }

  const high = Number.parseInt(groups[0] ?? '0', 16);
  const low = Number.parseInt(groups[1] ?? '0', 16);
  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }

  const value = high * 0x10000 + low;
  return [
    Math.floor(value / 0x1000000) % 0x100,
    Math.floor(value / 0x10000) % 0x100,
    Math.floor(value / 0x100) % 0x100,
    value % 0x100,
  ].join('.');
}

function hostMatchesAllowlist(host: string, allowed: string): boolean {
  const normalisedHost = normaliseHost(host);
  const normalisedAllowed = normaliseHost(allowed);
  return (
    normalisedHost === normalisedAllowed || normalisedHost.endsWith(`.${normalisedAllowed}`)
  );
}

async function sanitiseHookText(
  payload: HookPayload,
  ctx: HookRuntimeContext,
  destination: SanitiseDestination,
): Promise<HookResult> {
  if (ctx.sanitise === undefined) {
    return halt('scribe sanitiser unavailable', 'transient');
  }

  let sanitized: SanitisedUnknown;
  if (payload.event === 'PostToolUse') {
    sanitized = await sanitiseUnknown(payload.result, ctx, destination);
  } else if (payload.event === 'PostLLMCall') {
    sanitized = await sanitiseUnknown(payload.response, ctx, destination);
  } else {
    sanitized = { sanitized: true, value: undefined };
  }

  if (!sanitized.sanitized) {
    return sanitized.result;
  }

  if (payload.event === 'PostToolUse') {
    return { ok: true, payload: { ...payload, result: sanitized.value } };
  }

  if (payload.event === 'PostLLMCall') {
    return { ok: true, payload: { ...payload, response: sanitized.value } };
  }

  return ok();
}

type SanitisedUnknown =
  | { sanitized: true; value: unknown }
  | { sanitized: false; result: HookResult };

async function sanitiseUnknown(
  value: unknown,
  ctx: HookRuntimeContext,
  destination: SanitiseDestination,
): Promise<SanitisedUnknown> {
  if (typeof value === 'string') {
    if (value.length === 0) {
      return { sanitized: true, value };
    }

    try {
      const result = sanitiseResultSchema.parse(await ctx.sanitise?.({ text: value, destination }));
      if (!result.ok) {
        return {
          sanitized: false,
          result: halt('scribe sanitise rejected output', sanitiseFailureCode(result.reason)),
        };
      }

      return { sanitized: true, value: result.output };
    } catch {
      return { sanitized: false, result: halt('scribe sanitiser failed', 'transient') };
    }
  }

  if (Array.isArray(value)) {
    const sanitizedItems: unknown[] = [];
    for (const item of value) {
      const sanitized = await sanitiseUnknown(item, ctx, destination);
      if (!sanitized.sanitized) {
        return sanitized;
      }
      sanitizedItems.push(sanitized.value);
    }
    return { sanitized: true, value: sanitizedItems };
  }

  if (isPlainRecord(value)) {
    const sanitizedEntries: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const sanitized = await sanitiseUnknown(item, ctx, destination);
      if (!sanitized.sanitized) {
        return sanitized;
      }
      sanitizedEntries[key] = sanitized.value;
    }
    return { sanitized: true, value: sanitizedEntries };
  }

  return { sanitized: true, value };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function collectText(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectText(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap((item) => collectText(item));
  }

  return [];
}

function postToolUseDestination(tool: string): SanitiseDestination {
  return tool === 'execute_code' ? 'sandbox_stdout' : 'internal_context';
}

function sanitiseFailureCode(reason: SanitiseFailureReason): ErrorCode {
  return reason === 'oversize' ? 'oversize' : 'forbidden';
}
