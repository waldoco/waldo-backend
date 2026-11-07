import {
  replyChartSeriesPartV1Schema, SHOW_CHART_MAX_PER_TURN, showChartArgsSchema, showHealthChartArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type ConversationChart, type ConversationHealthChart, type GetHealthArgs, type GetHealthResult, type ShowChartArgs, type ShowChartResult,
  type ShowHealthChartArgs, type ShowHealthChartResult, type ToolHandler, type ToolResult,
} from '@waldo/contracts';
import type { z } from 'zod';
import { redactSecretUrls } from '../../channels/egress-guard';
import { numericHealthIn } from '../../scribe/sanitiser';
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

// The owner's readings for one chart, read live from the health plane through get_health's own read (its consent check, its
// one source per signal, its folding by local day). Nothing it returns is kept: the tool only learns whether there is
// something to draw, and the chat read draws the points for the response it is building.
export type HealthChartRead = (args: GetHealthArgs) => Promise<ToolResult<GetHealthResult>>;
export type ChartSeriesPart = z.infer<typeof replyChartSeriesPartV1Schema>;
export type HealthChartQuery = ConversationHealthChart['health'];
export type HealthSeries = Readonly<{ unit: string; points: readonly Readonly<{ t: number; v: number }>[] }>;
type HealthRead = Readonly<{ series: HealthSeries }> | Readonly<{ unavailable: Extract<GetHealthResult, { state: 'unavailable' }>['reason'] }> | Readonly<{ refused: string }>;
const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`);
// Only days with a value become points: nothing is invented for a day the store has none for.
export const readHealthSeries = async (query: HealthChartQuery, read: HealthChartRead): Promise<HealthRead> => {
  const answer = await read({ signals: [query.signal as GetHealthArgs['signals'][number]], from: query.from, to: query.to, aggregation: 'daily' });
  if (!answer.ok) return { refused: answer.error };
  if (answer.data.state === 'unavailable') return { unavailable: answer.data.reason };
  const [series] = answer.data.signals;
  const points = (series?.days ?? []).flatMap(day => day.value === null ? [] : [{ t: dayStart(day.day), v: day.value }]);
  return points.length && series ? { series: { unit: series.unit, points } } : { unavailable: 'no_readings' };
};
const SIGNAL_LABELS: Readonly<Record<string, string>> = {
  sleep: 'Sleep', sleep_midpoint: 'Sleep midpoint', hrv: 'HRV', resting_hr: 'Resting heart rate', heart_rate: 'Heart rate', movement: 'Movement',
  daylight: 'Daylight', sleep_light: 'Light sleep', sleep_deep: 'Deep sleep', sleep_rem: 'REM sleep', sleep_awake: 'Awake in bed',
  sleep_efficiency: 'Sleep efficiency', respiratory_rate: 'Breathing rate', spo2: 'Blood oxygen', wrist_temperature: 'Wrist temperature',
  walking_hr: 'Walking heart rate', hr_recovery: 'Heart rate recovery', vo2_max: 'VO2 max', steps: 'Steps', active_energy: 'Active energy',
  mindful: 'Mindful minutes', body_mass: 'Weight', body_fat: 'Body fat', lean_body_mass: 'Lean mass', stand_hours: 'Stand hours',
};
// One chart's part from a series read for its query; each chart keeps its own title and words.
export const healthChartPart = (chart: ConversationHealthChart, series: HealthSeries): ChartSeriesPart | undefined => {
  const part = replyChartSeriesPartV1Schema.safeParse({ type: 'chart_series', title: chart.title, unit: series.unit,
    series: [{ label: SIGNAL_LABELS[chart.health.signal] ?? chart.health.signal, points: series.points }], alt_text: chart.alt_text, fallback_text: chart.alt_text });
  return part.success ? part.data : undefined;
};
// The words are kept with the reply, where readings never go: Scribe's health floor, and any number in them that is one of
// the readings drawn as people write one, rounded (within half a unit, or 1% of a large reading: 14,000 steps for 14,003).
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const carriesDrawnReading = (text: string, points: readonly Readonly<{ v: number }>[]): boolean =>
  (text.match(NUMBER) ?? []).map(number => Number(number.replaceAll(',', ''))).some(number => points.some(point => Math.abs(point.v - number) <= Math.max(0.5, Math.abs(point.v) * 0.01)));
// What a stored health chart holds: the query, its words, and an empty series and unit, so code that predates health charts
// reads it as a chart with nothing to draw and shows its words.
export const storedHealthChart = (title: string, alt_text: string, health: HealthChartQuery): ConversationHealthChart => ({ title, alt_text, unit: '', series: [], health });

const HEALTH_DESCRIPTION = [
  'Draw a chart of the owner\'s own readings in your app reply: one signal over the local days your reply talks about (from before to, at most 31 days ending today).',
  'The reply keeps only which signal and which days; the app re-reads the readings each time it shows the chart, so they are never stored, and a chart whose readings are gone or no longer shared is shown as its alt_text.',
  'Title and alt_text are kept with the reply, so they say what the chart shows in words and never carry a reading: "HRV rose over the last two weeks", not the values.',
  `It shares show_chart's limit of ${SHOW_CHART_MAX_PER_TURN} charts per reply.`,
].join(' ');

export const showHealthChartHandler = (book: TurnChartBook, read: HealthChartRead): ToolHandler<ShowHealthChartArgs, ShowHealthChartResult, ToolDispatcherContext> => ({
  name: 'show_health_chart',
  description: HEALTH_DESCRIPTION,
  schema: showHealthChartArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('show_health_chart')),
  autonomy_gated: false,
  mutates_state: true,
  turn_bound: true,
  async handle(args, ctx) {
    if (ctx.trigger !== 'user_message' || ctx.ownerInitiated !== true || !ctx.turnId) return healthResult({ shown: false, reason: 'not_owner_turn' });
    if (numericHealthIn(args.title) || numericHealthIn(args.alt_text)) return healthResult({ shown: false, reason: 'readings_in_words' });
    const query = { signal: args.signal, from: args.from, to: args.to };
    const drawn = await readHealthSeries(query, read);
    if ('refused' in drawn) return { ok: false, code: 'invalid_args', error: drawn.refused, source_taint: null };
    if ('unavailable' in drawn) return healthResult({ shown: false, reason: 'health_unavailable', health_reason: drawn.unavailable });
    if (carriesDrawnReading(args.title, drawn.series.points) || carriesDrawnReading(args.alt_text, drawn.series.points)) return healthResult({ shown: false, reason: 'readings_in_words' });
    const kept = (text: string) => redactSecretUrls(text).text;
    const left = book.queue(ctx.turnId, storedHealthChart(kept(args.title), kept(args.alt_text), query));
    return left === 'limit_reached' ? healthResult({ shown: false, reason: 'limit_reached' }) : healthResult({ shown: true, charts_left: left });
  },
});
const healthResult = (data: ShowHealthChartResult): ToolResult<ShowHealthChartResult> => ({ ok: true, data, source_taint: null });
