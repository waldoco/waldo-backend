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

  it('record() drops a summary the prompt-boundary scribe would deny (16-hex canary shape)', async () => {
    const storage = fakeStorage();
    const ledger = toolOutputLedger(storage);
    // Gmail message ids are exactly 16 hex chars: the canary-shape scan denies this summary at
    // system_prompt for any taint, so persisting it would poison every later turn.
    await ledger.record({ tool: 'archive_email', ok: true, at: 1000, taint: 'external', summary: 'archived thread 9f8e7d6c5b4a3210 for the owner' });
    expect(storage.data.size).toBe(0);
    expect(await storage.get('toolout-count')).toBeUndefined();
    expect(await ledger.recent()).toHaveLength(0);
    // Clean writes around the dropped one still record and order normally.
    await ledger.record({ tool: 't', ok: true, at: 2000, taint: 'external', summary: 'clean' });
    const fragments = await ledger.recent();
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.text).toBe('t succeeded: clean');
  });

  it('recent() evicts a legacy poisoned entry from storage and stages only clean fragments', async () => {
    const storage = fakeStorage();
    // Legacy row written before the write guard existed (the self-sustaining outage state):
    // bypass record() and plant it directly, plus one clean row.
    storage.data.set('toolout:0000000001', { tool: 'archive_email', ok: true, at: 1, taint: 'external', summary: 'archived thread 0123456789abcdef done' });
    storage.data.set('toolout:0000000002', { tool: 'query_calendar', ok: true, at: 2, taint: 'external', summary: '{"events":[]}' });
    const ledger = toolOutputLedger(storage);
    const fragments = await ledger.recent();
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.text).toBe('query_calendar succeeded: {"events":[]}');
    // Self-heal: the poisoned row is deleted from storage, not just filtered once.
    expect(storage.data.has('toolout:0000000001')).toBe(false);
    expect(storage.data.has('toolout:0000000002')).toBe(true);
  });
});
