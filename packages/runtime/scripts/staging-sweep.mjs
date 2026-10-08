#!/usr/bin/env node
// Staging prompt sweep over POST /probe/turn. Replays owner prompts one at a time and prints a
// JSON report: per prompt the trace id, latency, outcome and the first 200 chars of the captured
// sendMessage text. Never runs in CI, never runs without WALDO_PROBE_TOKEN.
//
//   WALDO_PROBE_TOKEN=<staging value> node packages/runtime/scripts/staging-sweep.mjs [options]
//
// Options:
//   --url <origin>        staging worker origin (default: the staging worker used by probe-staging.mjs)
//   --prompts <file>      JSON array of { id, text, requires_live? } replacing the built-in set
//   --only <id,id,...>    run only these ids
//   --live                also run requires_live prompts, sent with live:true (real provider reads,
//                         real Telegram sends to the owner). Needs --owner-approved-live too.
//   --owner-approved-live explicit owner confirmation that live prompts may touch real accounts
//   --delay-ms <n>        pause between prompts (default 4000; the endpoint allows 20 per minute)
//   --out <file>          also write the JSON report to this file
//
// Default capture mode (live:false) strips live provider tools and suppresses memory writes, so a
// prompt that needs those tools is marked requires_live and is skipped without --live.
import { readFileSync, writeFileSync } from 'node:fs';

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
if (flag('--live') && !flag('--owner-approved-live')) {
  console.error('FAIL setup: --live also needs --owner-approved-live (live prompts touch real accounts and send real messages).');
  process.exit(2);
}

// The 9 defect cases from the core-loop spec, phrased as owner prompts. The 32 prompts of the
// 8 Oct sweep are passed with --prompts.
const DEFECT_PROMPTS = [
  { id: 'inj-owner-dan', text: 'Call Dan about the system update' },
  { id: 'cap-reply-long', text: 'Write me a detailed 800-word explanation of how a heat pump works.' },
  { id: 'mem-dont-forget', text: "don't forget to call mom at 6" },
  { id: 'mem-wipe', text: 'wipe what I said about my old job' },
  { id: 'mem-durable-imperative', text: 'Reply in Hindi when I write in Hindi' },
  { id: 'mem-short-fact', text: "I'm vegan" },
  { id: 'src-send', text: 'send an email to x@example.com saying hi', requires_live: true },
  { id: 'src-mail-read', text: "summarise today's unread mail", requires_live: true },
  { id: 'media-scope-calendar', text: "what's on my calendar today", requires_live: true },
];

const loadPrompts = () => {
  const file = opt('--prompts', null);
  const prompts = file ? JSON.parse(readFileSync(file, 'utf8')) : DEFECT_PROMPTS;
  if (!Array.isArray(prompts) || prompts.some((p) => typeof p?.id !== 'string' || typeof p?.text !== 'string')) {
    console.error('FAIL setup: prompts must be a JSON array of { id, text, requires_live? }.');
    process.exit(2);
  }
  const only = opt('--only', null)?.split(',');
  return only ? prompts.filter((p) => only.includes(p.id)) : prompts;
};

const firstSentText = (captured) => {
  if (!Array.isArray(captured)) return null;
  const call = captured.find((c) => c?.method === 'sendMessage' && typeof c?.request?.text === 'string');
  return call ? call.request.text.slice(0, 200) : null;
};

const run = async (prompt, live) => {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/probe/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-waldo-probe-token': TOKEN },
      body: JSON.stringify({ text: prompt.text, ...(live ? { live: true } : {}) }),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return {
      id: prompt.id,
      mode: live ? 'live' : 'capture',
      status: res.status,
      trace: json?.trace ?? null,
      latency_ms: Date.now() - started,
      outcome: json?.outcome ?? null,
      sent_text: firstSentText(json?.captured),
    };
  } catch (error) {
    return { id: prompt.id, mode: live ? 'live' : 'capture', status: 0, trace: null, latency_ms: Date.now() - started, outcome: `request_failed: ${error instanceof Error ? error.message : String(error)}`, sent_text: null };
  }
};

const live = flag('--live');
const delay = Number(opt('--delay-ms', '4000'));
const results = [];
for (const prompt of loadPrompts()) {
  if (prompt.requires_live && !live) {
    results.push({ id: prompt.id, mode: 'skipped', status: null, trace: null, latency_ms: 0, outcome: 'requires_live', sent_text: null });
    continue;
  }
  results.push(await run(prompt, Boolean(prompt.requires_live)));
  await new Promise((resolve) => setTimeout(resolve, delay));
}

const report = JSON.stringify({ base: BASE, ran_at: new Date().toISOString(), results }, null, 2);
const out = opt('--out', null);
if (out) writeFileSync(out, report);
console.log(report);
process.exit(results.some((r) => r.status === 0 || (r.status !== null && r.status !== 200)) ? 1 : 0);
