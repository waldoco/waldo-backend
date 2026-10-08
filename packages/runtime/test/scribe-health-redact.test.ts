import type { SanitiseDestination, SanitiseInput } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { sanitise } from '../src/scribe/sanitiser';

const CANARIES = ['1111111111111111', '2222222222222222', '3333333333333333'] as const;
const run = (payload: SanitiseInput['payload'], destination: SanitiseDestination, source_taint: 'external' | null) =>
  sanitise({ payload, destination, canary_tokens: [...CANARIES], source_taint });

describe('A-7: health free text in external content is redacted, not denied', () => {
  it('lets a mail about Form 16 reach the model with only the matched span withheld', () => {
    const result = run({ subject: 'Form 16 for FY 2025-26', body: 'Hi Shivansh, your Form 16 is attached. Thanks, HR' }, 'internal_context', 'external');
    expect(result).toMatchObject({
      ok: true,
      payload: { subject: '[health value withheld] for FY 2025-26', body: 'Hi Shivansh, your [health value withheld] is attached. Thanks, HR' },
    });
    if (result.ok) expect(result.redactions).toContainEqual({ kind: 'health_value', count: 2 });
    if (result.ok) for (const raw of ['Form 16']) for (const form of [raw, encodeURIComponent(raw), JSON.stringify(raw).slice(1, -1)]) expect(JSON.stringify(result.payload)).not.toContain(form);
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
