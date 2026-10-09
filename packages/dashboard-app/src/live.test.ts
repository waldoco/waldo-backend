import { describe, expect, it } from 'vitest';
import { nextLiveDelay, sameRecord, shouldPoll } from './live';
describe('live polling helpers', () => {
  it('backs off and caps', () => {
    expect(nextLiveDelay(0)).toBe(15000); expect(nextLiveDelay(1)).toBe(30000); expect(nextLiveDelay(2)).toBe(60000); expect(nextLiveDelay(9)).toBe(120000);
  });
  it('pauses while hidden', () => { expect(shouldPoll('hidden')).toBe(false); expect(shouldPoll('visible')).toBe(true); expect(shouldPoll(undefined)).toBe(true); });
  it('detects unchanged records', () => { expect(sameRecord({ a: 1 }, { a: 1 })).toBe(true); expect(sameRecord({ a: 1 }, { a: 2 })).toBe(false); });
});
