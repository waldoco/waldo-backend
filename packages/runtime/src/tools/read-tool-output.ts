import {
  readToolOutputArgsSchema,
  TOOL_PERMISSIONS,
  triggerTypeSchema,
  type ReadToolOutputArgs,
  type ToolHandler,
} from '@waldo/contracts';
import type { ToolOutputStore } from '../conversation/tool-output-store';
import type { ToolDispatcherContext } from './dispatcher';

export const readToolOutputHandler = (store: ToolOutputStore) => ({
  name: 'read_tool_output',
  description: 'Read a range of a stored large tool output. The id comes from a truncated tool result; offset starts at 0 and the result carries next_offset when more remains.',
  schema: readToolOutputArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('read_tool_output')),
  autonomy_gated: false,
  async handle({ id, offset, length }: ReadToolOutputArgs) {
    const slice = store.read(id, offset ?? 0, length ?? 4_000);
    if (slice === null) return { ok: false as const, code: 'not_found' as const, error: `No stored output ${id}; stored outputs live for the current conversation only.`, source_taint: 'external' as const };
    return { ok: true as const, data: slice, source_taint: 'external' as const };
  },
} satisfies ToolHandler<ReadToolOutputArgs, { text: string; total: number; original_chars: number; truncated: boolean; next_offset: number | null }, ToolDispatcherContext>);
