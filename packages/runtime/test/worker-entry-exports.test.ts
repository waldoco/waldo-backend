import { describe, expect, it } from 'vitest';
import * as entry from '../src/index';

// Why: `wrangler dev --local` (workerd) refuses a Worker entry module that exports a plain
// constant, array or object ("Incorrect type for map entry ... not of type function"). A named
// export of the entry must be a function or class (handlers and Durable Object classes).
// Constants and helpers belong in their own modules, imported from there.
describe('worker entry exports', () => {
  it('exports only functions or classes by name, plus the default handler', () => {
    const offenders = Object.entries(entry)
      .filter(([name, value]) => name !== 'default' && typeof value !== 'function')
      .map(([name]) => name)
      .sort();
    expect(offenders).toEqual([]);
  });

  it('still exports the Durable Object classes the wrangler config binds', () => {
    for (const name of ['RuntimeProbeDO', 'RunLoopDO', 'TracerDO', 'TelegramOwnerDO']) {
      expect(typeof (entry as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
