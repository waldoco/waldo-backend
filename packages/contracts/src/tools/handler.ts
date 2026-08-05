import { z } from 'zod';
import { errorCodeSchema, type ErrorCode } from '../core/error';
import { triggerTypeSchema, type TriggerType } from '../core/trigger';
import { isExternalSourceTaint, sourceTaintSchema, type SourceTaint } from '../memory/sanitise';
import { waldoCardSchema, type WaldoCard } from '../ui/card';
import { TOOL_PERMISSIONS, type ToolName } from './permissions';

// Runtime form of core/error's AdapterResult at the tool seam (ADR-0029): every dispatched
// tool resolves a coded discriminated union, never throws. core/error keeps AdapterResult a
// static type (a generic schema would be a factory, not a value); this factory is the
// validator run at the dispatch boundary. The optional card is the tool's render surface,
// owned by ui/card.
export const toolResultSchema = <Data extends z.ZodType>(dataSchema: Data) =>
  z.discriminatedUnion('ok', [
    z.strictObject({
      ok: z.literal(true),
      data: dataSchema,
      card: waldoCardSchema.optional(),
      source_taint: z.null(),
    }),
    z.strictObject({ ok: z.literal(false), error: z.string().min(1), code: errorCodeSchema }),
  ]);

export type ToolResult<T> =
  | { ok: true; data: T; source_taint: SourceTaint; card?: WaldoCard }
  | { ok: false; error: string; code: ErrorCode; source_taint?: SourceTaint };

// The trusted RunLoop V2 path provides this content-free capability only after it has committed
// a durable effect intent. A handler that cannot reconcile a retry on this key must not be used
// for a trusted effect; ordinary dispatcher callers remain on handle().
export type TrustedToolEffect = Readonly<{
  idempotency_key: string;
  request_digest: string;
  // Runtime-owned execution mode: a resumed durable intent may only reconcile the prior effect.
  // A missing receipt in `reconcile` mode is a fail-closed adapter outcome, never permission to
  // issue a second external tool call.
  operation: 'issue' | 'reconcile';
}>;

// A reconciliation adapter may know that it cannot recover a prior effect receipt after a
// restart. This is deliberately distinct from an ordinary tool failure: the RunLoop must retain
// its durable intent and fail closed rather than recording a fabricated settled witness.
export const trustedToolEffectReceiptUnavailableSchema = z.strictObject({
  ok: z.literal(false),
  error: z.string().min(1).max(512),
  code: z.literal('transient'),
  receipt_status: z.literal('unavailable'),
});
export type TrustedToolEffectReceiptUnavailable = z.infer<
  typeof trustedToolEffectReceiptUnavailableSchema
>;

export type TrustedToolExecutionResult<Result> =
  | ToolResult<Result>
  | TrustedToolEffectReceiptUnavailable;

// ADR-0049 accepted amendment: source_taint is a REQUIRED field on external-origin tool
// results (web, document, MCP, connector, calendar/email body text), carried 'external'
// end-to-end. The refine pins the stamp: an absent OR null stamp on an external-origin
// result would launder taint, so both are parse failures. The taint vocabulary is
// single-owned by memory/sanitise. Failure text can be provider-controlled too, so the external
// failure arm is stamped and cannot silently become trusted diagnostic context.
export const externalToolResultSchema = <Data extends z.ZodType>(dataSchema: Data) =>
  z.discriminatedUnion('ok', [
    z.strictObject({
      ok: z.literal(true),
      data: dataSchema,
      card: waldoCardSchema.optional(),
      source_taint: sourceTaintSchema.refine(isExternalSourceTaint, {
        error: "external-origin results are stamped 'external'; a null stamp launders taint",
      }),
    }),
    z.strictObject({
      ok: z.literal(false),
      error: z.string().min(1),
      code: errorCodeSchema,
      source_taint: z.literal('external'),
    }),
  ]);

// The three general-agent tools ship in V1 only WITH the taint gate (ADR-0049): if the gate
// has not landed, these are blocked from execution even with handlers implemented. Their
// results validate through externalToolResultSchema.
export const GENERAL_AGENT_TOOLS: readonly ToolName[] = [
  'web_search',
  'read_document',
  'call_mcp_tool',
];

// External-origin result classification is broader than the general-agent discovery cluster:
// calendar, communication, task, and connector reads also carry provider-controlled text. Keeping
// the complete set here makes a null taint stamp unrepresentable at the dispatcher boundary.
export const EXTERNAL_ORIGIN_TOOLS: readonly ToolName[] = [
  'query_calendar',
  'get_communication',
  'get_tasks',
  'web_search',
  'read_document',
  'call_mcp_tool',
  'search_connector',
];

// A privileged action is any DIRECT external mutation or send (ADR-0049) — the conservative
// superset the taint gate blocks, in tool-union order: the memory/Scribe write, execute_action,
// external send_message, the MCP write bridge, the copilot writes, and every message/thread
// mutation. ADR-0049 defines the class as "any external mutation or send" and requires a
// tainted web/MCP result that asks Waldo to mutate a message/task/thread to route through
// propose_action or block — never direct execution; the message/thread and MCP-write members
// are exactly what a narrower reading would have leaked.
// propose_action is absent — it IS the human-confirm route the gate falls back to.
// execute_code is absent because ADR-0050 gives it zero ACLs (undispatchable). That exclusion
// holds ONLY while it is unreachable: any change granting it an ACL MUST add it here in
// the same change (pinned by handler.test's zero-ACL coupling guard).
export const PRIVILEGED_ACTION_TOOLS: readonly ToolName[] = [
  'update_memory',
  'execute_action',
  'send_message',
  'call_mcp_tool',
  'write_task',
  'update_task',
  'draft_document',
  'draft_email',
  'propose_schedule',
  'write_sheet_cell',
  'create_thread',
  'delete_message',
  'restore_message',
  'archive_thread',
  'update_thread_topics',
];

// The single authority of the ADR-0049 taint gate, pure so hook and dispatcher share one law:
// a privileged action whose arguments derive from external-tainted content routes through
// propose_action (human confirm) or blocks — never direct execution. It is a composition, not
// a bare taint check: the external-taint primitive is single-owned by memory/sanitise, and a
// tool is gated only when it is BOTH tainted AND privileged — so a tainted read (get_crs,
// web_search, read_document) is always allowed. Which of propose_action / block the dispatcher
// picks per tool is its decision; that it can never pick direct execution is this contract.
export function taintGateBlocksDirectExecution(tool: ToolName, taint: SourceTaint): boolean {
  return isExternalSourceTaint(taint) && PRIVILEGED_ACTION_TOOLS.includes(tool);
}

// ADR-0008 conformance rule, deterministic: a handler's trigger_allowlist is the
// per-handler inverse of TOOL_PERMISSIONS — name ∈ TOOL_PERMISSIONS[t] exactly when
// t ∈ trigger_allowlist. A handler claiming a trigger its ACL denies, or hiding one it
// grants, is contract drift.
export function handlerAllowlistMatchesAcl(
  name: ToolName,
  trigger_allowlist: readonly TriggerType[],
): boolean {
  return triggerTypeSchema.options.every(
    (trigger) => TOOL_PERMISSIONS[trigger].includes(name) === trigger_allowlist.includes(trigger),
  );
}

// The ToolHandler seam (ADR-0029): name is the key the dispatcher routes on, typed as the
// union so drift is a compile error; schema validates args at PreToolUse priority 200 and
// autonomy_gated routes through the priority-300 gate (ADR-0032, ADR-0018) before
// execution. Ctx is the InvocationContext contract owned by a later runtime wave;
// genericity keeps this a static type rather than a Zod schema, like HookHandler.
export interface ToolHandler<Args, Result, Ctx> {
  name: ToolName;
  description: string;
  schema: z.ZodType<Args>;
  trigger_allowlist: readonly TriggerType[];
  autonomy_gated: boolean;
  handle(args: Args, ctx: Ctx): Promise<ToolResult<Result>>;
  idempotentOnKey?: true;
  executeOrReconcile?(
    args: Args,
    ctx: Ctx,
    effect: TrustedToolEffect,
  ): Promise<TrustedToolExecutionResult<Result>>;
  // Key-only recovery is intentionally separate from issue execution: it receives no original
  // arguments or invocation context and must return the adapter-held receipt or a typed
  // unavailable outcome.
  reconcileTrustedEffect?(
    effect: TrustedToolEffect,
  ): Promise<TrustedToolExecutionResult<Result>>;
}
