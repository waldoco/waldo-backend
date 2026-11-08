import {
  SHOW_CHART_MAX_PER_TURN, showChartArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type ConversationChart, type ShowChartArgs, type ShowChartResult, type ToolHandler, type ToolResult,
} from '@waldo/contracts';
import { redactSecretUrls } from '../../channels/egress-guard';
import type { ToolDispatcherContext } from '../dispatcher';

// The charts the model drew for its turn's reply, by the turn's id. The owner turn takes them when it saves the reply, so they
// are stored with it and read back with it; a turn that never saves a reply leaves them to clear(). Turns run one at a time
// per owner, so a queue lost with the process is a reply that was never saved either.
export const turnChartBook = () => {
  const queued = new Map<string, ConversationChart[]>();
  return {
    queue(turnId: string, chart: ConversationChart): number | 'limit_reached' {
      const charts = queued.get(turnId) ?? [];
      if (charts.length >= SHOW_CHART_MAX_PER_TURN) return 'limit_reached';
      queued.set(turnId, [...charts, chart]);
      return SHOW_CHART_MAX_PER_TURN - charts.length - 1;
    },
    take(turnId: string): readonly ConversationChart[] { const charts = queued.get(turnId) ?? []; queued.delete(turnId); return charts; },
    clear(turnId: string): void { queued.delete(turnId); },
  };
};
export type TurnChartBook = ReturnType<typeof turnChartBook>;

const DESCRIPTION = [
  'Draw a chart in your reply in the owner\'s app: one to eight series of points (t is the x position: a day number, an hour or epoch ms; v the value), a title, a unit and alt_text.',
  'Chart only numbers you already have in this turn, such as a quest\'s progress, the day\'s plan or a trend you read; never invent points.',
  'alt_text says in a sentence or two what the chart shows: it is what a build or surface that draws no chart shows instead, so write your reply to read whole without the chart.',
  'A chart is kept with the reply, so once this turn has read the owner\'s health readings none is drawn: say the trend in words instead.',
  `At most ${SHOW_CHART_MAX_PER_TURN} per reply.`,
].join(' ');

const result = (data: ShowChartResult): ToolResult<ShowChartResult> => ({ ok: true, data, source_taint: null });

export const showChartHandler = (book: TurnChartBook): ToolHandler<ShowChartArgs, ShowChartResult, ToolDispatcherContext> => ({
  name: 'show_chart',
  description: DESCRIPTION,
  schema: showChartArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('show_chart')),
  autonomy_gated: false,
  mutates_state: true,
  turn_bound: true,
  async handle(args, ctx) {
    if (ctx.trigger !== 'user_message' || ctx.ownerInitiated !== true || !ctx.turnId) return result({ shown: false, reason: 'not_owner_turn' });
    // Raw readings never go into the transcript, and a chart's points are kept there: a turn whose model has seen a reading
    // (from a tool or in its own context) draws none.
    if (ctx.healthShown === true) return result({ shown: false, reason: 'health_in_turn' });
    // Chart text is stored like the reply's own, so a secret-bearing link in it is removed the same way.
    const kept = (text: string) => redactSecretUrls(text).text;
    const left = book.queue(ctx.turnId, { title: kept(args.title), unit: kept(args.unit), alt_text: kept(args.alt_text),
      series: args.series.map(series => ({ label: kept(series.label), points: series.points.map(point => ({ t: point.t, v: point.v })) })) });
    return left === 'limit_reached' ? result({ shown: false, reason: 'limit_reached' }) : result({ shown: true, charts_left: left });
  },
});
