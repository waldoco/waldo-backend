import { describe, expect, it } from 'vitest';
import { showChartArgsSchema, showHealthChartArgsSchema } from './show-chart';
import { conversationChartTexts, isHealthChart, type ConversationChart } from '../../runtime/conversation-entry';
import { TOOL_PERMISSIONS } from '../permissions';
import { EXTERNAL_ORIGIN_TOOLS, PRIVILEGED_ACTION_TOOLS } from '../handler';

const chart = { title: 'Long runs this block', unit: 'km', series: [{ label: 'Long run', points: [{ t: 1, v: 12 }, { t: 2, v: 14.5 }] }], alt_text: 'Long runs rose from 12 km to 14.5 km over two weeks.' };

describe('show_chart arguments', () => {
  it('takes the chart_series shape without its type or fallback, which the host sets', () => {
    expect(showChartArgsSchema.safeParse(chart).success).toBe(true);
    expect(showChartArgsSchema.safeParse({ ...chart, unit: '' }).success).toBe(true);
    for (const bad of [
      { ...chart, type: 'chart_series' }, { ...chart, fallback_text: 'x' }, { ...chart, alt_text: ' ' }, (({ alt_text: _a, ...rest }) => rest)(chart),
      { ...chart, title: 'x'.repeat(121) }, { ...chart, series: [] }, { ...chart, series: Array.from({ length: 9 }, () => chart.series[0]) },
      { ...chart, series: [{ label: 'a', points: [] }] }, { ...chart, series: [{ label: 'a', points: [{ t: -1, v: 1 }] }] }, { ...chart, series: [{ label: 'a', points: [{ t: 1.5, v: 1 }] }] },
      { ...chart, series: [{ label: 'a', points: [{ t: 1, v: Number.POSITIVE_INFINITY }] }] }, { ...chart, series: [{ label: 'a', points: Array.from({ length: 501 }, (_, t) => ({ t, v: 1 })) }] },
    ]) expect(showChartArgsSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
  });

  it('is the owner chat turn\'s only, and neither outside text nor a privileged action', () => {
    expect(TOOL_PERMISSIONS.user_message).toContain('show_chart');
    for (const [trigger, tools] of Object.entries(TOOL_PERMISSIONS)) if (trigger !== 'user_message') expect(tools, trigger).not.toContain('show_chart');
    expect(EXTERNAL_ORIGIN_TOOLS).not.toContain('show_chart');
    expect(PRIVILEGED_ACTION_TOOLS).not.toContain('show_chart');
  });
});

describe('show_health_chart arguments', () => {
  const query = { title: 'Overnight HRV', signal: 'hrv', from: '2026-10-01', to: '2026-10-14', alt_text: 'Overnight HRV rose over the two weeks.' };
  it('takes one signal over two to 31 local days, with words for a build that draws none, and never points', () => {
    expect(showHealthChartArgsSchema.safeParse(query).success).toBe(true);
    expect(showHealthChartArgsSchema.safeParse({ ...query, signal: 'steps', from: '2026-09-14', to: '2026-10-14' }).success).toBe(true);
    for (const bad of [
      { ...query, signal: 'workouts' }, { ...query, signal: 'blood_glucose' }, { ...query, to: '2026-10-01' }, { ...query, from: '2026-10-15' },
      { ...query, from: '2026-09-13', to: '2026-10-14' }, { ...query, from: '2026-10-1' }, { ...query, alt_text: ' ' }, (({ alt_text: _a, ...rest }) => rest)(query),
      { ...query, title: 'x'.repeat(121) }, { ...query, series: chart.series }, { ...query, unit: 'ms' }, { ...query, signals: ['hrv'] },
    ]) expect(showHealthChartArgsSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
  });

  it('is the owner chat turn\'s only, and neither outside text nor a privileged action', () => {
    expect(TOOL_PERMISSIONS.user_message).toContain('show_health_chart');
    for (const [trigger, tools] of Object.entries(TOOL_PERMISSIONS)) if (trigger !== 'user_message') expect(tools, trigger).not.toContain('show_health_chart');
    expect(EXTERNAL_ORIGIN_TOOLS).not.toContain('show_health_chart');
    expect(PRIVILEGED_ACTION_TOOLS).not.toContain('show_health_chart');
  });

  it('keeps only the query in a stored chart, so a forget reads its words and nothing else', () => {
    const stored: ConversationChart = { title: query.title, alt_text: query.alt_text, unit: '', series: [], health: { signal: 'hrv', from: query.from, to: query.to } };
    expect(isHealthChart(stored)).toBe(true);
    expect(conversationChartTexts(stored)).toEqual([query.title, query.alt_text]);
  });
});
