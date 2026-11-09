#!/usr/bin/env node
// Where one iMessage turn's wait went, as a table. Two sources:
// - The turn's Langfuse trace. Only span names and times are read, never inputs or outputs.
// - Optionally, the host's journal for that turn.
// Nothing it prints holds message text, handles or credentials. The read key is taken from the environment and never
// printed.
//
//   node packages/runtime/scripts/imessage-turn-timing.mjs --trace-file trace.json [--host-file host.jsonl]
//   LANGFUSE_PUBLIC_KEY=… LANGFUSE_SECRET_KEY=… LANGFUSE_BASE_URL=https://… \
//     node packages/runtime/scripts/imessage-turn-timing.mjs --trace <trace id> [--host-file host.jsonl]
//
// trace.json is a Langfuse trace or observations export: an object with `observations` or `data`, or a bare array of
// observations. Each observation needs `name`, `startTime` and `endTime`. These shapes follow Langfuse's public API
// reference and have not yet been checked against a real export.
//
// host.jsonl is one JSON object per line: {"at": <ISO time or epoch ms>, "phase": <phase>, "kind": "reply" | "progress"}.
// The phases are:
//   message_received  Photon handed the owner's message to the host
//   event_acked       the bridge accepted the host's /events post
//   pulled            the host pulled the command
//   send_started      space.send began
//   send_done         space.send returned
//   result_acked      the bridge accepted the host's result
// `kind` is needed only on the outbound phases.

const ms = (value) => typeof value === 'number' ? value : Date.parse(value);
const n = (value) => `${Math.round(value).toLocaleString('en-US')} ms`;
const sum = (spans) => spans.reduce((total, span) => total + span.ms, 0);

const observationsOf = (input) => Array.isArray(input) ? input : input?.observations ?? input?.data ?? [];

/** The table's rows from a trace's observations and, optionally, the host's journal for the same turn. */
export function timingRows(input, hostEvents = []) {
  const spans = observationsOf(input).filter((o) => typeof o?.name === 'string' && o.startTime && o.endTime)
    .map((o) => ({ name: o.name, start: ms(o.startTime), end: ms(o.endTime) })).map((s) => ({ ...s, ms: s.end - s.start }))
    // The trace's root span (imessage.turn) only spans its children.
    .filter((s) => !s.name.includes('.'));
  if (!spans.length) throw new Error('the trace has no timed spans');
  const t0 = Math.min(...spans.map((s) => s.start));
  const named = (test) => spans.filter((s) => test(s.name));
  const grouped = (list, strip) => [...list.reduce((groups, s) => groups.set(s.name.slice(strip), [...(groups.get(s.name.slice(strip)) ?? []), s]), new Map())]
    .map(([name, group]) => `${name} ${group.length} × ${n(sum(group))}`).join('; ') || 'none';
  const replies = named((name) => name === 'llm_reply'), frozen = named((name) => name === 'outbox_enqueue').at(-1);
  const rows = [
    ['Worker clock', ''],
    ['turn spans', `${n(0)} → ${n(Math.max(...spans.map((s) => s.end)) - t0)}`],
    ['model calls (llm_reply)', replies.length ? `${replies.length} calls, ${n(sum(replies))} total, longest ${n(Math.max(...replies.map((s) => s.ms)))}` : 'none'],
    ['other model calls', grouped(named((name) => name.startsWith('llm_') && name !== 'llm_reply'), 4)],
    ['tools', grouped(named((name) => name.startsWith('tool_') || name.startsWith('subagent_tool_')), 0)],
    ['progress notes sent at', named((name) => name === 'progress_note').map((s) => `+${n(s.end - t0)}`).join(', ') || 'none'],
    ['reply frozen at', frozen ? `+${n(frozen.end - t0)}` : 'not in the trace'],
  ];
  const events = hostEvents.map((e) => ({ ...e, at: ms(e.at) })).filter((e) => Number.isFinite(e.at));
  if (!events.length) return rows;
  const at = (phase, kind) => events.find((e) => e.phase === phase && (kind === undefined || e.kind === kind))?.at;
  const span = (from, to) => from === undefined || to === undefined ? 'not in the journal' : n(to - from);
  const received = at('message_received'), acked = at('event_acked'), pulled = at('pulled', 'reply'), started = at('send_started', 'reply'), done = at('send_done', 'reply');
  rows.push(
    ['Host clock', ''],
    ['message received → event acked', span(received, acked)],
    ['reply pulled → send done', span(pulled, done)],
    ['Photon send (reply)', span(started, done)],
    ['progress notes sent (host)', events.filter((e) => e.phase === 'send_done' && e.kind === 'progress').map((e) => received === undefined ? n(e.at) : `+${n(e.at - received)}`).join(', ') || 'none'],
    ['Across clocks (host vs Worker; skew not removed)', ''],
    ['event acked → first turn span', span(acked, t0)],
    ['reply frozen → reply pulled', span(frozen?.end, pulled)],
    ['owner\'s message → reply sent', span(received, done)],
  );
  return rows;
}

export const formatRows = (rows) => rows.map(([label, value]) => value === '' ? label : `  ${label.padEnd(34)} ${value}`).join('\n');

const PAGE = 100, MAX_PAGES = 20;

// A long turn can log more spans than one page holds, so every page is read; a missing page count fails rather than
// leaving out the reply's span.
async function langfuseObservations(env, traceId, get) {
  const { LANGFUSE_PUBLIC_KEY: pk, LANGFUSE_SECRET_KEY: sk, LANGFUSE_BASE_URL: base } = env;
  if (!pk || !sk || !base) throw new Error('set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL, or pass --trace-file');
  const headers = { authorization: `Basic ${Buffer.from(`${pk}:${sk}`).toString('base64')}` }, observations = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL('/api/public/observations', base);
    url.searchParams.set('traceId', traceId); url.searchParams.set('limit', String(PAGE)); url.searchParams.set('page', String(page));
    const response = await get(url, { headers });
    if (!response.ok) throw new Error(`Langfuse answered ${response.status}`);
    const body = await response.json(), data = Array.isArray(body?.data) ? body.data : [], pages = body?.meta?.totalPages;
    observations.push(...data);
    if (typeof pages !== 'number') {
      if (data.length >= PAGE) throw new Error('Langfuse sent a full page without a page count; export the trace and pass --trace-file');
      return { observations };
    }
    if (page >= pages || !data.length) return { observations };
  }
  throw new Error(`the trace has more than ${MAX_PAGES * PAGE} spans; export it and pass --trace-file`);
}

export async function main({ argv, env, read, log, fail, fetch: get = globalThis.fetch }) {
  const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  try {
    const traceFile = flag('--trace-file'), traceId = flag('--trace'), hostFile = flag('--host-file');
    if (!traceFile && !traceId) throw new Error('pass --trace-file <file> or --trace <trace id>');
    const trace = traceFile ? JSON.parse(await read(traceFile)) : await langfuseObservations(env, traceId, get);
    const host = hostFile ? (await read(hostFile)).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)) : [];
    log(formatRows(timingRows(trace, host)));
    return 0;
  } catch (error) { fail(`timing: ${error?.message ?? 'failed'}`); return 1; }
}

if (globalThis.process?.argv?.[1]?.endsWith('imessage-turn-timing.mjs')) {
  const { readFile } = await import('node:fs/promises');
  process.exitCode = await main({ argv: process.argv.slice(2), env: process.env, read: (path) => readFile(path, 'utf8'), log: console.log, fail: console.error });
}
