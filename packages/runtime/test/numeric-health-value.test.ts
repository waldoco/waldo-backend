import { expect, it } from 'vitest';
import { numericHealthIn, numericHealthInJsonText, numericHealthInValue } from '../src/scribe/sanitiser';

// The floor over stored values and JSON text: a reading behind a quote or a tab is an escape in JSON, so each string is also
// read as written. What the floor does not match in plain text it does not match here either.
const QUOTED = 'Why HRV "47 ms" dropped', TABBED = 'recovery\t34% this morning';

it('finds a reading that JSON escaping hides from a scan of the JSON', () => {
  for (const text of [QUOTED, TABBED]) {
    expect(numericHealthIn(text), text).toBe(true);
    expect(numericHealthInValue({ findings: [{ text }] }), text).toBe(true);
    expect(numericHealthInJsonText(JSON.stringify({ args: { query: text } })), text).toBe(true);
  }
});

it('reads keys, arrays and plain text, and finds nothing in a value with no reading', () => {
  expect(numericHealthInValue({ [QUOTED]: true })).toBe(true);
  expect(numericHealthInValue(['a', ['b', TABBED]])).toBe(true);
  expect(numericHealthInJsonText(`not json: ${TABBED}`)).toBe(true);
  expect(numericHealthInValue({ summary: 'Recovery dipped this week.', findings: [{ text: '3 threads wait on you.' }] })).toBe(false);
  expect(numericHealthInJsonText('{"ok":true,"data":{"hits":2}}')).toBe(false);
  expect(numericHealthInValue(undefined)).toBe(false);
});
