import { describe, expect, it } from 'vitest';
import { TOOL_PERMISSIONS } from '@waldo/contracts';
import { healthLogBook, healthLogHandlers, healthSection, type HealthLogEntry } from '../src/channels/health-log';
import { md5Hex } from '../src/channels/md5';

describe('md5', () => {
  it('matches the published RFC 1321 vectors', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });

  it('matches Postgres md5() on the exact payload bytes, including non-ASCII', () => {
    // Values produced by md5() over the same UTF-8 text; pgTAP signs the identical strings.
    expect(md5Hex('{"description":"dal, rice, paneer"}')).toBe('5bf72f2e031a4e23276e860b699d14ce');
    expect(md5Hex('{"description":"डाल, चावल"}')).toBe('1070f2550037b9cec8a120241a51546b');
  });
});

describe('health log book', () => {
  const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-09-27T07:45:00Z') };
  const calls: { fn: string; message: string; args: Record<string, string | number> }[] = [];
  const call = async (fn: string, message: string, args: Record<string, string | number>) => {
    calls.push({ fn, message, args });
    return fn === 'health_log_add' ? 7 : [];
  };
  const book = healthLogBook(call, 'do-health', 'telegram', clock);

  it('signs health.add with the md5 of the exact payload text it sends', async () => {
    const logged = await book.log('meal', { description: 'dal, rice, paneer', calories_estimate: 600 }, '2026-09-27T13:15');
    expect(logged).toEqual({ id: 7, at: '2026-09-27T13:15' });
    const sent = calls[0]!;
    const body = JSON.stringify({ description: 'dal, rice, paneer', calories_estimate: 600 });
    expect(sent.fn).toBe('health_log_add');
    expect(sent.message).toBe(`health.add.do-health.meal.telegram.${md5Hex(body)}`);
    expect(sent.args).toMatchObject({ p_do_name: 'do-health', p_kind: 'meal', p_source: 'telegram', p_payload: body });
    expect(Date.parse(String(sent.args['p_logged_at']))).toBe(Date.parse('2026-09-27T13:15:00+05:30'));
  });

  it('signs health.recent with the same do name and limit', async () => {
    await book.recent(10);
    expect(calls[1]).toMatchObject({ fn: 'health_log_recent', message: 'health.recent.do-health.10', args: { p_do_name: 'do-health', p_limit: 10 } });
  });

  it('signs health.delete with the do name and the id, and answers the removed row or null', async () => {
    const row: HealthLogEntry = { id: 7, kind: 'meal', logged_at: '2026-09-27T07:45:00Z', source: 'telegram', payload: { description: 'dal, rice' } };
    const sent: { fn: string; message: string; args: Record<string, string | number> }[] = [];
    const deleting = healthLogBook(async (fn, message, args) => { sent.push({ fn, message, args }); return args['p_id'] === 7 ? [row] : []; }, 'do-health', 'telegram', clock);
    await expect(deleting.remove(7)).resolves.toEqual({ id: 7, kind: 'meal', at: '2026-09-27T13:15', payload: { description: 'dal, rice' } });
    expect(sent[0]).toEqual({ fn: 'health_log_delete', message: 'health.delete.do-health.7', args: { p_do_name: 'do-health', p_id: 7 } });
    await expect(deleting.remove(8)).resolves.toBeNull();
  });

  it('fails writes and empties reads when the store is not linked', async () => {
    const unlinked = healthLogBook(null, null, 'telegram', clock);
    expect(unlinked.linked()).toBe(false);
    await expect(unlinked.log('meal', { description: 'x' }, undefined)).rejects.toThrow('not linked');
    await expect(unlinked.remove(1)).rejects.toThrow('not linked');
    await expect(unlinked.recent(10)).resolves.toEqual([]);
  });

  it('degrades a failing read to empty so the beats never break', async () => {
    const errors: unknown[] = [];
    const failing = healthLogBook(async () => { throw new Error('connection refused'); }, 'do-health', 'whatsapp', clock, (error) => errors.push(error));
    await expect(failing.recent(10)).resolves.toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe('health log tools', () => {
  const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-09-27T07:45:00Z') };
  const stored: { kind: string; payload: Record<string, unknown>; at: string | undefined }[] = [];
  const rows: HealthLogEntry[] = [
    { id: 2, kind: 'workout', logged_at: '2026-09-27T00:30:00Z', source: 'telegram', payload: { type: 'run', duration_minutes: 30 } },
    { id: 1, kind: 'meal', logged_at: '2026-09-26T14:00:00Z', source: 'whatsapp', payload: { description: 'dal, rice', calories_estimate: 550 } },
  ];
  const book = healthLogBook(
    async (fn, _message, args) => (fn === 'health_log_add' ? 3 : fn === 'health_log_delete' ? rows.filter((row) => row.id === args['p_id']) : rows),
    'do-health', 'telegram', clock,
  );
  const wrapped = {
    ...book,
    async log(kind: 'meal' | 'workout', payload: Record<string, unknown>, at: string | undefined) {
      stored.push({ kind, payload, at });
      return book.log(kind, payload, at);
    },
  };
  const [logMeal, logWorkout, listHealthLogs, deleteHealthLog] = healthLogHandlers(wrapped);

  it('are chat-turn tools: owner writes live only on user_message', () => {
    for (const handler of [logMeal!, logWorkout!, listHealthLogs!, deleteHealthLog!]) {
      expect(handler.trigger_allowlist).toEqual(['user_message']);
      expect(TOOL_PERMISSIONS.user_message).toContain(handler.name);
    }
    expect(logMeal!.mutates_state).toBe(true);
    expect(logWorkout!.mutates_state).toBe(true);
    expect(deleteHealthLog!.name).toBe('delete_health_log');
    expect(deleteHealthLog!.mutates_state).toBe(true);
  });

  it('delete answers what it removed, at the owner\'s local time, so the reply can quote it and the owner can log it again', async () => {
    const result = await deleteHealthLog!.handle({ id: 1 } as never);
    expect(result).toEqual({
      ok: true,
      data: { removed: { id: 1, kind: 'meal', at: '2026-09-26T19:30', payload: { description: 'dal, rice', calories_estimate: 550 } } },
      source_taint: null,
    });
  });

  it('delete of an id the owner does not have is not_found and names the way to find one', async () => {
    const result = await deleteHealthLog!.handle({ id: 99 } as never);
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
    expect((result as { error: string }).error).toContain('list_health_logs');
  });

  it('delete with the store unlinked is transient, never a silent success', async () => {
    const [, , , unlinkedDelete] = healthLogHandlers(healthLogBook(null, null, 'telegram', clock));
    expect(await unlinkedDelete!.handle({ id: 1 } as never)).toMatchObject({ ok: false, code: 'transient' });
  });

  it('logs a meal with an honest estimate marker in the payload', async () => {
    const result = await logMeal!.handle({ description: 'dal, rice, paneer', calories_estimate: 600, at: '2026-09-27T13:15' } as never);
    expect(result).toMatchObject({ ok: true, data: { id: 3, kind: 'meal', at: '2026-09-27T13:15' } });
    expect(stored[0]).toMatchObject({ kind: 'meal', payload: { description: 'dal, rice, paneer', calories_estimate: 600 }, at: '2026-09-27T13:15' });
  });

  it('omits optional fields from the payload rather than writing nulls', async () => {
    await logWorkout!.handle({ type: 'run', duration_minutes: 30 } as never);
    expect(stored[1]!.payload).toEqual({ type: 'run', duration_minutes: 30 });
  });

  it('lists recent entries with the kind filter applied after the bounded read', async () => {
    const result = await listHealthLogs!.handle({ kind: 'meal', limit: 10 } as never);
    expect(result).toMatchObject({ ok: true, data: { linked: true, entries: [{ id: 1, kind: 'meal' }] } });
  });
});

describe('health ledger section', () => {
  it('renders terse lines with estimates marked and never a diagnosis', () => {
    const section = healthSection(
      [
        { id: 1, kind: 'meal', logged_at: '2026-09-27T02:00:00Z', source: 'telegram', payload: { description: 'dal, rice, paneer', calories_estimate: 600 } },
        { id: 2, kind: 'workout', logged_at: '2026-09-27T00:30:00Z', source: 'telegram', payload: { type: 'run', duration_minutes: 30 } },
      ],
      'Asia/Kolkata',
    );
    expect(section).toBe(
      'Recent health logs (owner-logged; calorie figures are estimates):\n- 09-27 07:30 meal: dal, rice, paneer (~600 kcal, estimate)\n- 09-27 06:00 workout: run, 30 min',
    );
  });

  it('is empty when there is nothing logged', () => {
    expect(healthSection([], 'Asia/Kolkata')).toBe('');
  });
});
