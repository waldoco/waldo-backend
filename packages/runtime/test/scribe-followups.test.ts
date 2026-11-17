// The Scribe's phone and health floors on the shapes it missed (a WhatsApp link with no plus, a national number with a hyphen,
// compact wearable durations, digits that are not ASCII) and on the ones it hid that are not phone numbers (order and
// booking references, amounts, timestamps, dates). Every number and reading is synthetic.
import type { SanitiseDestination } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { HEALTH_SPAN_MARKER, numericHealthIn, redactNumericHealth, sanitise } from '../src/scribe/sanitiser';
import { asciiDigits } from '../src/security/decimal-digits';

const CANARIES = ['a1b2c3d4e5f60718', '0f1e2d3c4b5a6978', '9a8b7c6d5e4f3021'];
const run = (text: string, destination: SanitiseDestination, taint: 'external' | null = 'external') =>
  sanitise({ payload: destination === 'send_message' ? text : { body: text }, destination, canary_tokens: [...CANARIES], source_taint: taint });
const bodyOf = (result: ReturnType<typeof run>): string => {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return typeof result.payload === 'string' ? result.payload : (result.payload as { body: string }).body;
};
const fullwidth = (text: string) => text.replace(/[0-9]/g, (digit) => String.fromCharCode(0xff10 + Number(digit)));
const devanagari = (text: string) => text.replace(/[0-9]/g, (digit) => String.fromCharCode(0x0966 + Number(digit)));
const mathematical = (text: string) => text.replace(/[0-9]/g, (digit) => String.fromCodePoint(0x1d7ce + Number(digit)));

describe('phone numbers the floor missed', () => {
  it.each([
    ['chat on wa.me/919876543210 today', 'chat on wa.me/[REDACTED_PHONE] today'],
    ['https://wa.me/15551234567?text=hi', 'https://wa.me/[REDACTED_PHONE]?text=hi'],
    ['WA.ME/447911123456', 'WA.ME/[REDACTED_PHONE]'],
    ['call 098765-43210 now', 'call [REDACTED_PHONE] now'],
    ['call 098765-43210.', 'call [REDACTED_PHONE].'],
    ['whatsapp me on 098765-43210', 'whatsapp me on [REDACTED_PHONE]'],
    ['Contact: 098765-43210', 'Contact: [REDACTED_PHONE]'],
    ['Ph. 098765-43210', 'Ph. [REDACTED_PHONE]'],
    ['mob 098765-43210', 'mob [REDACTED_PHONE]'],
    ['tel 098765-43210', 'tel [REDACTED_PHONE]'],
  ])('redacts the number in %j', (input, expected) => {
    for (const destination of ['send_message', 'memory_block'] as const) expect(bodyOf(run(input, destination)), destination).toBe(expected);
  });

  it.each([
    'upi ref 412345678901 paid',
    'IRCTC ref 123456789012',
    'txn 919876543210 settled',
    'see wa.me/message/AB12CD for the chat',
    'wa.me/123',
    'price 75000-80000',
    'call 98765-43210 now',
  ])('leaves %j alone', (text) => {
    expect(bodyOf(run(text, 'send_message'))).toBe(text);
  });
});

describe('numbers the floor hid that are not phone numbers', () => {
  it.each([
    'order 06123456789 shipped',
    'Order #09876543210',
    'booking ref: 07123456789',
    'x+123456789',
    'a+12345678 b',
    '₹75000 80000',
    'Rs. 75000 80000',
    'salary 75000 80000',
    'Salary: 75000 80000 a month',
    'budget 90000 95000',
    'ids 60000 70000 80000',
    'codes 70000 80000 90000 done',
    '+1 2026-11-06',
    'v2+1 2026-11-06 build',
    '+91 2026-11-06',
    'PNR 4523678901',
    'pnr no. 4523678901',
    'invoice 2345678901',
    'Invoice #2345678901',
    'ts 1730887200',
    'at 1730887200 the job ran',
    'id 0123456789',
  ])('leaves %j alone', (text) => {
    expect(bodyOf(run(text, 'send_message'))).toBe(text);
    expect(bodyOf(run(text, 'memory_block'))).toBe(text);
  });

  it.each([
    ['call 9876543210', 'call[REDACTED_PHONE]'],
    ['call 9810123456', 'call[REDACTED_PHONE]'],
    ['call 4155550142', 'call[REDACTED_PHONE]'],
    ['call 415-555-0142', 'call[REDACTED_PHONE]'],
    ['call 09876543210 now', 'call [REDACTED_PHONE] now'],
    ['call 98765 43210 at 9pm', 'call [REDACTED_PHONE] at 9pm'],
    ['pin 411001 98765 43210', 'pin 411001 [REDACTED_PHONE]'],
    ['call+447911123456', 'call[REDACTED_PHONE]'],
    ['x+1234567890', 'x[REDACTED_PHONE]'],
    ['call +1 202 555 0142', 'call [REDACTED_PHONE]'],
    ['my order is late, call 09876543210', 'my order is late, call [REDACTED_PHONE]'],
    ['account 9876543210', 'account[REDACTED_PHONE]'],
  ])('still redacts the phone number in %j', (input, expected) => {
    expect(bodyOf(run(input, 'send_message'))).toBe(expected);
  });
});

describe('a phone number written in digits that are not ASCII', () => {
  it.each([
    ['fullwidth', `call +91 ${fullwidth('98765 43210')} now`],
    ['Devanagari', `call ${devanagari('9876543210')} now`],
    ['Devanagari with a national 0', `call ${devanagari('09876543210')} now`],
    ['mathematical', `call +${mathematical('447911123456')} now`],
    ['a WhatsApp link in fullwidth', `wa.me/${fullwidth('919876543210')} now`],
    ['a national number with a hyphen in fullwidth', `call ${fullwidth('098765-43210')} now`],
  ])('is redacted like an ASCII one: %s', (_script, input) => {
    for (const destination of ['send_message', 'memory_block'] as const) {
      const out = bodyOf(run(input, destination));
      expect(out, destination).toContain('[REDACTED_PHONE]');
      expect(out.replace('[REDACTED_PHONE]', ''), destination).not.toMatch(/\p{Nd}/u);
    }
  });

  it.each([`Invoice ${fullwidth('2026')} paid, ${devanagari('12')} items`, `वर्ष ${devanagari('2026')}`])('leaves %j as it was', (text) => {
    expect(bodyOf(run(text, 'send_message'))).toBe(text);
  });
});

// Compact durations as a wearable app writes them.
const COMPACT = ['sleep: 7h30m', 'slept 7h30m', 'slept ~7h', 'sleep ~ 7h', 'sleep 7h22', 'slept: ~7h 5m', 'deep sleep 1h20m'];

describe('compact wearable durations', () => {
  it.each(COMPACT)('%s is refused where it would leave, and withheld where it reaches the model', (reading) => {
    for (const destination of ['send_message', 'memory_block'] as const) {
      expect(run(`last night: ${reading}.`, destination), destination).toMatchObject({ ok: false, reason: 'health_value_leak' });
    }
    const withheld = bodyOf(run(`last night: ${reading}.`, 'internal_context'));
    expect(withheld).toContain(HEALTH_SPAN_MARKER);
    expect(withheld.replaceAll(HEALTH_SPAN_MARKER, '')).not.toMatch(/\d/);
  });

  it.each(COMPACT)('%s is a reading for the floor that guards memory writes, and is redacted whole for traces', (reading) => {
    expect(numericHealthIn(reading)).toBe(true);
    expect(redactNumericHealth(`x ${reading} y`, '[h]')).not.toMatch(/\d/);
  });

  it.each([
    'sleep at 10h30',
    'sleep in until 10h30',
    'went to sleep at 11h45 after the call',
    'slept through the 7h30 alarm',
    'the 7h30m flight',
  ])('leaves %s alone', (text) => {
    expect(bodyOf(run(text, 'send_message'))).toBe(text);
    expect(numericHealthIn(text)).toBe(false);
  });
});

describe('a reading written in digits that are not ASCII', () => {
  it.each([
    ['fullwidth', `hrv ${fullwidth('45')} ms`],
    ['Devanagari', `slept ${devanagari('7')}h`],
    ['mathematical', `resting heart rate ${mathematical('58')} bpm`],
  ])('is refused, withheld and read by the memory floor: %s', (_script, reading) => {
    expect(run(`today ${reading}.`, 'send_message')).toMatchObject({ ok: false, reason: 'health_value_leak' });
    expect(bodyOf(run(`today ${reading}.`, 'internal_context'))).toContain(HEALTH_SPAN_MARKER);
    expect(numericHealthIn(reading)).toBe(true);
    expect(redactNumericHealth(`today ${reading}.`, '[h]')).toBe('today [h].');
  });

  it.each([
    ['fullwidth', { hrv: fullwidth('45') }],
    ['Devanagari', { hrv: devanagari('45') }],
    ['Devanagari, beside the metric name', { metric: 'hrv', value: devanagari('45') }],
    ['mathematical', { resting_heart_rate: mathematical('58') }],
  ])('is refused in a structured payload like an ASCII one: %s', (_script, payload) => {
    const ascii = JSON.parse(asciiDigits(JSON.stringify(payload))) as Record<string, string>;
    for (const destination of ['send_message', 'memory_block', 'internal_context'] as const) {
      const send = (body: Record<string, string>) => sanitise({ payload: body, destination, canary_tokens: [...CANARIES], source_taint: 'external' });
      expect(send(ascii), destination).toMatchObject({ ok: false, reason: 'health_value_leak' });
      expect(send(payload), destination).toMatchObject({ ok: false, reason: 'health_value_leak' });
    }
  });

  it('leaves a structured payload with non-ASCII digits and no health key alone', () => {
    const payload = { room: fullwidth('12'), year: devanagari('2026') };
    expect(sanitise({ payload, destination: 'send_message', canary_tokens: [...CANARIES], source_taint: 'external' })).toMatchObject({ ok: true, payload });
  });

  it('leaves words with non-ASCII digits and no reading alone', () => {
    const text = `sleep ${devanagari('2026')} plans, room ${fullwidth('12')}`;
    expect(bodyOf(run(text, 'send_message'))).toBe(text);
    expect(numericHealthIn(text)).toBe(false);
  });
});
