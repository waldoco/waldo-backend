import type { SanitiseDestination, SanitiseInput } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { sanitise } from '../src/scribe/sanitiser';

const CANARIES = ['1111111111111111', '2222222222222222', '3333333333333333'] as const;
const run = (payload: SanitiseInput['payload'], destination: SanitiseDestination, source_taint: 'external' | null) =>
  sanitise({ payload, destination, canary_tokens: [...CANARIES], source_taint });

describe('A-7: health free text in external content is redacted, not denied', () => {
  it('lets a mail about Form 16 reach the model untouched: a plain word and a number is not a health score on a read', () => {
    const mail = { subject: 'Form 16 for FY 2025-26', body: 'Hi Shivansh, your Form 16 is attached. Thanks, HR' };
    const result = run(mail, 'internal_context', 'external');
    expect(result).toMatchObject({ ok: true, payload: mail });
    if (result.ok) expect(result.redactions).not.toContainEqual(expect.objectContaining({ kind: 'health_value' }));
  });

  it('withholds only the span in a web page that mentions a reading', () => {
    const result = run({ page: 'Average HRV 52 ms in athletes. Read more below.' }, 'internal_context', 'external');
    expect(result).toMatchObject({ ok: true, payload: { page: 'Average [health value withheld] ms in athletes. Read more below.' } });
    if (result.ok) for (const raw of ['HRV 52']) for (const form of [raw, encodeURIComponent(raw), JSON.stringify(raw).slice(1, -1)]) expect(JSON.stringify(result.payload)).not.toContain(form);
  });

  it('still denies the same payload at a third-party egress destination', () => {
    expect(run('HRV 52 ms', 'send_message', 'external')).toEqual({ ok: false, check: 'health_value', reason: 'health_value_leak' });
    expect(run('HRV 52 ms', 'memory_block', 'external')).toEqual({ ok: false, check: 'health_value', reason: 'health_value_leak' });
  });

  it('preserves JSON-encoded structured health for correlation denial before free-text redaction', () => {
    for (const payload of [JSON.stringify({ hrv: 1, unit: 'ms' }), { output: JSON.stringify({ motion: 'walking' }) }]) {
      expect(run(payload, 'internal_context', 'external')).toEqual({ ok: false, check: 'health_value', reason: 'health_value_leak' });
    }
  });

  it('still denies structured health correlation in external content at internal_context', () => {
    expect(run({ metric: 'hrv', measurement: 58, unit: 'ms' }, 'internal_context', 'external')).toEqual({ ok: false, check: 'health_value', reason: 'health_value_leak' });
  });
});

describe('a tool result the model reads as a JSON string', () => {
  const HOTEL = 'Deluxe Twin, sleeps 3. Free cancellation. Weight 23 kg per checked bag. Sleep 8 hours in blackout rooms. 120 steps to the beach. Rated 8.6 by 1,204 guests.';

  it('withholds only the matched spans of an external page and keeps the rest', () => {
    const output = JSON.stringify({ ok: true, data: { url: 'https://www.agoda.com/hotel', text: HOTEL } });
    const result = run([{ call: { call_id: 'c1', name: 'browse_page', arguments: '{}' }, output }], 'internal_context', 'external');
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const page = (JSON.parse((result.payload as Array<{ output: string }>)[0]!.output) as { data: { text: string } }).data.text;
    expect(page).toContain('Deluxe Twin');
    expect(page).toContain('Free cancellation');
    expect(page).toContain('[health value withheld]');
    expect(result.redactions).toContainEqual(expect.objectContaining({ kind: 'health_value' }));
  });

  it('still denies a wearable reading inside it', () => {
    for (const data of [{ metric: 'hrv', value: 42, unit: 'ms' }, { hrv: 42, unit: 'ms' }]) {
      expect(run([{ call: { call_id: 'c1', name: 'browse_page', arguments: '{}' }, output: JSON.stringify({ ok: true, data }) }], 'internal_context', 'external')).toEqual({ ok: false, check: 'health_value', reason: 'health_value_leak' });
    }
  });

  it('leaves the owner\'s own conversation about health as it is', () => {
    const text = 'I only slept 5 hours and my HRV was 42 ms this morning.';
    expect(run([{ role: 'user', content: text }], 'internal_context', null)).toMatchObject({ ok: true, payload: [{ role: 'user', content: text }] });
  });
});

describe('H-3: the health scrub on a read of the owner\'s own mail and calendar is scoped to real readings', () => {
  const MAIL = [
    { from: 'hr@example.com', subject: 'Form 16 for FY 2025-26', snippet: 'Your Form 16 is attached.' },
    { from: 'dispatch@example.com', subject: 'Pickup', snippet: 'Please load 3 trucks by noon; recovery 2 days after the strike.' },
    { from: 'ops@example.com', subject: 'Recovery: 2 days', snippet: 'Load: 40 pallets. Form, 12 pages.' },
  ];
  const CALENDAR: SanitiseInput['payload'] = { events: [{ title: 'Load 3 trucks', type: 'load', attendees: 4 }, { name: 'Recovery', days: 2 }, { kind: 'form', pages: 16 }] };

  it('lets "Form 16", "load 3 trucks" and "recovery 2 days" survive a mail read word for word', () => {
    for (const payload of [{ messages: MAIL }, [{ call: { call_id: 'c1', name: 'search_communication', arguments: '{}' }, output: JSON.stringify({ ok: true, data: { messages: MAIL } }) }]]) {
      const result = run(payload, 'internal_context', 'external');
      expect(result).toMatchObject({ ok: true, payload });
      if (result.ok) expect(result.redactions).not.toContainEqual(expect.objectContaining({ kind: 'health_value' }));
    }
  });

  it('lets a calendar read with plain-word keys and labels through', () => {
    expect(run(CALENDAR, 'internal_context', 'external')).toMatchObject({ ok: true, payload: CALENDAR });
    expect(run({ load: 3, form: 16, recovery: 2 }, 'internal_context', 'external')).toMatchObject({ ok: true });
  });

  it('still withholds a scored, unit-bearing or Waldo-named score and every sensor reading on a read', () => {
    for (const text of ['Recovery score 45 today', 'recovery 45% this morning', 'load score: 72', 'CRS 72', 'HRV 52 ms', 'slept 5 hours', 'form_score: 61']) {
      const result = run({ snippet: text }, 'internal_context', 'external');
      expect(result).toMatchObject({ ok: true, redactions: expect.arrayContaining([expect.objectContaining({ kind: 'health_value' })]) });
      if (result.ok) expect((result.payload as { snippet: string }).snippet).toContain('[health value withheld]');
    }
    for (const payload of [{ recovery_score: 45 }, { metric: 'recovery score', value: 45 }, { form_score: 61, unit: 'pct' }, { hrv: 42, unit: 'ms' }] as SanitiseInput['payload'][]) {
      expect(run(payload, 'internal_context', 'external')).toEqual({ ok: false, check: 'health_value', reason: 'health_value_leak' });
    }
  });

  it('keeps derived health scores out of memory and out of third-party sends, plain words included', () => {
    for (const destination of ['memory_block', 'send_message', 'draft_email', 'draft_document', 'outbox'] as const) {
      for (const taint of [null, 'external'] as const) {
        for (const text of ['Form 72 today', 'recovery 45', 'load: 80', 'CRS 72', 'recovery score 45']) {
          expect(run(text, destination, taint)).toEqual({ ok: false, check: 'health_value', reason: 'health_value_leak' });
        }
      }
      expect(run({ recovery: 45, form: 61 }, destination, null)).toEqual({ ok: false, check: 'health_value', reason: 'health_value_leak' });
    }
  });
});
