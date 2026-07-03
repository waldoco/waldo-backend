import { z } from 'zod';
import { errorCodeSchema, type ErrorCode } from '../core/error';
import { triggerTypeSchema, type TriggerType } from '../core/trigger';
import { sourceTaintSchema, type SourceTaint } from '../memory/sanitise';
import { waldoCardSchema, type WaldoCard } from '../ui/card';
import { TOOL_PERMISSIONS, type ToolName } from './permissions';

// Runtime form of core/error's AdapterResult at the tool seam (ADR-0029): every dispatched
// tool resolves a coded discriminated union, never throws. core/error keeps AdapterResult a
// static type (a generic schema would be a factory, not a value); this factory is the
// validator run at the dispatch boundary. The optional card is the tool's render surface,
// owned by ui/card.
export const toolResultSchema = <Data extends z.ZodType>(dataSchema: Data) =>
  z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), data: dataSchema, card: waldoCardSchema.optional() }),
    z.strictObject({ ok: z.literal(false), error: z.string().min(1), code: errorCodeSchema }),
  ]);

export type ToolResult<T> =
  | { ok: true; data: T; card?: WaldoCard }
  | { ok: false; error: string; code: ErrorCode };

// ADR-0049 accepted amendment: source_taint is a REQUIRED field on external-origin tool
// results (web, document, MCP, connector, calendar/email body text), carried 'external'
// end-to-end. The refine pins the stamp: an absent OR null stamp on an external-origin
// result would launder taint, so both are parse failures. The taint vocabulary is
// single-owned by memory/sanitise; a failure branch carries no content, hence no stamp.
export const externalToolResultSchema = <Data extends z.ZodType>(dataSchema: Data) =>
  z.discriminatedUnion('ok', [
    z.strictObject({
      ok: z.literal(true),
      data: dataSchema,
      card: waldoCardSchema.optional(),
      source_taint: sourceTaintSchema.refine((taint) => taint === 'external', {
        error: "external-origin results are stamped 'external'; a null stamp launders taint",
      }),
    }),
    z.strictObject({ ok: z.literal(false), error: z.string().min(1), code: errorCodeSchema }),
  ]);

// The three general-agent tools ship in V1 only WITH the taint gate (ADR-0049): if the gate
// has not landed, these are blocked from execution even with handlers implemented. Their
// results validate through externalToolResultSchema.
export const GENERAL_AGENT_TOOLS: readonly ToolName[] = [
  'web_search',
  'read_document',
  'call_mcp_tool',
];

// A privileged action is any external mutation or send (ADR-0049): execute_action, external
// send_message, update_memory/Scribe writes, and the connector writes — in union order.
// propose_action is absent because it IS the human-confirm route; execute_code is absent
// because zero ACLs (ADR-0050) already make it undispatchable — Phase 3 revisits.
export const PRIVILEGED_ACTION_TOOLS: readonly ToolName[] = [
  'update_memory',
  'execute_action',
  'send_message',
  'write_task',
  'update_task',
  'draft_document',
  'draft_email',
  'propose_schedule',
  'write_sheet_cell',
];

// The pinned half of the ADR-0049 taint gate, pure so hooks and dispatch share one law: a
// privileged action whose arguments derive from external-tainted content routes through
// propose_action (human confirm) or blocks. Which of those two the dispatcher picks per
// tool is its decision; that it can never pick direct execution is this contract.
export function taintGateBlocksDirectExecution(tool: ToolName, taint: SourceTaint): boolean {
  return taint === 'external' && PRIVILEGED_ACTION_TOOLS.includes(tool);
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
}
