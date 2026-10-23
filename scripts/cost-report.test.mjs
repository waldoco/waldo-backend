import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { delta, fetchLangfuse, langfuseCalls, ledgerCalls, parseWindow, render, report } from './cost-report.mjs';

const ledgerRows = [
  { owner: 'do-a', day: '2026-10-20', kind: 'turn', model: 'chat-model', calls: 4, input_tokens: 240000, cached_tokens: 180000, output_tokens: 2000, usd_estimate: 0.158 },
  { owner: 'do-a', day: '2026-10-20', kind: 'background', model: 'aux-model', calls: 2, input_tokens: 10000, cached_tokens: 0, output_tokens: 500, usd_estimate: 0.00125 },
  { owner: 'do-a', day: '2026-10-20', kind: 'turn', model: 'held:browse_page', calls: 1, input_tokens: 0, cached_tokens: 0, output_tokens: 0, usd_estimate: 0 },
  { owner: 'do-b', day: '2026-10-21', kind: 'turn', model: 'chat-model', calls: 1, input_tokens: 60000, cached_tokens: 0, output_tokens: 300, usd_estimate: 0.123 },
  { owner: 'do-b', day: '2026-10-25', kind: 'turn', model: 'chat-model', calls: 1, input_tokens: 60000, cached_tokens: 57000, output_tokens: 300, usd_estimate: 0.0147 },
];
const generation = (id, userId, traceId, startTime, input, cached, total) =>
  ({ id, userId, traceId, startTime, usageDetails: { input, input_cached_tokens: cached, output: 100 }, totalCost: total });

test('parseWindow accepts a closed day range and rejects anything else', () => {
  assert.deepEqual(parseWindow('2026-10-20..2026-10-22'), { from: '2026-10-20', to: '2026-10-22' });
  for (const bad of [undefined, '2026-10-20', '2026-10-22..2026-10-20', '20-10-2026..2026-10-22']) assert.throws(() => parseWindow(bad));
});

test('ledger rows report spend, cache share and holds per owner and day', () => {
  const result = report(ledgerCalls(ledgerRows), parseWindow('2026-10-20..2026-10-21'));
  const a = result.days.find((row) => row.owner === 'do-a');
  assert.equal(a.calls, 6);
  assert.equal(a.holds, 1);
  assert.equal(a.input, 250000);
  assert.equal(a.cache_share, 180000 / 250000);
  assert.equal(result.days.length, 2, 'the 25th is outside the window');
  assert.equal(result.owners[0].owner, 'do-a', 'owners sort by spend');
  assert.equal(result.total.cache_share, 180000 / 310000);
  assert.equal(result.total.usd_per_trace, null, 'the ledger has no trace ids');
});

test('Langfuse input adds the cached tokens back, since usageDetails.input is the uncached part', () => {
  const [call] = langfuseCalls([generation('o1', 'telegram:1', 't1', '2026-10-20T08:00:00Z', 6000, 54000, 0.0174)]);
  assert.equal(call.input, 60000);
  assert.equal(call.cached, 54000);
  assert.equal(call.day, '2026-10-20');
});

test('Langfuse rows count traces, so cost per trace is reported', () => {
  const calls = langfuseCalls([
    generation('o1', 'u', 't1', '2026-10-20T08:00:00Z', 60000, 0, 0.12),
    generation('o2', 'u', 't1', '2026-10-20T08:00:05Z', 6000, 54000, 0.02),
    generation('o3', 'u', 't2', '2026-10-20T09:00:00Z', 6000, 54000, 0.02),
  ]);
  const result = report(calls, parseWindow('2026-10-20..2026-10-20'));
  assert.equal(result.total.traces, 2);
  assert.ok(Math.abs(result.total.usd_per_trace - 0.08) < 1e-12);
});

test('a Langfuse observation without usage or user fails loudly instead of counting zero', () => {
  assert.throws(() => langfuseCalls([{ id: 'o1', userId: 'u', startTime: '2026-10-20' }]), /usageDetails/);
  assert.throws(() => langfuseCalls([{ id: 'o1', usageDetails: {}, startTime: '2026-10-20' }]), /userId/);
});

test('a baseline window renders the change in cache share and cost per trace', () => {
  const calls = langfuseCalls([
    generation('o1', 'u', 't1', '2026-10-20T08:00:00Z', 60000, 0, 0.12),
    generation('o2', 'u', 't2', '2026-10-25T08:00:00Z', 6000, 54000, 0.02),
  ]);
  const before = report(calls, parseWindow('2026-10-20..2026-10-21')), after = report(calls, parseWindow('2026-10-25..2026-10-26'));
  assert.equal(delta(before.total, after.total).cache_share, 0.9);
  const text = render('Langfuse', after, before);
  assert.match(text, /cache share \+90\.0 pts/);
  assert.match(text, /USD per trace -\$0\.1000/);
});

test('fetchLangfuse follows the cursor and asks for usage fields', async () => {
  const seen = [];
  const pages = [{ data: [{ id: 'a' }], meta: { cursor: 'next' } }, { data: [{ id: 'b' }], meta: {} }];
  const fetchImpl = async (url, init) => { seen.push({ url, auth: init.headers.authorization }); return { ok: true, json: async () => pages.shift() }; };
  const rows = await fetchLangfuse({ base: 'https://lf.example/', publicKey: 'pk', secretKey: 'sk', from: '2026-10-20', to: '2026-10-21', fetchImpl });
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b']);
  assert.match(seen[0].url, /^https:\/\/lf\.example\/api\/public\/v2\/observations\?/);
  assert.match(seen[0].url, /fields=core%2Cbasic%2Cusage/);
  assert.match(seen[1].url, /cursor=next/);
  assert.equal(seen[0].auth, `Basic ${Buffer.from('pk:sk').toString('base64')}`);
});

test('fetchLangfuse stops on an error status', async () => {
  await assert.rejects(fetchLangfuse({ base: 'https://lf.example', publicKey: 'pk', secretKey: 'sk', from: '2026-10-20', to: '2026-10-20',
    fetchImpl: async () => ({ ok: false, status: 401 }) }), /401/);
});

test('the script prints its report when run through a symlinked path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cost-report-'));
  try {
    const ledger = join(dir, 'ledger.json');
    writeFileSync(ledger, JSON.stringify(ledgerRows));
    const link = join(dir, 'cost-report-link.mjs');
    symlinkSync(fileURLToPath(new URL('./cost-report.mjs', import.meta.url)), link);
    const run = spawnSync(process.execPath, [link, '--window', '2026-10-20..2026-10-21', '--ledger', ledger], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /## Cost ledger: 2026-10-20 to 2026-10-21/);
    assert.match(run.stdout, /do-a/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger rows with tokens and no price are counted as unpriced and named, not passed off as free', () => {
  const rows = [
    ...ledgerRows,
    { owner: 'do-a', day: '2026-10-20', kind: 'turn', model: 'new-model', calls: 3, input_tokens: 9000, cached_tokens: 0, output_tokens: 400, usd_estimate: 0 },
  ];
  const result = report(ledgerCalls(rows), parseWindow('2026-10-20..2026-10-21'));
  assert.equal(result.total.unpriced_calls, 3, 'holds and priced rows are not unpriced');
  assert.deepEqual(result.total.unpriced_models, ['new-model']);
  assert.equal(result.days.find((row) => row.owner === 'do-b').unpriced_calls, 0);
  assert.match(render('Cost ledger', result), /Unpriced: 3 calls on new-model.*floor/);
});

test('Langfuse generations with tokens and zero cost are counted as unpriced and named', () => {
  const calls = langfuseCalls([
    generation('o1', 'u', 't1', '2026-10-20T08:00:00Z', 60000, 0, 0.12),
    { ...generation('o2', 'u', 't1', '2026-10-20T08:00:05Z', 6000, 0, undefined), providedModelName: 'new-model' },
  ]);
  const result = report(calls, parseWindow('2026-10-20..2026-10-20'));
  assert.equal(result.total.unpriced_calls, 1);
  assert.deepEqual(result.total.unpriced_models, ['new-model']);
  assert.match(render('Langfuse', result), /Unpriced: 1 call on new-model/);
});

test('a report with every call priced prints no unpriced line', () => {
  const result = report(ledgerCalls(ledgerRows), parseWindow('2026-10-20..2026-10-21'));
  assert.equal(result.total.unpriced_calls, 0);
  assert.doesNotMatch(render('Cost ledger', result), /Unpriced/);
});
