import { getHealthArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type GetHealthArgs, type ToolHandler } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { OwnerHealthTurnSources } from './model-context';
import { markProtectedHealthRead } from './tool-custody';
export const healthReadingsHandler = (sources: OwnerHealthTurnSources): ToolHandler<GetHealthArgs, unknown, ToolDispatcherContext> => markProtectedHealthRead({
  name: 'get_health', schema: getHealthArgsSchema,
  description: 'Read current owner-consented health summaries or a bounded observed daily/series set. Select this only when the owner task needs health. Inputs and reply remain volatile, unavailable algorithms stay unavailable; never infer missing clinical measurements. External work continues in a fresh phase with only minimum operational preferences.',
  autonomy_gated: false, trigger_allowlist: triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes('get_health')),
  async handle(args) {
    await sources.assertCurrent();
    const result = await sources.readings(args);
    await sources.assertCurrent();
    return result.ok ? { ok: true, data: result.data, source_taint: null } : { ok: false, code: 'forbidden', error: 'Consented current health readings are unavailable.', source_taint: null };
  },
}, sources.assertCurrent);
