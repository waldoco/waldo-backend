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
  it('retained source snapshots require the same owner, audience and current source authority', async () => {
    const storage = fakeStorage(), ledger = toolOutputLedger(storage);
    const context = { owner_ref: 'owner-a', conversation_ref: 'owner-private', source_epoch: 'account-and-task-v1' };
    await ledger.record({ tool: 'read_thread', ok: true, at: 1, taint: 'external', summary: 'Legacy mail row stays preserved' });
    await ledger.record({ tool: 'read_thread', ok: true, at: 2, taint: 'external', summary: 'Current scoped mail source', context });
    expect((await ledger.recent([], context)).map(row => row.text)).toEqual(['read_thread succeeded: Current scoped mail source']);
    for (const changed of [{ ...context, owner_ref: 'owner-b' }, { ...context, conversation_ref: 'group' }, { ...context, source_epoch: 'revoked-v2' }]) {
      expect(await ledger.recent([], changed)).toEqual([]);
    }
    expect(storage.data.size).toBe(3);
  });
  it('two calls of the same tool in the same millisecond keep distinct source keys', async () => {
    const storage = fakeStorage();
    const ledger = toolOutputLedger(storage as never);
    await ledger.record({ tool: 'store_memory', ok: true, at: 5000, taint: null, summary: '{"ok":true,"id":"a"}' });
    await ledger.record({ tool: 'store_memory', ok: true, at: 5000, taint: null, summary: '{"ok":true,"id":"b"}' });
    const keys = (await ledger.recent()).map(fragment => fragment.source.source_key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it.each(['capped', 'legacy', 'escaped'])('forgets exact text in a %s display summary while retaining ledger provenance', async (shape) => {
    const storage = fakeStorage();
    const needle = shape === 'escaped' ? 'Synthetic workshop "azure" context' : "For project WBX-20261002-M1, the workshop start time is 08:40 UTC; this is temporary fictional test context, not the owner's real schedule.";
    const keep = 'Unrelated synthetic reading preference';
    const data = { keep, text: needle, padding: 'x'.repeat(900) };
    const summary = JSON.stringify(shape === 'legacy' ? { events: [{ keep, text: needle }] } : { ok: true, data, source_taint: 'external' });
    const ledger = toolOutputLedger(storage as never);
    await ledger.record({ tool: 'read_owner_context', ok: true, at: 1000, taint: 'external', summary });
    const keys = [...storage.data.keys()];
    const before = [...storage.data.values()].find(value => typeof value === 'object') as { summary: string };
    if (shape !== 'legacy') { expect(before.summary).toHaveLength(503); expect(() => JSON.parse(before.summary)).toThrow(); }
    const { redactToolOutputLedger } = await import('../src/conversation/tool-output-ledger');
    expect(await redactToolOutputLedger(storage as never, [needle], '[forgotten]')).toBe(1);
    const row = [...storage.data.values()].find(value => typeof value === 'object') as { tool: string; ok: boolean; taint: string; summary: string };
    expect(row).toMatchObject({ tool: 'read_owner_context', ok: true, at: 1000, taint: 'external' });
    expect([...storage.data.keys()]).toEqual(keys);
    expect(row.summary).toContain(keep); expect(row.summary).toContain('[forgotten]');
    expect(row.summary).not.toContain(needle); expect(row.summary).not.toContain(JSON.stringify(needle).slice(1, -1));
    expect(JSON.stringify(await ledger.recent())).not.toContain('08:40');
  });

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
      expect(f.source.source_key).toBe(`tool_output:${i === 0 ? 'query_calendar:1000:0000000000' : 'web_search:2000:0000000001'}`);
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

  it('record() preserves ordinary 16-hex thread ids for later turns', async () => {
    const storage = fakeStorage();
    const ledger = toolOutputLedger(storage);
    await ledger.record({ tool: 'archive_email', ok: true, at: 1000, taint: 'external', summary: 'archived thread 9f8e7d6c5b4a3210 for the owner' });
    expect((await ledger.recent())[0]?.text).toContain('9f8e7d6c5b4a3210');
  });

  it('recent() preserves a legacy summary with an ordinary mail id', async () => {
    const storage = fakeStorage();
    storage.data.set('toolout:0000000001', { tool: 'archive_email', ok: true, at: 1, taint: 'external', summary: 'archived thread 0123456789abcdef done' });
    const ledger = toolOutputLedger(storage);
    expect((await ledger.recent())[0]?.text).toContain('0123456789abcdef');
    expect(storage.data.has('toolout:0000000001')).toBe(true);
  });

});

it('verifies all retained ledger rows including escaped summaries outside the staged ring',async()=>{
 const storage=fakeStorage(); const needle='Synthetic "quoted" pending topic';
 for(let i=0;i<8;i++)storage.data.set(`toolout:${String(i).padStart(10,'0')}`,{tool:'fixture',ok:true,at:i,taint:'external',summary:i===0?JSON.stringify({text:needle}):'Unrelated'});
 const ledger=toolOutputLedger(storage);
 expect(JSON.stringify(await ledger.recent())).not.toContain('pending topic');
 expect(await ledger.remaining([needle])).toBe(1);
 const {redactToolOutputLedger}=await import('../src/conversation/tool-output-ledger');await redactToolOutputLedger(storage,[needle],'[forgotten]');
 expect(await ledger.remaining([needle])).toBe(0);
});

it.each(['complete','capped','unclosed'])('verifies and redacts Unicode escaped topic in %s JSON display data',async shape=>{
 const storage=fakeStorage();const needle='Synthetic cobalt paper workshop';
 const encoded=JSON.stringify({text:needle,padding:'x'.repeat(900)}).replace('Synthetic','\\u0053ynthetic');
 const summary=shape==='complete'?encoded:shape==='capped'?encoded.slice(0,500)+'...':'{"text":"\\u0053ynthetic cobalt paper workshop and extra display...';
 storage.data.set('toolout:0000000000',{tool:'fixture',ok:true,at:1,taint:'external',summary});
 const ledger=toolOutputLedger(storage);expect(await ledger.remaining([needle])).toBe(1);
 expect(JSON.stringify(await ledger.recent([needle]))).not.toContain('cobalt paper workshop');
 const {redactToolOutputLedger}=await import('../src/conversation/tool-output-ledger');await redactToolOutputLedger(storage,[needle],'[forgotten]');
 expect(await ledger.remaining([needle])).toBe(0);expect(JSON.stringify(storage.data.get('toolout:0000000000'))).not.toContain('cobalt paper workshop');
});

describe('ledger forget sources', () => {
  it('an unrelated capped summary with a unicode escape does not hold the forget; a topic hidden behind escapes still does', async () => {
    const storage = fakeStorage();
    const ledger = toolOutputLedger(storage as never);
    const unrelated = `{"ok":true,"data":{"note":"caf\\u00e9 menu","padding":"${'x'.repeat(900)}"}}`;
    await ledger.record({ tool: 'search_communication', ok: true, at: 1000, taint: 'external', summary: unrelated });
    expect([...storage.data.values()].some(value => typeof value === 'object' && (() => { try { JSON.parse((value as { summary: string }).summary); return false; } catch { return true; } })())).toBe(true);
    expect((await ledger.forgetSources('ZEBRA-COBALT')).incomplete).toBe(false);
    const hidden = `{"note":"Call \\u005a\\u0045\\u0042\\u0052\\u0041\\u002d\\u0043\\u004f\\u0042\\u0041\\u004c\\u0054 later","padding":"${'x'.repeat(900)}`;
    await ledger.record({ tool: 'search_communication', ok: true, at: 1001, taint: 'external', summary: hidden });
    expect((await ledger.forgetSources('ZEBRA-COBALT')).incomplete).toBe(true);
  });
});
