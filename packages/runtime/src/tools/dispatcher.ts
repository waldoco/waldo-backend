import {
  TOOL_PERMISSIONS,
  ALWAYS_ON_TOOLS,
  EXTERNAL_ORIGIN_TOOLS,
  LAZY_DISCOVERY_TRIGGERS,
  errorCodeSchema,
  handlerAllowlistMatchesAcl,
  sessionToolAllowed,
  connectIntentSchema,
  sourceTaintSchema,
  trustedToolEffectReceiptUnavailableSchema,
  toolNameSchema,
  triggerTypeSchema,
  waldoCardSchema,
  type ConnectIntent,
  type ErrorCode,
  type HookPayload,
  type HookEvent,
  type SessionState,
  type SourceTaint,
  type ToolHandler,
  type ToolName,
  type TrustedToolEffect,
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
import { guardForOffload } from '../scribe/sanitiser';
import type { ToolOutputStore } from '../conversation/tool-output-store';

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
  authenticatedUserId: string;
  session: SessionState;
};

export type DispatchToolResult = (
  | {
      ok: true;
      call_id: string;
      tool: ToolName;
      data: unknown;
      source_taint: SourceTaint;
      card?: WaldoCard;
    }
  | {
      ok: false;
      call_id: string;
      tool: ToolName | null;
      error: string;
      code: ErrorCode;
      reason: ToolDispatchErrorReason;
      source_taint?: 'external';
      // S4 (CONNECT_FLOW_DESIGN 4.4): typed auth intent for the responder's offerConnect seam.
      connect?: ConnectIntent;
    }) & {
  // Present only after a trusted handler resolved an adapter result. This remains ephemeral until
  // RunLoopDO atomically writes its bounded checkpoint/receipt; a thrown adapter call leaves the
  // durable intent pending for reconciliation instead.
  trusted_effect?: TrustedToolEffect;
};

export type ToolDispatchErrorReason =
  | 'unknown_tool'
  | 'handler_unavailable'
  | 'effect_receipt_unavailable'
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
  offload?: import('../conversation/tool-output-store').ToolOutputStore;
  trustedEffect?: Readonly<{
    prepare(input: Readonly<{ tool: ToolName; args: unknown }>): Promise<TrustedToolEffect>;
  }>;
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

  if (
    typeof ctx.authenticatedUserId !== 'string' ||
    ctx.authenticatedUserId.trim().length === 0
  ) {
    return failDispatch(
      call.id,
      tool.data,
      'tool authentication failed',
      'auth_failed',
      'hook_halt',
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

  let preToolPayload: Extract<HookPayload, { event: 'PreToolUse' }> = {
    event: 'PreToolUse',
    tool: tool.data,
    args: call.args,
  };
  try {
    const nextPayload = await runTerminalHooks(
      'PreToolUse',
      preToolPayload,
      ctx,
      options.extraHooks,
    );
    if (nextPayload.event !== 'PreToolUse' || nextPayload.tool !== tool.data) {
      return failDispatch(
        call.id,
        tool.data,
        'tool args failed validation',
        'transient',
        'invalid_args',
      );
    }
    preToolPayload = nextPayload;
  } catch (error) {
    return hookFailure(call.id, tool.data, error);
  }

  let handlerResult: unknown;
  let settledTrustedEffect: TrustedToolEffect | undefined;
  const startedAt = Date.now();
  let args: unknown;
  try {
    args = handler.schema.parse(preToolPayload.args);
  } catch {
    return failDispatch(
      call.id,
      tool.data,
      'tool args failed schema validation',
      'invalid_args',
      'invalid_args',
    );
  }

  let trustedEffect: TrustedToolEffect | undefined;
  if (options.trustedEffect !== undefined) {
    const executeOrReconcile = handler.executeOrReconcile;
    if (
      handler.idempotentOnKey !== true ||
      executeOrReconcile === undefined ||
      handler.reconcileTrustedEffect === undefined
    ) {
      return failDispatch(
        call.id,
        tool.data,
        'tool effect receipt unavailable',
        'transient',
        'effect_receipt_unavailable',
      );
    }
    // Preparation happens after every pre-tool hook and argument schema validation but before
    // handler I/O. The digest therefore names the exact arguments that cross the adapter
    // boundary, while the durable intent is still committed first by RunLoopDO. Do not catch
    // this callback: a storage/programming fault must retain its original cause.
    trustedEffect = await options.trustedEffect.prepare({ tool: tool.data, args });
  }

  try {
    if (trustedEffect !== undefined) {
      const executeOrReconcile = handler.executeOrReconcile;
      if (executeOrReconcile === undefined) throw new Error('trusted tool reconciler disappeared');
      handlerResult = await executeOrReconcile(args, ctx, trustedEffect);
    } else {
      handlerResult = await handler.handle(args, ctx);
    }
  } catch (error) {
    // A trusted adapter can have crossed its side-effect boundary before an unexpected throw.
    // Preserve that original cause and leave the durable intent for reconciliation; collapsing it
    // into a normal tool failure would falsely make the effect look settled.
    if (trustedEffect !== undefined) throw error;
    return failDispatch(call.id, tool.data, 'tool handler failed', 'transient', 'handler_failed');
  }

  if (
    trustedEffect !== undefined &&
    trustedToolEffectReceiptUnavailableSchema.safeParse(handlerResult).success
  ) {
    return failDispatch(
      call.id,
      tool.data,
      'tool effect receipt unavailable',
      'transient',
      'effect_receipt_unavailable',
    );
  }
  if (trustedEffect !== undefined) settledTrustedEffect = trustedEffect;

  const parsedHandlerResult = parseToolResult(handlerResult, tool.data);
  if (parsedHandlerResult === null) {
    return withTrustedEffect(failDispatch(
      call.id,
      tool.data,
      'tool handler returned invalid result',
      'transient',
      'invalid_handler_result',
    ), settledTrustedEffect);
  }

  // Bound before sanitise: the PostToolUse sanitiser denies oversized payloads outright, which
  // killed large legitimate reads before the offload store could shrink them. Offload the full
  // untrusted data first; the reduced head still flows through every PostToolUse hook.
  let effectiveHandlerResult = parsedHandlerResult;
  if (parsedHandlerResult.ok && options.offload !== undefined) {
    const full = JSON.stringify(parsedHandlerResult.data);
    if (full.length > (options.maxResultJsonChars ?? DEFAULT_MAX_RESULT_JSON_CHARS)) {
      const offloaded = offloadResult(call.id, tool.data, full, ctx, options.offload);
      if (!offloaded.ok) return withTrustedEffect(offloaded.result, settledTrustedEffect);
      effectiveHandlerResult = { ...parsedHandlerResult, data: offloaded.data };
    }
  }

  let postToolPayload: PostToolUsePayload = {
    event: 'PostToolUse' as const,
    tool: tool.data,
    result: effectiveHandlerResult,
    latency_ms: Math.max(0, Date.now() - startedAt),
  };
  try {
    const nextPayload = await runTerminalHooks(
      'PostToolUse',
      postToolPayload,
      ctx,
      options.extraHooks,
    );
    if (nextPayload.event !== 'PostToolUse' || nextPayload.tool !== tool.data) {
      return withTrustedEffect(failDispatch(
        call.id,
        tool.data,
        'tool result failed validation',
        'transient',
        'invalid_tool_result',
      ), settledTrustedEffect);
    }
    postToolPayload = nextPayload;
  } catch (error) {
    // HookHaltError is the declared governed post-effect rejection vocabulary. Any other
    // exception may be a storage/programming fault after the adapter I/O boundary: leave the
    // intent unreceipted so RunLoopDO can reconcile it rather than invent a terminal receipt.
    if (settledTrustedEffect !== undefined && !(error instanceof HookHaltError)) throw error;
    return withTrustedEffect(hookFailure(call.id, tool.data, error), settledTrustedEffect);
  }

  const finalResult = parseToolResult(postToolPayload.result, tool.data);
  if (finalResult === null) {
    return withTrustedEffect(failDispatch(
      call.id,
      tool.data,
      'tool result failed validation',
      'transient',
      'invalid_tool_result',
    ), settledTrustedEffect);
  }

  if (!finalResult.ok) {
    if (finalResult.error.length > DEFAULT_MAX_ERROR_CHARS) {
      return withTrustedEffect(failDispatch(
        call.id,
        tool.data,
        'tool returned oversized error',
        finalResult.code,
        'tool_result_error',
      ), settledTrustedEffect);
    }

    return withTrustedEffect(failDispatch(
      call.id,
      tool.data,
      finalResult.error,
      finalResult.code,
      'tool_result_error',
      finalResult.source_taint,
      finalResult.connect,
    ), settledTrustedEffect);
  }

  const resultSize = jsonCharLength(finalResult, settledTrustedEffect !== undefined);
  if (resultSize === null) {
    return withTrustedEffect(failDispatch(
      call.id,
      tool.data,
      'tool result failed validation',
      'transient',
      'invalid_tool_result',
    ), settledTrustedEffect);
  }

  if (resultSize > (options.maxResultJsonChars ?? DEFAULT_MAX_RESULT_JSON_CHARS)) {
    if (options.offload !== undefined) {
      const full = JSON.stringify(finalResult.data);
      const offloaded = offloadResult(call.id, tool.data, full, ctx, options.offload);
      if (!offloaded.ok) return withTrustedEffect(offloaded.result, settledTrustedEffect);
      return withTrustedEffect({
        ok: true,
        call_id: call.id,
        tool: tool.data,
        data: offloaded.data,
        source_taint: finalResult.source_taint,
      }, settledTrustedEffect);
    }
    return withTrustedEffect(failDispatch(
      call.id,
      tool.data,
      'tool result exceeded bound',
      'oversize',
      'result_oversize',
    ), settledTrustedEffect);
  }

  return withTrustedEffect(
    finalResult.card === undefined
      ? {
          ok: true,
          call_id: call.id,
          tool: tool.data,
          data: finalResult.data,
          source_taint: finalResult.source_taint,
        }
      : {
          ok: true,
          call_id: call.id,
          tool: tool.data,
          data: finalResult.data,
          source_taint: finalResult.source_taint,
          card: finalResult.card,
        },
    settledTrustedEffect,
  );
}

// Recover one already-issued trusted tool effect without replaying its plan arguments, running
// pre-tool hooks, or touching a ContextComposer/replay artifact. The adapter contract is
// intentionally key-only here: it must return its own prior receipt or an explicit unavailable
// result, never issue a fresh side effect.
export async function reconcileTrustedToolEffect<Ctx extends ToolDispatcherContext>(
  input: Readonly<{
    callRef: string;
    tool: ToolName;
    ctx: Ctx;
    effect: TrustedToolEffect;
    handlers: readonly RuntimeToolHandler<Ctx>[];
    extraHooks?: HookRegistry<Ctx>;
    maxResultJsonChars?: number;
  offload?: import('../conversation/tool-output-store').ToolOutputStore;
  }>,
): Promise<DispatchToolResult> {
  const tool = toolNameSchema.safeParse(input.tool);
  if (!tool.success) {
    return failDispatch(input.callRef, null, 'unknown tool', 'invalid_args', 'unknown_tool');
  }
  if (
    typeof input.ctx.authenticatedUserId !== 'string' ||
    input.ctx.authenticatedUserId.trim().length === 0
  ) {
    return failDispatch(input.callRef, tool.data, 'tool authentication failed', 'auth_failed', 'hook_halt');
  }
  if (!sessionToolAllowed(input.ctx.session, tool.data)) {
    return failDispatch(input.callRef, tool.data, 'tool outside trigger ACL', 'forbidden', 'acl_denied');
  }
  const handler = input.handlers.find((candidate) => candidate.name === tool.data);
  if (handler === undefined) {
    return failDispatch(
      input.callRef,
      tool.data,
      'tool handler unavailable',
      'not_found',
      'handler_unavailable',
    );
  }
  if (!handlerAllowlistMatchesAcl(handler.name, handler.trigger_allowlist)) {
    return failDispatch(
      input.callRef,
      tool.data,
      'tool handler ACL drift',
      'transient',
      'handler_acl_drift',
    );
  }
  if (
    input.effect.operation !== 'reconcile' ||
    handler.idempotentOnKey !== true ||
    handler.reconcileTrustedEffect === undefined
  ) {
    return failDispatch(
      input.callRef,
      tool.data,
      'tool effect receipt unavailable',
      'transient',
      'effect_receipt_unavailable',
    );
  }

  // Do not catch: an unexpected adapter/storage/programming throw may occur after the original
  // external effect. RunLoopDO must retain its intent and preserve the cause for a later keyed
  // recovery rather than inventing a receipt.
  const handlerResult = await handler.reconcileTrustedEffect(input.effect);
  if (trustedToolEffectReceiptUnavailableSchema.safeParse(handlerResult).success) {
    return failDispatch(
      input.callRef,
      tool.data,
      'tool effect receipt unavailable',
      'transient',
      'effect_receipt_unavailable',
    );
  }
  const parsed = parseToolResult(handlerResult, tool.data);
  if (parsed === null) {
    return withTrustedEffect(failDispatch(
      input.callRef,
      tool.data,
      'tool handler returned invalid result',
      'transient',
      'invalid_handler_result',
    ), input.effect);
  }
  let postToolPayload: PostToolUsePayload = {
    event: 'PostToolUse',
    tool: tool.data,
    result: parsed,
    // The adapter-owned receipt is already complete; no fresh I/O latency is reconstructed.
    latency_ms: 0,
  };
  try {
    const nextPayload = await runTerminalHooks(
      'PostToolUse',
      postToolPayload,
      input.ctx,
      input.extraHooks,
    );
    if (nextPayload.event !== 'PostToolUse' || nextPayload.tool !== tool.data) {
      return withTrustedEffect(failDispatch(
        input.callRef,
        tool.data,
        'tool result failed validation',
        'transient',
        'invalid_tool_result',
      ), input.effect);
    }
    postToolPayload = nextPayload;
  } catch (error) {
    if (!(error instanceof HookHaltError)) throw error;
    return withTrustedEffect(hookFailure(input.callRef, tool.data, error), input.effect);
  }
  const finalResult = parseToolResult(postToolPayload.result, tool.data);
  if (finalResult === null) {
    return withTrustedEffect(failDispatch(
      input.callRef,
      tool.data,
      'tool result failed validation',
      'transient',
      'invalid_tool_result',
    ), input.effect);
  }
  if (!finalResult.ok) {
    if (finalResult.error.length > DEFAULT_MAX_ERROR_CHARS) {
      return withTrustedEffect(failDispatch(
        input.callRef,
        tool.data,
        'tool returned oversized error',
        finalResult.code,
        'tool_result_error',
      ), input.effect);
    }
    return withTrustedEffect(failDispatch(
      input.callRef,
      tool.data,
      finalResult.error,
      finalResult.code,
      'tool_result_error',
      finalResult.source_taint,
    ), input.effect);
  }
  const size = jsonCharLength(finalResult, true);
  if (size === null) {
    return withTrustedEffect(failDispatch(
      input.callRef,
      tool.data,
      'tool result failed validation',
      'transient',
      'invalid_tool_result',
    ), input.effect);
  }
  if (size > (input.maxResultJsonChars ?? DEFAULT_MAX_RESULT_JSON_CHARS)) {
    return withTrustedEffect(failDispatch(
      input.callRef,
      tool.data,
      'tool result exceeded bound',
      'oversize',
      'result_oversize',
    ), input.effect);
  }
  return withTrustedEffect(
    finalResult.card === undefined
      ? {
          ok: true,
          call_id: input.callRef,
          tool: tool.data,
          data: finalResult.data,
          source_taint: finalResult.source_taint,
        }
      : {
          ok: true,
          call_id: input.callRef,
          tool: tool.data,
          data: finalResult.data,
          source_taint: finalResult.source_taint,
          card: finalResult.card,
        },
    input.effect,
  );
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

async function runTerminalHooks<Ctx extends ToolDispatcherContext>(
  event: HookEvent,
  payload: HookPayload,
  ctx: Ctx,
  extraHooks: HookRegistry<Ctx> | undefined,
): Promise<HookPayload> {
  const transformed =
    extraHooks === undefined
      ? payload
      : await runHooks(event, payload, ctx, { registry: extraHooks, commitContext: false });
  return runHooks(event, transformed, ctx, {
    registry: HOOK_REGISTRY as HookRegistry<Ctx>,
  });
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


type OffloadedResult =
  | { ok: true; data: { stored_output: string; total_chars: number; stored_chars: number; truncated: boolean; head: string; read_with: 'read_tool_output' } }
  | { ok: false; result: DispatchToolResult };

// Raw external output is never stored: the offload guard runs the full sanitise pipeline minus
// the destination size cap (storage is not model context). Only guarded text reaches the store,
// so a read-back slice can never expose unguarded content, including a secret that would span
// read chunks.
const offloadResult = (
  callId: string,
  tool: ToolName,
  full: string,
  ctx: ToolDispatcherContext,
  store: ToolOutputStore,
): OffloadedResult => {
  const guarded = guardForOffload({
    payload: full,
    destination: 'internal_context',
    canary_tokens: ctx.session?.canary_tokens ?? [],
    source_taint: 'external',
  });
  if (!guarded.ok) {
    return {
      ok: false,
      result: failDispatch(
        callId,
        tool,
        // Typed enums only - the denied stage/reason stay provable from the trace without any
        // provider content (live QA could not name the exact check before this).
        `tool result failed the offload guard: ${guarded.check}:${guarded.reason}`,
        guarded.reason === 'oversize' ? 'oversize' : 'forbidden',
        'sanitise_denied',
      ),
    };
  }
  const text = typeof guarded.payload === 'string' ? guarded.payload : JSON.stringify(guarded.payload);
  const stored = store.put(text);
  return {
    ok: true,
    // total_chars is the full guarded length; stored_chars + truncated say what is actually
    // retrievable - the receipt never claims retrievable output the store did not keep
    data: { stored_output: stored.id, total_chars: stored.original_chars, stored_chars: stored.stored_chars, truncated: stored.truncated, head: text.slice(0, 4_000), read_with: 'read_tool_output' },
  };
};

function failDispatch(
  callId: string,
  tool: ToolName | null,
  error: string,
  code: ErrorCode,
  reason: ToolDispatchErrorReason,
  sourceTaint?: SourceTaint,
  connect?: ConnectIntent,
): DispatchToolResult {
  const extra = connect === undefined ? {} : { connect };
  return sourceTaint === 'external'
    ? { ok: false, call_id: callId, tool, error, code, reason, source_taint: 'external', ...extra }
    : { ok: false, call_id: callId, tool, error, code, reason, ...extra };
}

function withTrustedEffect(
  result: DispatchToolResult,
  effect: TrustedToolEffect | undefined,
): DispatchToolResult {
  return effect === undefined ? result : { ...result, trusted_effect: effect };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonCharLength(value: unknown, preserveUnexpectedCause = false): number | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized.length : 0;
  } catch (error) {
    if (preserveUnexpectedCause) throw error;
    return null;
  }
}

function reasonFromHook(hook: string): ToolDispatchErrorReason {
  switch (hook) {
    case 'acl_check':
      return 'acl_denied';
    case 'tool_arg_zod_validate':
      return 'invalid_args';
    case 'tool_arg_sanitise':
      return 'sanitise_denied';
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
  | { ok: true; data: unknown; source_taint: SourceTaint; card?: WaldoCard }
  | { ok: false; error: string; code: ErrorCode; source_taint?: 'external'; connect?: ConnectIntent };

function parseToolResult(value: unknown, tool: ToolName): ParsedToolResult | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return null;
  }

  if (value.ok) {
    if (
      !hasOnlyKeys(value, ['ok', 'data', 'card', 'source_taint']) ||
      !Object.prototype.hasOwnProperty.call(value, 'data')
    ) {
      return null;
    }
    const sourceTaint = sourceTaintSchema.safeParse(value.source_taint);
    if (!sourceTaint.success) return null;
    const expectsExternal = EXTERNAL_ORIGIN_TOOLS.includes(tool);
    if (expectsExternal !== (sourceTaint.data === 'external')) return null;
    if (!Object.prototype.hasOwnProperty.call(value, 'card')) {
      return { ok: true, data: value.data, source_taint: sourceTaint.data };
    }

    const card = waldoCardSchema.safeParse(value.card);
    return card.success
      ? { ok: true, data: value.data, source_taint: sourceTaint.data, card: card.data }
      : null;
  }

  const expectsExternal = EXTERNAL_ORIGIN_TOOLS.includes(tool);
  if (
    !hasOnlyKeys(
      value,
      expectsExternal ? ['ok', 'error', 'code', 'source_taint', 'connect'] : ['ok', 'error', 'code', 'connect'],
    )
  ) {
    return null;
  }
  const code = errorCodeSchema.safeParse(value.code);
  if (typeof value.error !== 'string' || value.error.length === 0 || !code.success) {
    return null;
  }
  // S4: a typed connect intent rides the failure; anything that is not a valid intent is dropped
  // rather than failing the whole result - the fixed model-facing text already stands alone.
  const connect = value.connect === undefined ? undefined : connectIntentSchema.safeParse(value.connect);
  if (connect !== undefined && !connect.success) return null;

  if (expectsExternal) {
    if (value.source_taint !== 'external') return null;
    return {
      ok: false,
      error: value.error,
      code: code.data,
      source_taint: 'external',
      ...(connect?.success ? { connect: connect.data } : {}),
    };
  }
  return { ok: false, error: value.error, code: code.data, ...(connect?.success ? { connect: connect.data } : {}) };
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}
