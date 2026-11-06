import { z } from 'zod';
import { replyChartSeriesPartV1Schema } from '../../app/parts';

// show_chart: a chart in the owner's app reply, drawn from numbers the model already has in this turn (a quest's progress, the
// day's plan, a trend it read). The host keeps it with the reply as the app.v1 chart_series part; alt_text is the part's
// fallback, so a build or surface that draws no chart still reads what it shows. What to chart is the model's call; the
// host bounds the shape and the count per reply.
export const SHOW_CHART_MAX_PER_TURN = 2;
export const showChartArgsSchema = replyChartSeriesPartV1Schema.omit({ type: true, fallback_text: true });
export type ShowChartArgs = z.infer<typeof showChartArgsSchema>;
export const showChartResultSchema = z.union([
  z.strictObject({ shown: z.literal(true), charts_left: z.int().nonnegative() }),
  // not_owner_turn: only the owner's own chat turn carries a chart. limit_reached: this reply has its charts.
  z.strictObject({ shown: z.literal(false), reason: z.enum(['not_owner_turn', 'limit_reached']) }),
]);
export type ShowChartResult = z.infer<typeof showChartResultSchema>;
