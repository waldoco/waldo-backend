import { expect, it } from 'vitest';
// @ts-expect-error plain script module without types
import { formatRows, main, timingRows } from '../scripts/imessage-turn-timing.mjs';

const at = (offsetMs: number) => new Date(Date.UTC(2026, 9, 23, 9, 0, 0) + offsetMs).toISOString();
const span = (name: string, start: number, end: number) => ({ name, startTime: at(start), endTime: at(end), input: 'never read', output: 'never read' });
const trace = { observations: [
  span('imessage.turn', 0, 41_230),
  span('typing', 0, 5),
  span('llm_reply', 100, 6_100), span('tool_query_calendar', 6_100, 6_940),
  span('llm_reply', 7_000, 13_000), span('tool_browse_page', 13_000, 27_900),
  span('llm_progress_note', 20_000, 21_200), span('progress_note', 20_000, 21_400),
  span('llm_reply', 28_000, 41_200), span('outbox_enqueue', 41_200, 41_230),
] };
const host = [
  { at: at(-900), phase: 'message_received' }, { at: at(-600), phase: 'event_acked' },
  { at: at(22_300), phase: 'send_done', kind: 'progress' },
  { at: at(42_100), phase: 'pulled', kind: 'reply' }, { at: at(42_200), phase: 'send_started', kind: 'reply' }, { at: at(43_700), phase: 'send_done', kind: 'reply' },
];

it('splits a long turn into model, tool, note, hand-off and send time', () => {
  const rows = new Map(timingRows(trace, host) as [string, string][]);
  expect(rows.get('turn spans')).toBe('0 ms → 41,230 ms');
  expect(rows.get('model calls (llm_reply)')).toBe('3 calls, 25,200 ms total, longest 13,200 ms');
  expect(rows.get('other model calls')).toBe('progress_note 1 × 1,200 ms');
  expect(rows.get('tools')).toBe('tool_query_calendar 1 × 840 ms; tool_browse_page 1 × 14,900 ms');
  expect(rows.get('progress notes sent at')).toBe('+21,400 ms');
  expect(rows.get('reply frozen at')).toBe('+41,230 ms');
  expect(rows.get('message received → event acked')).toBe('300 ms');
  expect(rows.get('Photon send (reply)')).toBe('1,500 ms');
  expect(rows.get('reply frozen → reply pulled')).toBe('870 ms');
  expect(rows.get('owner\'s message → reply sent')).toBe('44,600 ms');
  expect(rows.get('progress notes sent (host)')).toBe('+23,200 ms');
});

it('works from the trace alone and never reads span inputs or outputs', () => {
  const table = formatRows(timingRows(trace));
  expect(table).toContain('reply frozen at');
  expect(table).not.toContain('Host clock');
  expect(table).not.toContain('never read');
});

it('refuses without a trace, and a Langfuse fetch without its key says which settings to set and never prints them', async () => {
  const failed: string[] = [];
  expect(await main({ argv: [], env: {}, read: async () => '', log: () => undefined, fail: (line: string) => failed.push(line) })).toBe(1);
  expect(await main({ argv: ['--trace', 'abc'], env: {}, read: async () => '', log: () => undefined, fail: (line: string) => failed.push(line) })).toBe(1);
  expect(failed).toEqual(['timing: pass --trace-file <file> or --trace <trace id>', 'timing: set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL, or pass --trace-file']);
  const logged: string[] = [];
  expect(await main({ argv: ['--trace-file', 'trace.json'], env: {}, read: async () => JSON.stringify(trace), log: (line: string) => logged.push(line), fail: () => undefined })).toBe(0);
  expect(logged[0]).toContain('model calls (llm_reply)');
});

it('reads every page of a long trace from Langfuse, and fails rather than drop spans when a full page has no page count', async () => {
  const all = trace.observations, requested: string[] = [];
  const pages = (meta: boolean) => async (url: URL, init: { headers: Record<string, string> }) => {
    requested.push(`${url.searchParams.get('page')}:${init.headers.authorization?.startsWith('Basic ') ? 'auth' : 'none'}`);
    const page = Number(url.searchParams.get('page'));
    const data = meta ? all.slice((page - 1) * 5, page * 5) : Array.from({ length: 100 }, () => all[1]);
    return new Response(JSON.stringify({ data, ...(meta ? { meta: { page, limit: 100, totalItems: all.length, totalPages: 2 } } : {}) }));
  };
  const env = { LANGFUSE_PUBLIC_KEY: 'pk-fixture', LANGFUSE_SECRET_KEY: 'sk-fixture', LANGFUSE_BASE_URL: 'https://langfuse.fixture.invalid' };
  const logged: string[] = [], failed: string[] = [];
  expect(await main({ argv: ['--trace', 'abc'], env, read: async () => '', log: (line: string) => logged.push(line), fail: () => undefined, fetch: pages(true) })).toBe(0);
  expect(requested).toEqual(['1:auth', '2:auth']);
  expect(logged[0]).toContain('+41,230 ms');
  expect(logged.join('\n')).not.toMatch(/pk-fixture|sk-fixture/);
  expect(await main({ argv: ['--trace', 'abc'], env, read: async () => '', log: () => undefined, fail: (line: string) => failed.push(line), fetch: pages(false) })).toBe(1);
  expect(failed).toEqual(['timing: Langfuse sent a full page without a page count; export the trace and pass --trace-file']);
});
