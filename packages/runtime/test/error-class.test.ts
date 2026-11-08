// errorClass is all of a failure that reaches a reply, a log line or a trace. The name is set by whoever threw, so only a
// short plain name passes.
import { describe, expect, it } from 'vitest';
import { errorClass } from '../src/observability/trace-privacy';

describe('errorClass', () => {
  it('keeps a plain error name', () => {
    expect([new Error('x'), new TypeError('x'), new RangeError('x')].map(errorClass)).toEqual(['Error', 'TypeError', 'RangeError']);
  });

  it('reads a name that could carry text, and anything not an Error, as unknown', () => {
    const named = (name: string) => Object.assign(new Error('x'), { name });
    const hostile = [named('sk-live-0000 leaked key'), named('Bearer synthetic.token.value'), named('https://example.invalid/?token=x'), named(''), named('A'.repeat(41)), named('Error2')];
    expect(hostile.map(errorClass)).toEqual(hostile.map(() => 'unknown'));
    expect([undefined, null, 'TypeError', { name: 'TypeError' }].map(errorClass)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
  });
});
