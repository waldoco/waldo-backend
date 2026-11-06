import { describe, expect, it } from 'vitest';
import { showChartArgsSchema } from './show-chart';
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
