import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { callWhy, forgetTrails } from '../src/channels/approvals';
import { dayPlanBook } from '../src/channels/day-cards';
import { toolDefinitions } from '../src/conversation/tool-loop';
import { appWhy, keptSteps, mergedSteps, peelWhy, readSources, recordRead, recordSharedHealth, withWhy, type TrailRead, type WhyHolder } from '../src/tools/why-trail';

const AT = Date.parse('2026-11-03T01:00:00Z');
const step = (kind: string, ref: string, label = 'Found the 3pm clash', verb = 'checked') => ({ verb, label, source: { kind, ref } });

describe('what a read returned that a step can name', () => {
  it('takes event ids from a calendar read, thread ids from mail reads, node ids from memory and signals from health', () => {
    expect(readSources('query_calendar', { calendar_id: 'primary' }, { events: [{ id: 'evt-3pm', title: 'Design review' }, { id: 'evt-5pm', recurring_event_id: 'evt-series' }] }))
      .toEqual([{ kind: 'calendar_event', ref: 'evt-3pm' }, { kind: 'calendar_event', ref: 'evt-5pm' }, { kind: 'calendar_event', ref: 'evt-series' }]);
    expect(readSources('read_thread', { thread_id: 'thr-1' }, { thread_id: 'thr-1', messages: [{ id: 'm1' }] })).toEqual([{ kind: 'mail_thread', ref: 'thr-1' }]);
    expect(readSources('read_memory', {}, { claims: [{ id: 7, text: 'Runs on Sundays' }], omitted_claim_ids: [9] })).toEqual([{ kind: 'memory_node', ref: '7' }]);
    expect(readSources('get_health', { signals: ['sleep', 'hrv'] }, { state: 'available' })).toEqual([{ kind: 'health_score', ref: 'sleep' }, { kind: 'health_score', ref: 'hrv' }]);
    // A health ref is only a score or signal name, never a value a result put under such a key.
    expect(readSources('get_health', { signals: ['sleep'] }, { signal: 42 })).toEqual([{ kind: 'health_score', ref: 'sleep' }]);
    expect(readSources('query_availability', { calendar_ids: ['primary', 'team@example.test'] }, {})).toEqual([{ kind: 'calendar_free_busy', ref: 'primary' }, { kind: 'calendar_free_busy', ref: 'team@example.test' }]);
  });

  it('a tool that reads none of these names nothing, and an id from another tool names no source', () => {
    expect(readSources('web_search', { query: 'thread_id' }, { thread_id: 'thr-1' })).toEqual([]);
    expect(readSources('read_memory', { thread_id: 'thr-1' }, {})).toEqual([]);
  });

  it('the turn record keeps only reads that named something, and skips arguments it cannot parse', () => {
    const reads: TrailRead[] = [];
    recordRead(reads, 'query_calendar', '{}', { events: [{ id: 'evt-3pm' }] }, AT);
    recordRead(reads, 'web_search', '{"query":"x"}', { results: [] }, AT + 1);
    recordRead(reads, 'read_thread', '{not json', { thread_id: 'thr-1' }, AT + 2);
    recordRead(undefined, 'query_calendar', '{}', { events: [{ id: 'evt-x' }] }, AT + 3);
    expect(reads).toEqual([{ at: AT, sources: [{ kind: 'calendar_event', ref: 'evt-3pm' }] }]);
  });

  it('the shared health the turn was given stands behind the scores it names, once', () => {
    const reads: TrailRead[] = [];
    recordSharedHealth(reads, 'Form: steady, in your usual zone. Recovery: low.', AT);
    recordSharedHealth(reads, 'Form: steady, in your usual zone. Recovery: low.', AT + 5);
    recordSharedHealth(reads, '', AT + 6);
    expect(reads).toEqual([{ at: AT, sources: [{ kind: 'health_score', ref: 'form' }, { kind: 'health_score', ref: 'recovery' }] }]);
  });
});

describe('the steps the host keeps', () => {
  const reads: readonly TrailRead[] = [
    { at: AT, sources: [{ kind: 'health_score', ref: 'recovery' }] },
    { at: AT + 4 * 60_000, sources: [{ kind: 'calendar_event', ref: 'evt-3pm' }] },
    { at: AT + 5 * 60_000, sources: [{ kind: 'calendar_free_busy', ref: 'primary' }] },
  ];

  it('keeps the mockup trail, each step at the time of its read, in time order', () => {
    const kept = keptSteps([
      step('calendar_free_busy', 'primary', 'Found Thursday at 11 free for Priya and Leon', 'prepared'),
      step('calendar_event', 'evt-3pm'),
      step('health_score', 'Recovery', 'Read Recovery', 'read'),
    ], reads);
    expect(appWhy(kept)).toEqual([
      { at: AT, verb: 'read', label: 'Read Recovery', source: 'health_score' },
      { at: AT + 4 * 60_000, verb: 'checked', label: 'Found the 3pm clash', source: 'calendar_event' },
      { at: AT + 5 * 60_000, verb: 'prepared', label: 'Found Thursday at 11 free for Priya and Leon', source: 'calendar_free_busy' },
    ]);
  });

  it('drops a step the model claimed with no read behind it, whatever its words', () => {
    expect(keptSteps([step('calendar_event', 'evt-4pm'), step('mail_thread', 'evt-3pm'), step('memory_node', 'primary')], reads)).toEqual([]);
  });

  it('drops a health step carrying a value, and any step whose line carries a health reading', () => {
    expect(keptSteps([step('health_score', 'recovery', 'Read Recovery, 42 today', 'read'), step('health_score', 'recovery', 'Slept 6h', 'read')], reads)).toEqual([]);
    for (const label of ['HRV 38 ms before the 3pm clash', 'Recovery at 42, so I moved the run', 'Resting HR 58 this morning', 'Sleep was 6h', 'Load 7 of 10 this week'])
      expect([label, keptSteps([step('calendar_event', 'evt-3pm', label)], reads)]).toEqual([label, []]);
    // A health word without a number, or a number without a health word, is an ordinary line.
    expect(keptSteps([step('calendar_event', 'evt-3pm', 'Moved the run since Recovery is low'), step('calendar_event', 'evt-3pm', 'Found the 3pm clash')], reads)).toHaveLength(2);
  });

  it('drops a step in the wrong shape, a repeat, and anything that is not a list', () => {
    expect(keptSteps([{ ...step('calendar_event', 'evt-3pm'), verb: 'approved' }, step('calendar_event', 'evt-3pm'), step('calendar_event', 'evt-3pm')], reads)).toHaveLength(1);
    expect(keptSteps('Found the 3pm clash', reads)).toEqual([]);
    expect(keptSteps(undefined, reads)).toEqual([]);
  });

  it('a day card gathers its cards\' steps once each, at most eight', () => {
    const one = keptSteps([step('calendar_event', 'evt-3pm')], reads);
    expect(mergedSteps([...one, ...one])).toEqual(one);
    expect(mergedSteps(Array.from({ length: 12 }, (_, i) => ({ ...one[0]!, label: `Step ${i}` })))).toHaveLength(8);
  });
});

describe('the why argument on a proposing tool', () => {
  it('appears in a tool definition only when the tool takes it, beside the tool\'s own parameters', () => {
    const plain = { name: 'propose_calendar_change', description: 'Propose a change.', schema: z.strictObject({ reason: z.string() }) };
    const [before] = toolDefinitions([plain] as never), [after] = toolDefinitions([{ ...plain, takes_why: true }] as never);
    expect(Object.keys((before!.parameters as { properties: object }).properties)).toEqual(['reason']);
    expect(Object.keys((after!.parameters as { properties: object }).properties)).toEqual(['reason', 'why']);
    expect((after!.parameters as { required?: string[] }).required ?? []).not.toContain('why');
  });

  it('is taken off the call before its arguments are checked', () => {
    expect(peelWhy({ action: 'create', why: [step('calendar_event', 'evt-3pm')] })).toEqual({ args: { action: 'create' }, why: [step('calendar_event', 'evt-3pm')] });
    expect(peelWhy({ action: 'create' })).toEqual({ args: { action: 'create' }, why: undefined });
    expect(peelWhy(['why'])).toEqual({ args: ['why'], why: undefined });
  });

  it('is offered only on the proposing tools the switch wraps, and the kept steps reach only the call that claimed them', async () => {
    const holder: WhyHolder = { collected: [] };
    const seen: unknown[] = [];
    const handlers = withWhy([
      { name: 'propose_calendar_change', handle: async (_args: never, ctx: never) => { seen.push(callWhy(ctx)); return { ok: true }; } },
      { name: 'propose_action', handle: async (_args: never, ctx: never) => { seen.push(callWhy(ctx)); return { ok: false }; } },
      { name: 'read_memory', handle: async () => ({ ok: true }) },
    ], holder);
    expect(handlers.map(handler => 'takes_why' in handler)).toEqual([true, true, false]);
    const run = (index: number, ctx: object) => (handlers[index]!.handle as (args: unknown, ctx: unknown) => Promise<unknown>)({}, ctx);
    const turnReads = [{ at: AT, sources: [{ kind: 'calendar_event', ref: 'evt-3pm' }] }];
    // A card raised while another call's steps are kept, here one with none of its own, takes none of them.
    await Promise.all([run(0, { claimedWhy: [step('calendar_event', 'evt-3pm')], turnReads }), run(0, { turnReads })]);
    expect(seen).toEqual([[{ at: AT, verb: 'checked', label: 'Found the 3pm clash', source: { kind: 'calendar_event', ref: 'evt-3pm' } }], undefined]);
    expect(holder.collected).toEqual([seen[0]].flat());
    // A proposal that failed raised no card, so the day card gathers nothing from it.
    await run(1, { claimedWhy: [step('calendar_event', 'evt-3pm', 'Another line')], turnReads });
    expect(holder.collected).toHaveLength(1);
  });
});

describe('owner forget', () => {
  it('clears every trail that names the forgotten text, on cards and day cards, and leaves the rest', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`why-forget-${crypto.randomUUID()}`)), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec('CREATE TABLE ledger (id TEXT PRIMARY KEY, why_json TEXT)');
      const trail = (label: string) => JSON.stringify([{ at: AT, verb: 'read', label, source: { kind: 'memory_node', ref: '7' } }]);
      sql.exec('INSERT INTO ledger (id, why_json) VALUES (?, ?), (?, ?), (?, NULL)', 'p1', trail('Read about the Priya offsite'), 'p2', trail('Read your goal for the half'), 'p3');
      const book = dayPlanBook(sql);
      book.why('2026-11-03', 'card:brief', trail('Read about the Priya offsite'));
      expect(forgetTrails(sql, ['Priya offsite']) + book.forgetWhy(['Priya offsite'])).toBe(0);
      expect(sql.exec<{ id: string }>('SELECT id FROM ledger WHERE why_json IS NOT NULL').toArray().map(row => row.id)).toEqual(['p2']);
      expect(book.whys('2026-11-03').size).toBe(0);
    });
  });
});
