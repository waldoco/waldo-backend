import { toolNameSchema } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { OWNER_TURN_ONLY_TOOLS, PAID_RUNG_TOOLS } from '../src/channels/owner-turn';
import { PROBE_STRIPPED_TOOLS } from '../src/channels/probe-turn';
import { CONCURRENT_READ_TOOLS } from '../src/conversation/tool-loop';
import { TOOL_RECORDS, type ToolRecord } from '../src/tools/records';

const withFact = (fact: (record: ToolRecord) => boolean): Set<string> =>
  new Set(Object.entries(TOOL_RECORDS).filter(([, record]) => fact(record)).map(([name]) => name));

const without = <K extends keyof ToolRecord>(key: K): Omit<ToolRecord, K> => {
  const { [key]: _dropped, ...rest } = TOOL_RECORDS.get_context;
  return rest;
};

describe('per-tool facts live in the tool record', () => {
  it('the reads one response may run together are exactly the records marked concurrent', () => {
    expect(new Set(CONCURRENT_READ_TOOLS)).toEqual(withFact((record) => record.concurrent));
  });
  it('the tools a capture probe strips are exactly the records marked probe strip', () => {
    expect(new Set(PROBE_STRIPPED_TOOLS)).toEqual(withFact((record) => record.probe === 'strip'));
  });
  it('the tools held past the spend ceiling are exactly the records marked paid', () => {
    expect(new Set(PAID_RUNG_TOOLS)).toEqual(withFact((record) => record.paid));
  });
  it("the tools only an owner's own turn holds are exactly the records marked ownerTurnOnly", () => {
    expect(new Set(OWNER_TURN_ONLY_TOOLS)).toEqual(withFact((record) => record.ownerTurnOnly));
  });
  it('every tool in the union decides each fact', () => {
    for (const name of toolNameSchema.options) {
      const record = TOOL_RECORDS[name];
      expect(typeof record.concurrent, name).toBe('boolean');
      expect(['strip', 'keep'], name).toContain(record.probe);
      expect(typeof record.paid, name).toBe('boolean');
      expect(typeof record.ownerTurnOnly, name).toBe('boolean');
    }
  });
  it('a record that leaves a fact out does not type', () => {
    // @ts-expect-error concurrent has no default
    const noConcurrent: ToolRecord = without('concurrent');
    // @ts-expect-error probe has no default: a new provider tool must say whether a probe may reach it
    const noProbe: ToolRecord = without('probe');
    // @ts-expect-error paid has no default
    const noPaid: ToolRecord = without('paid');
    // @ts-expect-error ownerTurnOnly has no default
    const noOwnerTurnOnly: ToolRecord = without('ownerTurnOnly');
    expect(noConcurrent).not.toHaveProperty('concurrent');
    expect(noProbe).not.toHaveProperty('probe');
    expect(noPaid).not.toHaveProperty('paid');
    expect(noOwnerTurnOnly).not.toHaveProperty('ownerTurnOnly');
  });
});
