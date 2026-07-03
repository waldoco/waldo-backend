import { z } from 'zod';
import { errorCodeSchema } from './error';
import { modelNameSchema } from '../model/roster';

// ADR-0032's title bills 7 middleware hooks; its own typed body carries these 9 — the
// lifecycle bookends OnInvocationStart/OnInvocationEnd are part of the accepted spec, the
// title is the stale artifact. Enum order is the ADR-0032 firing walk; OnError attaches at
// any layer.
export const hookEventSchema = z.enum([
  'OnInvocationStart',
  'PrePromptBuild',
  'PostPromptBuild',
  'PreLLMCall',
  'PostLLMCall',
  'PreToolUse',
  'PostToolUse',
  'OnError',
  'OnInvocationEnd',
]);
export type HookEvent = z.infer<typeof hookEventSchema>;

// Final close fires on success or failure (ADR-0032); 'fallback' records a close delivered
// through the OnError fallback chain rather than the primary path.
export const invocationOutcomeSchema = z.enum(['success', 'fallback', 'failure']);
export type InvocationOutcome = z.infer<typeof invocationOutcomeSchema>;

// Hook payloads carry raw pre-sanitise content in memory (prompt, response, tool result) —
// in-process only. Audit hooks persist a hash of the prompt and input/output summaries,
// never the raw values (ADR-0032); a hook payload must never be journaled, logged, or
// serialised into any log-destined contract.
//
// Opaque z.unknown() fields are deliberate: message/args/result shapes are owned by their
// own seams (adapters/llm, the tool schemas). The hook seam validates only the safety-
// relevant vocabulary — the model id, because the PreLLMCall hook rejects any id outside
// the roster (ADR-0069), and the core/error code vocabulary. `tool` carries the
// dispatcher's tool name opaquely; the tool-name union is owned by the tools contracts,
// and the deny-first ACL hook at PreToolUse priority 100 is the runtime authority
// (ADR-0008).
export const hookPayloadSchema = z.discriminatedUnion('event', [
  z.strictObject({ event: z.literal('OnInvocationStart'), trace_id: z.string().min(1) }),
  z.strictObject({ event: z.literal('PrePromptBuild') }),
  z.strictObject({ event: z.literal('PostPromptBuild'), prompt: z.string().min(1) }),
  z.strictObject({
    event: z.literal('PreLLMCall'),
    messages: z.array(z.unknown()),
    model: modelNameSchema,
  }),
  z.strictObject({
    event: z.literal('PostLLMCall'),
    response: z.unknown(),
    tokens_in: z.int().nonnegative(),
    tokens_out: z.int().nonnegative(),
  }),
  z.strictObject({
    event: z.literal('PreToolUse'),
    tool: z.string().min(1),
    args: z.unknown(),
  }),
  z.strictObject({
    event: z.literal('PostToolUse'),
    tool: z.string().min(1),
    result: z.unknown(),
    latency_ms: z.int().nonnegative(),
  }),
  z.strictObject({
    event: z.literal('OnError'),
    error: z.string().min(1),
    code: errorCodeSchema,
  }),
  z.strictObject({
    event: z.literal('OnInvocationEnd'),
    outcome: invocationOutcomeSchema,
  }),
]);
export type HookPayload = z.infer<typeof hookPayloadSchema>;

// Runner semantics (ADR-0032): a returned payload REPLACES the current one in full — no
// merge; a failing hook halts the invocation with a machine-readable code. `halt` is
// literal true so a non-halting failure is unrepresentable.
export const hookResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), payload: hookPayloadSchema.optional() }),
  z.strictObject({
    ok: z.literal(false),
    halt: z.literal(true),
    reason: z.string().min(1),
    code: errorCodeSchema,
  }),
]);
export type HookResult = z.infer<typeof hookResultSchema>;

// Independent traversal (ADR-0032): every hook runs under its own timeout budget; a slow
// hook halts the invocation — never skipped — so no shared bottleneck can degrade the
// safety layers together. This is the runner's budget when a hook pins none.
export const DEFAULT_HOOK_TIMEOUT_MS = 100;

// The hook seam (ADR-0032): zero-token harness-side middleware around every invocation;
// lower priority fires earlier; registration is explicit code, and adding a hook is a
// reviewed change. Ctx is the InvocationContext contract owned by a later runtime wave;
// genericity keeps this a static type rather than a Zod schema, like RecallGateway.
export interface HookHandler<Ctx> {
  name: string;
  event: HookEvent;
  priority: number;
  timeout_ms?: number;
  handle(payload: HookPayload, ctx: Ctx): Promise<HookResult>;
}

// The ADR-0032 numbered order around tool dispatch, verbatim; renumbering is a breaking
// change. Deny-first ACL (ADR-0008) leads.
export const PRE_TOOL_USE_PRIORITIES = {
  tool_in_acl_check: 100,
  tool_arg_zod_validate: 200,
  autonomy_gate_check: 300,
  rate_limit_per_tool: 400,
  egress_allowlist_check: 500,
  tool_audit_log_pre: 600,
} as const satisfies Record<string, number>;

// Sanitise (100) MUST precede compression (200): the Scribe sanitiser (ADR-0024) sees full
// tool output before ADR-0034 compression can strip the patterns it scans for.
export const POST_TOOL_USE_PRIORITIES = {
  tool_result_sanitise: 100,
  tool_output_compression: 200,
  tool_audit_log_post: 300,
  effectiveness_signal_capture: 400,
} as const satisfies Record<string, number>;

// A safety gate the dispatcher must register around privileged tool dispatch. A null
// priority means the gate's slot relative to the event's numbered order is an open
// dispatcher decision — the contract must not pre-decide it.
export const hookGateSchema = z.strictObject({
  name: z.string().min(1),
  events: z.array(hookEventSchema).min(1),
  priority: z.int().positive().nullable(),
});
export type HookGate = z.infer<typeof hookGateSchema>;

// ADR-0018 earned autonomy: mutating tools pass the autonomy gate, pinned at PreToolUse 300
// in the ADR-0032 numbered order.
export const AUTONOMY_GATE: HookGate = {
  name: 'autonomy_gate_check',
  events: ['PreToolUse'],
  priority: 300,
};

// ADR-0049 accepted amendment: a privileged action (execute_action, external send_message,
// update_memory/Scribe writes, connector writes, MCP writes, message/thread mutations) whose
// arguments derive from external-tainted content routes through propose_action (human confirm)
// or blocks — enforced in code-owned hooks, never prompt text. This is an ADDITIONAL
// Pre/PostToolUse gate, deliberately NOT one of the six numbered PreToolUse priorities. OPEN,
// not decided in a contract: its slot in the numbered order, and whether it merges with the
// autonomy gate into one privileged-action gate — the dispatcher build decides; this contract
// ships the two gates separate.
//
// This is the gate's REGISTRATION SLOT only. Its decision law is single-owned and lives
// elsewhere, so no competing authority is defined here: the tool-scoped block decision is
// taintGateBlocksDirectExecution (tools/handler), and the external-taint primitive it composes
// is isExternalSourceTaint (memory/sanitise). External taint alone never blocks a tool.
export const TAINT_PRIVILEGED_ACTION_GATE: HookGate = {
  name: 'taint_privileged_action_gate',
  events: ['PreToolUse', 'PostToolUse'],
  priority: null,
};
