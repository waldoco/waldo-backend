import { describe, expect, it } from 'vitest';
import { redactToolOutputLedger, toolOutputLedger } from '../src/conversation/tool-output-ledger';

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

// A proposing tool's output is a snapshot of the approval at the moment it was proposed. The approval desk owns the
// approval's state, so a later turn sees the desk's current state for that approval instead of the snapshot.
describe('a tool output that proposed an approval', () => {
  const ID = 'p3e9a1c07';
  const proposed = (padding = '') => JSON.stringify({ ok: true, data: { ...(padding ? { url: padding } : {}), proposal_id: ID, status: 'review card requested in chat; nothing was sent', sent: false } });
  const states = (state: string | null) => async (id: string) => (id === ID && state ? { kind: 'email_send', state } : null);

  it.each(['done', 'skipped', 'open'])('shows the desk\'s current state (%s) instead of the snapshot', async (state) => {
    const ledger = toolOutputLedger(fakeStorage() as never, { proposalState: states(state) });
    await ledger.record({ tool: 'send_email', ok: true, at: 1000, taint: 'external', summary: proposed() });
    const [fragment, ...rest] = await ledger.recent();
    expect(rest).toEqual([]);
    expect(fragment!.text).toBe(`send_email succeeded: proposed approval ${ID} (email_send). Its current state on the approval desk is ${state}; this replaces what the tool reported when it proposed.`);
    expect(fragment!.source).toMatchObject({ source_kind: 'tool_result', source_taint: 'external', produced_at: 1000 });
  });

  it('links an approval whose id falls past the stored summary cut', async () => {
    const storage = fakeStorage();
    const ledger = toolOutputLedger(storage as never, { proposalState: states('done') });
    await ledger.record({ tool: 'browse_act', ok: true, at: 1000, taint: 'external', summary: proposed('https://example.test/' + 'x'.repeat(600)) });
    expect(JSON.stringify([...storage.data.values()])).not.toContain(`"proposal_id":"${ID}"`);
    expect((await ledger.recent()).map(fragment => fragment.text)).toEqual([expect.stringContaining(`approval ${ID} (email_send). Its current state on the approval desk is done`)]);
  });

  it('links a row stored before the link was recorded, from its summary', async () => {
    const storage = fakeStorage();
    storage.data.set('toolout:0000000000', { tool: 'send_email', ok: true, at: 1000, taint: 'external', summary: proposed() });
    storage.data.set('toolout-count', 1);
    const [fragment] = await toolOutputLedger(storage as never, { proposalState: states('done') }).recent();
    expect(fragment!.text).toContain('current state on the approval desk is done');
    expect(fragment!.text).not.toContain('nothing was sent');
  });

  it.each([
    ['the desk has no such approval', { proposalState: states(null) }],
    ['the desk read fails', { proposalState: async () => { throw new Error('desk unavailable'); } }],
    ['no desk reader is wired', {}],
  ] as const)('is withheld, never shown as its snapshot, when %s; other outputs still show', async (_case, options) => {
    const ledger = toolOutputLedger(fakeStorage() as never, options);
    await ledger.record({ tool: 'send_email', ok: true, at: 1000, taint: 'external', summary: proposed() });
    await ledger.record({ tool: 'search_mail', ok: true, at: 2000, taint: 'external', summary: '{"ok":true,"data":{"count":2}}' });
    expect((await ledger.recent()).map(fragment => fragment.text)).toEqual(['search_mail succeeded: {"ok":true,"data":{"count":2}}']);
  });

  it.each([['a number', 42], ['text outside the approval id shape', 'p1; DROP TABLE ledger'], ['an id longer than the contract allows', `p${'0'.repeat(80)}`]])('is withheld when its proposal id is %s, and the desk is never asked', async (_case, id) => {
    const asked: string[] = [];
    const ledger = toolOutputLedger(fakeStorage() as never, { proposalState: async asking => { asked.push(asking); return { kind: 'email_send', state: 'done' }; } });
    await ledger.record({ tool: 'send_email', ok: true, at: 1000, taint: 'external', summary: JSON.stringify({ ok: true, data: { proposal_id: id, sent: false } }) });
    expect(await ledger.recent()).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('reads a row stored before the field existed, holding an ordinary result, exactly as before', async () => {
    const storage = fakeStorage();
    storage.data.set('toolout:0000000000', { tool: 'search_mail', ok: true, at: 1000, taint: 'external', summary: '{"ok":true,"data":{"count":2}}' });
    storage.data.set('toolout-count', 1);
    const asked: string[] = [];
    const [fragment, ...rest] = await toolOutputLedger(storage as never, { proposalState: async id => { asked.push(id); return null; } }).recent();
    expect(rest).toEqual([]);
    expect(fragment!.text).toBe('search_mail succeeded: {"ok":true,"data":{"count":2}}');
    expect(asked).toEqual([]);
  });

  it('leaves an output without a proposal exactly as before, and asks the desk nothing for it', async () => {
    const asked: string[] = [];
    const ledger = toolOutputLedger(fakeStorage() as never, { proposalState: async id => { asked.push(id); return null; } });
    await ledger.record({ tool: 'send_email', ok: false, at: 1000, taint: 'external', summary: '{"ok":false,"code":"rejected","error":"No email was sent."}' });
    expect((await ledger.recent()).map(fragment => fragment.text)).toEqual(['send_email failed: {"ok":false,"code":"rejected","error":"No email was sent."}']);
    expect(asked).toEqual([]);
  });
});

describe('which outputs link to the approval desk', () => {
  const ID = 'p3e9a1c07';
  const LINE = `proposed approval ${ID} (email_send). Its current state on the approval desk is done; this replaces what the tool reported when it proposed.`;
  const asking = () => {
    const asked: string[] = [];
    return { asked, proposalState: async (id: string) => { asked.push(id); return id === ID ? { kind: 'email_send', state: 'done' } : null; } };
  };

  // Each tool that puts an approval on the desk, with its output as the tool reports it.
  it.each([
    ['send_email', { account: 'owner@example.test', proposal_id: ID, status: 'review card requested in chat; nothing was sent', sent: false }],
    ['send_message', { proposal_id: ID, status: 'sent to the owner with Send it / Modify / Not now buttons; Nothing was sent.' }],
    ['propose_calendar_change', { proposal_id: ID, status: 'sent to the owner with Do it / Modify / Not now buttons; Nothing has changed.', applied: false }],
    ['call_mcp_tool', { proposal_id: ID, status: 'sent to the owner with Do it / Not now buttons; Nothing has run.' }],
    ['browse_act', { url: 'https://example.test/form', stopped: 'approval_pending', status: 'awaiting owner approval; Nothing was submitted.', proposal_id: ID }],
    ['propose_google_task_change', { approval_ref: ID, status: 'awaiting_owner_approval; Nothing has changed.', applied: false, source: 'google_tasks' }],
    ['raise_approval', { approval_id: ID, outcome: 'raised', on_this_reply: false, shown_on: ['telegram'], note: 'A fresh card with its buttons was sent to the owner.' }],
  ] as const)('%s shows the desk\'s current state instead of what it reported', async (tool, data) => {
    const desk = asking();
    const ledger = toolOutputLedger(fakeStorage() as never, desk);
    await ledger.record({ tool, ok: true, at: 1000, taint: null, summary: JSON.stringify({ ok: true, data }) });
    expect((await ledger.recent()).map(fragment => fragment.text)).toEqual([`${tool} succeeded: ${LINE}`]);
    expect(desk.asked).toEqual([ID]);
  });

  it('withholds a list of waiting approvals, which is the desk as it was', async () => {
    const desk = asking();
    const ledger = toolOutputLedger(fakeStorage() as never, desk);
    await ledger.record({ tool: 'raise_approval', ok: true, at: 1000, taint: null, summary: JSON.stringify({ ok: true, data: { approvals: [{ approval_id: ID, kind: 'email_send', summary: 'Note to Sam', state: 'open', put_off: true }] } }) });
    expect(await ledger.recent()).toEqual([]);
    expect(desk.asked).toEqual([]);
  });

  it('never links an output of a tool that proposes nothing, even when its data names a proposal id', async () => {
    const desk = asking();
    const ledger = toolOutputLedger(fakeStorage() as never, desk);
    const summary = JSON.stringify({ ok: true, data: { proposal_id: ID, snippet: 'the thread mentions a proposal' }, source_taint: 'external' });
    await ledger.record({ tool: 'read_thread', ok: true, at: 1000, taint: 'external', summary });
    expect((await ledger.recent()).map(fragment => fragment.text)).toEqual([`read_thread succeeded: ${summary}`]);
    expect(desk.asked).toEqual([]);
  });

  it('withholds a proposing tool\'s row stored before the link was kept, when its output was cut', async () => {
    const storage = fakeStorage();
    const cut = JSON.stringify({ ok: true, data: { url: `https://example.test/${'x'.repeat(600)}`, proposal_id: ID, sent: false } }).slice(0, 500) + '...';
    storage.data.set('toolout:0000000000', { tool: 'send_email', ok: true, at: 1000, taint: 'external', summary: cut });
    storage.data.set('toolout:0000000001', { tool: 'web_search', ok: true, at: 1001, taint: 'external', summary: cut });
    storage.data.set('toolout-count', 2);
    const desk = asking();
    expect((await toolOutputLedger(storage as never, desk).recent()).map(fragment => fragment.text)).toEqual([`web_search succeeded: ${cut}`]);
    expect(desk.asked).toEqual([]);
  });

  it('links an output the tool loop appended a note to', async () => {
    const ledger = toolOutputLedger(fakeStorage() as never, asking());
    await ledger.record({ tool: 'send_email', ok: true, at: 1000, taint: null, summary: `${JSON.stringify({ ok: true, data: { proposal_id: ID, sent: false } })}\n[budget: 2 tool rounds left this turn - wrap up and answer now]` });
    expect((await ledger.recent()).map(fragment => fragment.text)).toEqual([`send_email succeeded: ${LINE}`]);
  });
});

describe('earlier results for the owner\'s turn', () => {
  it('come only from the owner\'s own turns; a row stored before origins were kept is left out', async () => {
    const storage = fakeStorage();
    const ledger = toolOutputLedger(storage as never);
    await ledger.record({ tool: 'get_tasks', ok: true, at: 1001, taint: null, origin: 'machine', summary: 'from a job' });
    await ledger.record({ tool: 'get_tasks', ok: true, at: 1002, taint: null, origin: 'owner', summary: 'from the owner' });
    storage.data.set('toolout:0000000002', { tool: 'get_tasks', ok: true, at: 1000, taint: null, summary: 'from before' });
    storage.data.set('toolout-count', 3);
    expect(await ledger.ownerTurnResults()).toEqual(['get_tasks succeeded: from the owner']);
    expect((await ledger.recent()).map(fragment => fragment.text)).toEqual(['get_tasks succeeded: from a job', 'get_tasks succeeded: from the owner', 'get_tasks succeeded: from before']);
  });

  it('take a row recorded without an origin as a job\'s, never the owner\'s', async () => {
    const storage = fakeStorage();
    const ledger = toolOutputLedger(storage as never);
    await ledger.record({ tool: 'get_tasks', ok: true, at: 1000, taint: null, summary: 'unstated' });
    expect(storage.data.get('toolout:0000000000')).toMatchObject({ origin: 'machine' });
    expect(await ledger.ownerTurnResults()).toEqual([]);
    expect((await ledger.recent()).map(fragment => fragment.text)).toEqual(['get_tasks succeeded: unstated']);
  });

  it('never carry an external result\'s content; an approval it proposed shows as the desk\'s state', async () => {
    const ID = 'p3e9a1c07';
    const storage = fakeStorage();
    const ledger = toolOutputLedger(storage as never, { proposalState: async id => (id === ID ? { kind: 'browser_submit', state: 'done' } : null) });
    await ledger.record({ tool: 'search_episodes', ok: true, at: 1000, taint: null, origin: 'owner', summary: 'own words' });
    await ledger.record({ tool: 'read_thread', ok: true, at: 1001, taint: 'external', origin: 'owner', summary: 'a provider page' });
    await ledger.record({ tool: 'browse_act', ok: true, at: 1002, taint: 'external', origin: 'owner', summary: JSON.stringify({ ok: true, data: { url: 'https://example.test/form', stopped: 'approval_pending', proposal_id: ID }, source_taint: 'external' }) });
    storage.data.set('toolout:0000000003', { tool: 'search_episodes', ok: true, at: 1003, origin: 'owner', summary: 'unstamped' });
    storage.data.set('toolout-count', 4);
    expect(await ledger.ownerTurnResults()).toEqual([
      'search_episodes succeeded: own words',
      `browse_act succeeded: proposed approval ${ID} (browser_submit). Its current state on the approval desk is done; this replaces what the tool reported when it proposed.`,
    ]);
  });

  it('show a failed result as its tool and typed code only, never its error text', async () => {
    const ledger = toolOutputLedger(fakeStorage() as never);
    const refused = '{"ok":false,"error":"Google refused the request (403): mail quota for project 4417 exceeded","code":"rejected"}';
    await ledger.record({ tool: 'send_email', ok: false, at: 1000, taint: null, origin: 'owner', summary: refused });
    await ledger.record({ tool: 'set_reminder', ok: false, at: 1001, taint: null, origin: 'owner', summary: 'not json' });
    expect(await ledger.ownerTurnResults()).toEqual(['send_email failed (rejected)', 'set_reminder failed']);
    expect((await ledger.recent())[0]!.text).toBe(`send_email failed: ${refused}`);
  });

  it('show a failed output that names an approval as the desk\'s state for it, never its error text', async () => {
    const ID = 'p3e9a1c07';
    const ledger = toolOutputLedger(fakeStorage() as never, { proposalState: async id => (id === ID ? { kind: 'email_send', state: 'open' } : null) });
    const refused = JSON.stringify({ ok: false, error: 'Google refused the card for this send', code: 'rejected', data: { proposal_id: ID } });
    await ledger.record({ tool: 'send_email', ok: false, at: 1000, taint: null, origin: 'owner', summary: refused });
    expect(await ledger.ownerTurnResults()).toEqual([`send_email failed: proposed approval ${ID} (email_send). Its current state on the approval desk is open; this replaces what the tool reported when it proposed.`]);
  });

  it('admits a row as external data whatever its own taint, so an own result carrying a health reading is never kept', async () => {
    const storage = fakeStorage();
    await toolOutputLedger(storage as never).record({ tool: 'read_owner_context', ok: true, at: 1000, taint: null, origin: 'owner', summary: '{"ok":true,"data":{"note":"blood pressure 128/84"}}' });
    expect([...storage.data.keys()]).toEqual([]);
  });

  it('stages every row as external data whatever its own taint', async () => {
    const ledger = toolOutputLedger(fakeStorage() as never);
    await ledger.record({ tool: 'get_tasks', ok: true, at: 1000, taint: null, origin: 'owner', summary: 'own' });
    expect((await ledger.recent())[0]!.source.source_taint).toBe('external');
  });
});

describe('what the ring keeps', () => {
  const ID = 'p3e9a1c07';
  const desk = { proposalState: async (id: string) => (id === ID ? { kind: 'email_send', state: 'done' } : null) };
  const proposed = JSON.stringify({ ok: true, data: { proposal_id: ID, sent: false } });
  const LINE = `send_email succeeded: proposed approval ${ID} (email_send). Its current state on the approval desk is done; this replaces what the tool reported when it proposed.`;
  // The owner DO records inside its run scope, through synchronous storage; the scope commits the write.
  const fencedStorage = () => {
    const storage = fakeStorage();
    return Object.assign(storage, { kv: {
      put: (k: string, v: unknown) => { storage.data.set(k, v); },
      delete: (k: string) => storage.data.delete(k),
      list: <T,>({ prefix }: { prefix: string }) => new Map([...storage.data].filter(([k]) => k.startsWith(prefix)) as [string, T][]),
    } });
  };
  const scope = { commit: (write: () => void) => write() } as never;

  it.each([['awaited', undefined], ['fenced', scope]] as const)('%s: a job\'s results never push out the owner\'s; an approval the owner proposed still shows after six job calls', async (_path, runScope) => {
    const storage = fencedStorage();
    const ledger = toolOutputLedger(storage as never, desk);
    await ledger.record({ tool: 'send_email', ok: true, at: 1000, taint: null, origin: 'owner', summary: proposed }, runScope);
    for (let i = 0; i < 7; i += 1) await ledger.record({ tool: 'search_episodes', ok: true, at: 1001 + i, taint: null, origin: 'machine', summary: `job ${i}` }, runScope);
    expect(await ledger.ownerTurnResults()).toEqual([LINE]);
    expect((await ledger.recent()).map(fragment => fragment.text)).toEqual(['job 1', 'job 2', 'job 3', 'job 4', 'job 5', 'job 6'].map(text => `search_episodes succeeded: ${text}`));
  });

  it.each([['awaited', undefined], ['fenced', scope]] as const)('%s: each origin keeps its own newest six', async (_path, runScope) => {
    const storage = fencedStorage();
    const ledger = toolOutputLedger(storage as never);
    for (let i = 0; i < 8; i += 1) {
      await ledger.record({ tool: 'search_episodes', ok: true, at: 2000 + i, taint: null, origin: 'owner', summary: `owner ${i}` }, runScope);
      await ledger.record({ tool: 'search_episodes', ok: true, at: 3000 + i, taint: null, origin: 'machine', summary: `job ${i}` }, runScope);
    }
    const kept = [...storage.data].filter(([key]) => key.startsWith('toolout:')).map(([, row]) => (row as { summary: string }).summary);
    expect(kept.sort()).toEqual(['job 2', 'job 3', 'job 4', 'job 5', 'job 6', 'job 7', 'owner 2', 'owner 3', 'owner 4', 'owner 5', 'owner 6', 'owner 7']);
    expect(await ledger.ownerTurnResults()).toEqual(['owner 2', 'owner 3', 'owner 4', 'owner 5', 'owner 6', 'owner 7'].map(text => `search_episodes succeeded: ${text}`));
  });

  it.each([['awaited', 'owner', undefined], ['fenced', 'owner', scope], ['awaited', 'machine', undefined], ['fenced', 'machine', scope]] as const)('%s: the first %s write drops a row stored before origins were kept', async (_path, origin, runScope) => {
    const storage = fencedStorage();
    storage.data.set('toolout:0000000000', { tool: 'search_episodes', ok: true, at: 1000, taint: 'external', summary: 'from before' });
    storage.data.set('toolout-count', 1);
    const ledger = toolOutputLedger(storage as never);
    await ledger.record({ tool: 'search_episodes', ok: true, at: 2000, taint: null, origin, summary: `${origin} 0` }, runScope);
    expect(storage.data.has('toolout:0000000000')).toBe(false);
    for (let i = 1; i < 6; i += 1) await ledger.record({ tool: 'search_episodes', ok: true, at: 2000 + i, taint: null, origin, summary: `${origin} ${i}` }, runScope);
    expect((await ledger.recent()).map(fragment => fragment.text)).toEqual([0, 1, 2, 3, 4, 5].map(i => `search_episodes succeeded: ${origin} ${i}`));
  });

  it('forgets an owner\'s row kept behind six newer job rows', async () => {
    const storage = fakeStorage();
    const ledger = toolOutputLedger(storage as never);
    const needle = 'Synthetic amber offsite plan';
    await ledger.record({ tool: 'search_episodes', ok: true, at: 1000, taint: null, origin: 'owner', summary: `notes on ${needle}` });
    for (let i = 0; i < 6; i += 1) await ledger.record({ tool: 'search_episodes', ok: true, at: 2000 + i, taint: null, origin: 'machine', summary: `job ${i}` });
    expect(await ledger.remaining([needle])).toBe(1);
    expect(await redactToolOutputLedger(storage as never, [needle], '[forgotten]')).toBe(1);
    expect(await ledger.remaining([needle])).toBe(0);
    expect(JSON.stringify([...storage.data.values()])).not.toContain(needle);
    expect(await ledger.ownerTurnResults()).toEqual(['search_episodes succeeded: notes on [forgotten]']);
  });
});
