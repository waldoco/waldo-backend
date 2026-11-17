import { z } from 'zod';
import { replyChartSeriesPartV1Schema } from '../../app/parts';
import { HEALTH_READ_MAX_DAYS, healthReadSignalSchema } from './reads';

// show_chart: a chart in the owner's app reply, drawn from numbers the model already has in this turn (a quest's progress, the
// day's plan, a trend it read). The host keeps it with the reply as the app.v1 chart_series part; alt_text is the part's
// fallback, so a build or surface that draws no chart still reads what it shows. What to chart is the model's call; the
// host bounds the shape and the count per reply.
export const SHOW_CHART_MAX_PER_TURN = 2;
export const showChartArgsSchema = replyChartSeriesPartV1Schema.omit({ type: true, fallback_text: true });
export type ShowChartArgs = z.infer<typeof showChartArgsSchema>;
export const showChartResultSchema = z.union([
  z.strictObject({ shown: z.literal(true), charts_left: z.int().nonnegative() }),
  // not_owner_turn: only the owner's own chat turn carries a chart. limit_reached: this reply has its charts. health_in_turn:
  // this turn has shown the model the owner's health readings, and a chart is kept with the reply, where readings never go.
  z.strictObject({ shown: z.literal(false), reason: z.enum(['not_owner_turn', 'limit_reached', 'health_in_turn']) }),
]);
export type ShowChartResult = z.infer<typeof showChartResultSchema>;

// show_health_chart: a chart of the owner's own readings, one signal over the days the reply talks about. The reply keeps this
// query and never the values; each read of the chat re-reads the health plane, so the readings never persist in the transcript
// and a withdrawal or deletion takes the chart back to its words. Workouts are sessions, not one value a day, so they are not
// charted here.
export const healthChartSignalSchema = healthReadSignalSchema.exclude(['workouts']);
const chartDay = z.iso.date();
const dayNumber = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
export const showHealthChartArgsSchema = z.strictObject({
  title: replyChartSeriesPartV1Schema.shape.title,
  signal: healthChartSignalSchema,
  from: chartDay,
  to: chartDay,
  alt_text: replyChartSeriesPartV1Schema.shape.alt_text,
})
  .refine((args) => dayNumber(args.from) < dayNumber(args.to), { error: 'from must be before to: a chart needs at least two days', path: ['to'] })
  .refine((args) => dayNumber(args.to) - dayNumber(args.from) < HEALTH_READ_MAX_DAYS, { error: `at most ${HEALTH_READ_MAX_DAYS} days`, path: ['to'] });
export type ShowHealthChartArgs = z.infer<typeof showHealthChartArgsSchema>;
export const showHealthChartResultSchema = z.union([
  z.strictObject({ shown: z.literal(true), charts_left: z.int().nonnegative() }),
  // readings_in_words: the title or alt text carries a reading, and those words are kept with the reply. health_unavailable:
  // the health plane has nothing to draw for these days right now (why is in health_reason), so the chart would only be words.
  z.strictObject({ shown: z.literal(false), reason: z.enum(['not_owner_turn', 'limit_reached', 'readings_in_words']) }),
  z.strictObject({ shown: z.literal(false), reason: z.literal('health_unavailable'),
    health_reason: z.enum(['consent_required', 'consent_withdrawn', 'not_linked', 'no_readings', 'read_failed']) }),
]);
export type ShowHealthChartResult = z.infer<typeof showHealthChartResultSchema>;
