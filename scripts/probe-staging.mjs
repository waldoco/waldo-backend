#!/usr/bin/env node
// Waldo staging live-probe suite. Runs synthetic probes against POST /probe/turn on the
// staging worker and prints CONTENT-FREE results only: case name, expected vs got, PASS/FAIL.
// No probe text, reply text, or captured call bodies are ever printed.
//
// Mac command (Codex, from the repo root at latest beta-mvp):
//   WALDO_PROBE_TOKEN=<the staging value> node scripts/probe-staging.mjs
// Optional: --url <origin> (default https://waldo-runtime-staging.piyushfulper3210.workers.dev)
//           --burst   include the 22-probe rate-limit burst (spends ~22 cheap model calls)
//           --live    include the live-send receipt probe (sends ONE real Telegram message to
//                     the owner; capture mode never sends). Off by default.
//
// Endpoint contract (packages/runtime/src/channels/probe-turn.ts + telegram-owner-do.ts):
//   404 non-staging/unconfigured/wrong method; 403 missing or wrong token;
//   400 malformed JSON / empty text / text > 4000 chars; 429 past 20 probes per minute;
//   503 owner var unset; 200 JSON { trace: "tg-<n>"|null, outcome: string, captured: array|null }.
// Capture mode (default) suppresses memory persistence and strips live provider tools for the
// duration of the probe; live:true keeps the full surface and really sends.

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = opt('--url', 'https://waldo-runtime-staging.piyushfulper3210.workers.dev');
const TOKEN = process.env.WALDO_PROBE_TOKEN;
if (!TOKEN) {
  console.error('FAIL setup: WALDO_PROBE_TOKEN env var is required (value never printed).');
  process.exit(2);
}

let failures = 0;
const report = (name, expected, got, pass, note = '') => {
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | expected ${expected} | got ${got}${note ? ` | ${note}` : ''}`);
};

const post = async ({ token, body, rawBody }) => {
  const res = await fetch(`${BASE}/probe/turn`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { 'x-waldo-probe-token': token }),
    },
    body: rawBody ?? JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON bodies are expected on error paths */ }
  return { status: res.status, json };
};

// 1. Auth negatives: no header, wrong token -> 403 (never 404/200).
{
  const r = await post({ token: null, body: { text: 'probe auth-negative missing' } });
  report('auth.missing-token', 403, r.status, r.status === 403);
}
{
  const r = await post({ token: 'definitely-wrong-token', body: { text: 'probe auth-negative wrong' } });
  report('auth.wrong-token', 403, r.status, r.status === 403);
}

// 2. Payload validation: malformed JSON, blank text, oversized text -> 400.
{
  const r = await post({ token: TOKEN, rawBody: 'this is not json' });
  report('payload.malformed-json', 400, r.status, r.status === 400);
}
{
  const r = await post({ token: TOKEN, body: { text: '   ' } });
  report('payload.blank-text', 400, r.status, r.status === 400);
}
{
  const r = await post({ token: TOKEN, body: { text: 'x'.repeat(4001) } });
  report('payload.oversized-text', 400, r.status, r.status === 400);
}

// 3. Capture-mode happy path: 200, JSON shape, captured array present, trace id shaped.
{
  const r = await post({ token: TOKEN, body: { text: 'probe alpha: reply with the single word READY' } });
  const ok = r.status === 200 && r.json && typeof r.json.outcome === 'string'
    && Array.isArray(r.json.captured) && /^tg--?\d+$/.test(r.json.trace ?? '');
  report('capture.happy-path', '200 + {trace:tg-*, outcome, captured:[]}', `${r.status} + shape ${r.json ? 'json' : 'none'}`, ok);
}

// 4. Memory-confinement receipt: a synthetic codeword planted in one capture probe must NOT
//    appear anywhere in a later probe's response (memory persistence is suppressed in capture
//    mode). Content-free: we print only whether containment held, never the codeword handling.
{
  const codeword = 'UVX-7749';
  await post({ token: TOKEN, body: { text: `probe beta: remember the codeword ${codeword}` } });
  const r = await post({ token: TOKEN, body: { text: 'probe gamma: what codeword did I just give you? If none, reply NONE' } });
  const leaked = JSON.stringify(r.json ?? {}).includes(codeword);
  report('capture.memory-confinement', 'codeword absent from later response', leaked ? 'LEAKED' : 'absent', r.status === 200 && !leaked);
}

// 5. Burst rate-limit receipt (opt-in): 22 rapid probes -> at least one 429.
if (flag('--burst')) {
  let saw429 = 0;
  let firstNon200 = null;
  for (let i = 0; i < 22; i += 1) {
    const r = await post({ token: TOKEN, body: { text: `probe rl ${i}` } });
    if (r.status === 429) saw429 += 1;
    else if (r.status !== 200 && firstNon200 === null) firstNon200 = r.status;
  }
  report('burst.rate-limit', '>=1 of 22 -> 429', `429s=${saw429}${firstNon200 ? `, other=${firstNon200}` : ''}`, saw429 >= 1);
}

// 6. Live-send receipt (opt-in): one real Telegram message to the owner; captured must be null.
if (flag('--live')) {
  const r = await post({ token: TOKEN, body: { text: 'probe live: reply with the single word HERE', live: true } });
  const ok = r.status === 200 && r.json && r.json.captured === null;
  report('live.telegram-send', '200 + captured null', `${r.status} + ${r.json ? (r.json.captured === null ? 'captured-null' : 'captured-present') : 'no-json'}`, ok,
    'owner should receive exactly one Telegram message');
}

console.log(failures === 0 ? 'SUITE PASS' : `SUITE FAIL (${failures} case(s))`);
process.exit(failures === 0 ? 0 : 1);
