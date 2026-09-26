import { describe, expect, it } from 'vitest';
import { toolOutputLedger } from '../src/conversation/tool-output-ledger';

const fakeStorage = () => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T,>(k: string) => data.get(k) as T | undefined,
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...data].filter(([k]) => k.startsWith(prefix)) as [string, T][]),
    put: async (rows: Record<string, unknown>) => { for (const [k, v] of Object.entries(rows)) data.set(k, v); },
    delete: async (keys: string[]) => { for (const k of keys) data.delete(k); },
  };
};

describe('tool output ledger', () => {
  it('forget redaction removes casing variants of the forgotten text, not just the exact string', async () => {
    const storage = fakeStorage();
    const ledger = toolOutputLedger(storage);
    await ledger.record({ tool: 'web_search', ok: true, at: 1000, taint: 'external', summary: 'Owner mentioned Morning Pages and MORNING PAGES again' });
    const { redactToolOutputLedger } = await import('../src/conversation/tool-output-ledger');
    const touched = await redactToolOutputLedger(storage as never, ['morning pages'], '[forgotten]');
    expect(touched).toBe(1);
    const row = [...storage.data.values()][0] as { summary: string };
    expect(row.summary.toLowerCase()).not.toContain('morning pages');
    expect(row.summary).toBe('Owner mentioned [forgotten] and [forgotten] again');
  });

  it('records and returns recent outputs as tool_result fragments, newest last', async () => {
    const ledger = toolOutputLedger(fakeStorage());
    await ledger.record({ tool: 'query_calendar', ok: true, at: 1000, taint: 'external', summary: '{"events":[]}' });
    await ledger.record({ tool: 'web_search', ok: false, at: 2000, taint: 'external', summary: 'timeout' });
    const fragments = await ledger.recent();
    expect(fragments).toHaveLength(2);
    expect(fragments[0]!.text).toBe('query_calendar succeeded: {"events":[]}');
    expect(fragments[1]!.text).toBe('web_search failed: timeout');
    for (const [i, f] of fragments.entries()) {
      expect(f.source.source_kind).toBe('tool_result');
      expect(f.source.scope).toBe('invocation');
      expect(f.source.source_taint).toBe('external');
      expect(f.source.source_key).toBe(`tool_output:${i === 0 ? 'query_calendar:1000' : 'web_search:2000'}`);
    }
  });

  it('keeps only the last 6 (ring eviction)', async () => {
    const ledger = toolOutputLedger(fakeStorage());
    for (let i = 0; i < 8; i += 1) await ledger.record({ tool: 't', ok: true, at: i, taint: null, summary: `s${i}` });
    const fragments = await ledger.recent();
    expect(fragments).toHaveLength(6);
    expect(fragments[0]!.text).toBe('t succeeded: s2');
    expect(fragments[5]!.text).toBe('t succeeded: s7');
  });

  it('truncates oversized summaries', async () => {
    const ledger = toolOutputLedger(fakeStorage());
    await ledger.record({ tool: 't', ok: true, at: 1, taint: null, summary: 'x'.repeat(900) });
    const [f] = await ledger.recent();
    expect(f!.text.length).toBeLessThan(560);
    expect(f!.text).toContain('...');
  });
});
