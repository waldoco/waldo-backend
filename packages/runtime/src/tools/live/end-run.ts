import { endRunArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type EndRunArgs, type EndRunResult, type ToolHandler } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../dispatcher';

const DESCRIPTION = 'End this run (a reminder, a check-back, a card, an update or a task\'s result that Waldo started) and say how: send or ask_owner with the message the owner gets, follow_up once you have set what brings it back, or nothing_to_send. Nothing runs after it.';

// The tool loop ends the run on a successful call (conversation/run-end); the handler only confirms the end it was given.
export const endRunHandler: ToolHandler<EndRunArgs, EndRunResult, ToolDispatcherContext> = {
  name: 'end_run',
  description: DESCRIPTION,
  schema: endRunArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('end_run')),
  autonomy_gated: false,
  async handle(args) {
    return { ok: true, data: { ended: true, outcome: args.outcome }, source_taint: null };
  },
};
