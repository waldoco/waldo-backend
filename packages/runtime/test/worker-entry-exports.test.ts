import { describe, expect, it } from 'vitest';
import * as full from '../src/index';
import * as production from '../src/entry';
import * as staging from '../src/staging-entry';

// Why: `wrangler dev --local` (workerd) refuses a Worker entry module that exports a plain
// constant, array or object ("Incorrect type for map entry ... not of type function"). A named
// export of the entry must be a function or class (handlers and Durable Object classes).
// Constants and helpers belong in their own modules, imported from there. The deployed entries
// (wrangler main) and the full Worker they load are held to the same rule.
describe.each([['src/index', full], ['src/entry', production], ['src/staging-entry', staging]])('worker entry exports: %s', (_name, entry) => {
  it('exports only functions or classes by name, plus the default handler', () => {
    const offenders = Object.entries(entry)
      .filter(([name, value]) => name !== 'default' && typeof value !== 'function')
      .map(([name]) => name)
      .sort();
    expect(offenders).toEqual([]);
  });

  it('still exports the Durable Object classes the wrangler config binds', () => {
    for (const name of ['RuntimeProbeDO', 'RunLoopDO', 'TracerDO', 'OwnerDO', 'DeviceBridgeDO', 'IMessageBridgeDO', 'TaskWorkerDO']) {
      expect(typeof (entry as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('exports the fetch, email and scheduled handlers', () => {
    expect(Object.keys(entry.default).sort()).toEqual(['email', 'fetch', 'scheduled']);
  });
});
