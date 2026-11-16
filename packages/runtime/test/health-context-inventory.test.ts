import { describe, expect, it } from 'vitest';
import { derivedHealthDestinationViewSchema } from '@waldo/contracts';
import { healthContextBook, toHealthInventory, type HealthContextRow } from '../src/channels/health-context';
import { md5Hex } from '../src/channels/md5';
import { renderHealth } from '../src/context-composer/prompt';
import { scrubTraceHealth } from '../src/observability/trace-health-scrub';

// The inventory: which kinds of body data exist, in words, beside or instead of the stored row. Synthetic owner in Kolkata,
// read at noon local time on 1 Nov 2026; no reading value appears anywhere here, since the read never returns one.
const TZ = 'Asia/Kolkata', HOUR = 3_600_000;
const NOW = Date.parse('2026-11-01T06:30:00Z');
const clock = { timezone: TZ, now: () => new Date(NOW) };
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString().replace('.000Z', 'Z');
const kind = (signal: string, hoursAgo: number, days: number) => ({ signal, newest_at: ago(hoursAgo), days });
const STEPS_ONLY = { sources: [{ source: 'health_connect', kinds: [kind('steps_window', 1, 30), kind('heart_rate_window', 2, 12)] }] };

// A row with a Form zone, as waldo.health_context_read returns it.
const FULL_ROW: HealthContextRow = {
  context: {
    id: 'ctx-full', day: '2026-11-01', compiled_at: ago(1), freshness: 'fresh', confidence: 0.8, drivers: [], tags: [],
    recovery: { score: 71, zone: 'good', algorithm_version: 'recovery.candidate.v4' },
    form: { score: 66, zone: 'good', algorithm_version: 'form.v10' },
    weight: { score: 40, zone: 'moderate', algorithm_version: 'weight.v5' },
    basis: [{ source: 'health_connect', consent_epoch: 1 }],
  },
  previous: null,
};

const book = (answers: { row?: unknown; inventory?: unknown }, options = { partial: true, inventory: true }) => {
  const calls: { fn: string; message: string; args: Record<string, string | number> }[] = [];
  const errors: string[] = [];
  const codes: string[] = [];
  const call = async (fn: string, message: string, args: Record<string, string | number>) => {
    calls.push({ fn, message, args });
    if (fn === 'health_context_read') return answers.row ?? null;
    if (fn === 'health_inventory_read') { if (answers.inventory instanceof Error) throw answers.inventory; return answers.inventory; }
    throw new Error(`unexpected rpc ${fn}`);
  };
  const health = healthContextBook(call, 'do-x', clock, error => errors.push(String(error)), (present, _trace, partial) => codes.push(partial ? 'partial' : present ? 'present' : 'absent'), options);
  return { health, calls, errors, codes };
};

describe('the health inventory in words', () => {
  it('merges a kind across sources, keeps the newest and the most days, and says each in words', () => {
    const inventory = toHealthInventory({ sources: [
      { source: 'apple', kinds: [kind('sleep_duration', 6, 20), kind('body_mass', 24 * 9, 2)] },
      { source: 'health_connect', kinds: [kind('sleep_duration', 30, 27), kind('steps_window', 26, 5)] },
    ] }, clock);
    expect(inventory?.entries).toEqual([
      { signal: 'sleep_duration', grain: 'night', newest: 'today', regularity: 'nearly_every_day', sources: ['apple', 'health_connect'] },
      { signal: 'steps_window', grain: 'hour', newest: 'yesterday', regularity: 'some_days', sources: ['health_connect'] },
      { signal: 'body_mass', grain: 'reading', newest: 'this_month', regularity: 'a_few_days', sources: ['apple'] },
    ]);
    expect(inventory?.newestAt).toBe(NOW - 6 * HOUR);
  });

  it('leaves out a kind or a source it does not know, and gives no inventory for an answer of another shape', () => {
    expect(toHealthInventory({ sources: [{ source: 'fitbit', kinds: [kind('steps_window', 1, 3)] }, { source: 'apple', kinds: [kind('blood_glucose', 1, 3)] }] }, clock)?.entries).toEqual([]);
    expect(toHealthInventory({ kinds: [] }, clock)).toBeNull();
  });

  it('gives an owner with readings and no score row a block of what exists, with no zone and no figure', async () => {
    const { health, codes } = book({ inventory: STEPS_ONLY });
    const material = await health.latest();
    expect(material && derivedHealthDestinationViewSchema.safeParse(material.view).success).toBe(true);
    const block = renderHealth(material);
    expect(block).toBe([
      'Partial health context: no Recovery, Form or Load reading is stored for this owner yet, so there is no recovery or readiness reading to give.',
      'Freshness: fresh. Latest body data: today, from Health Connect.',
      'Body data on hand this month: heart rate through the day (hourly; newest within hours; some days); steps (hourly; newest within hours; nearly every day).',
      'If get_health is in your function list, it reads any kind on hand; read what the question needs before answering from the body data.',
    ].join('\n'));
    expect(block).not.toMatch(/\d/);
    expect(codes).toEqual(['partial']);
    const input = JSON.stringify([{ role: 'system', content: `Before.\n\n${block}\n\nAfter.` }]);
    const scrubbed = JSON.stringify(scrubTraceHealth({ trace: 't', hop: 'llm_reply', ms: 1, ok: true, text: { input, output: '' } }).text);
    expect(scrubbed).not.toContain('Body data on hand');
    expect(scrubbed).toContain('Before.');
  });

  it('adds the inventory to a full day\'s block as one line', async () => {
    const block = renderHealth(await book({ row: FULL_ROW, inventory: STEPS_ONLY }).health.latest());
    const without = renderHealth(await book({ row: FULL_ROW, inventory: { sources: [] } }).health.latest());
    expect(block.split('\n').filter(line => !without.split('\n').includes(line))).toEqual([
      'Body data on hand this month: heart rate through the day (hourly; newest within hours; some days); steps (hourly; newest within hours; nearly every day).',
    ]);
  });

  it('signs the read over the exact payload: the owner\'s last thirty local days', async () => {
    const { health, calls } = book({ inventory: STEPS_ONLY });
    await health.latest();
    const payload = JSON.stringify({ from: '2026-10-03', to: '2026-11-01' });
    expect(calls.find(call => call.fn === 'health_inventory_read')).toEqual({
      fn: 'health_inventory_read', message: `health.inventory_read.do-x.${md5Hex(payload)}`, args: { p_do_name: 'do-x', p_payload: payload },
    });
  });

  it('reads no inventory unless both switches are on', async () => {
    for (const options of [{ partial: true, inventory: false }, { partial: false, inventory: true }]) {
      const { health, calls } = book({ row: FULL_ROW, inventory: STEPS_ONLY }, options);
      expect(renderHealth(await health.latest())).not.toContain('Body data on hand');
      expect(calls.map(call => call.fn)).toEqual(['health_context_read']);
    }
  });

  it('gives the row\'s block alone, and logs why, when the inventory read fails or answers another shape', async () => {
    for (const inventory of [new Error('timeout'), { error: 'invalid_request' }]) {
      const { health, errors, codes } = book({ row: FULL_ROW, inventory });
      const block = renderHealth(await health.latest());
      expect(block).toContain('Form zone: steady.');
      expect(block).not.toContain('Body data on hand');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/health inventory read/);
      expect(codes).toEqual(['present']);
    }
  });

  it('says nothing more for an owner the plane does not know, and gives no block when nothing exists', async () => {
    const unlinked = book({ inventory: { error: 'not_linked' } });
    expect(await unlinked.health.latest()).toBeNull();
    expect(unlinked.errors).toEqual([]);
    const empty = book({ inventory: { sources: [{ source: 'apple', kinds: [] }] } });
    expect(await empty.health.latest()).toBeNull();
    expect(empty.codes).toEqual(['absent']);
  });

  it('ages an owner whose newest reading is days old as expired, and still says what exists', async () => {
    const block = renderHealth(await book({ inventory: { sources: [{ source: 'apple', kinds: [kind('sleep_duration', 24 * 5, 9)] }] } }).health.latest());
    expect(block).toContain('is more than three days old');
    expect(block).toContain('Body data on hand this month: time asleep (nightly; newest this week; some days).');
  });
});
