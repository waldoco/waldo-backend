import { getContextArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type GetContextArgs, type ToolHandler } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../dispatcher';

export type OwnerClock = Readonly<{ timezone: string; now: () => Date }>;

export const getContextHandler = (clock: OwnerClock): ToolHandler<GetContextArgs, Readonly<{ now: string; local_time: string; timezone: string }>, ToolDispatcherContext> => ({
  name: 'get_context',
  description: "The owner's current date, local time and timezone.",
  schema: getContextArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('get_context')),
  autonomy_gated: false,
  async handle() {
    const now = clock.now();
    const local_time = new Intl.DateTimeFormat('en-GB', { timeZone: clock.timezone, dateStyle: 'full', timeStyle: 'short' }).format(now);
    return { ok: true, data: { now: now.toISOString(), local_time, timezone: clock.timezone }, source_taint: null };
  },
});
