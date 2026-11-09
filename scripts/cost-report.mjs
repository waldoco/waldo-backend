#!/usr/bin/env node
// Per-owner, per-day model spend and prompt-cache share, from the durable cost ledger and from Langfuse.
// Prints numbers only: no prompt, reply or tool text is read or printed.
//
//   node scripts/cost-report.mjs --window 2026-10-23..2026-10-29 [--baseline 2026-10-16..2026-10-22]
//     [--ledger ledger.json] [--langfuse] [--json]
//
// --ledger reads the single JSON cell this query returns in the Supabase SQL editor (service role):
//   select coalesce(json_agg(r), '[]') from (
//     select o.do_name as owner, l.day, l.kind, l.model, l.calls, l.input_tokens, l.cached_tokens, l.output_tokens, l.usd_estimate
//     from waldo.cost_ledger_daily l join waldo.owners o on o.id = l.owner_id
//     where l.day >= current_date - 30) r;
// --langfuse reads model calls from the Langfuse v2 observations API with LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY and
// LANGFUSE_SECRET_KEY, the same three values the Worker exports with. Langfuse owners are trace user ids, ledger owners
// are DO names; the two sources are reported side by side, not joined.
//
// Cache share is cached input tokens over all input tokens, the hit rate the prefix-stability work is judged by.

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const parseWindow = (text) => {
  const [from, to] = String(text ?? '').split('..');
  if (!DAY.test(from ?? '') || !DAY.test(to ?? '') || from > to) throw new Error(`window must be YYYY-MM-DD..YYYY-MM-DD, got "${text}"`);
  return { from, to };
};

const inWindow = (day, { from, to }) => day >= from && day <= to;
const empty = () => ({ calls: 0, input: 0, cached: 0, output: 0, usd: 0, traces: new Set(), holds: 0, unpriced: 0, unpricedModels: new Set() });
const add = (into, row) => {
  into.calls += row.calls; into.input += row.input; into.cached += row.cached; into.output += row.output; into.usd += row.usd;
  if (row.traceId) into.traces.add(row.traceId);
  into.holds += row.holds ?? 0;
  if (row.unpriced) { into.unpriced += row.calls; into.unpricedModels.add(row.model || '(unnamed)'); }
};

// Tokens billed at 0 USD mean the model has no row in pricing.ts; the total is then a floor, so say so.
const isUnpriced = ({ input, output, usd }) => usd === 0 && input + output > 0;

// One row per model call (Langfuse) or per ledger bucket, normalised to the same fields; input counts cached tokens.
export const ledgerCalls = (rows) => rows.map((row) => {
  const held = String(row.model).startsWith('held:');
  const call = {
    source: 'ledger', owner: String(row.owner), day: String(row.day).slice(0, 10), model: String(row.model),
    calls: held ? 0 : Number(row.calls), holds: held ? Number(row.calls) : 0,
    input: Number(row.input_tokens), cached: Number(row.cached_tokens), output: Number(row.output_tokens), usd: Number(row.usd_estimate),
  };
  return { ...call, unpriced: !held && isUnpriced(call) };
});

export const langfuseCalls = (observations) => observations.map((item) => {
  const usage = item.usageDetails;
  if (!usage || typeof usage !== 'object') throw new Error(`Langfuse observation ${item.id} has no usageDetails; request fields=core,basic,usage`);
  if (!item.userId) throw new Error(`Langfuse observation ${item.id} has no userId; request fields=core,basic,usage`);
  const cached = Number(usage.input_cached_tokens ?? 0);
  const call = {
    source: 'langfuse', owner: String(item.userId), day: String(item.startTime).slice(0, 10), model: String(item.providedModelName ?? item.model ?? ''),
    traceId: item.traceId, calls: 1, holds: 0, input: Number(usage.input ?? 0) + cached, cached, output: Number(usage.output ?? 0),
    usd: Number(item.totalCost ?? item.costDetails?.total ?? 0),
  };
  return { ...call, unpriced: isUnpriced(call) };
});

const share = (cached, input) => (input > 0 ? cached / input : null);
const summary = (bucket) => ({
  calls: bucket.calls, traces: bucket.traces.size, holds: bucket.holds, unpriced_calls: bucket.unpriced, unpriced_models: [...bucket.unpricedModels].sort(), input: bucket.input, cached: bucket.cached, output: bucket.output,
  usd: bucket.usd, cache_share: share(bucket.cached, bucket.input),
  usd_per_trace: bucket.traces.size > 0 ? bucket.usd / bucket.traces.size : null,
});

export const report = (calls, window) => {
  const days = new Map(), owners = new Map(), total = empty();
  for (const call of calls) {
    if (!inWindow(call.day, window)) continue;
    const key = `${call.owner}\u0000${call.day}`;
    if (!days.has(key)) days.set(key, empty());
    if (!owners.has(call.owner)) owners.set(call.owner, empty());
    add(days.get(key), call); add(owners.get(call.owner), call); add(total, call);
  }
  return {
    window,
    days: [...days].map(([key, bucket]) => { const [owner, day] = key.split('\u0000'); return { owner, day, ...summary(bucket) }; })
      .sort((a, b) => a.owner.localeCompare(b.owner) || a.day.localeCompare(b.day)),
    owners: [...owners].map(([owner, bucket]) => ({ owner, ...summary(bucket) })).sort((a, b) => b.usd - a.usd),
    total: summary(total),
  };
};

export const delta = (before, after) => ({
  usd: after.usd - before.usd,
  cache_share: before.cache_share === null || after.cache_share === null ? null : after.cache_share - before.cache_share,
  usd_per_trace: before.usd_per_trace === null || after.usd_per_trace === null ? null : after.usd_per_trace - before.usd_per_trace,
});

const pct = (value) => (value === null ? '-' : `${(value * 100).toFixed(1)}%`);
const usd = (value) => (value === null ? '-' : `$${value.toFixed(4)}`);
const signedPct = (value) => (value === null ? '-' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} pts`);

export const render = (source, current, baseline) => {
  const lines = [`## ${source}: ${current.window.from} to ${current.window.to}`, '',
    '| Owner | Day | Calls | Traces | Input | Cached | Cache share | Output | USD | USD/trace | Holds |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const row of current.days) {
    lines.push(`| ${row.owner} | ${row.day} | ${row.calls} | ${row.traces || '-'} | ${row.input} | ${row.cached} | ${pct(row.cache_share)} | ${row.output} | ${usd(row.usd)} | ${usd(row.usd_per_trace)} | ${row.holds} |`);
  }
  const t = current.total;
  lines.push('', `Total: ${t.calls} calls, ${usd(t.usd)}, cache share ${pct(t.cache_share)}, ${usd(t.usd_per_trace)} per trace.`);
  if (t.unpriced_calls > 0) {
    lines.push(`Unpriced: ${t.unpriced_calls} ${t.unpriced_calls === 1 ? 'call' : 'calls'} on ${t.unpriced_models.join(', ')} had tokens and no price, counted as $0, so the USD above is a floor.`);
  }
  if (baseline) {
    const b = baseline.total, d = delta(b, t);
    lines.push(`Baseline ${baseline.window.from} to ${baseline.window.to}: ${b.calls} calls, ${usd(b.usd)}, cache share ${pct(b.cache_share)}, ${usd(b.usd_per_trace)} per trace.`,
      `Change: cache share ${signedPct(d.cache_share)}, USD per trace ${d.usd_per_trace === null ? '-' : `${d.usd_per_trace >= 0 ? '+' : '-'}$${Math.abs(d.usd_per_trace).toFixed(4)}`}.`);
  }
  return lines.join('\n');
};

// Every generation from Langfuse in [from, to], following the v2 cursor to the end.
export const fetchLangfuse = async ({ base, publicKey, secretKey, from, to, fetchImpl = fetch }) => {
  const out = [];
  let cursor;
  do {
    const query = new URLSearchParams({ type: 'GENERATION', fields: 'core,basic,usage', limit: '1000',
      fromStartTime: `${from}T00:00:00.000Z`, toStartTime: `${to}T23:59:59.999Z`, ...(cursor ? { cursor } : {}) });
    const response = await fetchImpl(`${base.replace(/\/+$/, '')}/api/public/v2/observations?${query}`, {
      headers: { authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}` },
    });
    if (!response.ok) throw new Error(`Langfuse observations answered ${response.status}`);
    const page = await response.json();
    out.push(...(page.data ?? []));
    cursor = page.meta?.cursor ?? undefined;
  } while (cursor);
  return out;
};

const main = async (argv) => {
  const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const window = parseWindow(value('--window'));
  const baseline = value('--baseline') === undefined ? undefined : parseWindow(value('--baseline'));
  const ledgerPath = value('--ledger');
  if (!ledgerPath && !argv.includes('--langfuse')) throw new Error('give --ledger <file>, --langfuse, or both');
  const sections = [], json = {};
  const emit = (source, calls) => {
    const current = report(calls, window), before = baseline && report(calls, baseline);
    json[source] = { current, ...(before ? { baseline: before } : {}) };
    sections.push(render(source, current, before));
  };
  if (ledgerPath) emit('Cost ledger', ledgerCalls(JSON.parse(readFileSync(ledgerPath, 'utf8'))));
  if (argv.includes('--langfuse')) {
    const { LANGFUSE_BASE_URL: base, LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey } = process.env;
    if (!base || !publicKey || !secretKey) throw new Error('--langfuse needs LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');
    const from = baseline && baseline.from < window.from ? baseline.from : window.from;
    const to = baseline && baseline.to > window.to ? baseline.to : window.to;
    emit('Langfuse', langfuseCalls(await fetchLangfuse({ base, publicKey, secretKey, from, to })));
  }
  console.log(argv.includes('--json') ? JSON.stringify(json, null, 2) : sections.join('\n\n'));
};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(`FAIL ${error.message}`); process.exit(1); });
}
