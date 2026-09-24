import { toolNameSchema, toolParameters, type LLMTool, type LLMToolCall, type LLMToolTurn } from '@waldo/contracts';
import { dispatchTool, type DispatchToolOptions, type ToolDispatcherContext } from '../tools/dispatcher';
import type { ToolOutputStore } from './tool-output-store';


export const TOOL_OUTPUT_LIMIT = 16_000;

export const TOOL_OUTPUT_HEAD = 4_000;

export const capToolOutput = (output: string, offload?: ToolOutputStore): string => {
  if (output.length <= TOOL_OUTPUT_LIMIT) return output;
  if (offload === undefined) return `${output.slice(0, TOOL_OUTPUT_LIMIT)}\n[cut: ${output.length - TOOL_OUTPUT_LIMIT} more characters not shown; narrow the request]`;
  const id = offload.put(output);
  return `${output.slice(0, TOOL_OUTPUT_HEAD)}\n[full output stored as ${id}: ${output.length} characters total; call read_tool_output with this id, offset and length to read more]`;
};

export type ToolLoopStep = (
  tools: readonly LLMTool[] | undefined,
  turns: readonly LLMToolTurn[],
) => Promise<Readonly<{ text: string; tool_calls?: readonly LLMToolCall[]; output_items?: readonly Record<string, unknown>[] }>>;

export type ToolLoopEvent = Readonly<{ call: LLMToolCall; ok: boolean; ms: number; output: string }>;

export const toolDefinitions = (handlers: DispatchToolOptions<ToolDispatcherContext>['handlers']): LLMTool[] =>
  handlers.map((handler) => ({
    name: handler.name,
    description: handler.description,
    parameters: toolParameters(handler.schema),
  }));

// The model calls tools until it answers. maxSteps is a safety budget, not a plan (see
// docs/planning/TOOL_LOOP_BUDGET.md). The loop also stops offering tools after
// FAILED_ROUNDS_LIMIT rounds in a row where every call failed. Once tools are withdrawn the
// model must answer, so a turn always ends in words. Identical repeated calls are refused.
export const FAILED_ROUNDS_LIMIT = 3;

export async function runToolLoop(input: Readonly<{
  step: ToolLoopStep;
  handlers: DispatchToolOptions<ToolDispatcherContext>['handlers'];
  ctx: ToolDispatcherContext;
  maxSteps: number;
  offload?: ToolOutputStore;
  onTool?: (event: ToolLoopEvent) => void;
}>): Promise<string> {
  const tools = toolDefinitions(input.handlers);
  const turns: LLMToolTurn[] = [];
  const seen = new Set<string>();
  let failedRounds = 0;
  for (let round = 0; ; round += 1) {
    const offer = tools.length > 0 && round < input.maxSteps && failedRounds < FAILED_ROUNDS_LIMIT;
    const response = await input.step(offer ? tools : undefined, turns);
    if (response.tool_calls === undefined) return response.text;
    let anyOk = false;
    let firstCall = true;
    for (const call of response.tool_calls) {
      const started = Date.now();
      const key = `${call.name}\u0000${call.arguments}`;
      const result = seen.has(key)
        ? { ok: false, error: 'Same call already made this turn; use its result.' }
        : await dispatch(call, input);
      seen.add(key);
      const output = capToolOutput(JSON.stringify(result), input.offload);
      turns.push({ call, output, ...(firstCall && response.output_items?.length ? { prior_items: [...response.output_items] } : {}) });
      firstCall = false;
      input.onTool?.({ call, ok: result.ok, ms: Date.now() - started, output });
      anyOk ||= result.ok;
    }
    failedRounds = anyOk ? 0 : failedRounds + 1;
  }
}

async function dispatch(
  call: LLMToolCall,
  input: Readonly<{ handlers: DispatchToolOptions<ToolDispatcherContext>['handlers']; ctx: ToolDispatcherContext; offload?: ToolOutputStore }>,
): Promise<Readonly<{ ok: boolean; data?: unknown; error?: string }>> {
  const name = toolNameSchema.safeParse(call.name);
  if (!name.success) return { ok: false, error: `Unknown tool ${call.name}.` };
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    return { ok: false, error: 'Arguments were not valid JSON.' };
  }
  const result = await dispatchTool({ id: call.call_id, name: name.data, args }, input.ctx, { handlers: input.handlers, ...(input.offload === undefined ? {} : { offload: input.offload }) });
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
}
