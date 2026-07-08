import {
  TOOL_PERMISSIONS,
  ALWAYS_ON_TOOLS,
  LAZY_DISCOVERY_TRIGGERS,
  errorCodeSchema,
  handlerAllowlistMatchesAcl,
  sessionToolAllowed,
  toolNameSchema,
  triggerTypeSchema,
  waldoCardSchema,
  type ErrorCode,
  type HookPayload,
  type SessionState,
  type ToolHandler,
  type ToolName,
  type TriggerType,
  type WaldoCard,
} from '@waldo/contracts';
import {
  HookHaltError,
  HOOK_REGISTRY,
  runHooks,
  type HookRegistry,
  type HookRuntimeContext,
} from '../hooks/registry';

export type RuntimeToolCall = {
  id: string;
  name: ToolName;
  args: unknown;
};

type FailedToolCallParse<Repaired extends boolean = boolean> = {
  ok: false;
  repaired: Repaired;
  error: string;
  code: ErrorCode;
};

export type ParseToolCallsResult =
  | { ok: true; repaired: boolean; calls: RuntimeToolCall[] }
  | FailedToolCallParse;

export type ToolDispatcherContext = HookRuntimeContext & {
  session: SessionState;
};

export type DispatchToolResult =
  | { ok: true; call_id: string; tool: ToolName; data: unknown; card?: WaldoCard }
  | {
      ok: false;
      call_id: string;
      tool: ToolName | null;
      error: string;
      code: ErrorCode;
      reason: ToolDispatchErrorReason;
    };

export type ToolDispatchErrorReason =
  | 'unknown_tool'
  | 'handler_unavailable'
  | 'handler_acl_drift'
  | 'acl_denied'
  | 'invalid_args'
  | 'approval_denied'
  | 'egress_denied'
  | 'sanitise_denied'
  | 'hook_halt'
  | 'handler_failed'
  | 'invalid_handler_result'
  | 'tool_result_error'
  | 'invalid_tool_result'
  | 'result_oversize';

export type ToolDefinition = {
  name: ToolName;
  description: string;
  autonomy_gated: boolean;
};

type PostToolUsePayload = Extract<HookPayload, { event: 'PostToolUse' }>;
type RuntimeToolHandler<Ctx> = ToolHandler<any, any, Ctx>;

export type ParseToolCallsOptions = {
  repair?: (input: { raw: unknown; error: string }) => unknown | Promise<unknown>;
};

export type DispatchToolOptions<Ctx extends ToolDispatcherContext> = {
  handlers: readonly RuntimeToolHandler<Ctx>[];
  extraHooks?: HookRegistry<Ctx>;
  maxResultJsonChars?: number;
};

const DEFAULT_MAX_RESULT_JSON_CHARS = 16_384;
const DEFAULT_MAX_ERROR_CHARS = 512;

export async function parseToolCalls(
  raw: unknown,
  options: ParseToolCallsOptions = {},
): Promise<ParseToolCallsResult> {
  const parsed = parseToolCallsOnce(raw);
  if (parsed.ok || options.repair === undefined) {
    return parsed;
  }

  let repairedRaw: unknown;
  try {
    repairedRaw = await options.repair({ raw, error: parsed.error });
  } catch {
    return failParse('tool-call repair failed', true);
  }

  const repaired = parseToolCallsOnce(repairedRaw);
  return repaired.ok ? { ...repaired, repaired: true } : { ...repaired, repaired: true };
}

export async function dispatchTool<Ctx extends ToolDispatcherContext>(
  call: RuntimeToolCall,
  ctx: Ctx,
  options: DispatchToolOptions<Ctx>,
): Promise<DispatchToolResult> {
  const tool = toolNameSchema.safeParse(call.name);
  if (!tool.success) {
    return failDispatch(call.id, null, 'unknown tool', 'invalid_args', 'unknown_tool');
  }

  const handler = options.handlers.find((candidate) => candidate.name === tool.data);
  if (handler === undefined) {
    return failDispatch(
      call.id,
      tool.data,
      'tool handler unavailable',
      'not_found',
      'handler_unavailable',
    );
  }

  if (!handlerAllowlistMatchesAcl(handler.name, handler.trigger_allowlist)) {
    return failDispatch(
      call.id,
      tool.data,
      'tool handler ACL drift',
      'transient',
      'handler_acl_drift',
    );
  }

  if (!sessionToolAllowed(ctx.session, tool.data)) {
    return failDispatch(
      call.id,
      tool.data,
      'tool outside trigger ACL',
      'forbidden',
      'acl_denied',
    );
  }

  try {
    await runHooks(
      'PreToolUse',
      { event: 'PreToolUse', tool: tool.data, args: call.args },
      ctx,
      hookOptions(options),
    );
  } catch (error) {
    return hookFailure(call.id, tool.data, error);
  }

  let handlerResult: unknown;
  const startedAt = Date.now();
  let args: unknown;
  try {
    args = handler.schema.parse(call.args);
  } catch {
    return failDispatch(
      call.id,
      tool.data,
      'tool args failed schema validation',
      'invalid_args',
      'invalid_args',
    );
  }

  try {
    handlerResult = await handler.handle(args, ctx);
  } catch {
    return failDispatch(call.id, tool.data, 'tool handler failed', 'transient', 'handler_failed');
  }

  const parsedHandlerResult = parseToolResult(handlerResult);
  if (parsedHandlerResult === null) {
    return failDispatch(
      call.id,
      tool.data,
      'tool handler returned invalid result',
      'transient',
      'invalid_handler_result',
    );
  }

  let postToolPayload: PostToolUsePayload = {
    event: 'PostToolUse' as const,
    tool: tool.data,
    result: parsedHandlerResult,
    latency_ms: Math.max(0, Date.now() - startedAt),
  };
  try {
    const nextPayload = await runHooks('PostToolUse', postToolPayload, ctx, hookOptions(options));
    if (nextPayload.event !== 'PostToolUse') {
      return failDispatch(
        call.id,
        tool.data,
        'tool result failed validation',
        'transient',
        'invalid_tool_result',
      );
    }
    postToolPayload = nextPayload;
  } catch (error) {
    return hookFailure(call.id, tool.data, error);
  }

  const finalResult = parseToolResult(postToolPayload.result);
  if (finalResult === null) {
    return failDispatch(
      call.id,
      tool.data,
      'tool result failed validation',
      'transient',
      'invalid_tool_result',
    );
  }

  if (!finalResult.ok) {
    if (finalResult.error.length > DEFAULT_MAX_ERROR_CHARS) {
      return failDispatch(
        call.id,
        tool.data,
        'tool returned oversized error',
        finalResult.code,
        'tool_result_error',
      );
    }

    return failDispatch(
      call.id,
      tool.data,
      finalResult.error,
      finalResult.code,
      'tool_result_error',
    );
  }

  const resultSize = jsonCharLength(finalResult);
  if (resultSize === null) {
    return failDispatch(
      call.id,
      tool.data,
      'tool result failed validation',
      'transient',
      'invalid_tool_result',
    );
  }

  if (resultSize > (options.maxResultJsonChars ?? DEFAULT_MAX_RESULT_JSON_CHARS)) {
    return failDispatch(
      call.id,
      tool.data,
      'tool result exceeded bound',
      'oversize',
      'result_oversize',
    );
  }

  return finalResult.card === undefined
    ? { ok: true, call_id: call.id, tool: tool.data, data: finalResult.data }
    : {
        ok: true,
        call_id: call.id,
        tool: tool.data,
        data: finalResult.data,
        card: finalResult.card,
      };
}

export function getAllowedTools(trigger: TriggerType): readonly ToolName[] {
  const parsed = triggerTypeSchema.parse(trigger);
  return TOOL_PERMISSIONS[parsed];
}

export function formatToolDefinitions<Ctx extends ToolDispatcherContext>(
  trigger: TriggerType,
  handlers: readonly RuntimeToolHandler<Ctx>[],
): ToolDefinition[] {
  const allowed = new Set(getAllowedTools(trigger));
  const loadable = LAZY_DISCOVERY_TRIGGERS.includes(trigger)
    ? new Set(ALWAYS_ON_TOOLS.filter((tool) => allowed.has(tool)))
    : allowed;
  return handlers
    .filter((handler) => loadable.has(handler.name))
    .map((handler) => ({
      name: handler.name,
      description: handler.description,
      autonomy_gated: handler.autonomy_gated,
    }));
}

function parseToolCallsOnce(raw: unknown): ParseToolCallsResult {
  const source = parseToolCallSource(raw);
  if (!source.ok) {
    return source;
  }

  const calls: RuntimeToolCall[] = [];
  const callIds = new Set<string>();
  for (const candidate of source.candidates) {
    const parsed = parseToolCallCandidate(candidate);
    if (!parsed.ok) {
      return parsed;
    }
    if (callIds.has(parsed.call.id)) {
      return failParse('duplicate tool call id', false);
    }
    callIds.add(parsed.call.id);
    calls.push(parsed.call);
  }

  return { ok: true, repaired: false, calls };
}

type CandidateResult =
  | { ok: true; candidates: readonly unknown[] }
  | { ok: false; repaired: false; error: string; code: ErrorCode };

function parseToolCallSource(raw: unknown): CandidateResult {
  if (typeof raw === 'string') {
    try {
      return parseToolCallSource(JSON.parse(raw) as unknown);
    } catch {
      return failParse('tool-call text is not valid JSON', false);
    }
  }

  if (Array.isArray(raw)) {
    return { ok: true, candidates: raw };
  }

  if (!isRecord(raw)) {
    return failParse('tool-call response must be an object, array, or JSON text', false);
  }

  if (Array.isArray(raw.content)) {
    return { ok: true, candidates: raw.content.filter(isPossibleToolUseBlock) };
  }

  if (Array.isArray(raw.tool_calls)) {
    return { ok: true, candidates: raw.tool_calls };
  }

  const choiceCalls = toolCallsFromChoices(raw.choices);
  if (choiceCalls !== null) {
    return { ok: true, candidates: choiceCalls };
  }

  if (typeof raw.text === 'string') {
    return parseToolCallSource(raw.text);
  }

  return { ok: true, candidates: [] };
}

type ParsedCandidate =
  | { ok: true; call: RuntimeToolCall }
  | { ok: false; repaired: false; error: string; code: ErrorCode };

function parseToolCallCandidate(candidate: unknown): ParsedCandidate {
  if (!isRecord(candidate)) {
    return failParse('tool call must be an object', false);
  }

  const id = candidate.id;
  if (typeof id !== 'string' || id.length === 0) {
    return failParse('tool call id missing', false);
  }

  const name = candidateName(candidate);
  const parsedName = toolNameSchema.safeParse(name);
  if (!parsedName.success) {
    return failParse('unknown tool', false);
  }

  const args = candidateArgs(candidate);
  if (!isRecord(args)) {
    return failParse('tool call args missing or malformed', false);
  }

  return { ok: true, call: { id, name: parsedName.data, args } };
}

function candidateName(candidate: Readonly<Record<string, unknown>>): unknown {
  if (typeof candidate.name === 'string') {
    return candidate.name;
  }
  if (isRecord(candidate.function)) {
    return candidate.function.name;
  }
  if (typeof candidate.tool === 'string') {
    return candidate.tool;
  }
  return undefined;
}

function candidateArgs(candidate: Readonly<Record<string, unknown>>): unknown {
  if (Object.prototype.hasOwnProperty.call(candidate, 'input')) {
    return candidate.input;
  }
  if (Object.prototype.hasOwnProperty.call(candidate, 'args')) {
    return candidate.args;
  }
  if (Object.prototype.hasOwnProperty.call(candidate, 'arguments')) {
    return parseArguments(candidate.arguments);
  }
  if (
    isRecord(candidate.function) &&
    Object.prototype.hasOwnProperty.call(candidate.function, 'arguments')
  ) {
    return parseArguments(candidate.function.arguments);
  }
  return undefined;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isPossibleToolUseBlock(value: unknown): boolean {
  return isRecord(value) && (value.type === 'tool_use' || value.type === 'tool_call');
}

function toolCallsFromChoices(choices: unknown): readonly unknown[] | null {
  if (!Array.isArray(choices)) {
    return null;
  }

  return choices.flatMap((choice) => {
    if (
      !isRecord(choice) ||
      !isRecord(choice.message) ||
      !Array.isArray(choice.message.tool_calls)
    ) {
      return [];
    }
    return choice.message.tool_calls;
  });
}

function hookOptions<Ctx extends ToolDispatcherContext>(
  options: DispatchToolOptions<Ctx>,
): { registry: HookRegistry<Ctx> } {
  const base = HOOK_REGISTRY as HookRegistry<Ctx>;
  return {
    registry:
      options.extraHooks === undefined ? base : Object.freeze([...base, ...options.extraHooks]),
  };
}

function hookFailure(callId: string, tool: ToolName, error: unknown): DispatchToolResult {
  if (error instanceof HookHaltError) {
    return failDispatch(callId, tool, error.clientMessage, error.code, reasonFromHook(error.hook));
  }
  return failDispatch(callId, tool, 'tool hook failed', 'transient', 'hook_halt');
}

function failParse(error: string, repaired: false): FailedToolCallParse<false>;
function failParse(error: string, repaired: true): FailedToolCallParse<true>;
function failParse(error: string, repaired: boolean): ParseToolCallsResult & { ok: false } {
  return { ok: false, repaired, error, code: 'invalid_args' };
}

function failDispatch(
  callId: string,
  tool: ToolName | null,
  error: string,
  code: ErrorCode,
  reason: ToolDispatchErrorReason,
): DispatchToolResult {
  return { ok: false, call_id: callId, tool, error, code, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonCharLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized.length : 0;
  } catch {
    return null;
  }
}

function reasonFromHook(hook: string): ToolDispatchErrorReason {
  switch (hook) {
    case 'acl_check':
      return 'acl_denied';
    case 'tool_arg_zod_validate':
      return 'invalid_args';
    case 'autonomy_gate_check':
      return 'approval_denied';
    case 'egress_allowlist_check':
      return 'egress_denied';
    case 'scribe_sanitise':
      return 'sanitise_denied';
    default:
      return 'hook_halt';
  }
}

type ParsedToolResult =
  | { ok: true; data: unknown; card?: WaldoCard }
  | { ok: false; error: string; code: ErrorCode };

function parseToolResult(value: unknown): ParsedToolResult | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return null;
  }

  if (value.ok) {
    if (!Object.prototype.hasOwnProperty.call(value, 'data')) {
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(value, 'card')) {
      return { ok: true, data: value.data };
    }

    const card = waldoCardSchema.safeParse(value.card);
    return card.success ? { ok: true, data: value.data, card: card.data } : null;
  }

  const code = errorCodeSchema.safeParse(value.code);
  if (typeof value.error !== 'string' || value.error.length === 0 || !code.success) {
    return null;
  }

  return { ok: false, error: value.error, code: code.data };
}
