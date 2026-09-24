import type {
  CanaryTokens,
  ErrorCode,
  HookEvent,
  HookHandler,
  HookPayload,
  HookResult,
  SanitiseFailureReason,
  SanitiseDestination,
  SanitiseInput,
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
  connectServiceArgsSchema,
  queryCalendarArgsSchema,
  readDocumentArgsSchema,
  readToolOutputArgsSchema,
  readMemoryArgsSchema,
  restoreMessageArgsSchema,
  sanitiseInputSchema,
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
import { EGRESS_TARGET_PATHS, evaluateDeclaredEgress } from './egress-policy';

export type HookRegistry<Ctx> = readonly HookHandler<Ctx>[];

type MaybePromise<T> = T | Promise<T>;

type HookDecision =
  | boolean
  | { ok: true }
  | { ok: false; reason: string; code?: ErrorCode };

type ToolArgSchema = {
  safeParse(input: unknown): { success: boolean };
  toJSONSchema(): unknown;
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
  sourceTaint: SourceTaint;
  toolArgSourceTaint: SourceTaint;
  egressAllowlist?: readonly string[];
  sanitise?: (input: SanitiseInput) => MaybePromise<SanitiseResult>;
  medicalGate?: (text: string) => MaybePromise<HookDecision>;
};

const ok = (): HookResult => ({ ok: true });

const halt = (reason: string, code: ErrorCode): HookResult => ({
  ok: false,
  halt: true,
  reason,
  code,
});

export const TOOL_ARG_SCHEMAS: Partial<Record<ToolName, ToolArgSchema>> = Object.freeze({
  get_crs: getCrsArgsSchema,
  get_health: getHealthArgsSchema,
  connect_service: connectServiceArgsSchema,
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
  read_tool_output: readToolOutputArgsSchema,
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

export const scribeSanitisePreToolUseHook: HookHandler<HookRuntimeContext> = {
  name: 'tool_arg_sanitise',
  event: 'PreToolUse',
  priority: PRE_TOOL_USE_PRIORITIES.tool_arg_sanitise,
  async handle(payload, ctx) {
    if (payload.event !== 'PreToolUse') return ok();
    const tool = parseToolName(payload.tool);
    if (!tool.parsed) return tool.result;
    const sourceTaint = sourceTaintSchema.safeParse(ctx.toolArgSourceTaint);
    if (!sourceTaint.success) return halt('tool argument taint invalid', 'invalid_args');
    const sanitized = await sanitiseCandidate(
      payload.args,
      ctx,
      preToolUseDestination(tool.data),
      sourceTaint.data,
    );
    return sanitized.ok
      ? { ok: true, payload: { ...payload, args: sanitized.payload } }
      : sanitized.result;
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

    const sourceTaint = sourceTaintSchema.safeParse(ctx.toolArgSourceTaint);
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

    const tool = parseToolName(payload.tool);
    if (!tool.parsed) return tool.result;

    return evaluateDeclaredEgress(
      payload.args,
      EGRESS_TARGET_PATHS[tool.data] ?? [],
      ctx.egressAllowlist,
    ).ok
      ? ok()
      : halt('egress destination denied', 'forbidden');
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

    return sanitiseHookPayload(payload, ctx, postToolUseDestination(payload.tool));
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

    return sanitiseHookPayload(payload, ctx, 'send_message');
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
        await ctx.medicalGate(text),
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
  scribeSanitisePreToolUseHook,
  autonomyGateCheckHook,
  egressAllowlistHook,
  scribeSanitisePostToolUseHook,
  canaryLeakCheckHook,
  scribeSanitisePostLlmCallHook,
  medicalGateHook,
]);

export type RunHooksOptions<Ctx> = {
  registry?: HookRegistry<Ctx>;
  commitContext?: boolean;
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
  const runContext = options.commitContext === false ? cloneHookContext(ctx) : ctx;
  const matching = [...registry]
    .filter((hook) => hook.event === parsedEvent)
    .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));

  for (const hook of matching) {
    const hookCtx = cloneHookContext(runContext);
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

    commitHookContext(runContext, hookCtx);
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

async function sanitiseHookPayload(
  payload: HookPayload,
  ctx: HookRuntimeContext,
  destination: SanitiseDestination,
): Promise<HookResult> {
  if (payload.event === 'PostToolUse') {
    const sourceTaint = successfulResultTaint(payload.result);
    if (!sourceTaint.parsed) return sourceTaint.result;
    const sanitized = await sanitiseCandidate(payload.result, ctx, destination, sourceTaint.data);
    return sanitized.ok
      ? { ok: true, payload: { ...payload, result: sanitized.payload } }
      : sanitized.result;
  }

  if (payload.event === 'PostLLMCall') {
    const sourceTaint = sourceTaintSchema.safeParse(ctx.sourceTaint);
    if (!sourceTaint.success) return halt('model output taint invalid', 'transient');
    const sanitized = await sanitiseCandidate(
      payload.response,
      ctx,
      destination,
      sourceTaint.data,
    );
    return sanitized.ok
      ? { ok: true, payload: { ...payload, response: sanitized.payload } }
      : sanitized.result;
  }

  return ok();
}

async function sanitiseCandidate(
  value: unknown,
  ctx: HookRuntimeContext,
  destination: SanitiseDestination,
  sourceTaint: SourceTaint,
): Promise<
  | { ok: true; payload: Extract<SanitiseResult, { ok: true }>['payload'] }
  | { ok: false; result: HookResult }
> {
  if (ctx.sanitise === undefined) {
    return { ok: false, result: halt('scribe sanitiser unavailable', 'transient') };
  }
  const input = sanitiseInputSchema.safeParse({
    payload: value,
    destination,
    canary_tokens: ctx.session?.canary_tokens ?? ctx.canaryTokens,
    source_taint: sourceTaint,
  });
  if (!input.success) {
    return { ok: false, result: halt('scribe candidate invalid', 'invalid_args') };
  }
  try {
    const result = sanitiseResultSchema.parse(await ctx.sanitise(input.data));
    if (!result.ok) {
      return {
        ok: false,
        result: halt(`scribe:${result.reason}`, sanitiseFailureCode(result.reason)),
      };
    }
    if (result.source_taint !== sourceTaint) {
      return { ok: false, result: halt('scribe sanitiser changed taint', 'transient') };
    }
    return { ok: true, payload: result.payload };
  } catch {
    return { ok: false, result: halt('scribe sanitiser failed', 'transient') };
  }
}

function successfulResultTaint(value: unknown): Parsed<SourceTaint> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.ok !== true && !Object.hasOwn(record, 'source_taint')) {
      return { parsed: true, data: null };
    }
    const parsed = sourceTaintSchema.safeParse(record.source_taint);
    return parsed.success
      ? { parsed: true, data: parsed.data }
      : { parsed: false, result: halt('tool result taint invalid', 'transient') };
  }
  return { parsed: true, data: null };
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

function preToolUseDestination(tool: ToolName): SanitiseDestination {
  switch (tool) {
    case 'update_memory':
      return 'memory_block';
    case 'draft_document':
      return 'draft_document';
    case 'draft_email':
      return 'draft_email';
    case 'send_message':
      return 'send_message';
    default:
      return 'internal_context';
  }
}

function sanitiseFailureCode(reason: SanitiseFailureReason): ErrorCode {
  return reason === 'oversize' ? 'oversize' : 'forbidden';
}
